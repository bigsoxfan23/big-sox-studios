// Adapted from mail-desk/src/security.mjs at f085940. Deliberately local:
// no Mail Desk changes, session cookies, CSRF secrets, or cross-folder imports.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const requireThat = ok => { if (!ok) throw new Error('unauthorized'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function unb64(value) {
 requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
 const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
 requireThat(b64(bytes) === value);
 return bytes;
}
export const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export function httpsOrigin(value) {
 const url = new URL(value);
 requireThat(url.protocol === 'https:' && url.origin === value && !url.username && !url.password);
 return url;
}
export function validateConfig(env) {
 const issuer = httpsOrigin(env.ACCESS_ISSUER);
 requireThat(/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) && !issuer.port);
 httpsOrigin(env.APP_ORIGIN);
 requireThat(typeof env.ACCESS_AUDIENCE === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(env.ACCESS_AUDIENCE));
 requireThat(typeof env.OWNER_EMAIL === 'string' && /^[^\s@]+@[^\s@]+$/.test(env.OWNER_EMAIL));
}

export function createAuthenticator({ fetcher = fetch, now = () => Date.now() } = {}) {
 // Private to this verifier; tokens and owner identities are never cached.
 const cache = new Map();
 function refresh(issuer, state, rotation = false) {
  if (state.inFlight) return state.inFlight;
  // Retire the previous set immediately. Every request joins this refresh,
  // including requests for previously known keys during a rotation.
  state.keys = new Map(); state.until = 0;
  if (rotation) state.lastRefresh = now();
  // Register the flight before invoking injected fetch code. Only this promise
  // publishes state; timed-out transport/import work cannot roll it back later.
  state.inFlight = Promise.resolve().then(() => load(issuer)).then(result => {
   state.keys = result.keys; state.until = result.until;
  }, error => {
   // Negative cache also bounds retries during an outage or unknown-key attack.
   state.keys = new Map(); state.until = now() + 30000; state.lastRefresh = now();
   throw error;
  }).finally(() => { state.inFlight = null; });
  return state.inFlight;
 }
 async function load(issuer) {
  const controller = new AbortController();
  let timer;
  try {
   const work = async () => {
    // Call as a standalone function: workerd rejects this.fetcher(...).
    const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, { redirect: 'manual', signal: controller.signal });
    requireThat(response.status === 200 && !response.redirected);
    const reader = response.body?.getReader(); requireThat(reader);
    const chunks = []; let size = 0;
    try {
     while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; requireThat(size <= 65536); chunks.push(value);
     }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(decoder.decode(bytes));
    requireThat(object(data) && Array.isArray(data.keys) && data.keys.length > 0 && data.keys.length <= 20);
    const keys = new Map();
    for (const jwk of data.keys) {
     requireThat(object(jwk) && typeof jwk.kid === 'string' && jwk.kid.length > 0 && jwk.kid.length <= 256 && !keys.has(jwk.kid));
     requireThat(jwk.kty === 'RSA' && (jwk.alg === undefined || jwk.alg === 'RS256') && (jwk.use === undefined || jwk.use === 'sig'));
     requireThat(jwk.key_ops === undefined || (Array.isArray(jwk.key_ops) && jwk.key_ops.length === 1 && jwk.key_ops[0] === 'verify'));
     requireThat(!['d','p','q','dp','dq','qi','oth'].some(k => k in jwk));
     const modulus = unb64(jwk.n), exponent = unb64(jwk.e);
     requireThat(modulus.length >= 256 && modulus.length <= 1024 && modulus[0] >= 128 && exponent.length <= 4);
     const e = exponent.reduce((value, byte) => value * 256 + byte, 0);
     requireThat(e >= 3 && e % 2 === 1 && exponent[0] !== 0);
     keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    return { keys, until: now() + 300000 };
   };
   return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('unauthorized')); }, 5000); })]);
  } finally { clearTimeout(timer); controller.abort(); }
 }
 return async function authenticate(request, env) {
  try {
   validateConfig(env);
   const token = request.headers.get('Cf-Access-Jwt-Assertion');
   requireThat(token && token.length < 16384);
   const parts = token.split('.'); requireThat(parts.length === 3);
   const header = JSON.parse(decoder.decode(unb64(parts[0])));
   const claims = JSON.parse(decoder.decode(unb64(parts[1])));
   requireThat(object(header) && object(claims) && header.alg === 'RS256' && typeof header.kid === 'string' && header.kid.length > 0 && header.kid.length <= 256);
   requireThat(!['crit','jku','jwk','x5u','b64'].some(k => k in header));
   requireThat(claims.iss === env.ACCESS_ISSUER && claims.email === env.OWNER_EMAIL);
   requireThat(claims.aud === env.ACCESS_AUDIENCE || (Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.every(a => typeof a === 'string') && claims.aud.includes(env.ACCESS_AUDIENCE)));
   const time = Math.floor(now() / 1000);
   requireThat(['exp','nbf','iat'].every(k => Number.isSafeInteger(claims[k]) && claims[k] >= 0) && claims.exp > time && claims.nbf <= time && claims.iat <= time && claims.iat < claims.exp && claims.nbf < claims.exp);
   const signature = unb64(parts[2]);
   let cached = cache.get(env.ACCESS_ISSUER);
   if (!cached) {
    cached = { keys: new Map(), until: 0, lastRefresh: -Infinity, inFlight: null };
    cache.set(env.ACCESS_ISSUER, cached);
   }
   if (cached.inFlight) await cached.inFlight;
   else if (cached.until <= now()) await refresh(env.ACCESS_ISSUER, cached);
   if (!cached.keys.has(header.kid) && now() - cached.lastRefresh >= 30000) {
    await refresh(env.ACCESS_ISSUER, cached, true);
   }
   // Another waiter may have started a rotation after our first await.
   if (cached.inFlight) await cached.inFlight;
   const key = cached.keys.get(header.kid); requireThat(key);
   requireThat(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`)));
  } catch { throw new Error('unauthorized'); }
 };
}
