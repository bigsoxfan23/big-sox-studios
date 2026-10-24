// Only a server-owned, reviewed resolver may translate verified Access claims
// into a provider-stable identity. Access `sub`/email alone is NOT that proof.
const verified = new WeakSet();
export function normalizeEmail(value) {
 if (typeof value !== 'string' || value.length > 254 || value !== value.trim() || /[^\x21-\x7e]/.test(value)) throw Error('invalid email');
 // Preserve local-part case, dots and plus tags. Lowercase DNS domain only.
 const match = /^([A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)$/.exec(value);
 if (!match || match[1].length > 64 || match[2].split('.').some(x => x.length > 63)) throw Error('invalid email');
 return `${match[1]}@${match[2].toLowerCase()}`;
}
export function requireIdentity(identity, now = Math.floor(Date.now()/1000)) {
 if (!verified.has(identity) || !Number.isSafeInteger(now) || identity.expiresAt <= now) throw Error('verified identity required');
 return identity;
}
export function createIdentityAuthenticator({authenticate, resolveVerifiedIdentity} = {}) {
 return async (request, env) => {
  if (typeof authenticate !== 'function' || typeof resolveVerifiedIdentity !== 'function') throw Error('provider mapping unavailable');
  const claims = await authenticate(request, env);
  // Resolver must independently verify upstream/broker issuer, audience, nonce,
  // signature, provider subject, verified email and connection to THIS session.
  const proof = await resolveVerifiedIdentity(claims, request, env);
  if (!proof || proof.accessSubject !== claims.sub || proof.emailVerified !== true || proof.stableSubjectVerified !== true || proof.mfaVerified !== true ||
   !['google','otp','apple'].includes(proof.provider) || typeof proof.subject !== 'string' || !proof.subject.length || proof.subject.length > 512 || [...proof.subject].some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127) ||
   !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt > claims.exp) throw Error('identity unavailable');
  const identity = Object.freeze({provider:proof.provider,subject:proof.subject,email:normalizeEmail(proof.email),expiresAt:proof.expiresAt});
  verified.add(identity);
  return identity;
 };
}
