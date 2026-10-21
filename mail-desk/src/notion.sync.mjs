import { syncFolders } from './folders.sync.mjs';
import { stmt, now, senders, audit } from './store.mjs';
import { LiveNotion, liveEnabled, syncStart } from './notion.live.mjs';

// A receipt is the authority for live intake; synthetic records and mock sends
// cannot become eligible through a sync_jobs row or an environment flag.
const BACKOFF_SECONDS = 3600;
const eligible = `c.channel='support'
 AND NOT EXISTS(SELECT 1 FROM inbound_dedupe d WHERE d.case_id=c.id)
 AND EXISTS(SELECT 1 FROM email_receipts r WHERE r.case_id=c.id
 AND r.envelope_to=? AND r.forward_state='forwarded' AND r.created_at>?)`;
async function eligibleCase(db, caseId, start) {
 return stmt(db, `SELECT c.* FROM cases c WHERE c.id=? AND ${eligible}`, caseId, senders.support, start).first();
}
const inboundMessages = `SELECT m.id FROM messages m
 JOIN email_receipt_messages rm ON rm.message_id=m.id
 JOIN email_receipts r ON r.receipt_key=rm.receipt_key AND r.case_id=m.case_id
 LEFT JOIN notion_activity_links a ON a.message_id=m.id
 WHERE m.case_id=? AND m.direction='inbound' AND r.envelope_to=?
 AND r.forward_state='forwarded' AND r.created_at>? AND m.created_at>?
 AND (a.state IS NULL OR (a.state<>'linked' AND a.updated_at<=?))
 ORDER BY m.created_at,m.id LIMIT ?`;

// Table/key names are module-owned constants, never derived from API/input.
async function reconcile(db, table, key, id, caseId, find, create) {
 const old = await stmt(db, `SELECT * FROM ${table} WHERE ${key}=?`, id).first();
 if (old && key === 'message_id' && old.case_id !== caseId) throw Error('notion_link_conflict');
 if (old && old.state !== 'linked') {
  if (old.updated_at > now() - BACKOFF_SECONDS) return { status: 'UNKNOWN' };
  // Read reconciliation only; refreshing uncertainty never grants another create.
  await stmt(db, `UPDATE ${table} SET updated_at=? WHERE ${key}=? AND state<>'linked'`, now(), id).run();
 }
 const found = await find(); // Query errors never authorize a create.
 if (found.length > 1) throw Error('notion_duplicate_matches');
 if (found.length) {
  const page = found[0];
  if (old?.page_id && old.page_id !== page.id) throw Error('notion_link_conflict');
  const columns = key === 'case_id' ? 'case_id,page_id,state,updated_at' : 'message_id,case_id,page_id,state,updated_at';
  const values = key === 'case_id' ? [id, page.id, now()] : [id, caseId, page.id, now()];
  const placeholders = key === 'case_id' ? "?,?,'linked',?" : "?,?,?,'linked',?";
  const linked = await stmt(db, `INSERT INTO ${table} (${columns}) VALUES (${placeholders})
   ON CONFLICT(${key}) DO UPDATE SET page_id=excluded.page_id,state='linked',updated_at=excluded.updated_at
   WHERE (${table}.page_id IS NULL OR ${table}.page_id=excluded.page_id)
   RETURNING page_id`, ...values).first();
  if (!linked || linked.page_id !== page.id) throw Error('notion_link_conflict');
  return { status: 'linked', pageId: page.id };
 }
 if (old) {
  // A previously linked but now invisible page must also back off, preserving its ID.
  await stmt(db, `UPDATE ${table} SET state='UNKNOWN',updated_at=? WHERE ${key}=?`, now(), id).run();
  return { status: 'UNKNOWN' };
 }
 const columns = key === 'case_id' ? 'case_id,page_id,state,updated_at' : 'message_id,case_id,page_id,state,updated_at';
 const values = key === 'case_id' ? [id, now()] : [id, caseId, now()];
 const placeholders = key === 'case_id' ? "?,NULL,'creating',?" : "?,?,NULL,'creating',?";
 const claim = await stmt(db, `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON CONFLICT(${key}) DO NOTHING RETURNING ${key}`, ...values).first();
 if (!claim) return { status: 'UNKNOWN' };
 // Persist uncertainty BEFORE external side effect; a crash never grants a retry.
 const uncertain = await stmt(db, `UPDATE ${table} SET state='UNKNOWN',updated_at=? WHERE ${key}=? AND state='creating' RETURNING ${key}`, now(), id).first();
 if (!uncertain) return { status: 'UNKNOWN' };
 try {
  const page = await create();
  const linked = await stmt(db, `UPDATE ${table} SET page_id=?,state='linked',updated_at=?
   WHERE ${key}=? AND (page_id IS NULL OR page_id=?) RETURNING page_id`, page.id, now(), id, page.id).first();
  if (!linked) return { status: 'UNKNOWN' };
  return { status: 'linked', pageId: page.id };
 } catch { return { status: 'UNKNOWN' }; }
}

export async function syncSupportCase(db, env, caseId, fetcher = fetch, activityLimit = 5) {
 if (!liveEnabled(env)) return { status: 'off', activities: 0 };
 const c = await eligibleCase(db, caseId, syncStart(env));
 if (!c) return { status: 'ineligible', activities: 0 };
 const api = new LiveNotion(env, fetcher);
 const ticket = await reconcile(db, 'notion_links', 'case_id', c.id, c.id,
  () => api.findTicket(c), () => api.createTicket(c));
 if (ticket.status !== 'linked') return { ...ticket, activities: 0 };
 const limit = Number.isInteger(activityLimit) ? Math.max(0, Math.min(5, activityLimit)) : 0;
 const messages = (await stmt(db, inboundMessages, c.id, senders.support, syncStart(env), syncStart(env), now() - BACKOFF_SECONDS, limit).all()).results;
 let activities = 0, unresolved = 0;
 for (const message of messages) {
  try {
   const result = await reconcile(db, 'notion_activity_links', 'message_id', message.id, c.id,
    () => api.findActivity(c, message.id, ticket.pageId), () => api.createActivity(c, message.id, ticket.pageId));
   if (result.status === 'linked') activities++; else unresolved++;
  } catch { unresolved++; }
 }
 return { ...ticket, activities, attempted: messages.length, unresolved };
}

async function deferCase(db, caseId) {
 await stmt(db, `INSERT INTO notion_sync_backoff VALUES (?,?) ON CONFLICT(case_id)
  DO UPDATE SET updated_at=excluded.updated_at`, caseId, now()).run();
}

export async function runNotionSync(env, fetcher = fetch) {
 if (!liveEnabled(env)) return { status: 'off', processed: 0, activities: 0, unresolved: 0 };
 try {
  // Durable links form this queue. Existing mock jobs are never consumed/marked done.
  const cases = (await stmt(env.DB, `SELECT c.id FROM cases c
   LEFT JOIN notion_links l ON l.case_id=c.id
   LEFT JOIN notion_sync_backoff b ON b.case_id=c.id WHERE ${eligible}
   AND (b.case_id IS NULL OR b.updated_at<=?)
   AND (l.state IS NULL OR l.state='linked' OR l.updated_at<=?)
   AND (l.state IS NULL OR l.state<>'linked' OR EXISTS(
    SELECT 1 FROM messages m JOIN email_receipt_messages rm ON rm.message_id=m.id
    JOIN email_receipts r ON r.receipt_key=rm.receipt_key AND r.case_id=m.case_id
    LEFT JOIN notion_activity_links a ON a.message_id=m.id
    WHERE m.case_id=c.id AND m.direction='inbound' AND r.envelope_to=?
    AND r.forward_state='forwarded' AND r.created_at>? AND m.created_at>?
 AND (a.state IS NULL OR (a.state<>'linked' AND a.updated_at<=?))))
   ORDER BY CASE WHEN l.state IS NULL THEN 0 WHEN l.state='linked' THEN 1 ELSE 2 END,c.updated_at,c.id LIMIT 5`,
   senders.support, syncStart(env), now() - BACKOFF_SECONDS, now() - BACKOFF_SECONDS,
   senders.support, syncStart(env), syncStart(env), now() - BACKOFF_SECONDS).all()).results;
  let activities = 0, attempted = 0, unresolved = 0;
  for (const c of cases) {
   try {
    const result = await syncSupportCase(env.DB, env, c.id, fetcher, 5 - attempted);
    activities += result.activities; attempted += result.attempted ?? 0;
    if (result.unresolved > 0) await deferCase(env.DB, c.id);
    unresolved += result.unresolved ?? (result.status === 'linked' ? 0 : 1);
   } catch (error) {
    unresolved++;
    // Only a fixed error category in the private audit log; never any response or PII.
    const category = /^(?:notion_http_(?:400|401|403|404|409|422|429|500|502|503|504|other)|notion_(?:invalid_query|incomplete_query|duplicate_matches|invalid_source|activity_conflict|link_conflict|json_invalid|json_oversize|json_empty|deadline|transport_abort|transport_type|credential_format|transport_fetch_type|transport_body_type))$/.test(error?.message)
     ? error.message : 'notion_request_failed';
    try { await audit(env.DB, 'notion_sync_' + category, c.id); } catch { /* Fail closed without logging customer data. */ }
    // A failed read on an unclaimed case must not monopolize the oldest slots.
    await deferCase(env.DB, c.id);
   }
  }
  const folderSync = await syncFolders(env, fetcher);
  return { folderSync, status: unresolved || folderSync.unresolved ? 'partial' : 'complete', processed: cases.length, activities, unresolved };
 } catch { return { status: 'unavailable', processed: 0, activities: 0, unresolved: 1 }; }
}
