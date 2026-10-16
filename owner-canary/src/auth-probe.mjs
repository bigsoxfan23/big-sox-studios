import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

// Diagnostic only. NEVER import this as a sending or approval verifier.
const requireThat = value => { if (!value) throw new Error('denied'); };
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && value.split('').every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127);
const headers = {
 'Content-Type': 'application/json; charset=utf-8',
 'Cache-Control': 'no-store, private',
 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox",
 'X-Content-Type-Options': 'nosniff',
 'Referrer-Policy': 'no-referrer',
 'X-Frame-Options': 'DENY'
};

function config(env) {
 requireThat(env.AUTH_PROBE_ENABLED === 'owner-auth-diagnostic-v1');
 requireThat(typeof env.ACCESS_TEAM_HOST === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_HOST));
 requireThat(bounded(env.ACCESS_AUD, 256) && env.ACCESS_AUD.length >= 16);
 requireThat(bounded(env.OWNER_ACCESS_EMAIL, 254) && /^[^\s@]+@[^\s@]+$/.test(env.OWNER_ACCESS_EMAIL));
 requireThat(bounded(env.APP_ORIGIN, 2048));
 const origin = new URL(env.APP_ORIGIN);
 requireThat(origin.protocol === 'https:' && origin.origin === env.APP_ORIGIN);
 return { issuer: `https://${env.ACCESS_TEAM_HOST}`, audience: env.ACCESS_AUD };
}

// Offline seams only: the deployed default below fixes the clock and resolver.
// No request, environment binding or claim can supply dependencies or authority.
export function createAuthProbe({ keyResolver, now = () => Math.floor(Date.now() / 1000) } = {}) {
 let pinnedIssuer, pinnedResolver;
 return { async fetch(request, env) {
  try {
   const settings = config(env);
   requireThat(request.method === 'GET' && request.url === `${env.APP_ORIGIN}/`);
   requireThat(!request.headers.has('Origin') || request.headers.get('Origin') === env.APP_ORIGIN);
   requireThat(!request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret'));
   const token = request.headers.get('Cf-Access-Jwt-Assertion');
   requireThat(typeof token === 'string' && token.length > 0 && token.length < 16384);
   // Inspect only header syntax before verification; never trust decoded claims.
   const header = decodeProtectedHeader(token);
   requireThat(header.alg === 'RS256' && typeof header.kid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(header.kid));
   requireThat(Object.keys(header).every(key => ['alg', 'kid', 'typ'].includes(key)));
   requireThat(header.typ === undefined || header.typ === 'JWT');
   const seconds = now();
   requireThat(Number.isSafeInteger(seconds) && seconds >= 0);
   if (!keyResolver && pinnedIssuer !== settings.issuer) {
    pinnedResolver = createRemoteJWKSet(new URL(`${settings.issuer}/cdn-cgi/access/certs`), {
     timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 300000
    });
    pinnedIssuer = settings.issuer;
   }
   const { payload } = await jwtVerify(token, keyResolver ?? pinnedResolver, {
    ...settings, algorithms: ['RS256'], currentDate: new Date(seconds * 1000),
    requiredClaims: ['iss', 'aud', 'iat', 'exp', 'sub', 'email', 'type'],
    maxTokenAge: 600, clockTolerance: 0
   });
   requireThat((payload.aud === settings.audience ||
    (Array.isArray(payload.aud) && payload.aud.length === 1 && typeof payload.aud[0] === 'string' && payload.aud[0] === settings.audience)) && payload.type === 'app');
   requireThat(!Object.hasOwn(payload, 'common_name') && !Object.hasOwn(payload, 'service_token_id'));
   requireThat(bounded(payload.sub, 256) && bounded(payload.email, 254) && payload.email === env.OWNER_ACCESS_EMAIL);
   requireThat(Number.isSafeInteger(payload.iat) && payload.iat >= 0 && Number.isSafeInteger(payload.exp));
   requireThat(payload.iat <= seconds && seconds - payload.iat <= 600 && payload.exp > seconds && payload.exp > payload.iat && payload.exp - payload.iat <= 600);
   const nbfPresent = Object.hasOwn(payload, 'nbf');
   if (nbfPresent) requireThat(Number.isSafeInteger(payload.nbf) && payload.nbf >= 0 && payload.nbf <= seconds && payload.nbf < payload.exp);
   const amrPresent = Object.hasOwn(payload, 'amr');
   if (amrPresent) requireThat(Array.isArray(payload.amr) && payload.amr.length <= 16 && payload.amr.every(value => bounded(value, 128)));
   return new Response(JSON.stringify({
    sub: payload.sub, email: payload.email, iss: payload.iss, aud: payload.aud,
    iat: payload.iat, nbf: nbfPresent ? payload.nbf : null, exp: payload.exp,
    nbfPresent, amrPresent, ...(amrPresent ? { amr: payload.amr } : {}),
    sendAuthority: false, mfaVerified: false, diagnosticOnly: true
   }), { headers });
  } catch {
   return new Response(JSON.stringify({ error: 'auth_unavailable' }), { status: 503, headers });
  }
 } };
}

export default createAuthProbe();
