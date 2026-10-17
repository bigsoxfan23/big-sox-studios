import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { authenticator, stepupFixture } from './stepup-fixtures.mjs';
import { access, environment, resolver, timestamp, database } from './helpers.mjs';
import { verifyAccess, verifySignedOwnerIdentity } from '../src/auth.mjs';
import { credentialRecord, fingerprint, decode, registration, assertion } from '../src/stepup.mjs';
import { createCandidate } from '../src/worker.mjs';
import production from '../src/worker.mjs';
import { PRODUCTION_CREDENTIAL_PIN, FINAL_OWNER_CONFIRMATION, STEPUP_CONTRACT } from '../src/stepup-release.mjs';
const originalProductionPin = PRODUCTION_CREDENTIAL_PIN;
const confirmedFingerprint = 'sha256:798d9a0ac8aefeb35ac0f64c29341c4962539e051d396fd82a41bcb29c973584';

const req = token => new Request('https://canary.test/', { headers: { 'Cf-Access-Jwt-Assertion': token } });
test('distinct signed identity accepts absent AMR without manufacturing MFA or cutover evidence', async () => {
 const token = await access({ amr: undefined });
 const identity = await verifySignedOwnerIdentity(req(token), environment(), resolver, timestamp);
 assert.deepEqual(Object.keys(identity).sort(), ['expires', 'identityContract', 'sub', 'token']);
 await assert.rejects(verifyAccess(req(token), environment(), resolver, timestamp));
});
for (const [name, patch] of Object.entries({ owner: { sub: 'other' }, email: { email: 'other@identity.test' },
 issuer: { iss: 'https://evil.test' }, audience: { aud: ['offline-audience-only', 'other'] }, type: { type: 'service' },
 future: { iat: timestamp + 1 }, stale: { iat: timestamp - 601 }, expired: { exp: timestamp },
 missingNbf: { nbf: undefined }, service: { common_name: 'service' } })) test(`identity contract rejects ${name}`, async () => {
 await assert.rejects(verifySignedOwnerIdentity(req(await access(patch)), environment(), resolver, timestamp));
});
test('real ES256 none registration and zero-counter signatures verify using the pinned library', async () => {
 const a = authenticator(), row = { challenge: 'A'.repeat(43) };
 const { credentialID: ignoredID, publicKey: ignoredKey, algorithm: ignoredAlg, ...settings } = a.record;
 assert.ok(ignoredID && ignoredKey && ignoredAlg);
 assert.deepEqual(await registration(a.register(row.challenge), row, settings), a.record);
 await assertion(a.assert(row.challenge), row, a.record);
 await assertion(a.assert(row.challenge), row, a.record); // CAS, not counter, supplies replay protection
});
const badCrypto = {
 'no UP': { flags: 4 }, 'no UV': { flags: 1 }, 'neither': { flags: 0 },
 'wrong RP ID': { rpID: 'evil.test' }, 'wrong origin': { client: { origin: 'https://evil.test' } },
 'subdomain origin': { client: { origin: 'https://sub.canary.test' } },
 'wrong challenge': { client: { challenge: Buffer.alloc(32, 1).toString('base64url') } }, 'cross origin': { client: { crossOrigin: true } },
 'top origin': { client: { topOrigin: 'https://canary.test' } }, 'wrong ceremony': { client: { type: 'webauthn.create' } }
};
for (const [name, options] of Object.entries(badCrypto)) test(`real signed assertion rejects ${name}`, async () => {
 const a = authenticator(), row = { challenge: 'A'.repeat(43) };
 await assert.rejects(assertion(a.assert(row.challenge, options), row, a.record));
});
for (const [name, options] of Object.entries(badCrypto).filter(([n]) => n !== 'wrong ceremony')) test(`none registration rejects ${name}`, async () => {
 const a = authenticator(), row = { challenge: 'A'.repeat(43) }, settings = { ...a.record };
 delete settings.credentialID; delete settings.publicKey; delete settings.algorithm;
 await assert.rejects(registration(a.register(row.challenge, { ...options, flags: (options.flags ?? 5) | 64 }), row, settings));
});
for (const change of ['credential', 'rawID', 'key', 'signature', 'type', 'padded', 'oversized', 'invalidbase64']) test(`library assertion boundary rejects ${change}`, async () => {
 const a = authenticator(), b = authenticator(), row = { challenge: 'A'.repeat(43) }, response = a.assert(row.challenge);
 let record = a.record;
 if (change === 'credential') response.id = response.rawId = b.record.credentialID;
 if (change === 'rawID') response.rawId = b.record.credentialID;
 if (change === 'key') record = { ...a.record, publicKey: b.record.publicKey };
 if (change === 'signature') response.response.signature = b.assert(row.challenge).response.signature;
 if (change === 'type') response.type = 'other';
 if (change === 'padded') response.response.signature += '=';
 if (change === 'oversized') response.response.clientDataJSON = 'A'.repeat(4097);
 if (change === 'invalidbase64') response.id = response.rawId = '!bad';
 await assert.rejects(assertion(response, row, record));
});
test('ES256 only: reject other declared and COSE algorithms, extra record fields, invalid encoding', async () => {
 const a = authenticator();
 assert.throws(() => credentialRecord({ ...a.record, algorithm: -257 }));
 const cose = isoCBOR.encode(new Map([[1, 2], [3, -257], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]));
 assert.throws(() => credentialRecord({ ...a.record, publicKey: Buffer.from(cose).toString('base64url') }));
 const settings = { rpID: a.record.rpID, origin: a.record.origin, owner: a.record.owner, email: a.record.email, epoch: a.record.epoch };
 const row = { challenge: 'A'.repeat(43) };
 await assert.rejects(registration(a.register(row.challenge, { cose }), row, settings));
 assert.throws(() => credentialRecord({ ...a.record, approved: true }));
 for (const value of ['A', 'AA=', 'AB', 'a+b', '', 'A'.repeat(4097)]) assert.throws(() => decode(value));
});
for (const field of ['credentialID', 'publicKey', 'origin', 'owner', 'email', 'epoch']) test(`full canonical fingerprint binds ${field}`, async () => {
 const a = authenticator(), b = authenticator(), record = { ...a.record };
 if (['credentialID', 'publicKey'].includes(field)) record[field] = b.record[field];
 else if (field === 'origin') { record.origin = 'https://other.test'; record.rpID = 'other.test'; }
 else record[field] += 'x';
 assert.notEqual(await fingerprint(record), await fingerprint(a.record));
 const reverse = Object.fromEntries(Object.entries(a.record).reverse());
 assert.equal(await fingerprint(reverse), await fingerprint(a.record));
});

test('enrollment proves possession, emits only public candidate, never consumes campaign slot or pins', async t => {
 const s = await stepupFixture(t), candidate = await s.enroll();
 assert.equal(s.f.a.prepare('SELECT public_id FROM stepup_candidate WHERE id=?').get(candidate).public_id, null);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
 const proof = await s.possession(candidate);
 assert.equal(proof.r.status, 200); assert.equal(proof.data.trusted, false); assert.equal(proof.data.sendAuthority, false);
 assert.notEqual(proof.data.candidateID, candidate);
 assert.equal(proof.data.fingerprint, await s.fingerprint()); assert.deepEqual(proof.data.record, s.auth.record);
 assert.match(proof.data.instruction, /does NOT confirm/);
 assert.ok(!JSON.stringify(proof.data).includes(s.token)); assert.ok(!JSON.stringify(proof.data).includes(s.cookies));
 assert.equal(s.f.row(), undefined); assert.equal(PRODUCTION_CREDENTIAL_PIN, originalProductionPin);
 assert.equal(await fingerprint(PRODUCTION_CREDENTIAL_PIN), confirmedFingerprint);
 assert.ok(Object.isFrozen(PRODUCTION_CREDENTIAL_PIN));
 await assert.rejects(s.possession(candidate));
});
for (const path of ['/preview', '/dispatch', '/approve', '/pin', '/reset', '/enroll/pin', '/enroll/approve']) test(`enrollment has no sender/promotion endpoint ${path}`, async t => {
 const s = await stepupFixture(t);
 assert.equal((await s.call(path, { approved: true, pin: s.auth.record }, { target: s.enrollment })).r.status, 503);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});
test('latest concurrent candidates stay untrusted; null code pin cannot use enrollment records or HTTP/env forgery', async t => {
 const s = await stepupFixture(t);
 await s.session(s.enrollment);
 const candidates = await Promise.all(Array.from({ length: 8 }, () => s.enroll()));
 assert.equal(new Set(candidates).size, 8);
 for (const candidate of candidates) assert.equal((await s.possession(candidate)).r.status, 200);
 const target = createCandidate({ ...s.deps, credentialPin: null });
 const env = { ...s.f.env, PRODUCTION_CREDENTIAL_PIN: s.auth.record, credentialPin: s.auth.record, dispatchAuthorized: true };
 const r = await s.call('/preview', { proof: candidates.at(-1), credentialPin: s.auth.record }, { target, env });
 assert.equal(r.r.status, 503); assert.equal(s.f.row(), undefined);
});
test('dedicated cookie is initialized first, retained alongside approval cookie, and not refreshed', async t => {
 const s = await stepupFixture(t);
 assert.equal((await s.call('/stepup/challenge', { purpose: 'preview' })).r.status, 503);
 const first = await s.session(); assert.match(first.r.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict; Path=\//);
 const old = s.cookies; assert.equal((await s.session()).r.headers.get('set-cookie'), null);
 await s.preview(); assert.ok(s.cookies.includes(old)); assert.match(s.cookies, /__Host-canary=/);
 assert.equal((await s.session()).r.headers.get('set-cookie'), null);
});
test('well-formed caller-selected cookie is rejected by session initialization and challenge issuance', async t => {
 const s = await stepupFixture(t);
 s.setCookies(`__Host-stepup=${Buffer.alloc(32, 9).toString('base64url')}`);
 assert.equal((await s.session()).r.status, 503);
 assert.equal((await s.call('/stepup/challenge', { purpose: 'preview' })).r.status, 503);
 assert.equal(s.f.a.prepare('SELECT count(*) n FROM stepup_challenge').get().n, 0);
});
for (const stage of ['/review', '/approve', '/dispatch']) test(`a different legitimately server-issued stepup cookie cannot adopt campaign at ${stage}`, async t => {
 const s = await stepupFixture(t); await s.preview();
 if (stage !== '/review') assert.equal((await s.call('/review', { token: s.stageToken })).r.status, 200);
 if (stage === '/dispatch') { assert.equal((await s.call('/approve', { token: s.stageToken })).r.status, 200); await s.confirm(); }
 const old = s.cookies;
 assert.equal((await s.call('/stepup/session', {}, { headers: { Cookie: '' } })).r.status, 503);
 // Separate browser enrollment can initialize its own valid server session,
 // which must still be unable to adopt this browser's campaign/capability.
 assert.equal((await s.call('/stepup/session', {}, { target: s.enrollment, headers: { Cookie: '' } })).r.status, 200);
 assert.notEqual(s.cookies, old);
 assert.equal((await s.call(stage, stage === '/dispatch' ? { token: s.stageToken, proof: 'A'.repeat(43) } : { token: s.stageToken })).r.status, 503);
 assert.equal((await s.call('/stepup/challenge', { purpose: 'dispatch' })).r.status, 503);
 assert.equal(s.f.sends, 0);
});
for (const [name, headers] of Object.entries({ origin: { Origin: 'https://evil.test' }, missingOrigin: { Origin: '' },
 fetchsite: { 'Sec-Fetch-Site': 'cross-site' }, type: { 'Content-Type': 'text/plain' },
 action: { 'X-Canary-Action': 'preview' }, authorization: { Authorization: 'Bearer spoof' },
 duplicate: { Cookie: `__Host-stepup=${'A'.repeat(43)}; __Host-stepup=${'A'.repeat(43)}` },
 spacedDuplicate: { Cookie: `__Host-stepup=${'A'.repeat(43)}; __Host-stepup =${'A'.repeat(43)}` },
 malformed: { Cookie: '__Host-stepup=invalid' } })) test(`strict challenge HTTP boundary rejects ${name}`, async t => {
 const s = await stepupFixture(t); await s.session();
 assert.equal((await s.call('/stepup/challenge', { purpose: 'preview' }, { headers })).r.status, 503);
 assert.equal(s.f.row(), undefined);
});
test('stream bounds and exact request schema prevent oversized and caller-selected challenge/cookie authority', async t => {
 const s = await stepupFixture(t); await s.session();
 for (const body of [{ purpose: 'preview', challenge: 'A'.repeat(43) }, { purpose: 'preview', pin: s.auth.record },
  { purpose: 'preview', payload: 'x'.repeat(17000) }, { purpose: 'preview', session: s.cookies }]) {
  assert.equal((await s.call('/stepup/challenge', body)).r.status, 503);
 }
});
for (const changed of ['JWT refresh', 'cookie replacement', 'purpose', 'configuration', 'epoch', 'future', 'stale']) test(`challenge rejects ${changed} binding`, async t => {
 const s = await stepupFixture(t); await s.session();
 const o = await s.call('/stepup/challenge', { purpose: 'preview' });
 if (changed === 'JWT refresh') s.setToken(await access({ amr: undefined, jti: 'refresh' }));
 if (changed === 'cookie replacement') s.setCookies(`__Host-stepup=${Buffer.alloc(32, 1).toString('base64url')}`);
 if (changed === 'configuration') s.f.env.CANARY_CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
 if (changed === 'epoch') s.f.env.SESSION_EPOCH += 'new';
 if (changed === 'future') s.advance(-1);
 if (changed === 'stale') s.advance(120);
 const result = await s.call('/stepup/verify', { purpose: changed === 'purpose' ? 'dispatch' : 'preview',
  id: o.data.id, response: s.auth.assert(o.data.publicKey.challenge) });
 assert.equal(result.r.status, 503); assert.equal(s.f.row(), undefined);
});
test('actual crypto completion must precede deadline: clock crosses expiry during real signature verification', async t => {
 const s = await stepupFixture(t); await s.session();
 const o = await s.call('/stepup/challenge', { purpose: 'preview' });
 const original = crypto.subtle.verify;
 crypto.subtle.verify = async function (...args) {
  const result = await original.apply(this, args);
  if (args[0].name === 'ECDSA') s.advance(120);
  return result;
 };
 t.after(() => { crypto.subtle.verify = original; });
 const v = await s.call('/stepup/verify', { purpose: 'preview', id: o.data.id, response: s.auth.assert(o.data.publicKey.challenge) });
 assert.equal(v.r.status, 503); assert.equal(s.f.sends, 0);
});
test('32 real signed verifications produce exactly one durable grant; proof is one-use before preview', async t => {
 const s = await stepupFixture(t); await s.session();
 const o = await s.call('/stepup/challenge', { purpose: 'preview' });
 const response = s.auth.assert(o.data.publicKey.challenge);
 const results = await Promise.all(Array.from({ length: 32 }, () => s.call('/stepup/verify', { purpose: 'preview', id: o.data.id, response })));
 assert.equal(results.filter(x => x.r.ok).length, 1);
 const previews = await Promise.all(Array.from({ length: 32 }, () => s.call('/preview', { proof: o.data.id })));
 assert.equal(previews.filter(x => x.r.ok).length, 1);
 assert.equal(s.f.row().status, 'previewed'); assert.equal(s.f.sends, 0);
 assert.equal((await s.call('/preview', { proof: o.data.id })).r.status, 503);
});
test('preview and dispatch use distinct assertions; snapshot stays stable across proof expiry and review stages', async t => {
 const s = await stepupFixture(t);
 assert.equal((await s.call('/preview')).r.status, 503); assert.equal(s.f.row(), undefined);
 await s.preview(); const snapshot = s.f.row().snapshot;
 s.advance(121);
 for (const path of ['/review', '/approve']) assert.equal((await s.call(path, { token: s.stageToken })).r.status, 200);
 assert.equal(s.f.row().snapshot, snapshot); assert.equal(s.f.row().expires, timestamp + 300);
 await s.confirm(); const proof = await s.proof('dispatch');
 assert.equal((await s.call('/dispatch', { token: s.stageToken, proof })).r.status, 200);
 assert.equal(s.f.sends, 1);
});
test('32 coordinator dispatch contenders on two SQLite connections: one proof use, one original CAS, one stub send', async t => {
 const s = await stepupFixture(t); await s.approved(); await s.confirm();
 const proof = await s.proof('dispatch'), body = { token: s.stageToken, proof };
 const second = createCandidate(s.deps), otherEnv = { ...s.f.env, CANARY_DB: database(s.f.b) };
 const results = await Promise.all(Array.from({ length: 32 }, (_, i) => s.call('/dispatch', body,
  i % 2 ? { target: second, env: otherEnv } : {})));
 assert.equal(results.filter(x => x.r.ok).length, 1); assert.equal(s.f.sends, 1);
 assert.equal((await s.call('/dispatch', body)).r.status, 503);
});
for (const during of ['before claim', 'after claim']) test(`proof deadline crossed ${during} prevents transport even while intention/JWT live`, async t => {
 const s = await stepupFixture(t); await s.approved(); await s.confirm();
 const proof = await s.proof('dispatch'), db = s.f.env.CANARY_DB;
 s.f.env.CANARY_DB = { prepare(sql) { const stmt = db.prepare(sql); return { bind(...args) {
  const bound = stmt.bind(...args); return { async first() {
   const result = await bound.first();
   if ((during === 'before claim' && sql.includes("state='used'")) ||
       (during === 'after claim' && sql.includes('SET status=?') && args[0] === 'submitted')) s.advance(120);
   return result;
  } };
 } }; } };
 const result = await s.call('/dispatch', { token: s.stageToken, proof });
 assert.equal(s.f.sends, 0);
 assert.equal(s.f.row().status, during === 'before claim' ? 'approved' : 'UNKNOWN');
 assert.equal(during === 'before claim' ? result.r.status : result.data.status, during === 'before claim' ? 503 : 'UNKNOWN');
});
for (const change of ['JWT', 'cookie', 'configuration', 'epoch', 'expiry']) test(`verified preview grant cannot survive ${change} change`, async t => {
 const s = await stepupFixture(t); await s.session(); const proof = await s.proof('preview');
 if (change === 'JWT') s.setToken(await access({ amr: undefined, jti: 'new' }));
 if (change === 'cookie') s.setCookies(`__Host-stepup=${Buffer.alloc(32, 9).toString('base64url')}`);
 if (change === 'configuration') s.f.env.CANARY_CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
 if (change === 'epoch') s.f.env.SESSION_EPOCH += 'changed';
 if (change === 'expiry') s.advance(120);
 assert.equal((await s.call('/preview', { proof })).r.status, 503);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});
for (const change of ['JWT', 'cookie', 'candidate', 'expiry']) test(`enrollment possession proof cannot survive ${change} substitution`, async t => {
 const s = await stepupFixture(t), candidate = await s.enroll();
 const other = await s.enroll();
 const o = await s.call('/enroll/prove/options', { candidate }, { target: s.enrollment });
 if (change === 'JWT') s.setToken(await access({ amr: undefined, jti: 'new' }));
 if (change === 'cookie') s.setCookies(`__Host-stepup=${Buffer.alloc(32, 9).toString('base64url')}`);
 if (change === 'expiry') s.advance(120);
 const r = await s.call('/enroll/prove/verify', { candidate: change === 'candidate' ? other : candidate,
  id: o.data.id, response: s.auth.assert(o.data.publicKey.challenge) }, { target: s.enrollment });
 assert.equal(r.r.status, 503);
 assert.equal(s.f.a.prepare('SELECT count(*) n FROM stepup_candidate WHERE verified IS NOT NULL').get().n, 0);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});
test('identity-only stepup verifier cannot downgrade to the old signed AMR mode', async t => {
 const s = await stepupFixture(t); s.f.env.MFA_CONTRACT = 'signed-amr-mfa-v1';
 assert.equal((await s.call('/preview')).r.status, 503); assert.equal(s.f.row(), undefined);
});
for (const changed of ['null confirmation', 'message confirmation', 'epoch confirmation', 'config confirmation', 'expired proof', 'expired intention', 'JWT refresh', 'cookie replacement', 'preview proof']) test(`dispatch fails closed for ${changed}`, async t => {
 const s = await stepupFixture(t); await s.approved();
 if (changed !== 'null confirmation') await s.confirm();
 const proof = await s.proof(changed === 'preview proof' ? 'preview' : 'dispatch');
 if (changed === 'message confirmation') s.deps.finalConfirmation.envelopeDigest = 'a'.repeat(64);
 if (changed === 'epoch confirmation') s.deps.finalConfirmation.epoch += 'x';
 if (changed === 'config confirmation') s.deps.finalConfirmation.configDigest = 'a'.repeat(64);
 if (changed === 'expired proof') s.advance(120);
 if (changed === 'expired intention') s.advance(300);
 if (changed === 'JWT refresh') s.setToken(await access({ amr: undefined, jti: 'new' }));
 if (changed === 'cookie replacement') s.setCookies(`__Host-stepup=${Buffer.alloc(32, 3).toString('base64url')}; ` + s.cookies.split('; ').find(v => v.startsWith('__Host-canary=')));
 assert.equal((await s.call('/dispatch', { token: s.stageToken, proof })).r.status, 503);
 assert.equal(s.f.row().status, 'approved'); assert.equal(s.f.sends, 0);
});
for (const stage of ['preview', 'dispatch']) test(`crash after ${stage} proof consumption burns grant and cannot resume/send`, async t => {
 const s = await stepupFixture(t);
 if (stage === 'dispatch') { await s.approved(); await s.confirm(); } else await s.session();
 const proof = await s.proof(stage), db = s.f.env.CANARY_DB;
 s.f.env.CANARY_DB = { prepare(sql) { if (sql.startsWith('INSERT INTO canary_campaign') || sql.includes("SET status=?")) throw new Error('simulated crash'); return db.prepare(sql); } };
 const body = stage === 'preview' ? { proof } : { token: s.stageToken, proof };
 assert.equal((await s.call('/' + stage, body)).r.status, 503);
 s.f.env.CANARY_DB = db;
 assert.equal((await s.call('/' + stage, body)).r.status, 503); assert.equal(s.f.sends, 0);
 assert.equal(s.f.row()?.status, stage === 'preview' ? undefined : 'approved');
});
test('new table bindings and consume-once states are immutable and row counts are bounded', async t => {
 const s = await stepupFixture(t); await s.session();
 for (let n = 0; n < 127; n++) assert.equal((await s.call('/stepup/challenge', { purpose: 'preview' })).r.status, 200);
 assert.equal((await s.call('/stepup/challenge', { purpose: 'preview' })).r.status, 503);
 for (const sql of ["UPDATE stepup_challenge SET context='forged'", 'UPDATE stepup_challenge SET expires=expires+1', "UPDATE stepup_challenge SET state='used',verified=created,consumed=created"]) assert.throws(() => s.f.a.exec(sql));
 s.advance(120); assert.equal((await s.call('/stepup/challenge', { purpose: 'preview' })).r.status, 200);
 assert.equal(s.f.a.prepare('SELECT count(*) n FROM stepup_challenge').get().n, 2);
 assert.equal(s.f.row(), undefined);
});
test('candidate bindings immutable, candidate capacity bounded, expiry permits pruning', async t => {
 const s = await stepupFixture(t); const candidate = await s.enroll();
 for (const sql of ["UPDATE stepup_candidate SET record='{}'", "UPDATE stepup_candidate SET fingerprint='" + 'a'.repeat(71) + "'", 'UPDATE stepup_candidate SET expires=expires+1']) assert.throws(() => s.f.a.exec(sql));
 // Exercise durable trigger without 63 redundant cryptographic ceremonies.
 const insert = s.f.a.prepare(`INSERT INTO stepup_candidate(id,record,fingerprint,context,created,expires) SELECT ?,record,fingerprint,context,created,expires FROM stepup_candidate WHERE id=?`);
 for (let n = 1; n < 64; n++) insert.run(Buffer.alloc(32, n).toString('base64url'), candidate);
 assert.throws(() => insert.run(Buffer.alloc(32, 65).toString('base64url'), candidate));
 s.advance(600); await assert.rejects(s.possession(candidate)); assert.equal(s.f.row(), undefined);
});
test('confirmed production pin, null final confirmation and fixed full sender reject request/environment authority', async t => {
 const s = await stepupFixture(t);
 assert.equal(PRODUCTION_CREDENTIAL_PIN, originalProductionPin);
 assert.equal(await fingerprint(PRODUCTION_CREDENTIAL_PIN), confirmedFingerprint);
 assert.ok(Object.isFrozen(PRODUCTION_CREDENTIAL_PIN)); assert.equal(FINAL_OWNER_CONFIRMATION, null);
 const target = createCandidate({ ...s.deps, credentialPin: null });
 assert.equal((await s.call('/preview', { proof: 'A'.repeat(43) }, { target })).r.status, 503);
 const env = { ...s.f.env, MFA_CONTRACT: STEPUP_CONTRACT, verify: s.deps.verify,
  credentialPin: s.auth.record, FINAL_OWNER_CONFIRMATION: { approved: true }, dispatchAuthorized: true };
 assert.equal((await s.call('/preview', {}, { target: production, env })).r.status, 503);
 assert.equal(s.f.sends, 0); assert.equal(s.f.row(), undefined);
});
test('enrollment entrypoint dependency graph contains no sender, transport, key or original ledger; config has no live bindings', () => {
 const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
 for (const name of ['src/enrollment.mjs', 'src/enrollment-assets.mjs', 'src/stepup.mjs', 'src/auth.mjs', 'src/stepup-release.mjs', 'src/policy-release.mjs']) {
  assert.doesNotMatch(read(name), /from ['"].*(?:resend|worker|ledger)\.mjs|RESEND_API_KEY|canary_campaign/);
 }
 const config = read('wrangler.enrollment.toml');
 assert.match(config, /workers_dev = false/); assert.match(config, /preview_urls = false/); assert.match(config, /routes = \[\]/);
 assert.doesNotMatch(config, /\[\[d1_databases\]\]|account_id\s*=|database_id\s*=|\[triggers\]|\[\[queues/);
});
