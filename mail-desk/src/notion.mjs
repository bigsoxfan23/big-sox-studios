import { stmt, now } from './store.mjs';
export const DATA_SOURCE = '103d8328-de8b-4b7f-8986-000ce40450b5';
export const ACTIVITY_SOURCE = '17401fd3-c5f4-46bb-b516-c420b6e3ce24'; // Existing service owns activity writes.
export const NOTION_VERSION = '2025-09-03';
const select = name => ({ select: { name } });
const rich = content => ({ rich_text: [{ text: { content } }] });
export function mapNotion(c) {
 const membership = c.channel === 'members';
 if (!['members','support','hello'].includes(c.channel)) throw new Error('invalid_channel');
 return {
  parent: { type: 'data_source_id', data_source_id: DATA_SOURCE },
  properties: {
   Title: { title: [{ text: { content: c.subject } }] },
   'Ticket Family': select('Service Management'),
   'Ticket Kind': select(membership ? 'Membership' : c.channel === 'support' ? 'Incident / Support' : 'General inquiry'),
   Status: select('Inbox'), 'Request Channel': select(`${c.channel}@`),
   'Requester Name': rich(c.requester_name), 'Requester Email': { email: c.requester_email },
   'External Case ID': rich(c.id), 'Membership Decision': select(membership ? 'Pending' : 'Not applicable'),
   'Reply State': select('Needs approval'), 'Assigned To': select('Greg'), Priority: select('Normal'),
   'Project / System': select(membership ? 'Members Portal' : 'Other')
  }
 };
}
// Synthetic executor only. Delivery plans cannot reuse the initial-case mapper.
// No Notion token, fetch, or live executor exists.
export async function runMockSync(db, env, execute = async () => {}) {
 if (env.NOTION_SYNC_MODE !== 'mock') return { processed: 0 };
 const time = now();
 // Recover only synthetic sync leases; delivery claims are never reclaimed.
 await stmt(db, `UPDATE sync_jobs SET status=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END WHERE status='running' AND next_attempt<=?`, time).run();
 const jobs = await stmt(db, `UPDATE sync_jobs SET status='running',attempts=attempts+1,next_attempt=? WHERE id IN
 (SELECT id FROM sync_jobs WHERE status='pending' AND next_attempt<=? AND attempts<5 LIMIT 10) RETURNING *`, time + 300, time).all();
 for (const job of jobs.results) {
  try {
   const c = await stmt(db, 'SELECT * FROM cases WHERE id=?', job.case_id).first();
   const plan = job.kind === 'case_created' ? mapNotion(c) : { data_source_id: DATA_SOURCE, externalCaseId: c.id, properties: { 'Reply State': select('Sent') } };
   await execute(plan);
   await stmt(db, "UPDATE sync_jobs SET status='done' WHERE id=? AND status='running' AND attempts=?", job.id, job.attempts).run();
  } catch {
   await stmt(db, `UPDATE sync_jobs SET status=?,next_attempt=? WHERE id=? AND status='running' AND attempts=?`, job.attempts >= 5 ? 'dead' : 'pending', time + Math.min(3600, 30 * 2 ** (job.attempts - 1)), job.id, job.attempts).run();
  }
 }
 return { processed: jobs.results.length };
}

// Local-only model of External Case ID reconciliation. No transport/token is accepted.
// This mock stores pages in memory; it cannot call Notion or create databases/activity.
export class OfflineNotion {
 constructor() { this.pages = new Map(); this.calls = []; }
 async find(externalId) {
  this.calls.push('query');
  return [...this.pages.values()].filter(p => p.externalId === externalId);
 }
 async create(externalId, payload) {
  this.calls.push('create');
  const page = { id: crypto.randomUUID(), externalId, payload: structuredClone(payload) };
  this.pages.set(page.id, page); return page;
 }
 async update(id, properties) {
  this.calls.push('update');
  Object.assign(this.pages.get(id).payload.properties, structuredClone(properties));
 }
}
export async function offlineUpsert(db, env, c, job, mock) {
 if (env.NOTION_SYNC_MODE !== 'mock' || !(mock instanceof OfflineNotion)) return { status: 'off' };
 if (job.case_id !== c.id || !['case_created','delivery_sent'].includes(job.kind)) throw Error('invalid_job');
 if (job.kind === 'delivery_sent' && !await stmt(db, "SELECT id FROM outbound_intents WHERE id=? AND case_id=? AND status='sent'", job.intent_id, c.id).first()) throw Error('delivery_not_sent');
 // Query failure is safe to retry: it has no write effect. Never blindly retry a create.
 const found = await mock.find(c.id);
 if (found.length > 1) throw Error('external_id_conflict');
 const link = await stmt(db, 'SELECT * FROM notion_links WHERE case_id=?', c.id).first();
 let page = found[0];
 if (page) {
  if (link?.page_id && link.page_id !== page.id) throw Error('page_link_conflict');
  await stmt(db, `INSERT INTO notion_links VALUES (?,?,'linked',?) ON CONFLICT(case_id) DO UPDATE SET page_id=excluded.page_id,state='linked',updated_at=excluded.updated_at`, c.id, page.id, now()).run();
 } else {
  if (link) return { status: 'UNKNOWN' }; // Includes in-flight creates and eventual-consistency gaps.
  const claim = await stmt(db, `INSERT INTO notion_links VALUES (?,NULL,'creating',?) ON CONFLICT(case_id) DO NOTHING RETURNING case_id`, c.id, now()).first();
  if (!claim) return { status: 'UNKNOWN' };
  try {
   page = await mock.create(c.id, mapNotion(c));
   if (!page?.id) throw Error('ambiguous_create');
   await stmt(db, "UPDATE notion_links SET page_id=?,state='linked',updated_at=? WHERE case_id=? AND state='creating'", page.id, now(), c.id).run();
  } catch {
   await stmt(db, "UPDATE notion_links SET state='UNKNOWN',updated_at=? WHERE case_id=? AND state='creating'", now(), c.id).run();
   return { status: 'UNKNOWN' };
  }
 }
 if (job.kind === 'delivery_sent') {
  // Idempotent assignment only. Never reset Status, ownership, Reference or Sequence.
  await mock.update(page.id, { 'Reply State': select('Sent') });
 }
 return { status: 'linked', pageId: page.id };
}
