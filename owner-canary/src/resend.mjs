import { requireThat } from './auth.mjs';
export const MESSAGE = Object.freeze({
 from: 'support@bigsoxstudios.com',
 subject: 'Big Sox Studios — Outbound Email Verification',
 text: 'This is a one-time test of the Big Sox Studios outbound email system.\n\nThe message verifies that support@bigsoxstudios.com can securely send email through Resend.\n\nNo customer tickets or customer messages are involved.\n\n— Big Sox Studios'
});
export function envelope(mailbox) {
 requireThat(typeof mailbox === 'string' && mailbox.length <= 254);
 // Deliberately narrow ASCII mailbox grammar; exact bytes, no aliases/normalization.
 requireThat(/^[a-z0-9]+(?:[._-][a-z0-9]+)*@[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(mailbox));
 return Object.freeze({ ...MESSAGE, to: mailbox });
}

// Only the coordinator calls this, after the durable submitted CAS. There is no
// retry or alternate URL, and no key or raw provider response escapes the adapter.
export async function submitOnce(row, env, transport = fetch) {
 const unknown = { status: 'UNKNOWN' };
 try {
  requireThat(env.DEPLOYMENT_STAGE === 'production' && env.CANARY_SEND_ENABLED === 'owner-canary-v1-approved');
  requireThat(/^re_[A-Za-z0-9_-]{20,}$/.test(env.RESEND_API_KEY ?? ''));
  requireThat(row.status === 'submitted' && /^[0-9a-f-]{36}$/.test(row.campaign));
  const payload = envelope(env.CANARY_OWNER_MAILBOX);
  requireThat(JSON.stringify(payload) === JSON.stringify(JSON.parse(row.snapshot).payload));
  const response = await transport('https://api.resend.com/emails', {
   method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
   headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
    'Idempotency-Key': `owner-canary/${row.campaign}/${row.digest}` },
   body: JSON.stringify(payload)
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return unknown;
  // Bounded streaming read; malformed, oversized or uncertain outcomes are final.
  const reader = response.body?.getReader();
  if (!reader) return unknown;
  let size = 0, text = '';
  const decoder = new TextDecoder();
  while (true) {
   const { value, done } = await reader.read();
   if (done) break;
   size += value.length;
   if (size > 4096) { await reader.cancel(); return unknown; }
   text += decoder.decode(value, { stream: true });
  }
  const result = JSON.parse(text + decoder.decode());
  if (response.status === 200 && Object.keys(result).length === 1 &&
   typeof result.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result.id)) {
   return { status: 'accepted', id: result.id };
  }
  if ([400, 401, 403, 422].includes(response.status) && typeof result.name === 'string' && !result.id) return { status: 'refused' };
  return unknown;
 } catch { return unknown; }
}
