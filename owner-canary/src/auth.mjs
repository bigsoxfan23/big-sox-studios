import { createRemoteJWKSet, jwtVerify } from 'jose';

export function requireThat(value) {
 if (!value) throw new Error('denied');
}

// Only trusted operator configuration constructs this URL; request claims never do.
export function accessConfig(env) {
 requireThat(/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_HOST ?? ''));
 requireThat(typeof env.ACCESS_AUD === 'string' && env.ACCESS_AUD.length >= 16);
 requireThat(typeof env.OWNER_PRINCIPAL === 'string' && env.OWNER_PRINCIPAL.length > 0);
 requireThat(/^[^\s@]+@[^\s@]+$/.test(env.OWNER_ACCESS_EMAIL ?? ''));
 return { issuer: `https://${env.ACCESS_TEAM_HOST}`, audience: env.ACCESS_AUD };
}

// The key resolver seam is for offline local public keys. Production never accepts
// a resolver, identity, MFA result or injected dependency from environment/request.
export async function verifyAccess(request, env, keyResolver, seconds = Date.now() / 1000) {
 const config = accessConfig(env);
 const token = request.headers.get('Cf-Access-Jwt-Assertion');
 requireThat(token && token.length < 16384);
 requireThat(!request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret'));
 const { payload, protectedHeader } = await jwtVerify(token, keyResolver, {
  ...config, algorithms: ['RS256'], currentDate: new Date(seconds * 1000),
  requiredClaims: ['iss', 'aud', 'exp', 'iat', 'nbf', 'sub', 'email', 'type'],
  maxTokenAge: '10m', clockTolerance: 0
 });
 requireThat(typeof protectedHeader.kid === 'string' && protectedHeader.kid.length > 0);
 requireThat(!protectedHeader.jku && !protectedHeader.jwk && !protectedHeader.x5u);
 requireThat(payload.type === 'app' && payload.sub === env.OWNER_PRINCIPAL && payload.email === env.OWNER_ACCESS_EMAIL);
 requireThat(Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.nbf) && Number.isSafeInteger(payload.exp));
 requireThat(payload.iat <= seconds && payload.nbf <= seconds && payload.exp > seconds && payload.exp > payload.iat);
 requireThat(payload.exp - payload.iat <= 600 && payload.nbf >= payload.iat);
 requireThat(Array.isArray(payload.amr) && payload.amr.includes('mfa') && payload.amr.every(x => typeof x === 'string'));
 requireThat(!payload.service_token_id && !payload.common_name);
 return { sub: payload.sub, token, expires: payload.exp };
}

const resolvers = new Map();
export async function authenticate(request, env) {
 const { issuer } = accessConfig(env);
 let resolver = resolvers.get(issuer);
 if (!resolver) {
  resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
   timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 300000
  });
  resolvers.set(issuer, resolver);
 }
 return verifyAccess(request, env, resolver);
}
