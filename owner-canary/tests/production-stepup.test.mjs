import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, fixture, resolver } from './helpers.mjs';
import { authenticator, stepupFixture } from './stepup-fixtures.mjs';
import { authenticateStepupOwner, verifyAccess, verifyPolicyAccess, verifySignedOwnerIdentity } from '../src/auth.mjs';
import { POLICY_CONTRACT } from '../src/policy-release.mjs';
import { STEPUP_CONTRACT, PRODUCTION_CREDENTIAL_PIN, FINAL_OWNER_CONFIRMATION } from '../src/stepup-release.mjs';
import production, { createCandidate } from '../src/worker.mjs';

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
  const env = { ...f.env, CANARY_OWNER_MAILBOX: 'fridman.greg@gmail.com', MFA_CONTRACT: mode,
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
  assert.equal(PRODUCTION_CREDENTIAL_PIN, null); assert.equal(FINAL_OWNER_CONFIRMATION, null);
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
 const env = { ...s.f.env, CANARY_OWNER_MAILBOX: 'fridman.greg@gmail.com', ...s.deps };
 assert.equal((await s.call('/status', {}, { target: production, env, method: 'GET', body: undefined })).r.status, 503);
 assert.equal(PRODUCTION_CREDENTIAL_PIN, null); assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});

test('default sender fixes the strict production verifier and disabled dispatch independently of offline factories', () => {
 const worker = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
 // Keep the historical local alias used by unchanged baseline boundary tests.
 assert.match(worker, /import \{ authenticateStepupOwner as authenticate, requireThat \} from '\.\/auth\.mjs'/);
 assert.match(worker, /export default createCandidate\(\{ verify: authenticate, transport: fetch, dispatchAuthorized: false \}\)/);
 assert.equal(PRODUCTION_CREDENTIAL_PIN, null); assert.equal(FINAL_OWNER_CONFIRMATION, null);
});
