import { authenticate, HttpError, requireThat, protectPost, sessionProof, readJson, mac, verifyMac, digest } from './security.mjs';
import { stmt, audit, rateLimit, getCase, saveDraft, reserveReview, claimSend, finalize, now, reviewMode, bindReviewMode, replyStage, requireCustomerInbound } from './store.mjs';
import { email, decodedSubject } from './inbound.mjs';
import { prepareReply, sendReply, replyMode, replyPolicy, customerReplies } from './reply.resend.mjs';
import { stagingProvider } from './providers.mjs';
import { runNotionSync } from './notion.sync.mjs';
import { liveEnabled } from './notion.live.mjs';
const headers = {
 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://bigsoxstudios.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000'
};
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json', ...extra } });
const approvalValue = (i, mode = 'mock', policy = 'owner-self-v1') => JSON.stringify([policy === 'owner-reviewed-customers-v2' ? 'maildesk-customer-reply-v2' : policy === 'owner-reviewed-customers-v1' ? 'maildesk-customer-reply-v1' : 'maildesk-reply-v1',mode,i.id,i.case_id,i.revision,i.recipient,i.sender,i.subject,i.body,i.session_hash,i.approval_expires]);
const publicIntent = (i, mode) => ({ mode, id: i.id, caseId: i.case_id, revision: i.revision, to: i.recipient, from: i.sender, subject: i.subject, body: i.body, status: i.status, expires: i.approval_expires });
async function requireInbound(db, id) {
 // Receipt linkage permits genuine existing support ingress; it does not claim
 // authenticated sender provenance. This legacy check is only for owner-self-v1.
 const row = await stmt(db, `SELECT r.receipt_key FROM email_receipts r
 JOIN email_receipt_messages rm ON rm.receipt_key=r.receipt_key
 JOIN messages m ON m.id=rm.message_id AND m.case_id=r.case_id
 WHERE r.case_id=? AND r.envelope_to='support@bigsoxstudios.com' AND r.forward_state='forwarded'
 AND m.direction='inbound' AND NOT EXISTS(SELECT 1 FROM inbound_dedupe d WHERE d.case_id=r.case_id) LIMIT 1`, id).first();
 requireThat(row, 403, 'reply_inbound_required');
}
export function createWorker({ fetcher = fetch, provider, simulation, replyTransport } = {}) {
 return { email, scheduled(controller, env, ctx) {
  void controller;
  ctx.waitUntil(runNotionSync(env, fetcher));
 }, async fetch(request, env) {
  let authed = false;
  try {
   // Authentication also covers unknown routes, assets, errors, and unsupported methods.
   const auth = await authenticate(request, env, fetcher); authed = true;
   const url = new URL(request.url);
   requireThat(url.origin === env.APP_ORIGIN, 403, 'origin_denied');
   requireThat(['GET','POST'].includes(request.method), 405, 'method_not_allowed');
   let proof;
   if (request.method === 'POST') {
    proof = await protectPost(request, env, auth);
    await rateLimit(env.DB, await digest(env.OWNER_EMAIL));
   }
   if (request.method === 'GET' && url.pathname === '/api/session') {
    const session = await sessionProof(request, env, auth, true);
    const mode = replyMode(env);
    const ready = mode !== 'live' || await stmt(env.DB, "SELECT name FROM sqlite_master WHERE type='table' AND name='reply_review_modes'").first();
    return json({ csrf: session.csrf, sendMode: ready ? mode : 'pending', replyPolicy: ready ? replyPolicy(env) : 'off', notionSync: liveEnabled(env) ? 'live' : 'off', acceptance: 'owner-only Cloudflare Access session' }, 200, { 'Set-Cookie': session.cookie });
   }
   if (request.method === 'GET' && url.pathname === '/api/inbound-status') {
    // Task9 staging may still have only 0001: absence is explicit, never a zero count.
    const schema = await stmt(env.DB, "SELECT name FROM sqlite_master WHERE type='table' AND name='email_receipts'").first();
    if (!schema) return json({ available: false, unresolved: null });
    const row = await stmt(env.DB, "SELECT COUNT(*) AS count FROM email_receipts WHERE forward_state IN ('claimed','UNKNOWN')").first();
    return json({ available: true, unresolved: row.count });
   }
   if (request.method === 'GET' && url.pathname === '/api/cases') {
    const cases = (await stmt(env.DB, `SELECT id,channel,subject,requester_name,updated_at FROM cases ORDER BY updated_at DESC LIMIT 100`).all()).results;
    return json(cases.map(c => ({ ...c, displaySubject: decodedSubject(c.subject) })));
   }
   const match = url.pathname.match(/^\/api\/cases\/([a-f0-9-]{36})(?:\/(draft|review|send))?$/);
   if (match) {
    const [, id, action] = match;
    if (request.method === 'GET' && !action) {
     const c = await getCase(env.DB, id);
     const messages = (await stmt(env.DB, 'SELECT direction,body,created_at,intent_id FROM messages WHERE case_id=? ORDER BY created_at,id', id).all()).results;
     const deliveries = (await stmt(env.DB, 'SELECT id,revision,status FROM outbound_intents WHERE case_id=? ORDER BY created_at,id', id).all()).results;
     for (const message of messages) { if (message.direction === 'outbound') message.mode = await reviewMode(env.DB, message.intent_id); delete message.intent_id; }
     for (const delivery of deliveries) { delivery.mode = await reviewMode(env.DB, delivery.id); if (delivery.mode === 'live') delivery.stage = await replyStage(env.DB, delivery.id); }
     return json({ ...c, displaySubject: decodedSubject(c.subject), messages, deliveries });
    }
    requireThat(request.method === 'POST' && action, 405, 'method_not_allowed');
    if (action === 'draft') {
     const data = await readJson(request, ['body','revision']);
     return json(await saveDraft(env.DB, id, data));
    }
    if (action === 'review') {
     const data = await readJson(request, ['revision']); requireThat(Number.isSafeInteger(data.revision));
     const intent = await reserveReview(env.DB, id, data.revision, proof.bound);
     // Preserve historical review-only API behavior while activation is pending.
     const mode = replyMode(env) === 'live' ? 'live' : 'mock';
     if (mode === 'live') {
      const c = await getCase(env.DB, id);
      requireThat(c.channel === 'support', 403, 'reply_preflight_rejected');
      prepareReply(intent, env);
      if (customerReplies(env)) await requireCustomerInbound(env.DB, intent);
      else await requireInbound(env.DB, id);
     }
     await bindReviewMode(env.DB, intent, mode);
     return json({ ...publicIntent(intent, mode), policy: replyPolicy(env), approval: await mac(env.CSRF_SECRET, approvalValue(intent, mode, replyPolicy(env))) });
    }
    if (action === 'send') {
     const data = await readJson(request, ['intentId','approval','confirmed']);
     requireThat(typeof data.intentId === 'string' && typeof data.approval === 'string');
     const i = await stmt(env.DB, 'SELECT * FROM outbound_intents WHERE id=? AND case_id=?', data.intentId, id).first();
     const mode = i ? await reviewMode(env.DB, i.id) : 'mock';
     requireThat(i && i.session_hash === proof.bound && await verifyMac(env.CSRF_SECRET, approvalValue(i, mode, replyPolicy(env)), data.approval), 403, 'approval_denied');
     if (i.status !== 'reserved') return json({ id: i.id, status: i.status, mode, stage: mode === 'live' ? await replyStage(env.DB, i.id) : undefined });
     requireThat(i.approval_expires > now(), 409, 'approval_expired');
     requireThat(provider === undefined, 503, 'staging_provider_denied');
     let send, prepared;
     if (mode === 'live') {
      requireThat(data.confirmed === true, 400, 'reply_confirmation_required');
      try {
       const c = await getCase(env.DB, id);
       requireThat(c.channel === 'support', 403, 'reply_preflight_rejected');
       prepared = prepareReply(i, env);
       if (customerReplies(env)) await requireCustomerInbound(env.DB, i);
       else await requireInbound(env.DB, id);
       await audit(env.DB, 'reply_config_approved', id, i.id);
      } catch (error) {
       await audit(env.DB, 'reply_preflight_rejected', id, i.id);
       throw error;
      }
     } else {
      requireThat(env.SEND_MODE === 'mock', 503, 'staging_send_disabled');
      send = stagingProvider(env, simulation);
     }
     const claimed = await claimSend(env.DB, i, mode === 'live' && customerReplies(env), mode === 'live' && replyPolicy(env) === 'owner-reviewed-customers-v2');
     if (!claimed) {
      const latest = await stmt(env.DB, 'SELECT status FROM outbound_intents WHERE id=?', i.id).first();
      requireThat(latest.status !== 'reserved', 409, 'revision_or_delivery_conflict');
      return json({ id: i.id, status: latest.status, mode });
     }
     let result;
     if (mode === 'live') {
      try {
       result = await sendReply(prepared, env, stage => audit(env.DB, `reply_${stage}`, id, i.id), replyTransport);
      } catch {
       result = { status:'UNKNOWN', stage:'dispatch_interrupted' };
       try { await audit(env.DB, 'reply_dispatch_interrupted', id, i.id); } catch { /* Never log a storage exception. */ }
      }
     } else {
      // Simulator is abortable too; there is no dangling provider Promise.race task.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
       result = await send(claimed, controller.signal);
       if (!['sent','failed','UNKNOWN'].includes(result?.status)) result = { status:'UNKNOWN' };
      } catch { result = { status:'UNKNOWN' }; }
      finally { clearTimeout(timer); controller.abort(); }
     }
     try {
      await finalize(env.DB, claimed, result);
      if (mode === 'live') {
       const saved = await stmt(env.DB, 'SELECT status FROM outbound_intents WHERE id=?', i.id).first();
       if (saved?.status !== result.status) result = { status:'UNKNOWN', stage:'storage_unconfirmed' };
      }
     } catch (error) {
      if (mode !== 'live') throw error;
      result = { status:'UNKNOWN', stage:'storage_unconfirmed' };
     }
     return json({ id: i.id, status: result.status, mode, stage: result.stage });
    }
   }
   if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found');
   requireThat(request.method === 'GET' && ['/', '/app.js','/styles.css'].includes(url.pathname), 404, 'not_found');
   const asset = await env.ASSETS.fetch(request);
   const output = new Response(asset.body, asset);
   for (const [key,value] of Object.entries(headers)) output.headers.set(key,value);
   return output;
  } catch (error) {
   const status = error instanceof HttpError ? error.status : 503;
   if (authed && status < 500) {
    try { await audit(env.DB, `denied_${error.message}`); } catch { /* No PII or credentials in logging fallback. */ }
   }
   return json({ error: error instanceof HttpError ? error.message : 'service_unavailable' }, status);
  }
 } };
}
export default createWorker();
