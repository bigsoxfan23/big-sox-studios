// Dormant Email Routing adapter. No HTTP intake, auto reply, raw storage, or logging.
import { stmt, now, senders } from './store.mjs';
import { digest } from './security.mjs';
import PostalMime from 'postal-mime';
// Owner inbox is a Cloudflare-verified deployment setting, not public source code.
export const MAX_RAW = 25 * 1024 * 1024;
export const MAX_PREVIEW_RAW = 256 * 1024;
const PLACEHOLDER = '[Preview unavailable: large or unsupported MIME, HTML, encoding, or attachment. Read the original forwarded email in Gmail.]';
// Conservative ASCII dot-atom subset; unsupported quoted/SMTPUTF8/null senders fail closed.
export const mailbox = value => {
 if (typeof value !== 'string' || value.length > 254) return false;
 const parts = value.split('@');
 if (parts.length !== 2 || !parts[0] || parts[0].length > 64 ||
     !parts[0].split('.').every(atom => /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/.test(atom))) return false;
 const labels = parts[1].split('.');
 return labels.length >= 2 && labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) && /^[A-Za-z]{2,63}$/.test(labels.at(-1));
};
export const messageId = value => {
 if (typeof value !== 'string' || value.length > 254 || !value.startsWith('<') || !value.endsWith('>')) return null;
 const parts = value.slice(1, -1).split('@');
 return parts.length === 2 && parts.every(part => part.split('.').every(atom => /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/.test(atom))) ? value : null;
};
function referenceIds(value) {
 if (!value) return [];
 if (value.length > 4096) return [];
 const ids = value.trim().split(/\s+/);
 return ids.length <= 20 && ids.every(messageId) ? [...new Set(ids)] : [];
}
async function readRaw(message) {
 const reader = message.raw.getReader();
 const preview = new Uint8Array(Math.min(message.rawSize, MAX_PREVIEW_RAW));
 let total = 0;
 try {
  for (;;) {
   const { done, value } = await reader.read(); if (done) break;
   if (!(value instanceof Uint8Array) || total + value.length > message.rawSize || total + value.length > MAX_RAW) throw Error('invalid_raw');
   if (total < preview.length) preview.set(value.subarray(0, preview.length - total), total);
   total += value.length;
  }
  if (total !== message.rawSize) throw Error('invalid_raw');
  return preview;
 } catch { await reader.cancel().catch(() => {}); throw Error('invalid_raw'); }
 finally { reader.releaseLock(); }
}
// Pinned postal-mime 4.0.6 internal collection hook: decode only inline plain text.
// Its default collector synthesizes HTML/text alternatives and extracts attachments.
// Keep this hook covered by fixtures before changing the exact dependency version.
class PlainTextMime extends PostalMime {
 async collectNode(node) {
  const names = node.headers.map(h => h.key);
  if (names.some(n => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(n)) ||
      ['content-type','content-transfer-encoding','content-disposition'].some(n => names.filter(v => v === n).length > 1)) throw Error('ambiguous_mime');
  const type = node.contentType.parsed.value;
  if (/^multipart\//i.test(node.contentType.value) && !node.contentType.multipart) throw Error('invalid_multipart');
  const disposition = node.contentDisposition.parsed;
  // Skip the entire subtree of attachments, named files, and encapsulated messages.
  if ((disposition.value && disposition.value !== 'inline') || disposition.params.filename ||
      node.contentType.parsed.params.name || type === 'message/rfc822') return;
  if (node.contentType.multipart) {
   if (!['alternative','mixed','related'].includes(node.contentType.multipart)) throw Error('unknown_multipart');
   for (const child of node.childNodes) await this.collectNode(child);
  } else if (type === 'text/plain') {
   if (node.contentTransferEncoding.value && !/^(7bit|8bit|quoted-printable|base64)$/i.test(node.contentTransferEncoding.value.trim())) throw Error('unknown_encoding');
   const text = node.getTextContent();
   this.preview = ((this.preview ? this.preview + '\n' : '') + text).slice(0, 10000);
  }
 }
 renderTextContent() {} // No HTML generation or HTML-to-text fallback.
 buildMessage() { return { text: this.preview }; }
}
async function plainPreview(bytes, size) {
 if (size > MAX_PREVIEW_RAW) return PLACEHOLDER;
 try {
  // Require a recognizable bounded header block; don't display malformed raw MIME.
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 32772));
  const split = prefix.search(/\r?\n\r?\n/);
  if (split < 0 || split > 32768) return PLACEHOLDER;
  const result = await new PlainTextMime({ maxNestingDepth: 16, maxPartCount: 100,
   maxHeadersSize: 32768, maxRfc822NestingDepth: 0, forceRfc822Attachments: true }).parse(bytes);
  // eslint-disable-next-line no-control-regex -- Intentional sanitization of control bytes in untrusted email text.
  return typeof result.text === 'string' ? result.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 10000) || '[Empty plain-text message]' : PLACEHOLDER;
 } catch { return PLACEHOLDER; } // Fixed fallback; parser errors never log content or stop forwarding.
}
export async function email(message, env, ctx) {
 void ctx;
 const reject = () => message.setReject('Mail Desk intake unavailable');
 if (env.ENABLE_INBOUND_EMAIL !== 'true') { reject(); return; }
 // Verify at Cloudflare and set as an explicit private binding at activation; never default.
 const forwardTo = env.INBOUND_FORWARD_TO;
 if (!mailbox(forwardTo)) { reject(); return; }
 let claimed = false;
 try {
  const to = typeof message.to === 'string' ? message.to.toLowerCase() : '';
  const channel = Object.keys(senders).find(k => senders[k] === to);
  if (!channel || !mailbox(message.from) || !Number.isSafeInteger(message.rawSize) || message.rawSize <= 0 || message.rawSize > MAX_RAW || message.canBeForwarded === false) { reject(); return; }
  // Envelope only determines routing/reply target. From, To, Reply-To and auth headers never authorize.
  const from = message.from; // Preserve local-part case; do not conflate distinct mailboxes.
  const id = messageId(message.headers.get('message-id'));
  const reply = messageId(message.headers.get('in-reply-to'));
  const refs = referenceIds(message.headers.get('references'));
  if (!id && message.rawSize > MAX_PREVIEW_RAW) { reject(); return; }
  const raw = await readRaw(message);
  const contentHash = id ? null : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), b => b.toString(16).padStart(2, '0')).join('');
  const key = await digest(JSON.stringify([from, to, id || contentHash]));
  const token = crypto.randomUUID(), candidate = crypto.randomUUID(), time = now();
  const parents = [...new Set([reply, ...refs].filter(Boolean))];
  // Thread hints are untrusted: scope to exact envelope sender and accepted mailbox.
  const matches = parents.length ? (await stmt(env.DB, `SELECT message_id,case_id FROM email_receipts WHERE envelope_from=? AND envelope_to=? AND message_id IN (${parents.map(() => '?').join(',')})`, from, to, ...parents).all()).results : [];
  // Every hint must resolve in this scope to the same case. Any ambiguity creates
  // an unlinked case, retaining bounded hints in its receipt for manual review.
  const cases = [...new Set(matches.map(m => m.case_id))];
  const linked = parents.length && cases.length === 1 && parents.every(id => matches.some(m => m.message_id === id));
  const caseId = linked ? cases[0] : candidate;
  // eslint-disable-next-line no-control-regex -- Strip control bytes from untrusted email header before storage.
  const subject = (message.headers.get('subject') || '(No subject)').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
  await env.DB.batch([
   stmt(env.DB, `INSERT INTO email_receipts VALUES (?,?,?,?,?,?,?,?, 'claimed',?,?) ON CONFLICT(receipt_key) DO NOTHING`, key, token, caseId, from, to, id, reply, JSON.stringify(refs), time, time),
   stmt(env.DB, `INSERT INTO cases SELECT ?,?,?,?, ?,0,'',?,? WHERE EXISTS(SELECT 1 FROM email_receipts WHERE claim_token=?) AND NOT EXISTS(SELECT 1 FROM cases WHERE id=?)`, caseId, channel, from, from, subject, time, time, token, caseId),
   stmt(env.DB, `INSERT INTO messages SELECT ?,case_id,'inbound',?,?,NULL FROM email_receipts WHERE claim_token=?`, crypto.randomUUID(), await plainPreview(raw, message.rawSize), time, token),
   stmt(env.DB, `INSERT INTO sync_jobs(id,case_id,kind,next_attempt,created_at) SELECT ?,case_id,'case_created',?,? FROM email_receipts WHERE claim_token=? AND case_id=?`, crypto.randomUUID(), time, time, token, candidate),
   stmt(env.DB, `UPDATE cases SET updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM email_receipts WHERE claim_token=?)`, time, caseId, token)
  ]);
  const receipt = await stmt(env.DB, 'SELECT * FROM email_receipts WHERE receipt_key=?', key).first();
  if (receipt.claim_token !== token) return; // Includes claimed/UNKNOWN: never retry automatically.
  claimed = true;
  // Persist uncertainty BEFORE external side effect. Crash/failure cannot authorize a replay.
  const uncertain = await stmt(env.DB, "UPDATE email_receipts SET forward_state='UNKNOWN',updated_at=? WHERE claim_token=? AND forward_state='claimed' RETURNING claim_token", now(), token).first();
  if (!uncertain) return; // Never forward unless the durable transition actually won.
  await message.forward(forwardTo); // Original MIME; no reconstruction or extra headers.
  await stmt(env.DB, "UPDATE email_receipts SET forward_state='forwarded',updated_at=? WHERE claim_token=? AND forward_state='UNKNOWN'", now(), token).run();
 } catch {
  // Before durable claim: fail closed. After claim: leave durable uncertainty, no SMTP rejection/retry.
  if (!claimed) reject();
 }
}
