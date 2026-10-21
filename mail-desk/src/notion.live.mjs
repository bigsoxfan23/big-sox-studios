// Owner-approved schema, dormant transport. No logging or automatic write retries.
import { DATA_SOURCE, ACTIVITY_SOURCE, NOTION_VERSION, mapNotion } from './notion.mjs';
// Runtime-only cutover; unsafe/rounded values fail closed before storage or transport.
export const syncStart = env => typeof env.NOTION_SYNC_START_UNIX === 'string' &&
 /^[0-9]+$/.test(env.NOTION_SYNC_START_UNIX) && Number.isSafeInteger(Number(env.NOTION_SYNC_START_UNIX))
 ? Number(env.NOTION_SYNC_START_UNIX) : null;
export const liveEnabled = env => env.NOTION_SYNC_MODE === 'live' &&
 env.DEPLOYMENT_STAGE === 'staging' && typeof env.NOTION_API_TOKEN === 'string' &&
 env.NOTION_API_TOKEN.trim().length > 0 && syncStart(env) !== null;
export const pageId = id => typeof id === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(id);
export const activityTitle = id => `Inbound email ${id}`;
const select = name => ({ select: { name } });
export function ticketPayload(c) {
 if (c.channel !== 'support') throw Error('notion_channel_denied');
 return mapNotion(c);
}
export function activityPayload(messageId, ticketId) {
 if (!pageId(messageId) || !pageId(ticketId)) throw Error('notion_invalid_id');
 return { parent: { type: 'data_source_id', data_source_id: ACTIVITY_SOURCE }, properties: {
  Event: { title: [{ text: { content: activityTitle(messageId) } }] },
  'Event Type': select('Work Note'), Author: select('System'),
  Details: { rich_text: [{ text: { content: 'Inbound support email received. Review the original forwarded email in the owner inbox.' } }] },
  Ticket: { relation: [{ id: ticketId }] }
 } };
}
const MAX_JSON = 256 * 1024;
async function boundedJson(response) {
 const declared = response.headers.get('Content-Length');
 if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON)) throw Error('bounded');
 const reader = response.body?.getReader();
 if (!reader) throw Error('empty');
 let size = 0; const chunks = [];
 try {
  for (;;) {
   const { done, value } = await reader.read(); if (done) break;
   size += value.byteLength; if (size > MAX_JSON) throw Error('bounded'); chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
 } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class LiveNotion {
 constructor(env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
 async request(channel, path, body, method = 'POST') {
  if (!liveEnabled(this.env) || channel !== 'support') throw Error('notion_disabled');
  const patchId = path.startsWith('pages/') ? path.slice(6) : null;
  if (method === 'PATCH') {
   if (!pageId(patchId) || Object.keys(body ?? {}).join() !== 'properties' || Object.keys(body.properties ?? {}).join() !== 'Mail Desk Folder' ||
    Object.keys(body.properties['Mail Desk Folder'] ?? {}).join() !== 'select' || Object.keys(body.properties['Mail Desk Folder'].select ?? {}).join() !== 'name' ||
    !['Inbox','Archive','Trash'].includes(body.properties['Mail Desk Folder'].select.name)) throw Error('notion_invalid_patch');
  } else if (method !== 'POST' || (path !== 'pages' && ![DATA_SOURCE, ACTIVITY_SOURCE].some(source => path === `data_sources/${source}/query`))) throw Error('notion_invalid_path');
  const controller = new AbortController(); let timer;
  try {
   // Deadline covers transport AND streamed JSON, including a stalled injected fetch.
   return await Promise.race([(async () => {
    // Never emit credential contents. Notion tokens do not include whitespace;
    // trim transport artifacts from copy/paste before constructing headers.
    const token = this.env.NOTION_API_TOKEN.trim();
    if (!/^[\x21-\x7e]{12,1024}$/.test(token)) throw Error('notion_credential_format');
    let response;
    // Cloudflare Workers fetch must be invoked as a bare function. Calling
    // this.fetcher(...) incorrectly binds this=LiveNotion and triggers
    // TypeError: Illegal invocation in the real workerd runtime.
    const callFetch = this.fetcher;
    try {
     response = await callFetch(`https://api.notion.com/v1/${path}`, {
      method, redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
     });
    } catch (error) {
     if (error instanceof TypeError) throw Error('notion_transport_fetch_type');
     throw error;
    }
    if (!response.ok || response.redirected) {
     await response.body?.cancel().catch(() => {});
     // Preserve only the HTTP status category; never Notion's body, URL, headers or token.
     const code = [400,401,403,404,409,422,429,500,502,503,504].includes(response.status) ? String(response.status) : 'other';
     throw Error('notion_http_' + code);
    }
    try { return await boundedJson(response); }
    catch (error) { if (error instanceof TypeError) throw Error('notion_transport_body_type'); throw error; }
   })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('timeout')); }, 9000); })]);
  } catch (error) {
   if (/^notion_http_(?:400|401|403|404|409|422|429|500|502|503|504|other)$/.test(error?.message)) throw error;
   if (error instanceof SyntaxError) throw Error('notion_json_invalid');
   if (error?.message === 'bounded') throw Error('notion_json_oversize');
   if (error?.message === 'empty') throw Error('notion_json_empty');
   if (error?.message === 'timeout') throw Error('notion_deadline');
   if (['notion_credential_format','notion_transport_fetch_type','notion_transport_body_type'].includes(error?.message)) throw error;
   if (error?.name === 'AbortError') throw Error('notion_transport_abort');
   if (error instanceof TypeError) throw Error('notion_transport_type');
   throw Error('notion_request_failed');
  }
  finally { clearTimeout(timer); controller.abort(); }
 }
 async find(channel, source, property, type, value) {
  if (![DATA_SOURCE, ACTIVITY_SOURCE].includes(source)) throw Error('notion_invalid_source');
  const matches = []; const cursors = new Set(); let cursor;
  // At most two matches and two pages. Incomplete pagination fails closed.
  for (let n = 0; n < 2; n++) {
   const result = await this.request(channel, `data_sources/${source}/query`, {
    filter: { property, [type]: { equals: value } }, page_size: 2 - matches.length,
    ...(cursor ? { start_cursor: cursor } : {})
   });
   if (!Array.isArray(result.results) || result.results.length > 2 - matches.length || typeof result.has_more !== 'boolean' ||
       result.results.some(p => p.object !== 'page' || !pageId(p.id))) throw Error('notion_invalid_query');
   matches.push(...result.results);
   if (matches.length > 1) throw Error('notion_duplicate_matches');
   if (!result.has_more) return matches;
   cursor = result.next_cursor;
   if (typeof cursor !== 'string' || !cursor || cursor.length > 256 || cursors.has(cursor)) throw Error('notion_incomplete_query');
   cursors.add(cursor);
  }
  throw Error('notion_incomplete_query');
 }
 findTicket(c) { return this.find(c.channel, DATA_SOURCE, 'External Case ID', 'rich_text', c.id); }
 async findActivity(c, messageId, ticketId) {
  const found = await this.find(c.channel, ACTIVITY_SOURCE, 'Event', 'title', activityTitle(messageId));
  if (found.length) {
   const title = found[0].properties?.Event;
   if (!Array.isArray(title?.title) || title.title.some(part => typeof part.plain_text !== 'string' && typeof part.text?.content !== 'string') ||
       title.title.map(part => part.plain_text ?? part.text.content).join('') !== activityTitle(messageId)) throw Error('notion_activity_conflict');
   const relation = found[0].properties?.Ticket;
   if (relation?.has_more === true || !Array.isArray(relation?.relation) || relation.relation.length !== 1 || relation.relation[0].id !== ticketId) throw Error('notion_activity_conflict');
  }
  return found;
 }
 async updateFolder(c, id, folder) {
  const names = {inbox:'Inbox',archive:'Archive',trash:'Trash'};
  if (!pageId(id) || !Object.hasOwn(names, folder)) throw Error('notion_invalid_patch');
  const page = await this.request(c.channel, `pages/${id}`, {properties:{'Mail Desk Folder':select(names[folder])}}, 'PATCH');
  if (page.object !== 'page' || !pageId(page.id) || page.id.replaceAll('-','').toLowerCase() !== id.replaceAll('-','').toLowerCase()) throw Error('notion_invalid_patch_response');
  return page;
 }
 async createTicket(c) { return this.create(c.channel, ticketPayload(c)); }
 async createActivity(c, messageId, ticketId) { return this.create(c.channel, activityPayload(messageId, ticketId)); }
 async create(channel, payload) {
  const page = await this.request(channel, 'pages', payload);
  if (page.object !== 'page' || !pageId(page.id)) throw Error('notion_ambiguous_create');
  return page;
 }
}
