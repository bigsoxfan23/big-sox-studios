// Conservative lossless header policy for a FUTURE authenticated ingress adapter.
// Existing Headers.get()/normalized receipt hints cannot establish this evidence.
import { requireThat } from './security.mjs';
import { mailbox, messageId } from './inbound.mjs';
import { stmt, senders } from './store.mjs';
export function parseVerifiedHeaders(pairs, envelopeFrom) {
 requireThat(Array.isArray(pairs) && pairs.length <= 100, 409, 'unsafe_headers');
 const headers = new Map(); let size = 0;
 for (const pair of pairs) {
  requireThat(Array.isArray(pair) && pair.length === 2 && pair.every(x => typeof x === 'string'), 409, 'unsafe_headers');
  const [name, value] = pair; size += name.length + value.length;
  // eslint-disable-next-line no-control-regex -- Reject folded/control-bearing headers instead of repairing ambiguity.
  requireThat(/^[A-Za-z0-9-]+$/.test(name) && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value) && size <= 32768, 409, 'unsafe_headers');
  const key = name.toLowerCase();
  requireThat(!headers.has(key), 409, 'ambiguous_headers'); headers.set(key, value);
 }
 requireThat(mailbox(envelopeFrom) && headers.get('from') === envelopeFrom && headers.get('to') === senders.support &&
  (!headers.has('reply-to') || headers.get('reply-to') === envelopeFrom), 409, 'conflicting_headers');
 const parent = headers.get('message-id'), reply = headers.get('in-reply-to') ?? null;
 requireThat(messageId(parent) && (reply === null || messageId(reply)), 409, 'unsafe_thread');
 const raw = headers.get('references');
 const refs = raw === undefined ? [] : raw.split(' ');
 requireThat(refs.length <= 19 && refs.every(messageId) && new Set(refs).size === refs.length &&
  !refs.includes(parent) && reply !== parent && (!reply || refs.length === 0 || refs.at(-1) === reply) &&
  [...refs, parent].join(' ').length <= 4096, 409, 'unsafe_thread');
 return { parent, reply, refs };
}
export async function loadEligible(db, caseId, cutoff, verifyEvidence) {
 const c = await stmt(db, 'SELECT *,instr(draft,char(0)) AS draft_nul,instr(subject,char(0)) AS subject_nul FROM cases WHERE id=?', caseId).first();
 // Some SQLite bindings truncate returned TEXT at NUL; check the stored bytes in SQL.
 requireThat(c?.draft_nul === 0 && c?.subject_nul === 0, 409, 'unsafe_stored_text');
 requireThat(c?.channel === 'support' && mailbox(c.requester_email), 409, 'support_only');
 requireThat(!await stmt(db, 'SELECT 1 FROM inbound_dedupe WHERE case_id=?', caseId).first(), 409, 'synthetic_inbound');
 // Never silently fall back to an older verified message. Equal latest timestamps
 // are ambiguous; independently ordered ingress timestamps are a future requirement.
 const latest = (await stmt(db, `SELECT * FROM messages WHERE case_id=? AND direction='inbound'
 AND created_at=(SELECT MAX(created_at) FROM messages WHERE case_id=? AND direction='inbound')`, caseId, caseId).all()).results;
 requireThat(latest.length === 1, 409, 'ambiguous_inbound');
 const m = latest[0];
 const rows = (await stmt(db, `SELECT r.*,p.evidence_json,p.signature,p.policy,p.message_id AS mapped_message_id
 FROM email_receipt_messages rm JOIN email_receipts r ON r.receipt_key=rm.receipt_key
 JOIN outbound_provenance p ON p.receipt_key=r.receipt_key AND p.message_id=rm.message_id
 WHERE rm.message_id=? AND r.case_id=?`, m.id, caseId).all()).results;
 requireThat(rows.length === 1, 409, 'missing_provenance');
 const r = rows[0];
 requireThat(r.envelope_to === senders.support && r.envelope_from === c.requester_email &&
 r.forward_state === 'forwarded' && r.created_at > cutoff && m.created_at > cutoff, 409, 'ineligible_receipt');
 requireThat(r.evidence_json.length <= 40000 && await verifyEvidence(r), 409, 'unverified_ingress');
 const e = JSON.parse(r.evidence_json);
 // A verified signature is necessary but insufficient: bind every authenticated
 // attribute to the persisted receipt and mapped message, including raw header set.
 requireThat(e.policy === 'maildesk-ingress-v1' && e.receiptKey === r.receipt_key && e.caseId === caseId &&
 e.messageId === m.id && e.envelopeFrom === r.envelope_from && e.envelopeTo === r.envelope_to &&
 e.receivedAt === r.created_at && e.messageCreatedAt === m.created_at &&
 e.dmarc === 'pass' && e.authenticatedMailbox === r.envelope_from && e.headerIntegrity === true &&
 typeof e.verifierEvent === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(e.verifierEvent), 409, 'provenance_mismatch');
 requireThat((await stmt(db, 'SELECT COUNT(*) AS n FROM email_receipts WHERE envelope_from=? AND envelope_to=? AND message_id=?', r.envelope_from, r.envelope_to, r.message_id).first()).n === 1, 409, 'ambiguous_message_id');
 const thread = parseVerifiedHeaders(e.rawHeaders, r.envelope_from);
 requireThat(thread.parent === r.message_id && thread.reply === r.in_reply_to &&
 JSON.stringify(thread.refs) === r.references_json, 409, 'thread_mismatch');
 // Each ancestor must itself have independently verified evidence, exact envelope,
 // same case and a mapped inbound message. No unchecked arbitrary References.
 for (const id of [...new Set([...thread.refs, ...(thread.reply ? [thread.reply] : [])])]) {
  const parents = (await stmt(db, `SELECT r.*,p.evidence_json,p.signature,p.policy,p.message_id AS mapped_message_id,m.created_at AS mapped_created_at
   FROM email_receipts r JOIN email_receipt_messages rm ON rm.receipt_key=r.receipt_key
   JOIN messages m ON m.id=rm.message_id AND m.case_id=r.case_id AND m.direction='inbound'
   JOIN outbound_provenance p ON p.receipt_key=r.receipt_key AND p.message_id=m.id
   WHERE r.message_id=? AND r.case_id=? AND r.envelope_from=? AND r.envelope_to=? AND r.forward_state='forwarded'`,
   id, caseId, r.envelope_from, r.envelope_to).all()).results;
  requireThat(parents.length === 1 && parents[0].created_at > cutoff && parents[0].created_at < r.created_at &&
   parents[0].evidence_json.length <= 40000 && await verifyEvidence(parents[0]), 409, 'unverified_ancestor');
  const a = JSON.parse(parents[0].evidence_json);
  const ancestorThread = parseVerifiedHeaders(a.rawHeaders, r.envelope_from);
  requireThat(a.policy === 'maildesk-ingress-v1' && a.receiptKey === parents[0].receipt_key && a.caseId === caseId && a.messageId === parents[0].mapped_message_id &&
   a.envelopeFrom === r.envelope_from && a.envelopeTo === r.envelope_to && a.receivedAt === parents[0].created_at &&
   a.dmarc === 'pass' && a.authenticatedMailbox === r.envelope_from && a.headerIntegrity === true &&
   a.messageCreatedAt > cutoff && a.messageCreatedAt === parents[0].mapped_created_at && ancestorThread.parent === id &&
   JSON.stringify(ancestorThread.refs) === parents[0].references_json && ancestorThread.reply === parents[0].in_reply_to, 409, 'unverified_ancestor');
 }
 return { c, m, r, thread };
}
