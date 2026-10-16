import { authenticate, HttpError, requireThat, protectPost, sessionProof, readJson, mac, verifyMac, digest } from './security.mjs';
import { stmt, audit, rateLimit, getCase, saveDraft, reserveReview, claimSend, finalize, now } from './store.mjs';
import { email } from './inbound.mjs';
import { stagingProvider } from './providers.mjs';
import { runNotionSync } from './notion.sync.mjs';
import { liveEnabled } from './notion.live.mjs';
const headers = {
 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://bigsoxstudios.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000'
};
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json', ...extra } });
const approvalValue = i => JSON.stringify([i.id,i.case_id,i.revision,i.recipient,i.sender,i.subject,i.body,i.session_hash,i.approval_expires]);
const publicIntent = i => ({ id: i.id, caseId: i.case_id, revision: i.revision, to: i.recipient, from: i.sender, subject: i.subject, body: i.body, status: i.status, expires: i.approval_expires });
export function createWorker({ fetcher = fetch, provider } = {}) {
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
    return json({ csrf: session.csrf, sendMode: env.SEND_MODE === 'mock' ? 'mock' : 'disabled', notionSync: liveEnabled(env) ? 'live' : 'off', acceptance: 'pending owner Access and MFA review' }, 200, { 'Set-Cookie': session.cookie });
   }
   if (request.method === 'GET' && url.pathname === '/api/inbound-status') {
    // Task9 staging may still have only 0001: absence is explicit, never a zero count.
    const schema = await stmt(env.DB, "SELECT name FROM sqlite_master WHERE type='table' AND name='email_receipts'").first();
    if (!schema) return json({ available: false, unresolved: null });
    const row = await stmt(env.DB, "SELECT COUNT(*) AS count FROM email_receipts WHERE forward_state IN ('claimed','UNKNOWN')").first();
    return json({ available: true, unresolved: row.count });
   }
   if (request.method === 'GET' && url.pathname === '/api/cases') {
    return json((await stmt(env.DB, `SELECT id,channel,subject,requester_name,updated_at FROM cases ORDER BY updated_at DESC LIMIT 100`).all()).results);
   }
   const match = url.pathname.match(/^\/api\/cases\/([a-f0-9-]{36})(?:\/(draft|review|send))?$/);
   if (match) {
    const [, id, action] = match;
    if (request.method === 'GET' && !action) {
     const c = await getCase(env.DB, id);
     const messages = (await stmt(env.DB, 'SELECT direction,body,created_at FROM messages WHERE case_id=? ORDER BY created_at,id', id).all()).results;
     const deliveries = (await stmt(env.DB, 'SELECT id,revision,status FROM outbound_intents WHERE case_id=? ORDER BY created_at,id', id).all()).results;
     return json({ ...c, messages, deliveries });
    }
    requireThat(request.method === 'POST' && action, 405, 'method_not_allowed');
    if (action === 'draft') {
     const data = await readJson(request, ['body','revision']);
     return json(await saveDraft(env.DB, id, data));
    }
    if (action === 'review') {
     const data = await readJson(request, ['revision']); requireThat(Number.isSafeInteger(data.revision));
     const intent = await reserveReview(env.DB, id, data.revision, proof.bound);
     return json({ ...publicIntent(intent), approval: await mac(env.CSRF_SECRET, approvalValue(intent)) });
    }
    if (action === 'send') {
     const data = await readJson(request, ['intentId','approval']);
     requireThat(typeof data.intentId === 'string' && typeof data.approval === 'string');
     const i = await stmt(env.DB, 'SELECT * FROM outbound_intents WHERE id=? AND case_id=?', data.intentId, id).first();
     requireThat(i && i.session_hash === proof.bound && await verifyMac(env.CSRF_SECRET, approvalValue(i), data.approval), 403, 'approval_denied');
     if (i.status !== 'reserved') return json({ id: i.id, status: i.status });
     requireThat(i.approval_expires > now(), 409, 'approval_expired');
     // Fail closed even if an operator injects a live mode or credentials into staging.
     requireThat(env.SEND_MODE === 'mock', 503, 'staging_send_disabled');
     const send = provider ?? stagingProvider(env);
     const claimed = await claimSend(env.DB, i);
     if (!claimed) {
      const latest = await stmt(env.DB, 'SELECT status FROM outbound_intents WHERE id=?', i.id).first();
      return json({ id: i.id, status: latest.status }, latest.status === 'reserved' ? 409 : 200);
     }
     let result, timer;
     try {
      result = await Promise.race([send(claimed), new Promise((_, reject) => {
       timer = setTimeout(() => reject(new Error('timeout')), 10000);
      })]);
      if (!['sent','failed','UNKNOWN'].includes(result?.status)) result = { status: 'UNKNOWN' };
     } catch { result = { status: 'UNKNOWN' }; }
     finally { clearTimeout(timer); }
     await finalize(env.DB, claimed, result);
     return json({ id: i.id, status: result.status });
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
