import { SignJWT, jwtVerify } from 'jose';
import { authenticate, requireThat } from './auth.mjs';
import { PRODUCTION_POLICY_RELEASE, POLICY_CONTRACT, validatePolicyRelease, policyBinding } from './policy-release.mjs';
import { ledger } from './ledger.mjs';
import { envelope, submitOnce } from './resend.mjs';
import { assets } from './ui-assets.mjs';

const encoder = new TextEncoder();
export const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const cookieName = '__Host-canary';
const headers = {
 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private',
 'Pragma': 'no-cache', 'Vary': 'Cookie, Cf-Access-Jwt-Assertion',
 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
};
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
async function configuration(env, identity, release, time) {
 requireThat(env.DEPLOYMENT_STAGE === 'production');
 requireThat(env.CANARY_SEND_ENABLED === 'owner-canary-v1-approved');
 let policy;
 if (env.MFA_CONTRACT === POLICY_CONTRACT) {
  policy = validatePolicyRelease(release, time);
  const binding = await policyBinding(policy, time);
  requireThat(identity.assurance && Object.keys(identity.assurance).length === Object.keys(binding).length &&
   Object.entries(binding).every(([name, value]) => identity.assurance[name] === value));
  requireThat(policy.issuer === `https://${env.ACCESS_TEAM_HOST}` && policy.audience === env.ACCESS_AUD &&
   policy.origin === env.APP_ORIGIN && policy.ownerSub === env.OWNER_PRINCIPAL && policy.ownerEmail === env.OWNER_ACCESS_EMAIL);
  requireThat(identity.sub === policy.ownerSub && Number.isSafeInteger(identity.expires) && identity.expires <= policy.validUntil);
 } else {
  requireThat(env.MFA_CONTRACT === 'signed-amr-mfa-v1' && !identity.assurance);
 }
 requireThat(/^re_[A-Za-z0-9_-]{20,}$/.test(env.RESEND_API_KEY ?? ''));
 requireThat(typeof env.APPROVAL_SIGNING_KEY === 'string' && /^[A-Za-z0-9_-]{64,}$/.test(env.APPROVAL_SIGNING_KEY));
 requireThat(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.CANARY_CAMPAIGN_ID ?? ''));
 requireThat(/^[a-zA-Z0-9_-]{16,}$/.test(env.SESSION_EPOCH ?? ''));
 const origin = new URL(env.APP_ORIGIN);
 requireThat(origin.protocol === 'https:' && origin.origin === env.APP_ORIGIN);
 const payload = envelope(env.CANARY_OWNER_MAILBOX);
 return JSON.stringify({ purpose: 'owner-direct-canary-v1', version: 1,
  campaign: env.CANARY_CAMPAIGN_ID, origin: origin.origin,
  owner: env.OWNER_PRINCIPAL, ownerEmail: env.OWNER_ACCESS_EMAIL,
  team: env.ACCESS_TEAM_HOST, audience: env.ACCESS_AUD,
  epoch: env.SESSION_EPOCH, mfa: env.MFA_CONTRACT, ...(policy ? { policy, assurance: identity.assurance } : {}), payload });
}
async function capability(row, stage, key, time) {
 return new SignJWT({ purpose: 'owner-direct-canary-v1', stage, digest: row.digest, binding: row.binding })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('owner-canary')
  .setAudience('owner-canary-stages').setSubject(row.campaign).setJti(crypto.randomUUID())
  .setIssuedAt(time).setExpirationTime(row.expires).sign(key);
}

// Controlled offline factory. Dependency injection is not a production trust
// source. The default entrypoint below fixes the real verifier and disables send.
export function createCandidate({ verify, transport, dispatchAuthorized = false, policyRelease = PRODUCTION_POLICY_RELEASE, now = () => Math.floor(Date.now() / 1000) }) {
 return { async fetch(request, env) {
  try {
   const identity = await verify(request, env);
   const time = now(), key = encoder.encode(env.APPROVAL_SIGNING_KEY);
   const snapshot = await configuration(env, identity, policyRelease, time), hash = await digest(snapshot);
   requireThat(identity.expires > time);
   const url = new URL(request.url);
   requireThat(url.origin === env.APP_ORIGIN && !url.search && !url.hash);
   // Every asset passes the same signed identity, MFA, configuration and origin
   // checks as JSON. No ASSETS binding or independently public asset route.
   if (request.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
    requireThat(!request.headers.has('Origin') || request.headers.get('Origin') === env.APP_ORIGIN);
    requireThat(!request.headers.has('Sec-Fetch-Site') || ['same-origin', 'none'].includes(request.headers.get('Sec-Fetch-Site')));
    const asset = assets[url.pathname];
    return new Response(asset.body, { headers: { ...headers, 'Content-Type': asset.type,
     'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
     'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
     'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' } });
   }
   const store = ledger(env.CANARY_DB);
   if (request.method === 'GET' && url.pathname === '/status') {
    const row = await store.get();
    return json({ status: row?.status ?? 'empty', delivery: 'unverified', sendAuthority: dispatchAuthorized });
   }
   requireThat(request.method === 'POST');
   requireThat(['/preview', '/review', '/approve', '/dispatch'].includes(url.pathname));
   requireThat(request.headers.get('Origin') === env.APP_ORIGIN);
   requireThat(request.headers.get('Sec-Fetch-Site') === 'same-origin');
   requireThat(request.headers.get('Content-Type') === 'application/json');
   requireThat(request.headers.get('X-Canary-Action') === url.pathname.slice(1));
   requireThat(!request.headers.has('Authorization'));
   // Stream-bounded input; no envelope/content fields are ever accepted.
   const reader = request.body?.getReader();
   requireThat(reader);
   let bytes = 0, raw = '';
   const decoder = new TextDecoder('utf-8', { fatal: true });
   while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 4096) { await reader.cancel(); throw new Error('denied'); }
    raw += decoder.decode(value, { stream: true });
   }
   const body = JSON.parse(raw + decoder.decode());
   requireThat(body && !Array.isArray(body) && typeof body === 'object');
   if (url.pathname === '/preview') {
    requireThat(Object.keys(body).length === 0);
    const session = crypto.randomUUID();
    const binding = await digest(`${identity.sub}\n${await digest(identity.token)}\n${session}`);
    const row = { campaign: env.CANARY_CAMPAIGN_ID, snapshot, digest: hash, binding,
     created: time, expires: Math.min(time + 300, identity.expires) };
    requireThat(row.expires > time);
    const token = await capability(row, 'previewed', key, time);
    row.capability = await digest(token);
    requireThat(await store.initialize(row));
    return json({ campaign: row.campaign, snapshot: JSON.parse(snapshot), expires: row.expires, token }, 201,
     { 'Set-Cookie': `${cookieName}=${session}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=300` });
   }
   requireThat(Object.keys(body).length === 1 && typeof body.token === 'string' && body.token.length < 3000);
   const cookies = (request.headers.get('Cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`));
   requireThat(cookies.length === 1);
   const session = cookies[0].slice(cookieName.length + 1);
   requireThat(/^[0-9a-f-]{36}$/.test(session));
   const binding = await digest(`${identity.sub}\n${await digest(identity.token)}\n${session}`);
   const { payload } = await jwtVerify(body.token, key, { algorithms: ['HS256'], issuer: 'owner-canary',
    audience: 'owner-canary-stages', currentDate: new Date(time * 1000), requiredClaims: ['exp', 'iat', 'jti', 'sub'] });
   const row = await store.get();
   requireThat(row && row.snapshot === snapshot && row.digest === hash && row.binding === binding);
   requireThat(row.expires > time && payload.exp === row.expires && payload.iat <= time);
   requireThat(payload.sub === row.campaign && payload.digest === hash && payload.binding === binding);
   requireThat(payload.purpose === 'owner-direct-canary-v1' && payload.stage === row.status);
   requireThat(await digest(body.token) === row.capability);
   const next = { '/review': ['previewed', 'reviewed'], '/approve': ['reviewed', 'approved'], '/dispatch': ['approved', 'submitted'] }[url.pathname];
   requireThat(row.status === next[0]);
   if (url.pathname !== '/dispatch') {
    const token = await capability(row, next[1], key, time);
    requireThat(await store.advance(next[0], next[1], row, await digest(token), time));
    return json({ status: next[1], token, expires: row.expires, delivery: 'unverified' });
   }
   requireThat(dispatchAuthorized);
   // Recheck time immediately before CAS; a consumed claim can NEVER be retried.
   requireThat(identity.expires > now());
   const claimed = await store.advance('approved', 'submitted', row, row.capability, now());
   requireThat(claimed);
   const outcome = claimed.expires > now() && identity.expires > now()
    ? await submitOnce(claimed, env, transport) : { status: 'UNKNOWN' };
   try {
    requireThat(await store.finish(outcome, now()));
   } catch { return json({ status: 'UNKNOWN', delivery: 'unverified', retry: false }, 503); }
   return json({ status: outcome.status, delivery: 'unverified', retry: false });
  } catch { return json({ error: 'canary_unavailable' }, 503); }
 } };
}

// HARD RELEASE BLOCK: actual authentication assurance evidence and final
// deployment/send authorization have not been established. No environment flag overrides this.
export default createCandidate({ verify: authenticate, transport: fetch, dispatchAuthorized: false });
