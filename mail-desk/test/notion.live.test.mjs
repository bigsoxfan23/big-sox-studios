import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { createWorker } from '../src/worker.mjs';
import { DATA_SOURCE, ACTIVITY_SOURCE } from '../src/notion.mjs';
import { LiveNotion, activityTitle, ticketPayload, liveEnabled, syncStart } from '../src/notion.live.mjs';
import { runNotionSync, syncSupportCase } from '../src/notion.sync.mjs';

const enabled = { DEPLOYMENT_STAGE: 'staging', NOTION_SYNC_MODE: 'live', NOTION_API_TOKEN: 'offline-test-placeholder', NOTION_SYNC_START_UNIX: '0' };
const rows = (f, table) => f.DB.sqlite.prepare(`SELECT * FROM ${table}`).all();
// Model a later invocation without deleting any side-effect suppression record.
function ageBackoff(f) {
 for (const table of ['notion_links', 'notion_activity_links', 'notion_sync_backoff'])
  f.DB.sqlite.exec(`UPDATE ${table} SET updated_at=updated_at-3600`);
}
async function setup(t) { return fixture(t, { notion: true, env: enabled }); }
async function inbound(f, { id = 'first', parent, channel = 'support', failForward = false } = {}) {
 const bytes = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nPRIVATE_BODY_SENTINEL');
 await f.worker.email({ from: 'person@example.test', to: `${channel}@bigsoxstudios.com`, rawSize: bytes.length,
  raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  headers: new Headers({ Subject: 'Fixture support subject', 'Message-ID': `<${id}@example.test>`, ...(parent ? { 'In-Reply-To': `<${parent}@example.test>` } : {}) }),
  setReject() { assert.fail('fixture rejected'); }, async forward() { if (failForward) throw Error('private'); }
 }, { ...f.env, ENABLE_INBOUND_EMAIL: 'true', INBOUND_FORWARD_TO: 'owner@example.test' }, {});
 return rows(f, 'email_receipts').at(-1).case_id;
}
function server() {
 const calls = [], pages = [];
 const fetcher = async (url, init) => {
  const body = JSON.parse(init.body); calls.push({ url, init, body });
  assert.equal(new URL(url).origin, 'https://api.notion.com');
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, 'Bearer offline-test-placeholder');
  assert.equal(init.headers['Notion-Version'], '2025-09-03');
  assert.ok(init.signal instanceof AbortSignal);
  if (url.endsWith('/query')) {
   const source = url.split('/').at(-2), type = body.filter.title ? 'title' : 'rich_text';
   const found = pages.filter(p => p.parent.data_source_id === source && p.properties[body.filter.property]?.[type]?.[0]?.text.content === body.filter[type].equals);
   return Response.json({ results: found, has_more: false, next_cursor: null });
  }
  assert.equal(url, 'https://api.notion.com/v1/pages');
  const page = { object: 'page', id: crypto.randomUUID(), ...structuredClone(body) }; pages.push(page);
  return Response.json(page);
 };
 return { calls, pages, fetcher, creates: () => calls.filter(c => c.url.endsWith('/pages')) };
}

test('0003 upgrades populated 0002 additively and enforces activity keys/FKs/states', async t => {
 const f = await fixture(t); const id = await inbound(f); await f.seed();
 const tables = ['cases','messages','email_receipts','notion_links','sync_jobs','inbound_dedupe'];
 const before = tables.map(table => rows(f, table));
 f.DB.sqlite.exec(await readFile(new URL('../migrations/0003_notion_activity.sql', import.meta.url), 'utf8'));
 assert.deepEqual(tables.map(table => rows(f, table)), before);
 assert.equal(rows(f, 'email_receipt_messages').length, 0); // Never guess old receipt/message associations.
 const message = rows(f, 'messages')[0].id;
 f.DB.sqlite.prepare("INSERT INTO notion_activity_links VALUES (?, ?, NULL, 'creating', 1)").run(message, id);
 assert.throws(() => f.DB.sqlite.prepare("INSERT INTO notion_activity_links VALUES (?, ?, NULL, 'creating', 1)").run(message, id));
 assert.throws(() => f.DB.sqlite.prepare("UPDATE notion_activity_links SET state='pending'").run());
 assert.throws(() => f.DB.sqlite.prepare("UPDATE notion_activity_links SET case_id='missing'").run());
 assert.equal(f.DB.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
});
test('all off/no-token/stage gates precede D1 and network, including bound scheduled()', async () => {
 let calls = 0; const fetcher = () => { calls++; throw Error('unexpected network'); };
 const db = { prepare() { throw Error('unexpected database'); } };
 const worker = createWorker({ fetcher });
 for (const change of [{ NOTION_SYNC_MODE: undefined }, { NOTION_SYNC_MODE: 'mock' }, { NOTION_SYNC_MODE: 'LIVE' }, { NOTION_SYNC_MODE: 'off' }, { NOTION_API_TOKEN: undefined }, { NOTION_API_TOKEN: ' ' }, { DEPLOYMENT_STAGE: 'production' }, { DEPLOYMENT_STAGE: undefined },
  ...[undefined, null, '', ' ', ' 0', '0 ', '-1', '+1', '1.0', '1e3', '0x10', 'NaN', 'Infinity', '1\n', '9007199254740992', 0, 123].map(NOTION_SYNC_START_UNIX => ({ NOTION_SYNC_START_UNIX }))]) {
  const env = { ...enabled, ...change, DB: db };
  assert.equal((await runNotionSync(env, fetcher)).status, 'off');
  assert.equal((await syncSupportCase(db, env, 'anything', fetcher)).status, 'off');
  await assert.rejects(new LiveNotion(env, fetcher).findTicket({ channel: 'support', id: 'anything' }), /notion_disabled/);
  const pending = []; worker.scheduled({}, env, { waitUntil(p) { pending.push(p); } }); await Promise.all(pending);
 }
 assert.equal(calls, 0);
});
test('only forwarded exact support receipts qualify; synthetic/mock outbound never qualify', async t => {
 const f = await setup(t), s = server();
 await f.seed({ channel: 'support' });
 for (const channel of ['hello', 'members']) await inbound(f, { id: channel, channel });
 const uncertain = await inbound(f, { id: 'uncertain', failForward: true });
 await f.session(); const synthetic = rows(f, 'inbound_dedupe')[0].case_id; await f.send(synthetic, await f.review(synthetic));
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 0); assert.equal(s.calls.length, 0);
 for (const id of [synthetic, uncertain, ...rows(f, 'cases').filter(c => c.channel !== 'support').map(c => c.id)]) assert.equal((await syncSupportCase(f.DB, f.env, id, s.fetcher)).status, 'ineligible');
 for (const channel of ['Support','support@','members','hello']) await assert.rejects(new LiveNotion(enabled, s.fetcher).findTicket({ channel, id: synthetic }), /notion_disabled/);
 assert.equal(s.calls.length, 0);
});
test('new case exact mapping, two inbound messages => one ticket/two generic activities, mock send ignored', async t => {
 const f = await setup(t), s = server(), id = await inbound(f);
 await inbound(f, { id: 'reply', parent: 'first' });
 await f.session(); await f.send(id, await f.review(id));
 const jobs = rows(f, 'sync_jobs'), intents = rows(f, 'outbound_intents');
 const result = await runNotionSync(f.env, s.fetcher);
 assert.equal(result.processed, 1); assert.equal(result.activities, 2); assert.equal(result.unresolved, 0);
 const tickets = s.pages.filter(p => p.parent.data_source_id === DATA_SOURCE), activities = s.pages.filter(p => p.parent.data_source_id === ACTIVITY_SOURCE);
 assert.equal(tickets.length, 1); assert.equal(activities.length, 2);
 const c = rows(f, 'cases')[0], p = tickets[0].properties;
 assert.deepEqual(p, {
  Title: { title: [{ text: { content: c.subject } }] }, 'Ticket Family': { select: { name: 'Service Management' } },
  'Ticket Kind': { select: { name: 'Incident / Support' } }, Status: { select: { name: 'Inbox' } },
  'Request Channel': { select: { name: 'support@' } }, 'Requester Name': { rich_text: [{ text: { content: c.requester_name } }] },
  'Requester Email': { email: c.requester_email }, 'External Case ID': { rich_text: [{ text: { content: id } }] },
  'Membership Decision': { select: { name: 'Not applicable' } }, 'Reply State': { select: { name: 'Needs approval' } },
  'Assigned To': { select: { name: 'Greg' } }, Priority: { select: { name: 'Normal' } }, 'Project / System': { select: { name: 'Other' } }
 });
 for (const activity of activities) {
  assert.deepEqual(Object.keys(activity.properties), ['Event','Event Type','Author','Details','Ticket']);
  assert.equal(activity.properties['Event Type'].select.name, 'Work Note'); assert.equal(activity.properties.Author.select.name, 'System');
  assert.deepEqual(activity.properties.Ticket.relation, [{ id: tickets[0].id }]);
  assert.ok(rows(f, 'messages').some(m => activity.properties.Event.title[0].text.content === activityTitle(m.id)));
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_BODY_SENTINEL|person@example.test|Fixture support subject/);
 }
 assert.equal(rows(f, 'notion_activity_links').length, 2); assert.equal(rows(f, 'email_receipt_messages').length, 2);
 assert.deepEqual(rows(f, 'sync_jobs'), jobs); assert.deepEqual(rows(f, 'outbound_intents'), intents);
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 0); assert.equal(s.creates().length, 3);
});
test('existing closed ticket links without any workflow patch or create', async t => {
 const f = await setup(t), s = server(), id = await inbound(f), c = rows(f, 'cases')[0];
 const existing = { object: 'page', id: crypto.randomUUID(), ...ticketPayload(c) };
 Object.assign(existing.properties, { Status: { select: { name: 'Closed' } }, 'Assigned To': { select: { name: 'Other owner' } }, Reference: { rich_text: [] }, 'Notion Sequence': { number: 42 } });
 s.pages.push(existing); const before = structuredClone(existing);
 await syncSupportCase(f.DB, f.env, id, s.fetcher); assert.deepEqual(existing, before);
 assert.equal(s.creates().length, 1); assert.equal(s.creates()[0].body.parent.data_source_id, ACTIVITY_SOURCE);
});
test('concurrent schedulers/replays create each ticket and activity at most once', async t => {
 const f = await setup(t), s = server(); await inbound(f);
 await Promise.all(Array.from({ length: 12 }, () => runNotionSync(f.env, s.fetcher)));
 await runNotionSync(f.env, s.fetcher);
 assert.equal(s.creates().length, 2); assert.equal(rows(f, 'notion_links')[0].state, 'linked'); assert.equal(rows(f, 'notion_activity_links')[0].state, 'linked');
});
test('ambiguous ticket create persists UNKNOWN, never recreates on missing results, then reconciles', async t => {
 const f = await setup(t), s = server(); await inbound(f); let hide = false;
 const fetcher = async (url, init) => {
  if (hide && url.includes(DATA_SOURCE)) return Response.json({ results: [], has_more: false });
  const response = await s.fetcher(url, init);
  if (url.endsWith('/pages') && JSON.parse(init.body).parent.data_source_id === DATA_SOURCE) throw Error('response lost');
  return response;
 };
 await runNotionSync(f.env, fetcher); assert.equal(rows(f, 'notion_links')[0].state, 'UNKNOWN');
 ageBackoff(f); hide = true; await runNotionSync(f.env, fetcher); assert.equal(s.creates().length, 1);
 ageBackoff(f); hide = false; await runNotionSync(f.env, fetcher); assert.equal(rows(f, 'notion_links')[0].state, 'linked'); assert.equal(s.creates().length, 2);
});
test('ambiguous activity creates requery exact Event title and reconcile relation without retry', async t => {
 const f = await setup(t), s = server(); await inbound(f); let hide = false;
 const fetcher = async (url, init) => {
  if (hide && url.includes(ACTIVITY_SOURCE)) return Response.json({ results: [], has_more: false });
  const response = await s.fetcher(url, init);
  if (url.endsWith('/pages') && JSON.parse(init.body).parent.data_source_id === ACTIVITY_SOURCE) throw Error('lost');
  return response;
 };
 await runNotionSync(f.env, fetcher); assert.equal(rows(f, 'notion_activity_links')[0].state, 'UNKNOWN');
 ageBackoff(f); hide = true; await runNotionSync(f.env, fetcher); assert.equal(s.creates().length, 2);
 ageBackoff(f); hide = false; await runNotionSync(f.env, fetcher); assert.equal(rows(f, 'notion_activity_links')[0].state, 'linked');
 assert.equal(s.creates().length, 2);
 assert.ok(s.calls.some(c => c.body.filter?.property === 'Event' && c.body.filter.title.equals === activityTitle(rows(f, 'messages')[0].id)));
});
test('bounded scheduler processes <=5 cases and <=5 inbound activities across the batch', async t => {
 const f = await setup(t), s = server();
 for (let n = 0; n < 7; n++) await inbound(f, { id: `case${n}` });
 const result = await runNotionSync(f.env, s.fetcher); assert.equal(result.processed, 5); assert.equal(result.activities, 5);
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 2);
 assert.equal(rows(f, 'notion_links').length, 7);
});
test('new reply after linked ticket creates only its activity; many replies respect global activity bound', async t => {
 const f = await setup(t), s = server(); await inbound(f); await runNotionSync(f.env, s.fetcher);
 for (let n = 0; n < 7; n++) await inbound(f, { id: `reply${n}`, parent: 'first' });
 const result = await runNotionSync(f.env, s.fetcher); assert.equal(result.processed, 1); assert.equal(result.activities, 5);
 assert.equal((await runNotionSync(f.env, s.fetcher)).activities, 2);
 assert.equal(s.pages.filter(p => p.parent.data_source_id === DATA_SOURCE).length, 1);
 assert.equal(s.pages.filter(p => p.parent.data_source_id === ACTIVITY_SOURCE).length, 8);
});
test('zero-row activity claim transition cannot create; mismatched durable case refuses reconciliation', async t => {
 const f = await setup(t), s = server(), id = await inbound(f), other = await inbound(f, { id: 'other' });
 f.DB.sqlite.exec("CREATE TRIGGER skip_activity BEFORE UPDATE ON notion_activity_links BEGIN SELECT RAISE(IGNORE); END");
 await syncSupportCase(f.DB, f.env, id, s.fetcher);
 assert.equal(s.creates().length, 1); assert.equal(rows(f, 'notion_activity_links')[0].state, 'creating');
 f.DB.sqlite.exec('DROP TRIGGER skip_activity'); ageBackoff(f); f.DB.sqlite.prepare('UPDATE notion_activity_links SET case_id=?').run(other);
 const result = await syncSupportCase(f.DB, f.env, id, s.fetcher); assert.equal(result.unresolved, 1); assert.equal(s.creates().length, 1);
});
test('missing 0003 is a fixed unavailable result and never consumes existing jobs', async t => {
 const f = await fixture(t, { env: enabled }), s = server(); await inbound(f);
 assert.equal(rows(f, 'email_receipts')[0].forward_state, 'forwarded');
 const before = rows(f, 'sync_jobs'); assert.equal((await runNotionSync(f.env, s.fetcher)).status, 'unavailable');
 assert.deepEqual(rows(f, 'sync_jobs'), before); assert.equal(s.calls.length, 0);
});
test('bound scheduled handler runs through waitUntil; no HTTP sync route exists', async t => {
 const f = await setup(t), s = server(); await inbound(f);
 const pending = []; createWorker({ fetcher: s.fetcher }).scheduled({}, f.env, { waitUntil(p) { pending.push(p); } });
 assert.equal(pending.length, 1); await Promise.all(pending); assert.equal(s.creates().length, 2);
 assert.equal((await f.request('/api/notion-sync', undefined, { headers: { 'Cf-Access-Jwt-Assertion': null } })).status, 401);
 assert.equal((await f.request('/api/notion-sync')).status, 404);
 const config = await readFile(new URL('../wrangler.staging.toml', import.meta.url), 'utf8');
 assert.doesNotMatch(config, /crons\s*=|NOTION_API_TOKEN\s*=/); assert.match(config, /NOTION_SYNC_MODE = "off"/);
});

test('pagination finds second-page match; multiple matches and incomplete/repeated cursors refuse', async () => {
 const id = crypto.randomUUID(), c = { channel: 'support', id };
 const p = { object: 'page', id: crypto.randomUUID() };
 let calls = 0;
 const api = new LiveNotion(enabled, async (_, init) => {
  const body = JSON.parse(init.body); assert.equal(body.page_size, 2);
  if (++calls === 1) return Response.json({ results: [], has_more: true, next_cursor: 'next' });
  assert.equal(body.start_cursor, 'next'); return Response.json({ results: [p], has_more: false });
 });
 assert.deepEqual(await api.findTicket(c), [p]); assert.equal(calls, 2);
 for (const results of [[p, { ...p, id: crypto.randomUUID() }], [p, p]]) {
  await assert.rejects(new LiveNotion(enabled, async () => Response.json({ results, has_more: false })).findTicket(c), /duplicate/);
 }
 let n = 0;
 const duplicate = new LiveNotion(enabled, async (_, init) => {
  if (++n === 2) assert.equal(JSON.parse(init.body).page_size, 1);
  return Response.json({ results: [p], has_more: n === 1, next_cursor: 'x' });
 });
 await assert.rejects(duplicate.findTicket(c), /duplicate/);
 for (const next_cursor of [null, '', 'x']) {
  let count = 0;
  await assert.rejects(new LiveNotion(enabled, async () => { count++; return Response.json({ results: [], has_more: true, next_cursor }); }).findTicket(c), /incomplete/);
  assert.ok(count <= 2);
 }
});
test('duplicate matches/link conflict refuse without writes; missing linked page never recreates', async t => {
 const f = await setup(t), s = server(), id = await inbound(f), c = rows(f, 'cases')[0];
 const first = { object: 'page', id: crypto.randomUUID(), ...ticketPayload(c) }; s.pages.push(first, { ...first, id: crypto.randomUUID() });
 const jobs = rows(f, 'sync_jobs'); assert.equal((await runNotionSync(f.env, s.fetcher)).unresolved, 1);
 assert.equal(s.creates().length, 0); assert.equal(rows(f, 'notion_links').length, 0); assert.deepEqual(rows(f, 'sync_jobs'), jobs);
 s.pages.pop(); f.DB.sqlite.prepare("INSERT INTO notion_links VALUES (?,?,'linked',1)").run(id, crypto.randomUUID());
 await assert.rejects(syncSupportCase(f.DB, f.env, id, s.fetcher), /link_conflict/); assert.equal(s.creates().length, 0);
 s.pages.length = 0; assert.equal((await syncSupportCase(f.DB, f.env, id, s.fetcher)).status, 'UNKNOWN'); assert.equal(s.creates().length, 0);
});
test('activity relation conflict and duplicate titles refuse without recreating', async t => {
 const f = await setup(t), s = server(), id = await inbound(f); await runNotionSync(f.env, s.fetcher);
 f.DB.sqlite.exec("UPDATE notion_activity_links SET state='UNKNOWN'"); ageBackoff(f);
 const activity = s.pages[1]; activity.properties.Ticket.relation = [{ id: crypto.randomUUID() }];
 assert.equal((await runNotionSync(f.env, s.fetcher)).unresolved, 1); assert.equal(s.creates().length, 2);
 ageBackoff(f); activity.properties.Ticket.relation = [{ id: s.pages[0].id }]; s.pages.push({ ...activity, id: crypto.randomUUID() });
 assert.equal((await syncSupportCase(f.DB, f.env, id, s.fetcher)).unresolved, 1); assert.equal(s.creates().length, 2);
});
for (const status of [400, 429, 500, 301, 302, 303, 307, 308]) test(`API ${status}: query fails safely; create UNKNOWN never retries or completes jobs`, async t => {
 const f = await setup(t), s = server(); await inbound(f);
 const reject = async () => new Response('private response person@example.test offline-test-placeholder PRIVATE_BODY_SENTINEL', { status, headers: { Location: 'https://untrusted.example.test' } });
 const queryFailure = await runNotionSync(f.env, reject); assert.equal(queryFailure.unresolved, 1); assert.equal(rows(f, 'notion_links').length, 0);
 ageBackoff(f); let creates = 0;
 const fetcher = async (url, init) => url.endsWith('/pages') ? (creates++, reject()) : s.fetcher(url, init);
 await runNotionSync(f.env, fetcher); await runNotionSync(f.env, fetcher);
 assert.equal(creates, 1); assert.equal(rows(f, 'notion_links')[0].state, 'UNKNOWN'); assert.equal(rows(f, 'sync_jobs')[0].status, 'pending');
});
test('JSON limits, malformed responses and transport exceptions expose only fixed errors, never log secrets', async t => {
 const f = await setup(t); await inbound(f); const logs = [];
 for (const key of ['log','warn','error','info','debug']) t.mock.method(console, key, (...args) => logs.push(args));
 for (const make of [
  () => new Response('x'.repeat(262145)),
  () => new Response('{}', { headers: { 'Content-Length': '262145' } }),
  () => new Response('bad json PRIVATE_BODY_SENTINEL'),
  () => Response.json({ results: [{}], has_more: false }),
  () => Response.json({ results: [], has_more: 'false' }),
  () => { throw Error('offline-test-placeholder person@example.test PRIVATE_BODY_SENTINEL'); }
 ]) {
  ageBackoff(f); const result = await runNotionSync(f.env, async () => make());
  assert.equal(result.unresolved, 1); assert.doesNotMatch(JSON.stringify(result), /placeholder|example.test|PRIVATE_BODY/);
 }
 await assert.rejects(new LiveNotion(enabled, async () => { throw Error('private secret'); }).findTicket({ channel: 'support', id: 'id' }), { message: 'notion_request_failed' });
 assert.deepEqual(logs, []);
});
test('9s timeout bounds a hung transport without retries and leaves create UNKNOWN', async t => {
 const f = await setup(t), s = server(); await inbound(f); let entered = false, count = 0, signal;
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const fetcher = (url, init) => {
  if (url.endsWith('/pages')) { entered = true; count++; signal = init.signal; return new Promise(() => {}); }
  return s.fetcher(url, init);
 };
 const pending = runNotionSync(f.env, fetcher);
 while (!entered) await new Promise(resolve => setImmediate(resolve));
 t.mock.timers.tick(9000); await pending;
 assert.equal(signal.aborted, true); assert.equal(rows(f, 'notion_links')[0].state, 'UNKNOWN');
 await runNotionSync(f.env, fetcher); assert.equal(count, 1);
});
test('9s deadline also bounds a stalled JSON body, aborting the request', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] }); let entered = false, signal;
 const api = new LiveNotion(enabled, async (_, init) => {
  signal = init.signal; entered = true;
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }));
 });
 const pending = assert.rejects(api.findTicket({ channel: 'support', id: crypto.randomUUID() }), /notion_deadline/);
 while (!entered) await new Promise(resolve => setImmediate(resolve));
 t.mock.timers.tick(9000); await pending; assert.equal(signal.aborted, true);
});
test('successful HTTP with invalid create payload stays UNKNOWN without retries', async t => {
 const f = await setup(t), s = server(); await inbound(f); let creates = 0;
 const fetcher = async (url, init) => url.endsWith('/pages') ? (creates++, Response.json({ id: 'not-a-page-id' })) : s.fetcher(url, init);
 await runNotionSync(f.env, fetcher); await runNotionSync(f.env, fetcher);
 assert.equal(creates, 1); assert.equal(rows(f, 'notion_links')[0].state, 'UNKNOWN');
});
test('durable claim/UNKNOWN transition failure cannot create; finalization loss reconciles later', async t => {
 const f = await setup(t), s = server(), id = await inbound(f);
 f.DB.sqlite.exec("CREATE TRIGGER skip BEFORE UPDATE ON notion_links BEGIN SELECT RAISE(IGNORE); END");
 await runNotionSync(f.env, s.fetcher); assert.equal(s.creates().length, 0); assert.equal(rows(f, 'notion_links')[0].state, 'creating');
 f.DB.sqlite.exec('DROP TRIGGER skip'); await runNotionSync(f.env, s.fetcher); assert.equal(s.creates().length, 0);
 // Separate case: external success followed by failed durable linkage.
 const second = await inbound(f, { id: 'second' });
 f.DB.sqlite.exec("CREATE TRIGGER fail BEFORE UPDATE ON notion_links WHEN NEW.state='linked' BEGIN SELECT RAISE(ABORT,'private'); END");
 await syncSupportCase(f.DB, f.env, second, s.fetcher); assert.equal(s.creates().length, 1);
 f.DB.sqlite.exec('DROP TRIGGER fail'); ageBackoff(f); await syncSupportCase(f.DB, f.env, second, s.fetcher);
 assert.equal(rows(f, 'notion_links').find(l => l.case_id === second).state, 'linked'); assert.equal(s.creates().length, 2);
 assert.equal(rows(f, 'notion_links').find(l => l.case_id === id).state, 'creating');
});

test('activation cutoff accepts only exact nonnegative safe decimal seconds', () => {
 for (const value of ['0', '000', '123', '9007199254740991']) {
  assert.equal(syncStart({ NOTION_SYNC_START_UNIX: value }), Number(value));
  assert.equal(liveEnabled({ ...enabled, NOTION_SYNC_START_UNIX: value }), true);
 }
});

test('cutoff excludes historical canaries and exact-boundary receipts despite later forwarding/updates', async t => {
 const f = await setup(t), s = server(); f.env.NOTION_SYNC_START_UNIX = '1000';
 for (const [id, time] of [['historical-test', 999], ['at-cutoff', 1000], ['future-support', 1001]]) {
  const caseId = await inbound(f, { id });
  f.DB.sqlite.prepare('UPDATE email_receipts SET created_at=?,updated_at=9000 WHERE case_id=?').run(time, caseId);
  f.DB.sqlite.prepare('UPDATE messages SET created_at=? WHERE case_id=?').run(time, caseId);
  if (time <= 1000) assert.equal((await syncSupportCase(f.DB, f.env, caseId, s.fetcher)).status, 'ineligible');
 }
 assert.equal(s.calls.length, 0);
 const result = await runNotionSync(f.env, s.fetcher);
 assert.equal(result.processed, 1); assert.equal(result.activities, 1); assert.equal(s.creates().length, 2);
 assert.equal(rows(f, 'notion_links').length, 1); assert.equal(rows(f, 'notion_activity_links').length, 1);
});

test('new reply may create an older case ticket, but only post-cutover receipt AND message activity qualifies', async t => {
 const f = await setup(t), s = server(), caseId = await inbound(f);
 f.env.NOTION_SYNC_START_UNIX = '1000';
 f.DB.sqlite.exec('UPDATE cases SET created_at=10; UPDATE email_receipts SET created_at=999; UPDATE messages SET created_at=999');
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 0);
 // Different timestamp combinations also protect against a wrong/legacy message association.
 for (const [id, receiptTime, messageTime] of [['old-receipt', 1000, 1001], ['old-message', 1001, 1000], ['new-reply', 1001, 1001]]) {
  assert.equal(await inbound(f, { id, parent: 'first' }), caseId);
  const receipt = rows(f, 'email_receipts').at(-1);
  const message = rows(f, 'email_receipt_messages').find(r => r.receipt_key === receipt.receipt_key).message_id;
  f.DB.sqlite.prepare('UPDATE email_receipts SET created_at=? WHERE receipt_key=?').run(receiptTime, receipt.receipt_key);
  f.DB.sqlite.prepare('UPDATE messages SET created_at=? WHERE id=?').run(messageTime, message);
 }
 const result = await runNotionSync(f.env, s.fetcher);
 assert.equal(result.processed, 1); assert.equal(result.activities, 1); assert.equal(s.creates().length, 2);
 assert.equal(s.pages[0].properties['External Case ID'].rich_text[0].text.content, caseId);
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 0);
 assert.equal(rows(f, 'notion_activity_links').length, 1);
});

test('scheduler prioritizes new cases over due UNKNOWN, backs off one hour and never retries a create', async t => {
 t.mock.method(Date, 'now', () => 10000000);
 const f = await setup(t), s = server(), oldCases = [];
 for (let n = 0; n < 5; n++) {
  const id = await inbound(f, { id: `old${n}` }); oldCases.push(id);
  f.DB.sqlite.prepare("INSERT INTO notion_links VALUES (?,NULL,'UNKNOWN',1)").run(id);
 }
 const newCases = [];
 for (let n = 0; n < 5; n++) newCases.push(await inbound(f, { id: `new${n}` }));
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 5);
 assert.deepEqual(new Set(s.pages.filter(p => p.parent.data_source_id === DATA_SOURCE).map(p => p.properties['External Case ID'].rich_text[0].text.content)), new Set(newCases));
 assert.equal((await runNotionSync(f.env, s.fetcher)).unresolved, 5);
 const calls = s.calls.length;
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 0); assert.equal(s.calls.length, calls);
 assert.equal((await syncSupportCase(f.DB, f.env, oldCases[0], s.fetcher)).status, 'UNKNOWN'); assert.equal(s.calls.length, calls);
 t.mock.method(Date, 'now', () => (10000 + 3599) * 1000);
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 0);
 t.mock.method(Date, 'now', () => (10000 + 3600) * 1000);
 assert.equal((await runNotionSync(f.env, s.fetcher)).unresolved, 5);
 assert.equal(s.creates().length, 10); // Only the five new tickets and their activities.
});

test('five oldest read errors cannot starve later mail, and read backoff never becomes a create claim', async t => {
 const f = await setup(t), s = server();
 for (let n = 0; n < 5; n++) await inbound(f, { id: `bad${n}` });
 const failed = await runNotionSync(f.env, async () => { throw Error('private read failure'); });
 assert.equal(failed.processed, 5); assert.equal(failed.unresolved, 5);
 assert.equal(rows(f, 'notion_links').length, 0); assert.equal(rows(f, 'notion_sync_backoff').length, 5);
 await inbound(f, { id: 'later-mail' });
 assert.equal((await runNotionSync(f.env, s.fetcher)).activities, 1);
 assert.equal(s.creates().length, 2);
 ageBackoff(f); assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 5);
 assert.equal(s.creates().length, 12);
});

test('uncertain activity reads back off and cannot starve new activity after expiry', async t => {
 const f = await setup(t), s = server(), id = await inbound(f); await runNotionSync(f.env, s.fetcher);
 f.DB.sqlite.exec("UPDATE notion_activity_links SET state='UNKNOWN'");
 const calls = s.calls.length;
 assert.equal((await runNotionSync(f.env, s.fetcher)).processed, 0); assert.equal(s.calls.length, calls);
 await inbound(f, { id: 'new-reply', parent: 'first' });
 assert.equal((await runNotionSync(f.env, s.fetcher)).activities, 1);
 ageBackoff(f);
 assert.equal((await syncSupportCase(f.DB, f.env, id, s.fetcher)).activities, 1);
 assert.equal(s.creates().length, 3);
});

test('activity title and relation are both checked, including truncated or missing relations', async () => {
 const message = crypto.randomUUID(), ticket = crypto.randomUUID();
 for (const properties of [
  { Event: { title: [{ text: { content: 'wrong title' } }] }, Ticket: { relation: [{ id: ticket }] } },
  { Ticket: { relation: [{ id: ticket }] } },
  { Event: { title: [{ text: { content: activityTitle(message) } }] }, Ticket: { relation: [{ id: ticket }], has_more: true } },
  { Event: { title: [{ text: { content: activityTitle(message) } }] }, Ticket: { relation: [] } }
 ]) {
  const api = new LiveNotion(enabled, async () => Response.json({ results: [{ object: 'page', id: crypto.randomUUID(), properties }], has_more: false }));
  await assert.rejects(api.findActivity({ channel: 'support' }, message, ticket), /activity_conflict/);
 }
});

test('transport only accepts module-owned paths before any network', async () => {
 let calls = 0; const api = new LiveNotion(enabled, () => { calls++; assert.fail('unexpected transport'); });
 for (const path of ['https://evil.example.test', '//evil.example.test', '../users', 'pages?url=evil', 'data_sources/unknown/query'])
  await assert.rejects(api.request('support', path, {}), /invalid_path/);
 assert.equal(calls, 0);
});

test('owner session reports accurate live Notion configuration without exposing secret', async t => {
 const f = await fixture(t);
 const disabled = await f.session();
 assert.equal(disabled.v.notionSync, 'off');
 f.env.NOTION_SYNC_MODE = 'live';
 f.env.DEPLOYMENT_STAGE = 'staging';
 f.env.NOTION_API_TOKEN = 'fixture-secret-only';
 f.env.NOTION_SYNC_START_UNIX = '0';
 const enabled = await f.session();
 assert.equal(enabled.v.notionSync, 'live');
 assert.ok(!JSON.stringify(enabled.v).includes('fixture-secret-only'));
 f.env.NOTION_SYNC_START_UNIX = 'invalid';
 assert.equal((await f.session()).v.notionSync, 'off');
});

test('failed real Notion lookups audit only a bounded HTTP category, not response bodies', async t => {
 const f = await setup(t); await inbound(f);
 const fetcher = async () => new Response('PRIVATE_BODY_SENTINEL person@example.test', {status:403});
 const result = await runNotionSync(f.env, fetcher);
 assert.equal(result.unresolved, 1);
 const logs = rows(f, 'audit_events').filter(v => v.event.startsWith('notion_sync_'));
 assert.equal(logs.length,1);
 assert.equal(logs[0].event,'notion_sync_notion_http_403');
 assert.ok(!JSON.stringify(logs).includes('PRIVATE_BODY_SENTINEL'));
 assert.equal(rows(f,'notion_links').length,0);
});

test('Notion JSON and response-schema errors remain non-sensitive diagnostic categories', async t => {
 for (const [content,expected] of [
  ['this is not JSON','notion_sync_notion_json_invalid'],
  ['{"results":"wrong shape","has_more":false}', 'notion_sync_notion_invalid_query']
 ]) {
  const f = await setup(t); await inbound(f);
  const fake = async () => new Response(content,{status:200,headers:{'Content-Type':'application/json'}});
  assert.equal((await runNotionSync(f.env, fake)).unresolved,1);
  const logs=rows(f,'audit_events').filter(v=>v.event.startsWith('notion_sync_'));
  assert.equal(logs.length,1);
  assert.equal(logs[0].event,expected);
  assert.ok(!JSON.stringify(logs).includes(content));
  assert.equal(rows(f,'notion_links').length,0);
 }
});

test('Notion token is whitespace-trimmed before its request header without leaking it', async t => {
 const f=await setup(t),s=server();await inbound(f);
 f.env.NOTION_API_TOKEN='\n  fixture-secret-only  \r\n';
 const seen=[];
 const wrapped=(url,init)=>{
  seen.push(init.headers.Authorization);
  return s.fetcher(url,{...init,headers:{...init.headers,Authorization:'Bearer offline-test-placeholder'}});
 };
 const result=await runNotionSync(f.env,wrapped);
 assert.equal(result.unresolved,0);
 assert.equal(rows(f,'notion_links')[0].state,'linked');
 assert.ok(seen.length>=2 && seen.every(value=>value==='Bearer fixture-secret-only'));
});
test('transport TypeError is reported by stage without leaking exception contents', async t => {
 const f=await setup(t);await inbound(f);
 const fetcher=async()=>{throw new TypeError('private token PRIVATE_BODY_SENTINEL');};
 assert.equal((await runNotionSync(f.env,fetcher)).unresolved,1);
 const logs=rows(f,'audit_events').filter(x=>x.event.startsWith('notion_sync_'));
 assert.equal(logs.length,1);
 assert.equal(logs[0].event,'notion_sync_notion_transport_fetch_type');
 assert.ok(!JSON.stringify(logs).includes('PRIVATE_BODY_SENTINEL'));
});

test('Cloudflare Workers native fetch must be called without an object receiver', async () => {
 let received = 0;
 function strictWorkerdFetch(url, init) {
  assert.equal(this, undefined, 'using this.fetcher() triggers workerd Illegal invocation');
  received++;
  assert.equal(url, 'https://api.notion.com/v1/data_sources/' + DATA_SOURCE + '/query');
  assert.equal(init.method, 'POST');
  return Promise.resolve(Response.json({results:[],has_more:false,next_cursor:null}));
 }
 const result = await new LiveNotion(enabled, strictWorkerdFetch).findTicket({channel:'support', id:crypto.randomUUID()});
 assert.deepEqual(result, []);
 assert.equal(received, 1);
});
