// Deliberately not imported by the staging Worker. Activation requires a reviewed code change.
import { senders } from './store.mjs';
import { mailbox, messageId } from './inbound.mjs';
export async function resendFuture(intent, env, fetcher, approval) {
 if (env.DEPLOYMENT_STAGE !== 'production' || env.SEND_MODE !== 'live' || env.ALLOW_REAL_SEND !== 'true' || !env.RESEND_API_KEY) throw new Error('live_send_forbidden');
 if (!Object.values(senders).includes(intent.sender)) throw new Error('invalid_sender');
 // Future caller must supply the independently verified immutable human approval snapshot.
 // The staging Worker never imports this adapter. A future caller owns HMAC/claim verification.
 if (!fetcher || !approval || approval.humanApproved !== true || approval.status !== 'dispatching' ||
     !Number.isFinite(approval.expires) || approval.expires <= Date.now() / 1000 ||
     ['id','sender','recipient','subject','body','inReplyTo','references'].some(k => JSON.stringify(intent[k]) !== JSON.stringify(approval[k]))) throw Error('approval_required');
 if (!/^[a-f0-9-]{36}$/.test(intent.id) || !mailbox(intent.recipient) ||
     typeof intent.subject !== 'string' || intent.subject.length > 200 || /[\r\n]/.test(intent.subject) ||
     typeof intent.body !== 'string' || !intent.body.trim() || intent.body.length > 10000) throw Error('invalid_intent');
 const refs = intent.references ?? [];
 if (!Array.isArray(refs) || refs.length > 20 || !refs.every(messageId) ||
     (intent.inReplyTo != null && !messageId(intent.inReplyTo))) throw Error('invalid_thread');
 const threadHeaders = intent.inReplyTo ? { 'In-Reply-To': intent.inReplyTo, References: [...new Set([...refs, intent.inReplyTo])].join(' ') } : {};

 try {
  const response = await fetcher('https://api.resend.com/emails', {
   method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
   headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
    'Idempotency-Key': intent.id, 'Resend-Idempotency-Key': intent.id },
   body: JSON.stringify({ from: intent.sender, to: [intent.recipient], subject: intent.subject, text: intent.body, headers: threadHeaders })
  });
  if (response.status >= 300 && response.status < 400) return { status: 'UNKNOWN' };
  // Ambiguous responses, throttles, conflicts and all server errors require reconciliation.
  if ([400,401,403,404,422].includes(response.status)) return { status: 'failed' };
  if (!response.ok) return { status: 'UNKNOWN' };
  const value = await response.json();
  return typeof value.id === 'string' && value.id ? { status: 'sent', id: value.id } : { status: 'UNKNOWN' };
 } catch { return { status: 'UNKNOWN' }; }
}
