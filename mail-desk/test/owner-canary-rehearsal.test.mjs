import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOwnerCanaryRehearsal, FIXTURE_MESSAGE } from '../offline/owner-canary-rehearsal.mjs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function fixture() {
 const r = createOwnerCanaryRehearsal(), s = r.openSession();
 const p = r.preview(s, { ...FIXTURE_MESSAGE });
 return { r, s, p };
}
function approved() {
 const f = fixture(); f.review = f.r.review(f.s, f.p);
 f.token = f.r.approve(f.s, f.p, f.review); return f;
}
const run = (f, outcome) => f.r.simulateOnce(f.s, f.p, f.token, outcome);
const invalidMessages = [
 ['customer recipient', { recipient: 'customer@personal.test' }],
 ['recipient local casing', { recipient: 'Owner@personal.test' }],
 ['recipient domain casing', { recipient: 'owner@PERSONAL.test' }],
 ['plus alias', { recipient: 'owner+canary@personal.test' }],
 ['dot alias', { recipient: 'o.wner@personal.test' }],
 ['multiple recipients', { recipient: ['owner@personal.test', 'other@personal.test'] }],
 ['comma recipient', { recipient: 'owner@personal.test,other@personal.test' }],
 ['display name', { recipient: 'Owner <owner@personal.test>' }],
 ['recipient domain suffix confusion', { recipient: 'owner@personal.test.attacker.test' }],
 ['different sender', { sender: 'members@studio.test' }],
 ['sender casing', { sender: 'Support@studio.test' }],
 ['sender domain suffix confusion', { sender: 'support@studio.test.attacker.test' }],
 ['subject header injection', { subject: 'Canary\r\nBcc: other@personal.test' }],
 ['subject NUL', { subject: 'Canary\0' }],
 ['subject unicode separator', { subject: 'Canary\u2028injected' }],
 ['empty subject', { subject: ' ' }],
 ['oversized subject', { subject: 'x'.repeat(201) }],
 ['empty body', { body: '\n ' }],
 ['oversized body', { body: 'x'.repeat(10001) }],
 ['body CR injection', { body: 'test\r\nBcc: other@personal.test' }],
 ['body hidden control', { body: 'x\u0085y' }],
 ['body escape', { body: 'x\u001by' }],
 ['non-string body', { body: {} }]
];
for (const [name, patch] of invalidMessages) test(`owner canary rejects ${name}`, () => {
 const r = createOwnerCanaryRehearsal();
 assert.throws(() => r.preview(r.openSession(), { ...FIXTURE_MESSAGE, ...patch }));
 assert.equal(r.status().state, 'empty'); assert.equal(r.status().attempts, 0);
});
test('all extra envelope, thread, approval and content fields denied', () => {
 for (const key of ['cc', 'bcc', 'html', 'attachments', 'headers', 'replyTo', 'inReplyTo', 'references', 'approved', 'humanApproved', 'recipientAllowlist', 'mode']) {
  const r = createOwnerCanaryRehearsal();
  assert.throws(() => r.preview(r.openSession(), { ...FIXTURE_MESSAGE, [key]: true }));
 }
});
test('accessors, inherited fields and symbol fields denied without evaluating getters', () => {
 const r = createOwnerCanaryRehearsal(), s = r.openSession();
 assert.throws(() => r.preview(s, Object.create(FIXTURE_MESSAGE)));
 assert.throws(() => r.preview(s, { ...FIXTURE_MESSAGE, [Symbol('extra')]: true }));
 let called = false;
 const value = { ...FIXTURE_MESSAGE, get subject() { called = true; return 'unsafe'; } };
 assert.throws(() => r.preview(s, value)); assert.equal(called, false);
});
test('preview copies and freezes complete content at exact bounds', () => {
 const r = createOwnerCanaryRehearsal(), s = r.openSession();
 const m = { ...FIXTURE_MESSAGE, subject: 'x'.repeat(200), body: 'x'.repeat(9999) + '\n' };
 const p = r.preview(s, m); m.body = 'changed';
 assert.equal(p.message.body.length, 10000);
 assert.throws(() => { p.message.recipient = 'other@personal.test'; });
 assert.throws(() => { p.expires++; });
});
test('approval requires a separate review', () => {
 const f = fixture(); assert.throws(() => f.r.approve(f.s, f.p, true));
});
test('approval boolean cannot simulate', async () => {
 const f = approved(); await assert.rejects(f.r.simulateOnce(f.s, f.p, true));
 assert.equal(f.r.status().attempts, 0);
});
test('review token cannot simulate; approval token cannot review again', async () => {
 const f = approved(); await assert.rejects(f.r.simulateOnce(f.s, f.p, f.review));
 assert.throws(() => f.r.approve(f.s, f.p, f.token));
});
test('serialized and cloned tokens have no authority', async () => {
 const f = fixture(), review = f.r.review(f.s, f.p);
 assert.throws(() => f.r.approve(f.s, f.p, { ...review }));
 const token = f.r.approve(f.s, f.p, review);
 await assert.rejects(f.r.simulateOnce(f.s, f.p, JSON.parse(JSON.stringify(token))));
});
test('approve replay and review replay denied', () => {
 const f = approved(); assert.throws(() => f.r.approve(f.s, f.p, f.review));
 assert.throws(() => f.r.review(f.s, f.p));
});
test('exact session binding at every phase', async () => {
 const f = fixture(), other = f.r.openSession();
 assert.throws(() => f.r.review(other, f.p));
 const review = f.r.review(f.s, f.p);
 assert.throws(() => f.r.approve(other, f.p, review));
 const token = f.r.approve(f.s, f.p, review);
 await assert.rejects(f.r.simulateOnce(other, f.p, token));
 assert.throws(() => f.r.review({ ...f.s }, f.p));
});
test('snapshot clones and stale substituted content rejected at every phase', async () => {
 const f = fixture(), clone = structuredClone(f.p);
 assert.throws(() => f.r.review(f.s, clone));
 const review = f.r.review(f.s, f.p);
 assert.throws(() => f.r.approve(f.s, clone, review));
 const token = f.r.approve(f.s, f.p, review);
 await assert.rejects(f.r.simulateOnce(f.s, clone, token));
});
test('cross-instance tokens and sessions denied', async () => {
 const a = approved(), b = approved();
 await assert.rejects(b.r.simulateOnce(b.s, b.p, a.token));
 await assert.rejects(b.r.simulateOnce(a.s, b.p, b.token));
});
test('expiry equality denies review, approve and simulation', async () => {
 for (const stage of ['preview', 'review', 'approve']) {
  const f = fixture(); let token;
  if (stage !== 'preview') token = f.r.review(f.s, f.p);
  if (stage === 'approve') token = f.r.approve(f.s, f.p, token);
  f.r.advance(600);
  assert.throws(() => f.r.review(f.s, f.p));
  assert.throws(() => f.r.approve(f.s, f.p, token));
  await assert.rejects(f.r.simulateOnce(f.s, f.p, token));
  assert.equal(f.r.status().attempts, 0);
 }
});
test('clock cannot roll back or overflow to revive approval', () => {
 const f = approved();
 for (const value of [-1, NaN, Infinity, 0.1, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.r.advance(value));
 f.r.advance(600); assert.equal(f.r.status().state, 'expired');
});
test('concurrent simulation has one winner and no duplicate dispatch', async () => {
 const f = approved();
 const results = await Promise.allSettled([run(f), run(f)]);
 assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
 assert.equal(f.r.status().attempts, 1);
});
test('accepted simulation is terminal with no delivery assertion or retry', async () => {
 const f = approved(), result = await run(f);
 assert.equal(result.state, 'simulated-acceptance');
 assert.equal(result.delivery, 'unverified'); assert.equal(result.sendAuthority, false);
 await assert.rejects(run(f)); f.r.advance(86401); await assert.rejects(run(f));
 assert.equal(f.r.status().attempts, 1);
});
test('timeout UNKNOWN is terminal even beyond 24 hours', async () => {
 const f = approved(); assert.equal((await run(f, 'timeout')).state, 'UNKNOWN');
 f.r.advance(86401); await assert.rejects(run(f)); assert.equal(f.r.status().attempts, 1);
});
test('rejected simulation cannot be retried', async () => {
 const f = approved(); assert.equal((await run(f, 'rejected')).state, 'simulated-rejection');
 await assert.rejects(run(f));
});
test('mixed, malformed and forged outcome scripts never become acceptance', async () => {
 for (const value of ['accepted,rejected', 'UNKNOWN', { status: 'accepted' }, true, null, () => assert.fail('callback')]) {
  const f = approved(); assert.equal((await run(f, value)).state, 'UNKNOWN'); await assert.rejects(run(f));
 }
});
test('expiry during dispatch becomes UNKNOWN', async () => {
 const f = approved(), pending = run(f); assert.equal(f.r.status().state, 'dispatching');
 f.r.advance(600); assert.equal((await pending).state, 'UNKNOWN'); await assert.rejects(run(f));
});
test('one preview per instance; terminal result cannot mint another intention', async () => {
 const f = approved(); await run(f);
 assert.throws(() => f.r.preview(f.s, FIXTURE_MESSAGE));
 assert.throws(() => f.r.preview(f.r.openSession(), FIXTURE_MESSAGE));
 assert.equal(f.r.status().durableReplayProtection, false);
});
test('fixture cannot be configured into a production or callback path', () => {
 for (const config of [{}, { sender: FIXTURE_MESSAGE.sender }, { mode: 'production' }, () => assert.fail('callback')]) {
  assert.throws(() => createOwnerCanaryRehearsal(config));
 }
 assert.equal(Object.isFrozen(createOwnerCanaryRehearsal()), true);
});
test('rehearsal has no imports, transport, ambient clock or persistence', () => {
 const code = read('../offline/owner-canary-rehearsal.mjs').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
 assert.doesNotMatch(code, /\b(?:import|fetch|XMLHttpRequest|WebSocket|process|Date|setTimeout|Resend|Authorization)\b|https?:\/\//);
 const addresses = code.match(/[a-z]+@[a-z]+\.[a-z]+/g);
 assert.deepEqual(addresses, ['support@studio.test', 'owner@personal.test']);
});
test('entire deployed source tree and configs exclude owner rehearsal', () => {
 function check(path) {
  for (const entry of readdirSync(new URL(path, import.meta.url), { withFileTypes: true })) {
   if (entry.isDirectory()) check(`${path}/${entry.name}`);
   else assert.doesNotMatch(read(`${path}/${entry.name}`), /owner-canary-rehearsal/);
  }
 }
 check('../src'); check('../public');
 assert.doesNotMatch(read('../wrangler.staging.toml'), /owner-canary-rehearsal|offline\//);
});
test('actual production source hashes and unconditional hard block preserved', () => {
 // Candidate hash includes Cleanup A's folder guards; activation remains blocked.
 for (const [path, expected] of [
  ['../src/outbound.candidate.mjs', '9e28f7323f9fb8ac0cac52be24a1d2d83a0c3da1c4af69072db30920ea3ff20c'],
  ['../src/resend.future.mjs', 'c6ee94b26fe39157e58a265c805fb3cf1b300138dcb1d03ba3ead5e293410839']
 ]) assert.equal(createHash('sha256').update(read(path)).digest('hex'), expected);
 const code = read('../src/outbound.candidate.mjs');
 assert.match(code, /requireThat\(offline, 503, 'verified_ingress_unavailable'\)/);
 assert.match(code, /verifyEvidence:async \(\) => false, send:async \(\) => \{ throw Error\('integration_blocked'\); \}, offline:false/);
});
