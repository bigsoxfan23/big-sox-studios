// Sole simple-reply transport. No threading headers without independent provenance.
import { requireThat } from './security.mjs';
const encoder = new TextEncoder();
const preparedReplies = new WeakMap();
const owner = 'fridman.greg@gmail.com';
const sender = 'support@bigsoxstudios.com';
const mailbox = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
// Customer activation has its own exact policy; the fixed owner allowlist stays closed.
export function replyPolicy(env) {
 const base = env.DEPLOYMENT_STAGE === 'staging' && env.SEND_MODE === 'live' && env.ALLOW_REAL_SEND === 'true'
  && env.MAILDESK_RECIPIENT_ALLOWLIST === JSON.stringify([owner])
  && env.OWNER_EMAIL === owner && typeof env.RESEND_API_KEY === 'string' && /^re_[A-Za-z0-9_-]{20,200}$/.test(env.RESEND_API_KEY);
 if (!base) return 'off';
 if (env.MAILDESK_REPLY_ACTIVATION === 'owner-self-v1') return 'owner-self-v1';
 if (env.MAILDESK_REPLY_ACTIVATION === 'owner-reviewed-customers-v1'
  && env.MAILDESK_CUSTOMER_REPLIES === 'enabled'
  && env.MAILDESK_CUSTOMER_RECIPIENT_POLICY === 'exact-forwarded-requester-v1'
  // This release authorizes only one owner-controlled external test mailbox,
  // and automatically fails closed after its short time window.
  && env.MAILDESK_CUSTOMER_TEST_RECIPIENT === 'greg.fridman@outlook.com'
  && typeof env.MAILDESK_CUSTOMER_TEST_EXPIRES_AT === 'string'
  && /^[1-9][0-9]{9}$/.test(env.MAILDESK_CUSTOMER_TEST_EXPIRES_AT)
  && Number(env.MAILDESK_CUSTOMER_TEST_EXPIRES_AT) > Math.floor(Date.now() / 1000)
  && Number(env.MAILDESK_CUSTOMER_TEST_EXPIRES_AT) <= Math.floor(Date.now() / 1000) + 48 * 3600
 ) return 'owner-reviewed-customers-v1';
 return 'off';
}
export const replyEnabled = env => replyPolicy(env) !== 'off';
export const customerReplies = env => replyPolicy(env) === 'owner-reviewed-customers-v1';
export const replyMode = env => env.SEND_MODE === 'mock' ? 'mock' : replyEnabled(env) ? 'live' : 'pending';
// Envelope evidence is routing evidence, never sender authentication.
const customerMailbox = value => mailbox(value) && value.split('@')[0].length <= 64
 && value.split('@')[0].split('.').every(Boolean)
 && !/^(?:postmaster|mailer-daemon|no[._-]?reply|do[._-]?not[._-]?reply)(?:[+@])/i.test(value)
 && !/@bigsoxstudios\.com$/i.test(value);
export function prepareReply(intent, env) {
 requireThat(replyEnabled(env), 503, 'reply_preflight_rejected');
 requireThat(intent.sender === sender && mailbox(intent.recipient) && (customerReplies(env) ? customerMailbox(intent.recipient) && intent.recipient === env.MAILDESK_CUSTOMER_TEST_RECIPIENT : intent.recipient === owner), 403, 'reply_preflight_rejected');
 requireThat(typeof intent.id === 'string' && /^[a-f0-9-]{36}$/.test(intent.id), 400, 'reply_preflight_rejected');
 // eslint-disable-next-line no-control-regex -- Reject control bytes in outbound email subject.
 requireThat(typeof intent.subject === 'string' && intent.subject.trim().length > 0 && encoder.encode(intent.subject).length <= 998 && !/[\x00-\x1f\x7f]/.test(intent.subject), 400, 'reply_preflight_rejected');
 // eslint-disable-next-line no-control-regex -- Reject NUL in outbound plain-text body.
 requireThat(typeof intent.body === 'string' && intent.body.trim().length > 0 && intent.body.length <= 10000 && !/[\x00]/.test(intent.body), 400, 'reply_preflight_rejected');
 const body = JSON.stringify({ from: sender, to: [intent.recipient], subject: intent.subject, text: intent.body });
 requireThat(encoder.encode(body).length <= 45000, 413, 'reply_preflight_rejected');
 const key = `maildesk-reply-v1-${intent.id}`;
 // All validation/serialization is completed before the durable dispatch claim.
 const prepared = Object.freeze({ body, key });
 preparedReplies.set(prepared, replyPolicy(env));
 return prepared;
}
async function boundedJson(response, signal) {
 const reader = response.body?.getReader();
 if (!reader) throw Error('invalid');
 let size = 0; const chunks = [];
 const abort = () => { void reader.cancel().catch(() => {}); };
 signal.addEventListener('abort', abort, { once:true });
 if (signal.aborted) abort();
 try {
  while (true) {
   signal.throwIfAborted();
   const {done,value} = await reader.read();
   signal.throwIfAborted();
   if (done) break;
   size += value.length;
   if (size > 4096) { void reader.cancel().catch(() => {}); throw Error('invalid'); }
   chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
 } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
export async function sendReply(prepared, env, stage, fetcher = fetch) {
 requireThat(replyEnabled(env) && preparedReplies.get(prepared) === replyPolicy(env), 503, 'reply_preflight_rejected');
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 8000);
 let response;
 try {
  // If this durable diagnostic fails, no request starts; caller locks the claim UNKNOWN.
  await stage('fetch_started');
  try {
   response = await fetcher('https://api.resend.com/emails', { method:'POST', redirect:'manual', signal:controller.signal,
    headers:{ Authorization:`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json', 'Idempotency-Key':prepared.key }, body:prepared.body });
  } catch { await stage('fetch_rejected'); return { status:'UNKNOWN', stage:'fetch_rejected' }; }
  await stage(`response_http_${response.status}`);
  // Only definite validation/auth/rate refusals establish no acceptance. Conflicts,
  // redirects, timeouts, 5xx and unexpected statuses remain uncertain, never retried.
  if ([400,401,403,404,413,422,429].includes(response.status)) {
   void response.body?.cancel().catch(() => {});
   await stage('provider_refused'); return { status:'failed', stage:'provider_refused' };
  }
  if (response.status !== 200 && response.status !== 201) {
   void response.body?.cancel().catch(() => {});
   await stage('response_invalid'); return { status:'UNKNOWN', stage:'response_invalid' };
  }
  let value;
  try { value = await boundedJson(response, controller.signal); } catch {
   await stage('response_invalid'); return { status:'UNKNOWN', stage:'response_invalid' };
  }
  if (!value || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)) {
   await stage('response_invalid'); return { status:'UNKNOWN', stage:'response_invalid' };
  }
  await stage('provider_accepted');
  return { status:'sent', id:value.id, stage:'provider_accepted' };
 } finally { clearTimeout(timer); controller.abort(); }
}
