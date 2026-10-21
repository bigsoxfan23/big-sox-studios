// Isolated candidate. Production has no ingress verifier or live transport authority.
// Only the offline factory below can exercise the coordinator, using .test data.
import { authenticate, unb64, requireThat, HttpError, sessionProof, protectPost, readJson, mac, verifyMac } from './security.mjs';
import { stmt, now, senders, rateLimit } from './store.mjs';
import { loadEligible } from './outbound.provenance.mjs';
import { rehearseResend } from './resend.future.mjs';
const PURPOSE = 'maildesk-live-review-v2';
const approvalValue = (i, phase) => JSON.stringify([PURPOSE, phase, i.id, i.case_id, i.receipt_key, i.message_id,
 i.revision, i.snapshot_json, i.session_hash, i.approval_expires]);
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: {
 'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'", ...extra } });
function gates(env) {
 requireThat(env.DEPLOYMENT_STAGE === 'production' && env.SEND_MODE === 'live' && env.ALLOW_REAL_SEND === 'true' &&
 typeof env.RESEND_API_KEY === 'string' && /^[\x21-\x7e]{1,1024}$/.test(env.RESEND_API_KEY) &&
 typeof env.LIVE_APPROVAL_SECRET === 'string' && env.LIVE_APPROVAL_SECRET.length >= 32 &&
 env.LIVE_APPROVAL_SECRET !== env.CSRF_SECRET && typeof env.OUTBOUND_START_UNIX === 'string' &&
 /^[0-9]+$/.test(env.OUTBOUND_START_UNIX) && Number.isSafeInteger(Number(env.OUTBOUND_START_UNIX)), 503, 'live_gates_closed');
}
function allowlists(env, s) {
 for (const [key, address] of [['OUTBOUND_SENDER_ALLOWLIST',s.sender],['OUTBOUND_RECIPIENT_ALLOWLIST',s.recipient]]) {
  let list; try { list = JSON.parse(env[key]); } catch { /* Deny below. */ }
  requireThat(Array.isArray(list) && list.length === 1 && list[0] === address, 503, 'canary_allowlist_required');
 }
 requireThat(s.sender === senders.support && s.recipient === env.OWNER_EMAIL, 503, 'owner_canary_only');
}
function snapshot({ c, m, r, thread }, id, session, expires) {
 return { purpose:PURPOSE, id, caseId:c.id, revision:c.revision, session, expires,
  receiptKey:r.receipt_key, messageId:m.id, envelopeFrom:r.envelope_from, envelopeTo:r.envelope_to,
  receivedAt:r.created_at, messageCreatedAt:m.created_at, forwardState:r.forward_state,
  inboundBody:m.body, receiptClaim:r.claim_token, provenance:r.evidence_json, provenanceSignature:r.signature,
  provenancePolicy:r.policy, inboundMessageId:thread.parent, inboundInReplyTo:thread.reply, inboundReferences:thread.refs,
  sender:senders.support, recipient:r.envelope_from, subject:c.subject, body:c.draft,
  inReplyTo:thread.parent, references:[...thread.refs, thread.parent] };
}
function validateContent(s) {
 // eslint-disable-next-line no-control-regex -- Plain-text bodies allow newlines but no other hidden control characters.
 requireThat(typeof s.body === 'string' && s.body.trim() && s.body.length <= 10000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s.body), 409, 'unsafe_body');
 // eslint-disable-next-line no-control-regex -- Header injection prevention.
 requireThat(typeof s.subject === 'string' && s.subject.trim() && s.subject.length <= 200 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(s.subject), 409, 'unsafe_subject');
}
async function schema(db) {
 requireThat(await stmt(db, "SELECT name FROM sqlite_master WHERE type='trigger' AND name='live_review_transition'").first(), 503, 'migration_0004_required');
}
const noConflict = `NOT EXISTS(SELECT 1 FROM live_outbound_reviews l WHERE l.case_id=c.id AND l.status IN ('dispatching','UNKNOWN'))
 AND NOT EXISTS(SELECT 1 FROM outbound_intents o WHERE o.case_id=c.id AND (o.status IN ('dispatching','UNKNOWN') OR o.revision=c.revision))`;
async function current(db, env, i, verifyEvidence) {
 const eligible = await loadEligible(db, i.case_id, Number(env.OUTBOUND_START_UNIX), verifyEvidence);
 const expected = snapshot(eligible, i.id, i.session_hash, i.approval_expires);
 requireThat(JSON.stringify(expected) === i.snapshot_json, 409, 'stale_review');
 validateContent(expected); allowlists(env, expected); return expected;
}
// The UPDATE predicates independently compare current case/message selection at the
// atomic D1 write boundary. Provenance sources are frozen by 0004 DB triggers.
async function transition(db, i, from, to) {
 return stmt(db, `UPDATE live_outbound_reviews SET status=?,updated_at=?
 WHERE id=? AND status=? AND snapshot_json=? AND session_hash=? AND approval_expires>?
 AND EXISTS(SELECT 1 FROM cases c JOIN messages m ON m.case_id=c.id
 WHERE c.id=live_outbound_reviews.case_id AND c.revision=live_outbound_reviews.revision
 AND EXISTS(SELECT 1 FROM case_folders f WHERE f.case_id=c.id AND f.folder<>'trash')
 AND c.channel='support' AND c.requester_email=json_extract(snapshot_json,'$.recipient')
 AND c.subject=json_extract(snapshot_json,'$.subject') AND c.draft=json_extract(snapshot_json,'$.body')
 AND m.id=live_outbound_reviews.message_id AND m.direction='inbound'
 AND NOT EXISTS(SELECT 1 FROM messages newer WHERE newer.case_id=c.id AND newer.direction='inbound'
 AND newer.id<>m.id AND newer.created_at>=m.created_at)
 AND NOT EXISTS(SELECT 1 FROM inbound_dedupe d WHERE d.case_id=c.id) AND ${noConflict}) RETURNING *`,
 to, now(), i.id, from, i.snapshot_json, i.session_hash, now()).first();
}
async function finalize(db, i, result) {
 const time = now();
 // Separate durable outcome table: no existing Notion queue is consumed or changed.
 await db.batch([
  stmt(db, `UPDATE live_outbound_reviews SET status=?,provider_id=?,updated_at=? WHERE id=? AND status='dispatching'`,
   result.status, result.id ?? null, time, i.id),
  stmt(db, `INSERT INTO messages(id,case_id,direction,body,created_at,intent_id)
   SELECT ?,case_id,'outbound',json_extract(snapshot_json,'$.body'),?,id FROM live_outbound_reviews
   WHERE id=? AND status='sent' AND ?='sent'`, crypto.randomUUID(), time, i.id, result.status),
  stmt(db, `INSERT INTO audit_events SELECT ?,?,case_id,id,? FROM live_outbound_reviews WHERE id=? AND status=?`,
   crypto.randomUUID(), `live_acceptance_${result.status}`, time, i.id, result.status)
 ]);
 const durable = await stmt(db, 'SELECT status FROM live_outbound_reviews WHERE id=?', i.id).first();
 requireThat(['sent','failed','UNKNOWN'].includes(durable?.status), 503, 'outcome_not_persisted');
 return durable.status;
}
function coordinator({ fetcher, verifyEvidence, send, offline }) {
 return { async fetch(request, env) {
  try {
   // Snapshot configuration per invocation; no caller mutation during awaits.
   env = { ...env };
   const auth = await authenticate(request, env, fetcher);
   const claims = JSON.parse(new TextDecoder().decode(unb64(request.headers.get('Cf-Access-Jwt-Assertion').split('.')[1])));
   // Additional signed MFA evidence, never a request header or environment boolean.
   // Real Access claim/policy contract still needs independent deployed acceptance.
   requireThat(Array.isArray(claims.amr) && claims.amr.includes('mfa'), 401, 'owner_mfa_required');
   const url = new URL(request.url);
   requireThat(url.origin === env.APP_ORIGIN, 403, 'origin_denied');
   if (offline) requireThat(env.RESEND_API_KEY === 'offline-placeholder' && new URL(env.APP_ORIGIN).hostname.endsWith('.test') && env.OWNER_EMAIL?.endsWith('.test'), 503, 'offline_only');
   if (request.method === 'GET' && url.pathname === '/api/live/session') {
    const proof = await sessionProof(request, env, auth, true);
    return json({ csrf:proof.csrf, state:offline ? 'offline rehearsal' : 'live pending: verified ingress unavailable', liveAvailable:false }, 200, { 'Set-Cookie':proof.cookie });
   }
   requireThat(request.method === 'POST', 405, 'method_not_allowed');
   const proof = await protectPost(request, env, auth);
   await rateLimit(env.DB, proof.bound);
   gates(env); await schema(env.DB);
   // No flag, credential, forged stored approval or provider injection can lift this.
   requireThat(offline, 503, 'verified_ingress_unavailable');
   const match = url.pathname.match(/^\/api\/live\/cases\/([a-f0-9-]{36})\/(review|approve|send)$/);
   requireThat(match, 404, 'not_found'); const [,caseId,action] = match;
   if (action === 'review') {
    const data = await readJson(request, ['revision']); requireThat(Number.isSafeInteger(data.revision));
    const eligible = await loadEligible(env.DB, caseId, Number(env.OUTBOUND_START_UNIX), verifyEvidence);
    requireThat(eligible.c.revision === data.revision, 409, 'revision_conflict');
    const id = crypto.randomUUID(), time = now(), expires = time + 600;
    const s = snapshot(eligible, id, proof.bound, expires); validateContent(s); allowlists(env, s);
    await stmt(env.DB, `INSERT INTO live_outbound_reviews
     (id,case_id,receipt_key,message_id,revision,purpose,snapshot_json,session_hash,approval_expires,status,created_at,updated_at)
     SELECT ?,c.id,?,?,?,?,?,?,?,'reserved',?,? FROM cases c WHERE c.id=? AND c.revision=?
     AND EXISTS(SELECT 1 FROM case_folders f WHERE f.case_id=c.id AND f.folder<>'trash') AND ${noConflict}
     ON CONFLICT(case_id,revision) DO NOTHING`, id, s.receiptKey, s.messageId, data.revision, PURPOSE,
     JSON.stringify(s), proof.bound, expires, time, time, caseId, data.revision).run();
    const i = await stmt(env.DB, 'SELECT * FROM live_outbound_reviews WHERE case_id=? AND revision=?', caseId, data.revision).first();
    requireThat(i?.session_hash === proof.bound && i.status === 'reserved' && i.approval_expires > now(), 409, 'review_conflict');
    await current(env.DB, env, i, verifyEvidence);
    return json({ id:i.id, status:i.status, snapshot:JSON.parse(i.snapshot_json), approval:await mac(env.LIVE_APPROVAL_SECRET, approvalValue(i, 'review')) });
   }
   const data = await readJson(request, ['intentId','approval']);
   requireThat(typeof data.intentId === 'string' && typeof data.approval === 'string');
   const i = await stmt(env.DB, 'SELECT * FROM live_outbound_reviews WHERE id=? AND case_id=?', data.intentId, caseId).first();
   requireThat(i && i.purpose === PURPOSE && i.session_hash === proof.bound &&
    await verifyMac(env.LIVE_APPROVAL_SECRET, approvalValue(i, action === 'approve' ? 'review' : 'send'), data.approval), 403, 'approval_denied');
   requireThat(i.approval_expires > now(), 409, 'approval_expired');
   const s = await current(env.DB, env, i, verifyEvidence);
   if (action === 'approve') {
    requireThat(i.status === 'reserved', 409, 'approval_replayed');
    requireThat(await transition(env.DB, i, 'reserved', 'approved'), 409, 'approval_conflict');
    return json({ id:i.id, status:'approved', approval:await mac(env.LIVE_APPROVAL_SECRET, approvalValue(i, 'send')) });
   }
   if (['dispatching','sent','failed','UNKNOWN'].includes(i.status)) return json({ id:i.id, status:i.status });
   requireThat(i.status === 'approved', 409, 'approval_required');
   const claimed = await transition(env.DB, i, 'approved', 'dispatching');
   if (!claimed) {
    const latest = await stmt(env.DB, 'SELECT status FROM live_outbound_reviews WHERE id=?', i.id).first();
    return json({ id:i.id, status:latest.status }, latest.status === 'approved' ? 409 : 200);
   }
   // The private closure only sees a successfully claimed immutable snapshot.
   // Wire deadline bounds fetch AND response body. No retries, ever.
   let result;
   try { result = await send(s, env); } catch { result = { status:'UNKNOWN' }; }
   if (!['sent','failed','UNKNOWN'].includes(result?.status) || (result.status === 'sent' && (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)))) result = { status:'UNKNOWN' };
   const durableStatus = await finalize(env.DB, claimed, result);
   return json({ id:i.id, status:durableStatus, meaning:durableStatus === 'sent' ? 'provider accepted; delivery unverified' : 'no automatic retry' });
  } catch (error) {
   return json({ error:error instanceof HttpError ? error.message : 'service_unavailable' }, error instanceof HttpError ? error.status : 503);
  }
 } };
}
export function createProductionCandidate({ fetcher = fetch } = {}) {
 return coordinator({ fetcher, verifyEvidence:async () => false, send:async () => { throw Error('integration_blocked'); }, offline:false });
}
// Never import this factory into a deployed entrypoint. No default provider fetch.
// Both factory and wire enforce fake credentials and test-only recipients.
export function createOfflineOutbound({ fetcher, providerStub, ingressPublicKey }) {
 requireThat(typeof fetcher === 'function' && typeof providerStub === 'function' && ingressPublicKey?.type === 'public', 400, 'offline_only');
 const verifyEvidence = async r => {
  try { return await crypto.subtle.verify('Ed25519', ingressPublicKey, unb64(r.signature), new TextEncoder().encode(r.evidence_json)); } catch { return false; }
 };
 return coordinator({ fetcher, verifyEvidence, send:(s, env) => rehearseResend(s, env, providerStub), offline:true });
}
export async function recoverLiveUncertain(db, cutoff = now() - 300) {
 await stmt(db, "UPDATE live_outbound_reviews SET status='UNKNOWN',updated_at=? WHERE status='dispatching' AND updated_at<?", now(), cutoff).run();
}
