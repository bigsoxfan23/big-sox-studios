// Code-owned authority only. Evidence is incomplete: never populate from env,
// HTTP, a fixture, API response or an operator MFA boolean.
export const PRODUCTION_POLICY_RELEASE = null;
export const POLICY_CONTRACT = 'reviewed-policy-release-v1';
const deny = value => { if (!value) throw new Error('denied'); };
const fields = ['contract', 'accountId', 'appId', 'policyId', 'audience', 'issuer', 'origin', 'ownerSub', 'ownerEmail', 'effectivePolicyDigest', 'sessionCutoff', 'validFrom', 'validUntil', 'evidence'];
const evidenceFields = ['completeEffectivePolicy', 'independentMfaEnforcement', 'sessionCutover', 'configurationFreeze', 'independentReview'];
const exact = (value, names) => {
 deny(value && Object.getPrototypeOf(value) === Object.prototype);
 deny(Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
};
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
const second = value => Number.isSafeInteger(value) && value >= 0;
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

// Bounded exact schema; external evidence remains an independent review gate.
// The digest covers the FULL canonical effective evidence artifact, not a chosen
// subset of API fields. References identify nonsecret, immutable review artifacts.
export function validatePolicyRelease(release, seconds) {
 exact(release, fields);
 deny(second(seconds));
 deny(release.contract === POLICY_CONTRACT);
 deny(typeof release.accountId === 'string' && /^[0-9a-f]{32}$/.test(release.accountId));
 for (const id of [release.appId, release.policyId]) deny(typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
 deny(bounded(release.audience, 256) && release.audience.length >= 16);
 deny(typeof release.issuer === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(release.issuer));
 deny(bounded(release.origin, 2048));
 const origin = new URL(release.origin);
 deny(origin.protocol === 'https:' && origin.origin === release.origin);
 deny(bounded(release.ownerSub, 256));
 deny(bounded(release.ownerEmail, 254) && /^[^\s@]+@[^\s@]+$/.test(release.ownerEmail));
 deny(typeof release.effectivePolicyDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(release.effectivePolicyDigest));
 deny(second(release.sessionCutoff) && second(release.validFrom) && second(release.validUntil));
 deny(release.sessionCutoff <= release.validFrom && release.validUntil > release.validFrom && release.validUntil - release.validFrom <= 600);
 deny(seconds >= release.validFrom && seconds < release.validUntil);
 exact(release.evidence, evidenceFields);
 const evidence = {};
 for (const name of evidenceFields) {
  deny(bounded(release.evidence[name], 256) && /^sha256:[0-9a-f]{64}$/.test(release.evidence[name]));
  evidence[name] = release.evidence[name];
 }
 // Canonical order independent of insertion order; return a detached frozen copy.
 return Object.freeze(Object.fromEntries(fields.map(name => [name, name === 'evidence' ? Object.freeze(evidence) : release[name]])));
}

export async function policyBinding(release, seconds) {
 const snapshot = validatePolicyRelease(release, seconds);
 return Object.freeze({ contract: POLICY_CONTRACT,
  releaseDigest: `sha256:${await hash(JSON.stringify(snapshot))}`,
  evidenceDigest: snapshot.effectivePolicyDigest, sessionCutoff: snapshot.sessionCutoff,
  validFrom: snapshot.validFrom, validUntil: snapshot.validUntil });
}
