// Deliberately outside the Worker graph. There is NO live approval authority yet.
import { senders } from './store.mjs';
import { mailbox, messageId } from './inbound.mjs';
function gates(env) {
 if (env.DEPLOYMENT_STAGE !== 'production' || env.SEND_MODE !== 'live' || env.ALLOW_REAL_SEND !== 'true' ||
     typeof env.RESEND_API_KEY !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(env.RESEND_API_KEY)) throw Error('live_send_forbidden');
}
export async function resendFuture(intent, env, fetcher, approval) {
 gates(env);
 // A serializable humanApproved flag/snapshot is never authorization. 0001-0003
 // have no immutable outbound thread/provenance snapshot. No caller can safely
 // bridge the current mock review to live delivery. Requires a reviewed code change.
 void intent; void fetcher; void approval;
 throw Error('approval_required_integration_blocked');
}
function allowlist(value) {
 try {
  const list = JSON.parse(value);
  return Array.isArray(list) && list.length > 0 && list.length <= 20 && list.every(mailbox) && new Set(list).size === list.length ? list : [];
 } catch { return []; }
}
function validate(intent, env) {
 if (!Object.values(senders).includes(intent.sender)) throw Error('invalid_sender');
 if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(intent.id) || !mailbox(intent.recipient) ||
     // eslint-disable-next-line no-control-regex -- Prevent untrusted subject headers from containing control characters.
     typeof intent.subject !== 'string' || !intent.subject.trim() || intent.subject.length > 200 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(intent.subject) ||
     typeof intent.body !== 'string' || !intent.body.trim() || intent.body.length > 10000) throw Error('invalid_intent');
 const refs = intent.references ?? [];
 if (!Array.isArray(refs) || refs.length > 20 || !refs.every(messageId)) throw Error('invalid_thread');
 const all = [...new Set([...refs, ...(intent.inReplyTo ? [intent.inReplyTo] : [])])];
 if (all.length > 20 || all.join(' ').length > 4096 ||
     (intent.inReplyTo != null && !messageId(intent.inReplyTo)) || (!intent.inReplyTo && refs.length)) throw Error('invalid_thread');
 if (!allowlist(env.OUTBOUND_SENDER_ALLOWLIST).includes(intent.sender) ||
     !allowlist(env.OUTBOUND_RECIPIENT_ALLOWLIST).includes(intent.recipient)) throw Error('invalid_allowlist');
 return intent.inReplyTo ? { 'In-Reply-To': intent.inReplyTo, References: all.join(' ') } : {};
}
const MAX_RESPONSE = 16384;
async function boundedJson(response, setReader) {
 const declared = response.headers.get('Content-Length');
 if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE)) throw Error('bounded');
 const reader = response.body?.getReader(); if (!reader) throw Error('empty');
 setReader(reader);
 let size = 0; const chunks = [];
 for (;;) {
  const { done, value } = await reader.read(); if (done) break;
  size += value.byteLength; if (size > MAX_RESPONSE) throw Error('bounded'); chunks.push(value);
 }
 if (declared !== null && Number(declared) !== size) throw Error('length');
 const bytes = new Uint8Array(size); let offset = 0;
 for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
 return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
async function sendWire(intent, env, fetcher, threadHeaders) {
 const controller = new AbortController(); let timer, reader, response;
 try {
  return await Promise.race([(async () => {
   // Bare invocation is required by workerd's native fetch receiver contract.
   response = await fetcher('https://api.resend.com/emails', {
    method: 'POST', redirect: 'manual', signal: controller.signal,
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
     'Idempotency-Key': intent.id, 'Resend-Idempotency-Key': intent.id },
    body: JSON.stringify({ from: intent.sender, to: [intent.recipient], subject: intent.subject, text: intent.body, headers: threadHeaders })
   });
   if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return { status: 'UNKNOWN' }; }
   if (response.redirected || (response.status >= 300 && response.status < 400)) return { status: 'UNKNOWN' };
   if ([400,401,403,404,422].includes(response.status)) return { status: 'failed' };
   if (response.status !== 200 && response.status !== 201) return { status: 'UNKNOWN' };
   const value = await boundedJson(response, value => { reader = value; });
   return typeof value?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.id) ? { status: 'sent', id: value.id } : { status: 'UNKNOWN' };
  })(), new Promise(resolve => {
   timer = setTimeout(() => { controller.abort(); resolve({ status: 'UNKNOWN' }); }, 10000);
  })]);
 } catch { return { status: 'UNKNOWN' }; }
 finally {
  clearTimeout(timer); controller.abort();
  // Cleanup must not extend the deadline if a transport ignores cancellation.
  if (reader) void reader.cancel().catch(() => {});
  else if (response) void response.body?.cancel().catch(() => {});
 }
}
// Offline wire rehearsal ONLY: cannot accept a real provider key or a customer.
// The fetch argument must be a local stub. No default/global fetch is supplied.
// This does not grant human approval or claim D1 and must never be wired to HTTP.
export async function rehearseResend(intent, env, fetcher) {
 gates(env);
 const headers = validate(intent, env);
 if (env.RESEND_API_KEY !== 'offline-placeholder' || !intent.recipient.endsWith('.test') || typeof fetcher !== 'function') throw Error('offline_only');
 return sendWire(structuredClone(intent), { ...env }, fetcher, headers);
}
