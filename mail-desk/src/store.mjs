import { requireThat } from './security.mjs';
export const now = () => Math.floor(Date.now() / 1000);
export const senders = Object.freeze({ members: 'members@bigsoxstudios.com', support: 'support@bigsoxstudios.com', hello: 'hello@bigsoxstudios.com' });
export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
export async function audit(db, event, caseId = null, intentId = null) {
 await stmt(db, 'INSERT INTO audit_events VALUES (?,?,?,?,?)', crypto.randomUUID(), event, caseId, intentId, now()).run();
}
export async function rateLimit(db, session) {
 const time = now();
 const row = await stmt(db, `INSERT INTO rate_limits(bucket,count,expires_at) VALUES (?,1,?)
 ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
 expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
 RETURNING count`, session, time + 60, time, time).first();
 requireThat(row.count <= 30, 429, 'rate_limited');
}
export async function getCase(db, id) {
 const row = await stmt(db, 'SELECT * FROM cases WHERE id=?', id).first();
 requireThat(row, 404, 'case_not_found'); return row;
}
export async function saveDraft(db, id, data) {
 requireThat(Number.isSafeInteger(data.revision) && typeof data.body === 'string' && data.body.trim().length > 0 && data.body.length <= 10000);
 const row = await stmt(db, `UPDATE cases SET draft=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?
 AND NOT EXISTS(SELECT 1 FROM outbound_intents WHERE case_id=? AND status IN ('dispatching','UNKNOWN')) RETURNING *`, data.body, now(), id, data.revision, id).first();
 requireThat(row, 409, 'revision_or_delivery_conflict'); await audit(db, 'draft_saved', id); return row;
}
export async function reserveReview(db, id, revision, session) {
 const c = await getCase(db, id); requireThat(c.revision === revision && c.draft.trim(), 409, 'revision_conflict');
 const time = now();
 await stmt(db, `INSERT INTO outbound_intents(id,case_id,revision,recipient,sender,subject,body,session_hash,approval_expires,status,created_at,updated_at)
 SELECT ?,id,revision,requester_email,?,subject,draft,?,?,'reserved',?,? FROM cases WHERE id=? AND revision=?
 AND NOT EXISTS(SELECT 1 FROM outbound_intents WHERE case_id=? AND status IN ('dispatching','UNKNOWN'))
 ON CONFLICT(case_id,revision) DO NOTHING`, crypto.randomUUID(), senders[c.channel], session, time + 600, time, time, id, revision, id).run();
 const intent = await stmt(db, 'SELECT * FROM outbound_intents WHERE case_id=? AND revision=?', id, revision).first();
 requireThat(intent && intent.session_hash === session && intent.status === 'reserved' && intent.approval_expires > time, 409, 'review_conflict');
 await audit(db, 'reviewed', id, intent.id); return intent;
}
export async function claimSend(db, intent) {
 const time = now();
 // One atomic compare-and-set: concurrent requests and old reviews cannot dispatch.
 return stmt(db, `UPDATE outbound_intents SET status='dispatching',updated_at=? WHERE id=? AND status='reserved'
 AND case_id=? AND revision=? AND recipient=? AND sender=? AND subject=? AND body=? AND session_hash=? AND approval_expires=?
 AND approval_expires>? AND EXISTS(SELECT 1 FROM cases c WHERE c.id=outbound_intents.case_id AND c.revision=outbound_intents.revision
 AND c.requester_email=outbound_intents.recipient AND c.subject=outbound_intents.subject AND c.draft=outbound_intents.body
 AND outbound_intents.sender=CASE c.channel WHEN 'members' THEN 'members@bigsoxstudios.com' WHEN 'support' THEN 'support@bigsoxstudios.com' WHEN 'hello' THEN 'hello@bigsoxstudios.com' END)
 AND NOT EXISTS(SELECT 1 FROM outbound_intents o WHERE o.case_id=outbound_intents.case_id AND o.id<>outbound_intents.id AND o.status IN ('dispatching','UNKNOWN')) RETURNING *`, time, intent.id, intent.case_id, intent.revision, intent.recipient, intent.sender, intent.subject, intent.body, intent.session_hash, intent.approval_expires, time).first();
}
export async function finalize(db, intent, result) {
 requireThat(['sent','failed','UNKNOWN'].includes(result.status), 500, 'provider_contract');
 const time = now();
 // D1 batch is transactional: sent, outbound thread, sync job and audit commit together.
 await db.batch([
  stmt(db, `INSERT INTO messages(id,case_id,direction,body,created_at,intent_id) SELECT ?,case_id,'outbound',body,?,id FROM outbound_intents WHERE id=? AND status='dispatching' AND ?='sent'`, crypto.randomUUID(), time, intent.id, result.status),
  stmt(db, `INSERT INTO sync_jobs(id,case_id,intent_id,next_attempt,created_at) SELECT ?,case_id,id,?,? FROM outbound_intents WHERE id=? AND status='dispatching' AND ?='sent'`, crypto.randomUUID(), time, time, intent.id, result.status),
  stmt(db, `INSERT INTO audit_events SELECT ?,?,case_id,id,? FROM outbound_intents WHERE id=? AND status='dispatching'`, crypto.randomUUID(), `delivery_${result.status}`, time, intent.id),
  stmt(db, `UPDATE outbound_intents SET status=?,provider_id=?,updated_at=? WHERE id=? AND status='dispatching'`, result.status, result.id ?? null, time, intent.id)
 ]);
}
export async function recoverUncertain(db, cutoff = now() - 300) {
 // Never reclaim or resend a dispatch. Crash recovery only moves forward to UNKNOWN.
 await stmt(db, `UPDATE outbound_intents SET status='UNKNOWN',updated_at=? WHERE status='dispatching' AND updated_at<?`, now(), cutoff).run();
}
