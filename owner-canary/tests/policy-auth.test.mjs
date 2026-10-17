import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyAccess, verifyPolicyAccess, authenticate } from '../src/auth.mjs';
import { PRODUCTION_POLICY_RELEASE, POLICY_CONTRACT, validatePolicyRelease, policyBinding } from '../src/policy-release.mjs';
import production, { createCandidate } from '../src/worker.mjs';
import { access, keys, resolver, timestamp as time, environment, fixture } from './helpers.mjs';

// Invented offline values ONLY. No real account/policy/identity or live evidence.
const ref = char => `sha256:${char.repeat(64)}`;
const release = () => ({
 contract: POLICY_CONTRACT, accountId: 'a'.repeat(32),
 appId: '11111111-1111-4111-8111-111111111111', policyId: '22222222-2222-4222-8222-222222222222',
 audience: 'offline-audience-only', issuer: 'https://offline-test.cloudflareaccess.com',
 origin: 'https://canary.test', ownerSub: 'offline-owner-sub', ownerEmail: 'owner@identity.test',
 effectivePolicyDigest: ref('a'), sessionCutoff: time - 1, validFrom: time, validUntil: time + 120,
 evidence: { completeEffectivePolicy: ref('b'), independentMfaEnforcement: ref('c'),
  sessionCutover: ref('d'), configurationFreeze: ref('e'), independentReview: ref('f') }
});
const settings = () => ({ ...environment(), MFA_CONTRACT: POLICY_CONTRACT });
const request = (token, headers = {}) => new Request('https://canary.test/preview', { headers: { 'Cf-Access-Jwt-Assertion': token, ...headers } });
const check = async (claims = {}, snapshot = release(), seconds = time, env = settings(), header = {}) =>
 verifyPolicyAccess(request(await access({ amr: undefined, ...claims }, keys.privateKey, header)), env, resolver, snapshot, seconds);

test('signed owner without AMR has distinct policy assurance, bounded by evidence expiry', async () => {
 const identity = await check({ nbf: time - 100, aud: [settings().ACCESS_AUD] });
 assert.equal(identity.expires, time + 120);
 assert.deepEqual(identity.assurance, await policyBinding(release(), time));
 assert.equal(identity.assurance.contract, POLICY_CONTRACT);
 assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.assurance));
 await assert.rejects(verifyAccess(request(identity.token), environment(), resolver, time));
 assert.equal((await check({ exp: time + 1 })).expires, time + 1);
});
test('release is valid at start, denies before start and at/after deadline, maximum 600 seconds', async () => {
 await check({}, { ...release(), validUntil: time + 600 });
 await assert.rejects(check({}, release(), time - 1));
 await check({}, release(), time + 119);
 await assert.rejects(check({}, release(), time + 120));
 await assert.rejects(check({}, release(), time + 121));
});
for (const [name, patch] of [
 ['no release', null], ['unknown property', { ...release(), mfa: true }],
 ['bad contract', { ...release(), contract: 'signed-amr-mfa-v1' }],
 ...['accountId', 'appId', 'policyId', 'audience', 'issuer', 'origin', 'ownerSub', 'ownerEmail', 'effectivePolicyDigest'].map(name => [`missing ${name}`, { ...release(), [name]: undefined }]),
 ...Object.entries({ accountId: 'A'.repeat(32), appId: 'not-a-uuid', policyId: 'x'.repeat(37),
  audience: 'x'.repeat(257), issuer: 'https://evil.test', origin: 'https://canary.test/path',
  ownerSub: 'x'.repeat(257), ownerEmail: 'invalid' }).map(([name, value]) => [`malformed ${name}`, { ...release(), [name]: value }]),
 ['ambiguous digest', { ...release(), effectivePolicyDigest: 'a'.repeat(64) }],
 ['missing independent review', { ...release(), evidence: { ...release().evidence, independentReview: undefined } }],
 ['unreviewed evidence kind', { ...release(), evidence: { ...release().evidence, extra: ref('a') } }],
 ['boolean evidence', { ...release(), evidence: { ...release().evidence, independentMfaEnforcement: true } }],
 ['unbounded evidence', { ...release(), evidence: { ...release().evidence, sessionCutover: 'x'.repeat(257) } }],
 ['long window', { ...release(), validUntil: time + 601 }],
 ['zero window', { ...release(), validUntil: time }], ['reverse window', { ...release(), validUntil: time - 1 }],
 ['cutoff after start', { ...release(), sessionCutoff: time + 1 }],
 ...['sessionCutoff', 'validFrom', 'validUntil'].flatMap(name => [null, '1800000000', 1.5, -1, Number.MAX_SAFE_INTEGER + 1].map(value => [`${name} ${value}`, { ...release(), [name]: value }]))
]) test(`release denies ${name}`, async () => { await assert.rejects(check({}, patch)); });

for (const [name, patch] of [
 ['wrong issuer', { iss: 'https://evil.test' }], ['wrong sub', { sub: 'other' }], ['wrong email', { email: 'other@identity.test' }],
 ['wrong type', { type: 'service' }], ['missing nbf', { nbf: undefined }], ['future nbf', { nbf: time + 1 }],
 ['missing iat', { iat: undefined }], ['missing exp', { exp: undefined }], ['expired', { exp: time }],
 ['at cutoff', { iat: time - 1 }], ['before cutoff', { iat: time - 2 }], ['future iat', { iat: time + 1 }],
 ['long lifetime', { exp: time + 601 }], ['old token', { iat: time - 601 }],
 ...['iat', 'nbf', 'exp'].flatMap(name => [null, '1800000000', 1.5, -1, Number.MAX_SAFE_INTEGER + 1].map(value => [`${name} ${value}`, { [name]: value }])),
 ['malformed AMR', { amr: 'mfa' }]
]) test(`policy signed JWT denies ${name}`, async () => { await assert.rejects(check(patch)); });

// Both contracts share the same signature/header/audience/service rejection path.
for (const mode of ['amr', 'policy']) {
 const verify = async (claims, headers = {}, header = {}) => {
  const token = await access(claims, keys.privateKey, header);
  return mode === 'amr' ? verifyAccess(request(token, headers), environment(), resolver, time) :
   verifyPolicyAccess(request(token, headers), settings(), resolver, release(), time);
 };
 for (const aud of [[], ['offline-audience-only', 'other'], ['offline-audience-only', 'offline-audience-only'], ['offline-audience-only', null], [1], 'other'])
  test(`${mode} denies audience ${JSON.stringify(aud)}`, async () => assert.rejects(verify({ aud })));
 for (const field of ['common_name', 'service_token_id']) for (const value of ['', null, false, 0])
  test(`${mode} denies presence ${field} ${value}`, async () => assert.rejects(verify({ [field]: value })));
 for (const header of [{ kid: '../key' }, { kid: 'x'.repeat(129) }, { typ: null }, { typ: 'other' }, { x5c: [] }, { jku: '' }, { arbitrary: true }])
  test(`${mode} rejects header before resolving keys ${JSON.stringify(header)}`, async () => {
   let resolutions = 0;
   const token = await access({}, keys.privateKey, header);
   const resolve = () => { resolutions++; throw new Error('unexpected resolver'); };
   await assert.rejects(mode === 'amr' ? verifyAccess(request(token), environment(), resolve, time) :
    verifyPolicyAccess(request(token), settings(), resolve, release(), time));
   assert.equal(resolutions, 0);
  });
 for (const name of ['CF-Access-Client-Id', 'CF-Access-Client-Secret']) test(`${mode} rejects empty service header ${name}`, async () => assert.rejects(verify({}, { [name]: '' })));
 test(`${mode} accepts singleton audience and nbf preceding iat`, async () => verify({ aud: ['offline-audience-only'], nbf: time - 100 }));
}
test('policy verifies signatures, rejects tampering, wrong key and algorithm confusion', async () => {
 const wrong = await generateKeyPair('RS256');
 const verify = token => verifyPolicyAccess(request(token), settings(), resolver, release(), time);
 await assert.rejects(verify(await access({}, wrong.privateKey)));
 const parts = (await access()).split('.');
 parts[1] = Buffer.from(JSON.stringify({ sub: 'offline-owner-sub' })).toString('base64url');
 await assert.rejects(verify(parts.join('.')));
 await assert.rejects(verify(await new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'offline-key' }).sign(new Uint8Array(64))));
 await assert.rejects(verify('eyJhbGciOiJub25lIn0.e30.'));
});
for (const [field, value] of Object.entries({ ACCESS_TEAM_HOST: 'other.cloudflareaccess.com', ACCESS_AUD: 'other-audience-only', APP_ORIGIN: 'https://other.test', OWNER_PRINCIPAL: 'other', OWNER_ACCESS_EMAIL: 'other@identity.test', MFA_CONTRACT: 'signed-amr-mfa-v1' }))
 test(`policy requires configuration match ${field}`, async () => assert.rejects(check({}, release(), time, { ...settings(), [field]: value })));

test('canonical binding changes with every reviewed release field and evidence reference', async () => {
 const original = release(), binding = await policyBinding(original, time);
 const reordered = Object.fromEntries(Object.entries(original).reverse());
 assert.deepEqual(await policyBinding(reordered, time), binding);
 for (const [field, value] of Object.entries({ accountId: 'b'.repeat(32), appId: original.policyId, policyId: original.appId,
  audience: 'other-audience-only', issuer: 'https://other.cloudflareaccess.com', origin: 'https://other.test', ownerSub: 'other',
  ownerEmail: 'other@identity.test', effectivePolicyDigest: ref('b'), sessionCutoff: time - 2, validFrom: time - 1, validUntil: time + 119 })) {
  assert.notEqual((await policyBinding({ ...original, [field]: value }, time)).releaseDigest, binding.releaseDigest, field);
 }
 for (const name of Object.keys(original.evidence)) assert.notEqual((await policyBinding({ ...original, evidence: { ...original.evidence, [name]: ref('0') } }, time)).releaseDigest, binding.releaseDigest, name);
 const frozen = validatePolicyRelease(original, time); original.evidence.independentReview = ref('0');
 assert.notEqual(frozen.evidence.independentReview, original.evidence.independentReview);
});

async function policyFixture(t) {
 const f = await fixture(); t.after(() => f.cleanup());
 f.env.MFA_CONTRACT = POLICY_CONTRACT;
 let current = time, snapshot = release(), transform = identity => identity;
 const jwt = await access({ amr: undefined });
 const deps = { ...f.deps, now: () => current, policyRelease: snapshot,
  verify: async (req, env) => transform(await verifyPolicyAccess(req, env, resolver, snapshot, current)) };
 const worker = createCandidate(deps);
 const call = (path, target = worker) => f.call(path, undefined, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }, target);
 return { f, deps, call, setRelease(value) { snapshot = value; }, transform(value) { transform = value; },
  advance(seconds) { current += seconds; f.advance(seconds); } };
}
test('policy coordinator binds contract/evidence/cutover/window in immutable snapshot and capability', async t => {
 const p = await policyFixture(t), { f } = p;
 const preview = await p.call('/preview'); assert.equal(preview.response.status, 201);
 assert.deepEqual(preview.data.snapshot.policy, release());
 assert.deepEqual(preview.data.snapshot.assurance, await policyBinding(release(), time));
 assert.equal(preview.data.expires, time + 120);
 assert.equal((await p.call('/review')).response.status, 200);
 assert.equal((await p.call('/approve')).response.status, 200);
 assert.equal(f.sends, 0);
 assert.equal((await p.call('/dispatch')).data.status, 'accepted'); assert.equal(f.sends, 1);
});
for (const change of ['digest', 'review', 'cutoff', 'window', 'account', 'app', 'policy']) test(`changed policy ${change} cannot continue approved intention`, async t => {
 const p = await policyFixture(t);
 for (const step of ['/preview', '/review', '/approve']) assert.ok((await p.call(step)).response.ok);
 const changed = release();
 if (change === 'digest') changed.effectivePolicyDigest = ref('b');
 if (change === 'review') changed.evidence.independentReview = ref('0');
 if (change === 'cutoff') changed.sessionCutoff--;
 if (change === 'window') changed.validUntil--;
 if (change === 'account') changed.accountId = 'b'.repeat(32);
 if (change === 'app') changed.appId = changed.policyId;
 if (change === 'policy') changed.policyId = changed.appId;
 p.setRelease(changed);
 // Both verifier and coordinator see the new code release: old intention still fails.
 const target = createCandidate({ ...p.deps, policyRelease: changed });
 assert.equal((await p.call('/dispatch', target)).response.status, 503);
 assert.equal(p.f.row().status, 'approved'); assert.equal(p.f.sends, 0);
});
for (const change of ['missing', 'contract', 'digest', 'cutoff', 'window', 'expiry', 'extra']) test(`coordinator rejects mismatched identity assurance ${change}`, async t => {
 const p = await policyFixture(t);
 p.transform(identity => {
  const copy = { ...identity, assurance: { ...identity.assurance } };
  if (change === 'missing') delete copy.assurance;
  if (change === 'contract') copy.assurance.contract = 'signed-amr-mfa-v1';
  if (change === 'digest') copy.assurance.evidenceDigest = ref('b');
  if (change === 'cutoff') copy.assurance.sessionCutoff--;
  if (change === 'window') copy.assurance.validUntil++;
  if (change === 'expiry') copy.expires++;
  if (change === 'extra') copy.assurance.mfa = true;
  return copy;
 });
 assert.equal((await p.call('/preview')).response.status, 503); assert.equal(p.f.row(), undefined);
});
test('AMR identity cannot select policy configuration and policy identity cannot downgrade to AMR', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); f.env.MFA_CONTRACT = POLICY_CONTRACT;
 assert.equal((await f.call('/preview')).response.status, 503);
 const p = await policyFixture(t); p.f.env.MFA_CONTRACT = 'signed-amr-mfa-v1';
 assert.equal((await p.call('/preview')).response.status, 503);
});
for (const during of ['before claim', 'after claim']) test(`policy deadline ${during} prevents transport despite live JWT`, async t => {
 const p = await policyFixture(t);
 for (const step of ['/preview', '/review', '/approve']) assert.ok((await p.call(step)).response.ok);
 const original = p.f.env.CANARY_DB;
 p.f.env.CANARY_DB = { prepare(sql) { const stmt = original.prepare(sql); return { bind(...args) {
  const bound = stmt.bind(...args); return { async first() {
   const result = await bound.first();
   if ((during === 'before claim' && sql.startsWith('SELECT')) || (during === 'after claim' && sql.includes('SET status=?') && args[0] === 'submitted')) p.advance(120);
   return result;
  } };
 } }; } };
 const result = await p.call('/dispatch');
 assert.equal(p.f.sends, 0);
 assert.equal(p.f.row().status, during === 'before claim' ? 'approved' : 'UNKNOWN');
 assert.equal(during === 'before claim' ? result.response.status : result.data.status, during === 'before claim' ? 503 : 'UNKNOWN');
});
test('production null snapshot and fixed dependencies reject env/request policy authority without I/O', async t => {
 assert.equal(PRODUCTION_POLICY_RELEASE, null);
 let injected = 0;
 const f = await fixture(); t.after(() => f.cleanup());
 const env = { ...f.env, MFA_CONTRACT: POLICY_CONTRACT, policyRelease: release(), PRODUCTION_POLICY_RELEASE: release(),
  MFA_VERIFIED: true, verify: () => { injected++; }, transport: () => { injected++; }, keyResolver: resolver, now: () => time, dispatchAuthorized: true };
 const req = request(await access(), { mfa: 'true', 'X-Policy-Release': JSON.stringify(release()) });
 await assert.rejects(authenticate(req, env));
 assert.equal((await production.fetch(req, env)).status, 503);
 // Even an offline verified identity cannot supply the coordinator's default release.
 const identity = await check();
 const worker = createCandidate({ ...f.deps, verify: async () => identity });
 assert.equal((await f.call('/preview', {}, {}, worker, env)).response.status, 503);
 assert.equal(injected, 0); assert.equal(f.row(), undefined); assert.equal(f.sends, 0);
});

for (const step of ['/review', '/approve', '/dispatch']) test(`policy deadline denies subsequent ${step} with otherwise valid signed token`, async t => {
 const p = await policyFixture(t);
 for (const prior of ['/preview', '/review', '/approve']) {
  if (prior === step) break;
  assert.ok((await p.call(prior)).response.ok);
 }
 const previous = p.f.row();
 p.advance(120);
 assert.equal((await p.call(step)).response.status, 503);
 assert.deepEqual(p.f.row(), previous); assert.equal(p.f.sends, 0);
});
test('policy JWT refresh cannot adopt the exact-token-bound intention', async t => {
 const p = await policyFixture(t);
 assert.equal((await p.call('/preview')).response.status, 201);
 const refreshed = await access({ amr: undefined, jti: 'new-signed-token' });
 const worker = createCandidate(p.deps);
 const result = await p.f.call('/review', undefined, { headers: { 'Cf-Access-Jwt-Assertion': refreshed } }, worker);
 assert.equal(result.response.status, 503); assert.equal(p.f.row().status, 'previewed'); assert.equal(p.f.sends, 0);
});
