// Deliberately not imported by the staging Worker. Activation requires a reviewed code change.
import { senders } from './store.mjs';
export async function resendFuture(intent, env, fetcher = fetch) {
 if (env.DEPLOYMENT_STAGE !== 'production' || env.SEND_MODE !== 'live' || env.ALLOW_REAL_SEND !== 'true' || !env.RESEND_API_KEY) throw new Error('live_send_forbidden');
 if (!Object.values(senders).includes(intent.sender)) throw new Error('invalid_sender');
 try {
  const response = await fetcher('https://api.resend.com/emails', {
   method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
   headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
    'Idempotency-Key': intent.id, 'Resend-Idempotency-Key': intent.id },
   body: JSON.stringify({ from: intent.sender, to: [intent.recipient], subject: intent.subject, text: intent.body })
  });
  // Ambiguous responses, throttles, conflicts and all server errors require reconciliation.
  if ([400,401,403,404,422].includes(response.status)) return { status: 'failed' };
  if (!response.ok) return { status: 'UNKNOWN' };
  const value = await response.json();
  return typeof value.id === 'string' && value.id ? { status: 'sent', id: value.id } : { status: 'UNKNOWN' };
 } catch { return { status: 'UNKNOWN' }; }
}
