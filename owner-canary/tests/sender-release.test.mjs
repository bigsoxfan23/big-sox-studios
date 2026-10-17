import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { access, fixture, keys, resolver, timestamp } from './helpers.mjs';
import { stepupFixture } from './stepup-fixtures.mjs';
import { verifySignedOwnerIdentity } from '../src/auth.mjs';
import { createCandidate, configuration, confirmedSnapshot } from '../src/worker.mjs';
import { credentialRecord } from '../src/stepup.mjs';
import { FINAL_OWNER_CONFIRMATION, PRODUCTION_CREDENTIAL_PIN, CONFIRMED_CAMPAIGN_ID, OWNER_CONFIRMED_RELEASE } from '../src/stepup-release.mjs';
import { submitOnce } from '../src/resend.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
// Independent literals, ordered exactly as the released coordinator serializer.
// No real key or production authentication assertion is used by these tests.
const record = {
 credentialID: 'MANaCK7rJfDfUuXeSlx46S4ypCw',
 publicKey: 'pQECAyYgASFYINcxjXlys_igeNRhUyf9UKeHO_H1Vs3aak-7y7CzVdInIlggkRNP2BSEiVzRHn7DReQZzhdf88DJVrCEo_Ptk_qHdsE',
 algorithm: -7, rpID: 'canary.bigsoxstudios.com', origin: 'https://canary.bigsoxstudios.com',
 owner: '19e39702-51ab-52dc-9172-91bcb059ec5d', email: 'fridman.greg@gmail.com', epoch: 'owner-canary-webauthn-v1-20261016'
};
const payload = {
 from: 'support@bigsoxstudios.com', subject: 'Big Sox Studios — Outbound Email Verification',
 text: 'This is a one-time test of the Big Sox Studios outbound email system.\n\nThe message verifies that support@bigsoxstudios.com can securely send email through Resend.\n\nNo customer tickets or customer messages are involved.\n\n— Big Sox Studios',
 to: 'fridman.greg@gmail.com'
};
const approvedSnapshot = JSON.stringify({ purpose: 'owner-direct-canary-v1', version: 1,
 campaign: '3ed38bbd-997c-4ce5-abad-e131b115ede4', origin: record.origin,
 owner: record.owner, ownerEmail: record.email, team: 'old-hill-995d.cloudflareaccess.com',
 audience: '9d60254aaedad88d7176ba1c455881da09177143ab7dba2070896bfafd209401',
 epoch: record.epoch, mfa: 'application-webauthn-stepup-v1',
 credentialContract: { contract: 'application-webauthn-stepup-v1', record,
  fingerprint: 'sha256:798d9a0ac8aefeb35ac0f64c29341c4962539e051d396fd82a41bcb29c973584' }, payload });
const settings = JSON.parse(approvedSnapshot);
async function released(t) {
 const s = await stepupFixture(t);
 Object.assign(s.f.env, { APP_ORIGIN: record.origin, OWNER_PRINCIPAL: record.owner,
  OWNER_ACCESS_EMAIL: record.email, SESSION_EPOCH: record.epoch, CANARY_OWNER_MAILBOX: payload.to,
  CANARY_CAMPAIGN_ID: settings.campaign, ACCESS_TEAM_HOST: settings.team, ACCESS_AUD: settings.audience });
 const token = await new SignJWT({ iss: `https://${settings.team}`, aud: settings.audience,
  sub: record.owner, email: record.email, type: 'app', iat: timestamp, nbf: timestamp, exp: timestamp + 600 })
  .setProtectedHeader({ alg: 'RS256', kid: 'offline-key' }).sign(keys.privateKey);
 s.setToken(token);
 const deps = { verify: s.deps.verify, transport: s.deps.transport, now: s.now,
  dispatchAuthorized: OWNER_CONFIRMED_RELEASE, enforceRelease: true };
 return { s, deps, target: createCandidate(deps) };
}

test('source consent has exactly three immutable keys and independently computed exact digests', async t => {
 assert.equal(OWNER_CONFIRMED_RELEASE, true);
 assert.equal(CONFIRMED_CAMPAIGN_ID, settings.campaign);
 assert.deepEqual(credentialRecord(PRODUCTION_CREDENTIAL_PIN), record);
 assert.equal(JSON.stringify(credentialRecord(PRODUCTION_CREDENTIAL_PIN)), JSON.stringify(record));
 assert.deepEqual(FINAL_OWNER_CONFIRMATION, { envelopeDigest: sha(JSON.stringify(payload)), configDigest: sha(approvedSnapshot), epoch: record.epoch });
 assert.ok(Object.isFrozen(FINAL_OWNER_CONFIRMATION));
 const { s, target } = await released(t);
 const identity = await verifySignedOwnerIdentity(new Request(record.origin, { headers: { 'Cf-Access-Jwt-Assertion': s.token } }), s.f.env, resolver, timestamp);
 const actual = await configuration(s.f.env, identity, null, timestamp, PRODUCTION_CREDENTIAL_PIN);
 assert.equal(actual, approvedSnapshot);
 assert.equal(await confirmedSnapshot(actual, s.f.env, FINAL_OWNER_CONFIRMATION), true);
 const status = await s.call('/status', {}, { target, method: 'GET', body: undefined });
 assert.equal(status.r.status, 200); assert.equal(status.data.sendAuthority, true);
 assert.equal(status.data.applicationStepup, true);
 assert.equal((await s.session(target)).r.status, 200);
 assert.equal((await s.call('/stepup/challenge', { purpose: 'preview' }, { target })).r.status, 200);
 assert.equal((await s.call('/preview', { proof: 'A'.repeat(43) }, { target })).r.status, 503);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});

for (const field of ['from', 'to', 'subject', 'text']) test(`exact consent and adapter deny changed ${field}`, async t => {
 const { s } = await released(t);
 const changed = JSON.parse(approvedSnapshot); changed.payload[field] += 'changed';
 assert.equal(await confirmedSnapshot(JSON.stringify(changed), s.f.env, FINAL_OWNER_CONFIRMATION), false);
 let calls = 0;
 const result = await submitOnce({ status: 'submitted', campaign: settings.campaign, digest: sha(JSON.stringify(changed)), snapshot: JSON.stringify(changed) }, s.f.env,
  async () => { calls++; return Response.json({ id: '22222222-2222-4222-8222-222222222222' }); });
 assert.deepEqual(result, { status: 'UNKNOWN' }); assert.equal(calls, 0);
});
for (const [field, value] of Object.entries({ CANARY_CAMPAIGN_ID: '22222222-2222-4222-8222-222222222222',
 CANARY_OWNER_MAILBOX: 'other@recipient.test', SESSION_EPOCH: 'other-release-epoch-v1',
 ACCESS_TEAM_HOST: 'other.cloudflareaccess.com', ACCESS_AUD: 'other-audience-only', OWNER_PRINCIPAL: 'other-owner',
 OWNER_ACCESS_EMAIL: 'other@identity.test', APP_ORIGIN: 'https://other.test', MFA_CONTRACT: 'signed-amr-mfa-v1',
 DEPLOYMENT_STAGE: 'offline', CANARY_SEND_ENABLED: 'false', APPROVAL_SIGNING_KEY: undefined, RESEND_API_KEY: undefined })) {
 test(`production release rejects changed/missing ${field} before any campaign write`, async t => {
  const { s, target } = await released(t);
  s.f.env[field] = value;
  for (const path of ['/status', '/preview']) {
   assert.equal((await s.call(path, { proof: 'A'.repeat(43) }, { target, ...(path === '/status' ? { method: 'GET', body: undefined } : {}) })).r.status, 503);
  }
  assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
 });
}
for (const patch of [{ finalConfirmation: null }, { finalConfirmation: { ...FINAL_OWNER_CONFIRMATION, epoch: 'other' } },
 { finalConfirmation: { ...FINAL_OWNER_CONFIRMATION, extra: true } }, { credentialPin: { ...PRODUCTION_CREDENTIAL_PIN } }, { dispatchAuthorized: false }]) {
 test(`production enforcer rejects substituted source dependency ${JSON.stringify(Object.keys(patch))}`, async t => {
  const { s, deps } = await released(t);
  const target = createCandidate({ ...deps, ...patch });
  assert.equal((await s.call('/status', {}, { target, method: 'GET', body: undefined })).r.status, 503);
  assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
 });
}
test('factory remains disabled by default even with exact consent and env flags', async t => {
 const { s, deps } = await released(t);
 const { dispatchAuthorized: ignored, enforceRelease: ignoredEnforcer, ...offline } = deps;
 assert.ok(ignored && ignoredEnforcer);
 const status = await s.call('/status', {}, { target: createCandidate(offline), method: 'GET', body: undefined });
 assert.equal(status.r.status, 200); assert.equal(status.data.sendAuthority, false);
});

test('provider missing domain scope is a terminal refusal with one stub call, no claimed delivery', async t => {
 const s = await stepupFixture(t); await s.approved(); await s.confirm();
 let count = 0;
 const target = createCandidate({ ...s.deps, transport: async () => { count++; return Response.json({ name: 'restricted_api_key' }, { status: 403 }); } });
 const proof = await s.proof('dispatch'), body = { token: s.stageToken, proof };
 const result = await s.call('/dispatch', body, { target });
 assert.equal(result.data.status, 'refused'); assert.equal(result.data.delivery, 'unverified'); assert.equal(result.data.retry, false);
 assert.equal((await s.call('/dispatch', body, { target })).r.status, 503); assert.equal(count, 1);
});

const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
test('signed exact-owner OAuth return opens only root document, with no ledger mutation', async t => {
 const { s, target } = await released(t);
 const r = await target.fetch(new Request(record.origin + '/', { headers: { ...navigation, 'Cf-Access-Jwt-Assertion': s.token } }), s.f.env);
 assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});
for (const path of ['/', '/app.js', '/styles.css', '/status', '/stepup/session', '/preview', '/dispatch']) {
 for (const [name, patch] of Object.entries({ badOrigin: { Origin: 'https://evil.test' }, script: { 'Sec-Fetch-Dest': 'script' }, fetch: { 'Sec-Fetch-Mode': 'cors' } })) {
  test(`OAuth exception denies ${name} on ${path}`, async t => {
   const f = await fixture(); t.after(() => f.cleanup());
   assert.equal((await f.worker.fetch(new Request(f.env.APP_ORIGIN + path, { headers: { ...navigation, ...patch, 'Cf-Access-Jwt-Assertion': f.token } }), f.env)).status, 503);
  });
 }
 if (path !== '/') test(`OAuth document navigation cannot open ${path}`, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  assert.equal((await f.worker.fetch(new Request(f.env.APP_ORIGIN + path, { headers: { ...navigation, 'Cf-Access-Jwt-Assertion': f.token } }), f.env)).status, 503);
 });
}
for (const claims of [{ sub: 'other' }, { email: 'other@identity.test' }, { exp: timestamp }]) test(`OAuth exception still verifies signed owner ${JSON.stringify(claims)}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 assert.equal((await f.worker.fetch(new Request(f.env.APP_ORIGIN, { headers: { ...navigation, 'Cf-Access-Jwt-Assertion': await access(claims) } }), f.env)).status, 503);
});
for (const method of ['POST', 'HEAD', 'OPTIONS']) test(`OAuth exception denies ${method} root`, async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 assert.equal((await f.worker.fetch(new Request(f.env.APP_ORIGIN, { method, headers: { ...navigation, 'Cf-Access-Jwt-Assertion': f.token } }), f.env)).status, 503);
});

test('aged identity cannot spend campaign even with a newly verified preview passkey', async t => {
 const s = await stepupFixture(t); s.advance(301); await s.session();
 const proof = await s.proof('preview');
 assert.equal((await s.call('/preview', { proof })).r.status, 503);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});
test('crossing a clock second during proof consumption still creates a full review window', async t => {
 const s = await stepupFixture(t); await s.session(); const proof = await s.proof('preview');
 const db = s.f.env.CANARY_DB;
 s.f.env.CANARY_DB = { prepare(sql) { const stmt = db.prepare(sql); return { bind(...args) {
  const bound = stmt.bind(...args); return { async first() {
   const result = await bound.first();
   if (sql.includes("state='used'")) s.advance(1);
   return result;
  } };
 } }; } };
 assert.equal((await s.call('/preview', { proof })).r.status, 201);
 assert.equal(s.f.row().created, timestamp + 1); assert.equal(s.f.row().expires, timestamp + 301);
});
test('dispatch native prompt timeout fits the remaining intention lifetime', async t => {
 const s = await stepupFixture(t); await s.approved(); s.advance(250);
 const o = await s.call('/stepup/challenge', { purpose: 'dispatch' });
 assert.equal(o.r.status, 200); assert.equal(o.data.publicKey.timeout, 50000);
 assert.equal(o.data.publicKey.userVerification, 'required');
});
test('a 119-second native passkey followed by 170-second review leaves time for distinct dispatch proof', async t => {
 const s = await stepupFixture(t); await s.session();
 const options = await s.call('/stepup/challenge', { purpose: 'preview' }); s.advance(119);
 const v = await s.call('/stepup/verify', { purpose: 'preview', id: options.data.id, response: s.auth.assert(options.data.publicKey.challenge) });
 assert.equal(v.r.status, 200);
 assert.equal((await s.call('/preview', { proof: v.data.proof })).r.status, 201);
 assert.equal(s.f.row().expires, timestamp + 419);
 s.advance(170);
 for (const path of ['/review', '/approve']) assert.equal((await s.call(path, { token: s.stageToken })).r.status, 200);
 await s.confirm(); const proof = await s.proof('dispatch');
 assert.equal((await s.call('/dispatch', { token: s.stageToken, proof })).data.status, 'accepted');
 assert.equal(s.f.sends, 1);
});
