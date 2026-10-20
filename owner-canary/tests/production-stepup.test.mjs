import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, fixture, resolver } from './helpers.mjs';
import { authenticator, stepupFixture } from './stepup-fixtures.mjs';
import { authenticateStepupOwner, verifyAccess, verifyPolicyAccess, verifySignedOwnerIdentity } from '../src/auth.mjs';
import { POLICY_CONTRACT } from '../src/policy-release.mjs';
import { STEPUP_CONTRACT, PRODUCTION_CREDENTIAL_PIN, FINAL_OWNER_CONFIRMATION } from '../src/stepup-release.mjs';
import production, { createCandidate } from '../src/worker.mjs';
import { assertion, fingerprint, pinnedRecord } from '../src/stepup.mjs';

const confirmedPin = {
 credentialID: 'MANaCK7rJfDfUuXeSlx46S4ypCw',
 publicKey: 'pQECAyYgASFYINcxjXlys_igeNRhUyf9UKeHO_H1Vs3aak-7y7CzVdInIlggkRNP2BSEiVzRHn7DReQZzhdf88DJVrCEo_Ptk_qHdsE',
 algorithm: -7, rpID: 'canary.bigsoxstudios.com', origin: 'https://canary.bigsoxstudios.com',
 owner: '19e39702-51ab-52dc-9172-91bcb059ec5d', email: 'fridman.greg@gmail.com',
 epoch: 'owner-canary-webauthn-v1-20261016'
};
const confirmedFingerprint = 'sha256:798d9a0ac8aefeb35ac0f64c29341c4962539e051d396fd82a41bcb29c973584';
const pinEnvironment = () => ({ APP_ORIGIN: confirmedPin.origin, OWNER_PRINCIPAL: confirmedPin.owner,
 OWNER_ACCESS_EMAIL: confirmedPin.email, SESSION_EPOCH: confirmedPin.epoch });
const pinIdentity = () => ({ sub: confirmedPin.owner, identityContract: 'signed-owner-identity-v1' });

test('production pin contains exactly the owner-confirmed canonical public bytes and is immutable', async () => {
 assert.deepEqual(PRODUCTION_CREDENTIAL_PIN, confirmedPin);
 assert.equal(await fingerprint(PRODUCTION_CREDENTIAL_PIN), confirmedFingerprint);
 assert.ok(Object.isFrozen(PRODUCTION_CREDENTIAL_PIN));
 for (const field of Object.keys(confirmedPin)) {
  assert.throws(() => { PRODUCTION_CREDENTIAL_PIN[field] = 'forged'; }, TypeError);
  assert.throws(() => { delete PRODUCTION_CREDENTIAL_PIN[field]; }, TypeError);
 }
 assert.throws(() => { PRODUCTION_CREDENTIAL_PIN.candidateID = 'forged'; }, TypeError);
 assert.deepEqual(pinnedRecord(PRODUCTION_CREDENTIAL_PIN, pinEnvironment(), pinIdentity()), confirmedPin);
 assert.ok(Object.isFrozen(FINAL_OWNER_CONFIRMATION)); assert.deepEqual(Object.keys(FINAL_OWNER_CONFIRMATION).sort(), ['configDigest', 'envelopeDigest', 'epoch']);
});

for (const [field, value] of Object.entries({ APP_ORIGIN: 'https://other.test', OWNER_PRINCIPAL: 'other-owner',
 OWNER_ACCESS_EMAIL: 'other@identity.test', SESSION_EPOCH: 'other-release-epoch-v1' })) {
 test(`confirmed pin rejects mismatched ${field}`, () => {
  assert.throws(() => pinnedRecord(PRODUCTION_CREDENTIAL_PIN, { ...pinEnvironment(), [field]: value }, pinIdentity()));
 });
}
test('confirmed pin rejects substituted signed identity and RP ID', () => {
 assert.throws(() => pinnedRecord(PRODUCTION_CREDENTIAL_PIN, pinEnvironment(), { ...pinIdentity(), sub: 'other' }));
 assert.throws(() => pinnedRecord({ ...confirmedPin, rpID: 'other.test' }, pinEnvironment(), pinIdentity()));
});
test('every public credential field participates in the confirmed fingerprint', async () => {
 const other = authenticator().record;
 for (const patch of [{ credentialID: other.credentialID }, { publicKey: other.publicKey },
  { owner: 'other' }, { email: 'other@identity.test' }, { epoch: 'other-release-epoch-v1' },
  { rpID: 'other.test', origin: 'https://other.test' }]) {
  assert.notEqual(await fingerprint({ ...confirmedPin, ...patch }), confirmedFingerprint);
 }
 await assert.rejects(fingerprint({ ...confirmedPin, algorithm: -257 }));
});
test('forged candidate with matching credential ID and bindings cannot sign for the confirmed key', async () => {
 const forged = authenticator();
 Object.assign(forged.record, confirmedPin, { publicKey: forged.record.publicKey });
 const challenge = Buffer.alloc(32, 9).toString('base64url');
 const response = forged.assert(challenge);
 await assertion(response, { challenge }, forged.record);
 await assert.rejects(assertion(response, { challenge }, PRODUCTION_CREDENTIAL_PIN));
 assert.deepEqual(PRODUCTION_CREDENTIAL_PIN, confirmedPin);
});
test('factory defaults use the confirmed pin; forged proof and environment candidate cannot spend campaign', async t => {
 const s = await stepupFixture(t);
 Object.assign(s.f.env, pinEnvironment(), { CANARY_OWNER_MAILBOX: confirmedPin.email,
  credentialPin: s.auth.record, PRODUCTION_CREDENTIAL_PIN: s.auth.record, dispatchAuthorized: true,
  FINAL_OWNER_CONFIRMATION: { approved: true } });
 s.setToken(await access({ sub: confirmedPin.owner, email: confirmedPin.email, amr: undefined }));
 const target = createCandidate({ verify: s.deps.verify, transport: s.deps.transport, now: s.now });
 const status = await s.call('/status', {}, { target, method: 'GET', body: undefined });
 assert.equal(status.r.status, 200); assert.equal(status.data.sendAuthority, false);
 assert.equal((await s.call('/preview', { proof: 'A'.repeat(43) }, { target })).r.status, 503);
 assert.equal((await s.call('/dispatch', { token: 'forged', proof: 'A'.repeat(43) }, { target })).r.status, 503);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
 assert.deepEqual(PRODUCTION_CREDENTIAL_PIN, confirmedPin); assert.ok(Object.isFrozen(FINAL_OWNER_CONFIRMATION)); assert.deepEqual(Object.keys(FINAL_OWNER_CONFIRMATION).sort(), ['configDigest', 'envelopeDigest', 'epoch']);
});
test('exact production mode and owner reject invalid issuer configuration before external JWKS despite injected resolver', async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 let injected = 0;
 const env = { ...f.env, MFA_CONTRACT: STEPUP_CONTRACT, CANARY_OWNER_MAILBOX: confirmedPin.email,
  ACCESS_TEAM_HOST: 'denied.invalid', keyResolver: () => { injected++; return resolver; } };
 await assert.rejects(authenticateStepupOwner(f.request('/status'), env), { message: 'denied' });
 assert.equal((await production.fetch(f.request('/status'), env)).status, 503);
 assert.equal(injected, 0); assert.equal(f.row(), undefined); assert.equal(f.sends, 0);
});

// Synthetic, valid legacy policy authority for offline compatibility only.
function policy(env, time) {
 const ref = `sha256:${'a'.repeat(64)}`;
 return { contract: POLICY_CONTRACT, accountId: 'a'.repeat(32),
  appId: '11111111-1111-4111-8111-111111111111', policyId: '22222222-2222-4222-8222-222222222222',
  audience: env.ACCESS_AUD, issuer: `https://${env.ACCESS_TEAM_HOST}`, origin: env.APP_ORIGIN,
  ownerSub: env.OWNER_PRINCIPAL, ownerEmail: env.OWNER_ACCESS_EMAIL,
  effectivePolicyDigest: ref, sessionCutoff: time - 1, validFrom: time, validUntil: time + 120,
  evidence: { completeEffectivePolicy: ref, independentMfaEnforcement: ref,
   sessionCutover: ref, configurationFreeze: ref, independentReview: ref } };
}

for (const mode of ['signed-amr-mfa-v1', POLICY_CONTRACT, STEPUP_CONTRACT, undefined, 'unknown', `${STEPUP_CONTRACT} `]) {
 for (const signedAMR of [true, false]) test(`production rejects mode ${String(mode)} with valid signed ${signedAMR ? 'AMR' : 'identity'} and forged release authority`, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const time = Math.floor(Date.now() / 1000);
  const token = await access({ iat: time, nbf: time, exp: time + 600, amr: signedAMR ? ['pwd', 'mfa'] : undefined });
  let injected = 0;
  const forbidden = () => { injected++; throw new Error('injected authority'); };
  const pin = authenticator().record;
  const confirmation = { configDigest: 'a'.repeat(64), envelopeDigest: 'b'.repeat(64), epoch: f.env.SESSION_EPOCH };
  // Exact mode must fail at the recipient gate before production JWKS/network.
  // Other modes use the exact owner to independently exercise strict mode denial.
  const env = { ...f.env, CANARY_OWNER_MAILBOX: mode === STEPUP_CONTRACT ? 'denied@recipient.test' : 'fridman.greg@gmail.com', MFA_CONTRACT: mode,
   credentialPin: pin, PRODUCTION_CREDENTIAL_PIN: pin, finalConfirmation: confirmation, FINAL_OWNER_CONFIRMATION: confirmation,
   verify: forbidden, authenticateStepupOwner: forbidden, createCandidate: forbidden, transport: forbidden,
   keyResolver: forbidden, now: () => time, dispatchAuthorized: true };
  env.policyRelease = env.PRODUCTION_POLICY_RELEASE = policy(env, time);
  const request = path => f.request(path, {}, { headers: { 'Cf-Access-Jwt-Assertion': token,
   'X-Credential-Pin': JSON.stringify(pin), 'X-Final-Owner-Confirmation': JSON.stringify(confirmation), mfa: 'true' } });
  // Prove these are legitimate signed legacy identities, not malformed JWT negatives.
  const identity = await verifySignedOwnerIdentity(request('/preview'), env, resolver, time);
  assert.equal(identity.sub, env.OWNER_PRINCIPAL);
  if (signedAMR) assert.equal((await verifyAccess(request('/preview'), env, resolver, time)).sub, identity.sub);
  if (mode === POLICY_CONTRACT) assert.equal((await verifyPolicyAccess(request('/preview'), env, resolver, env.policyRelease, time)).assurance.contract, POLICY_CONTRACT);
  assert.deepEqual(PRODUCTION_CREDENTIAL_PIN, confirmedPin); assert.ok(Object.isFrozen(FINAL_OWNER_CONFIRMATION)); assert.deepEqual(Object.keys(FINAL_OWNER_CONFIRMATION).sort(), ['configDigest', 'envelopeDigest', 'epoch']);
  // Extra caller arguments cannot replace the module-owned pin or verifier.
  await assert.rejects(authenticateStepupOwner(request('/preview'), env, { credentialPin: pin, keyResolver: resolver }), { message: 'denied' });
  for (const path of ['/', '/status', '/stepup/session', '/preview', '/dispatch']) {
   const response = await production.fetch(request(path), env);
   assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'canary_unavailable' });
  }
  assert.equal(injected, 0); assert.equal(f.row(), undefined); assert.equal(f.sends, 0);
 });
}

test('offline factory credential injection cannot replace the production code pin', async t => {
 const s = await stepupFixture(t);
 const offline = createCandidate(s.deps);
 assert.equal((await s.call('/status', {}, { target: offline, method: 'GET', body: undefined })).r.status, 200);
 const env = { ...s.f.env, CANARY_OWNER_MAILBOX: 'denied@recipient.test', ...s.deps };
 assert.equal((await s.call('/status', {}, { target: production, env, method: 'GET', body: undefined })).r.status, 503);
 assert.deepEqual(PRODUCTION_CREDENTIAL_PIN, confirmedPin); assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});

test('default sender fixes the strict production verifier and exact release dispatch independently of offline factories', () => {
 const worker = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
 // Keep the historical local alias used by unchanged baseline boundary tests.
 assert.match(worker, /import \{ authenticateStepupOwner as authenticate, requireThat \} from '\.\/auth\.mjs'/);
 assert.match(worker, /export default createCandidate\(\{ verify: authenticate, transport: fetch,\s*dispatchAuthorized: OWNER_CONFIRMED_RELEASE, enforceRelease: true \}\)/);
 assert.deepEqual(PRODUCTION_CREDENTIAL_PIN, confirmedPin); assert.ok(Object.isFrozen(FINAL_OWNER_CONFIRMATION)); assert.deepEqual(Object.keys(FINAL_OWNER_CONFIRMATION).sort(), ['configDigest', 'envelopeDigest', 'epoch']);
});
