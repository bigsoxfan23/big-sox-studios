const enc = new TextEncoder();
export class HttpError extends Error { constructor(status, code) { super(code); this.status = status; } }
export function requireThat(ok, status = 400, code = 'invalid_request') { if (!ok) throw new HttpError(status, code); }
export const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export function unb64(value) {
 requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
 return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function digest(value) { return b64(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function mac(secret, value) { return b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value))); }
export async function verifyMac(secret, value, signature) {
 try { return await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64(signature), enc.encode(value)); } catch { return false; }
}
const jwksCache = new Map();
export function clearJwksCache() { jwksCache.clear(); }
export async function authenticate(request, env, fetcher = fetch) {
 try {
  requireThat(env.ACCESS_ISSUER && env.ACCESS_AUDIENCE && env.OWNER_EMAIL && env.APP_ORIGIN && env.CSRF_SECRET?.length >= 32, 401);
  const issuer = new URL(env.ACCESS_ISSUER);
  requireThat(issuer.protocol === 'https:' && issuer.origin === env.ACCESS_ISSUER && issuer.hostname.endsWith('.cloudflareaccess.com'), 401);
  requireThat(new URL(env.APP_ORIGIN).origin === env.APP_ORIGIN && env.APP_ORIGIN.startsWith('https://'), 401);
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  requireThat(token && token.length < 16384, 401);
  const parts = token.split('.'); requireThat(parts.length === 3, 401);
  const header = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
  requireThat(header.alg === 'RS256' && typeof header.kid === 'string' && !header.crit, 401);
  const now = Math.floor(Date.now() / 1000);
  requireThat(claims.iss === env.ACCESS_ISSUER && (claims.aud === env.ACCESS_AUDIENCE || (Array.isArray(claims.aud) && claims.aud.includes(env.ACCESS_AUDIENCE))) && claims.email === env.OWNER_EMAIL, 401);
  requireThat(['exp','nbf','iat'].every(k => Number.isSafeInteger(claims[k])) && claims.exp > now && claims.nbf <= now && claims.iat <= now && claims.iat <= claims.exp && claims.nbf < claims.exp, 401);
  let cached = jwksCache.get(issuer.origin);
  if (!cached || cached.until <= Date.now()) {
   // Workers rejects redirect: 'error'; manual plus res.ok rejects redirects without following them.
   const res = await fetcher(`${issuer.origin}/cdn-cgi/access/certs`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
   requireThat(res.ok, 401); const data = await res.json();
   requireThat(Array.isArray(data.keys) && data.keys.length <= 20, 401);
   cached = { keys: data.keys, until: Date.now() + 300000 }; jwksCache.set(issuer.origin, cached);
  }
  const jwk = cached.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
  requireThat(jwk, 401);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  requireThat(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`)), 401);
  return { session: await digest(token) };
 } catch { throw new HttpError(401, 'unauthorized'); }
}
function cookie(request) { return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('__Host-maildesk='))?.slice(16); }
export async function sessionProof(request, env, auth, create = false) {
 let value = cookie(request);
 let parts = value?.split('.');
 const valid = parts?.length === 2 && /^[a-f0-9-]{36}$/.test(parts[0]) && await verifyMac(env.CSRF_SECRET, `${auth.session}:${parts[0]}`, parts[1]);
 if (!valid) {
  requireThat(create, 403, 'csrf_denied');
  const nonce = crypto.randomUUID(); value = `${nonce}.${await mac(env.CSRF_SECRET, `${auth.session}:${nonce}`)}`;
 }
 const bound = await digest(`${auth.session}:${value}`);
 return { bound, csrf: await mac(env.CSRF_SECRET, `csrf:${bound}`), cookie: `__Host-maildesk=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` };
}
export async function protectPost(request, env, auth) {
 requireThat(request.headers.get('Origin') === env.APP_ORIGIN, 403, 'origin_denied');
 requireThat(!request.headers.get('Sec-Fetch-Site') || request.headers.get('Sec-Fetch-Site') === 'same-origin', 403, 'origin_denied');
 const proof = await sessionProof(request, env, auth);
 requireThat(await verifyMac(env.CSRF_SECRET, `csrf:${proof.bound}`, request.headers.get('X-CSRF-Token')), 403, 'csrf_denied');
 return proof;
}
export async function readJson(request, allowed) {
 requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 415, 'json_required');
 const length = request.headers.get('Content-Length');
 requireThat(length === null || (/^\d+$/.test(length) && Number(length) <= 20000), 413, 'body_too_large');
 const reader = request.body?.getReader(); requireThat(reader);
 let size = 0; const chunks = [];
 while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 20000) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); } chunks.push(value); }
 requireThat(length === null || Number(length) === size, 400, 'content_length_mismatch');
 const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
 let data; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new HttpError(400, 'invalid_json'); }
 requireThat(data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).every(k => allowed.includes(k)), 400, 'unexpected_fields');
 return data;
}
