export const DAY = 86400000;
export const ORIGIN = 'https://bigsoxstudios.com';
export const escapeHTML = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export const requireThat = (ok, status = 400) => { if (!ok) throw Object.assign(new Error('request rejected'), {status}); };
export function secret(value) { requireThat(typeof value === 'string' && value.length >= 32 && !/^(?:1x|2x|3x|REPLACE|PLACEHOLDER)/i.test(value), 503); return value; }
export async function hmac(key, value) {
 const encoder = new TextEncoder();
 const imported = await crypto.subtle.importKey('raw', encoder.encode(secret(key)), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function readBody(request, max = 8192) {
 const declared = request.headers.get('Content-Length');
 requireThat(!declared || (/^\d+$/.test(declared) && Number(declared) <= max), 413);
 const reader = request.body?.getReader(); requireThat(reader);
 const chunks = []; let size = 0;
 try { while (true) {
  const {value,done} = await reader.read(); if (done) break;
  size += value.byteLength; requireThat(size <= max, 413); chunks.push(value);
 } } finally { await reader.cancel().catch(()=>{}); }
 const bytes = new Uint8Array(size); let offset = 0;
 for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export function clean(value, max, required = true) {
 requireThat(typeof value === 'string' && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));
 const result = value.normalize('NFC').trim();
 requireThat(result.length <= max && (!required || result.length > 0)); return result;
}
export function sameSite(request, origin) {
 requireThat(new URL(request.url).origin === origin && request.headers.get('Origin') === origin,403);
 const site = request.headers.get('Sec-Fetch-Site');
 requireThat(site === null || site === 'same-origin',403);
}
export function db(env) { requireThat(env.MEMBERSHIP_DB?.prepare,503); return env.MEMBERSHIP_DB; }
export async function sweep(env, time) {
 const database = db(env);
 // At most 100 rows per category per invocation. Repeat daily until caught up.
 await database.batch([
  database.prepare(`UPDATE membership_requests SET status='expired', closed_at=?, updated_at=?, revision=revision+1
   WHERE id IN (SELECT id FROM membership_requests WHERE status='pending' AND created_at<=? ORDER BY created_at LIMIT 100)`)
   .bind(time,time,time-90*DAY),
  database.prepare(`UPDATE membership_requests SET name=NULL,email=NULL,reason=NULL,owner_note=NULL,pii_cleared_at=?,updated_at=?,revision=revision+1
   WHERE id IN (SELECT id FROM membership_requests WHERE status IN ('rejected','revoked','expired') AND closed_at<=? AND pii_cleared_at IS NULL ORDER BY closed_at LIMIT 100)`)
   .bind(time,time,time-30*DAY),
  database.prepare('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE occurred_at<=? ORDER BY occurred_at LIMIT 500)').bind(time-365*DAY)
 ]);
}
