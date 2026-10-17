import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

import { PRODUCTION_POLICY_RELEASE, POLICY_CONTRACT, validatePolicyRelease, policyBinding } from './policy-release.mjs';
import { STEPUP_CONTRACT, PRODUCTION_CREDENTIAL_PIN } from './stepup-release.mjs';

export function requireThat(value) {
 if (!value) throw new Error('denied');
}

const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);

// Only trusted operator configuration constructs this URL; request claims never do.
export function accessConfig(env) {
 requireThat(typeof env.ACCESS_TEAM_HOST === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_HOST ?? ''));
 requireThat(bounded(env.ACCESS_AUD, 256) && env.ACCESS_AUD.length >= 16);
 requireThat(bounded(env.OWNER_PRINCIPAL, 256));
 requireThat(bounded(env.OWNER_ACCESS_EMAIL, 254) && /^[^\s@]+@[^\s@]+$/.test(env.OWNER_ACCESS_EMAIL));
 return { issuer: `https://${env.ACCESS_TEAM_HOST}`, audience: env.ACCESS_AUD };
}

// The key resolver seam is for offline local public keys. Production never accepts
// a resolver, identity, MFA result or injected dependency from environment/request.
async function signedOwner(request, env, keyResolver, seconds) {
 const config = accessConfig(env);
 const token = request.headers.get('Cf-Access-Jwt-Assertion');
 requireThat(token && token.length < 16384);
 requireThat(!request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret'));
 const header = decodeProtectedHeader(token);
 requireThat(header.alg === 'RS256' && typeof header.kid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(header.kid));
 requireThat(Object.keys(header).every(key => ['alg', 'kid', 'typ'].includes(key)));
 requireThat(header.typ === undefined || header.typ === 'JWT');
 requireThat(Number.isSafeInteger(seconds) && seconds >= 0);
 const { payload } = await jwtVerify(token, keyResolver, {
  ...config, algorithms: ['RS256'], currentDate: new Date(seconds * 1000),
  requiredClaims: ['iss', 'aud', 'exp', 'iat', 'nbf', 'sub', 'email', 'type'],
  maxTokenAge: '10m', clockTolerance: 0
 });
 requireThat(payload.aud === config.audience || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === config.audience));
 requireThat(payload.type === 'app' && payload.sub === env.OWNER_PRINCIPAL && payload.email === env.OWNER_ACCESS_EMAIL);
 requireThat(Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.nbf) && Number.isSafeInteger(payload.exp));
 requireThat(payload.iat <= seconds && payload.nbf <= seconds && payload.exp > seconds && payload.exp > payload.iat);
 requireThat(payload.iat >= 0 && payload.nbf >= 0 && payload.nbf < payload.exp && seconds - payload.iat <= 600 && payload.exp - payload.iat <= 600);
 if (Object.hasOwn(payload, 'amr')) requireThat(Array.isArray(payload.amr) && payload.amr.length <= 16 && payload.amr.every(value => bounded(value, 128)));
 requireThat(!Object.hasOwn(payload, 'service_token_id') && !Object.hasOwn(payload, 'common_name'));
 return { payload, token };
}

// Identity only: no Cloudflare MFA event, policy evidence, or session cutover claim.
export async function verifySignedOwnerIdentity(request, env, keyResolver, seconds = Math.floor(Date.now() / 1000)) {
 const { payload, token } = await signedOwner(request, env, keyResolver, seconds);
 return Object.freeze({ sub: payload.sub, token, expires: payload.exp, identityContract: 'signed-owner-identity-v1' });
}

// Original signed-AMR contract remains a separate verifier.
export async function verifyAccess(request, env, keyResolver, seconds = Math.floor(Date.now() / 1000)) {
 const { payload, token } = await signedOwner(request, env, keyResolver, seconds);
 requireThat(Array.isArray(payload.amr) && payload.amr.includes('mfa') && payload.amr.every(x => typeof x === 'string'));
 return { sub: payload.sub, token, expires: payload.exp };
}

// Offline resolver/release seams do not supply authority to authenticate().
export async function verifyPolicyAccess(request, env, keyResolver, release, seconds = Math.floor(Date.now() / 1000)) {
 const snapshot = validatePolicyRelease(release, seconds);
 requireThat(env.MFA_CONTRACT === POLICY_CONTRACT);
 requireThat(snapshot.issuer === accessConfig(env).issuer && snapshot.audience === env.ACCESS_AUD &&
  snapshot.origin === env.APP_ORIGIN && snapshot.ownerSub === env.OWNER_PRINCIPAL && snapshot.ownerEmail === env.OWNER_ACCESS_EMAIL);
 const { payload, token } = await signedOwner(request, env, keyResolver, seconds);
 requireThat(payload.iat > snapshot.sessionCutoff);
 // AMR absence is never MFA evidence. This identity carries a distinct reviewed
 // policy-source assurance, with no claim about an individual MFA event/time.
 return Object.freeze({ sub: payload.sub, token, expires: Math.min(payload.exp, snapshot.validUntil),
  assurance: await policyBinding(snapshot, seconds) });
}

const resolvers = new Map();
function remoteResolver(env) {
 const { issuer } = accessConfig(env);
 let resolver = resolvers.get(issuer);
 if (!resolver) {
  resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
   timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 300000
  });
  resolvers.set(issuer, resolver);
 }
 return resolver;
}
export async function authenticateOwnerIdentity(request, env) {
 return verifySignedOwnerIdentity(request, env, remoteResolver(env));
}
// Production sender only: neither legacy mode nor an injected pin can supply
// authority. The coordinator validates the code-owned pin's full record/binding.
export async function authenticateStepupOwner(request, env) {
 requireThat(env.MFA_CONTRACT === STEPUP_CONTRACT);
 requireThat(PRODUCTION_CREDENTIAL_PIN);
 requireThat(env.CANARY_OWNER_MAILBOX === 'fridman.greg@gmail.com');
 return authenticateOwnerIdentity(request, env);
}
// Legacy compatibility only; never the default production sender verifier.
export async function authenticate(request, env) {
 // Exact production recipient restriction, never an environment-selected customer.
 requireThat(env.CANARY_OWNER_MAILBOX === 'fridman.greg@gmail.com');
 const resolver = remoteResolver(env);
 if (env.MFA_CONTRACT === STEPUP_CONTRACT) return verifySignedOwnerIdentity(request, env, resolver);
 if (env.MFA_CONTRACT === POLICY_CONTRACT) return verifyPolicyAccess(request, env, resolver, PRODUCTION_POLICY_RELEASE);
 return verifyAccess(request, env, resolver);
}
