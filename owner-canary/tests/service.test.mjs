import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, access, database } from './helpers.mjs';
import { createCandidate } from '../src/worker.mjs';
const denied = result => { assert.equal(result.response.status, 503); assert.deepEqual(result.data, { error: 'canary_unavailable' }); };

test('full fixed snapshot, separate human transitions, dispatch only once, accepted != delivery', async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 let r = await f.call('/preview');
 assert.equal(r.response.status, 201);
 assert.deepEqual(r.data.snapshot.payload, {
  from: 'support@bigsoxstudios.com', subject: 'Big Sox Studios — Outbound Email Verification',
  text: 'This is a one-time test of the Big Sox Studios outbound email system.\n\nThe message verifies that support@bigsoxstudios.com can securely send email through Resend.\n\nNo customer tickets or customer messages are involved.\n\n— Big Sox Studios', to: 'owner@personal.test'
 });
 assert.match(r.response.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict; Path=\//);
 assert.equal(r.response.headers.get('cache-control'), 'no-store, private');
 assert.equal(r.response.headers.get('access-control-allow-origin'), null);
 for (const step of ['/review', '/approve']) { r = await f.call(step); assert.equal(r.response.status, 200); assert.equal(f.sends, 0); }
 r = await f.call('/dispatch'); assert.equal(r.data.status, 'accepted'); assert.equal(r.data.delivery, 'unverified');
 assert.equal(f.sends, 1); assert.equal(f.row().status, 'accepted'); assert.ok(f.row().provider_id);
 denied(await f.call('/dispatch')); denied(await f.call('/preview')); assert.equal(f.sends, 1);
 assert.ok(!JSON.stringify(r.data).includes(f.env.RESEND_API_KEY));
});

for (const path of ['/review', '/approve', '/dispatch']) test(`can't invent capability for ${path}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup()); denied(await f.call(path, { token: 'invented' })); assert.equal(f.sends, 0);
});
for (const field of ['from','to','recipient','subject','text','html','headers','cc','bcc','replyTo','inReplyTo','references','approved','mfa']) test(`client cannot supply ${field}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup()); denied(await f.call('/preview', { [field]: 'customer@evil.test' })); assert.equal(f.row(), undefined);
});
for (const [name, headers] of [
 ['cross origin', { Origin: 'https://evil.test' }], ['missing origin', { Origin: '' }],
 ['cross site', { 'Sec-Fetch-Site': 'cross-site' }], ['missing fetch metadata', { 'Sec-Fetch-Site': '' }],
 ['form post', { 'Content-Type': 'application/x-www-form-urlencoded' }],
 ['missing action', { 'X-Canary-Action': '' }], ['bearer token', { Authorization: 'Bearer ignored' }],
 ['missing assertion', { 'Cf-Access-Jwt-Assertion': '' }]
]) test(`CSRF/auth deny ${name}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup()); denied(await f.call('/preview', {}, { headers })); assert.equal(f.row(), undefined);
});
for (const path of ['/preview?to=other@evil.test', '/delete', '/reset']) test(`no alternate mutation ${path}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup()); denied(await f.call(path));
});
test('no GET mutations, OPTIONS/CORS or DELETE route', async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 for (const method of ['GET','OPTIONS','DELETE']) {
  const r = await f.worker.fetch(new Request('https://canary.test/preview', { method, headers: { 'Cf-Access-Jwt-Assertion': f.token } }), f.env);
  assert.equal(r.status, 503); assert.equal(f.row(), undefined);
 }
 const r = await f.worker.fetch(new Request('https://canary.test/status', { headers: { 'Cf-Access-Jwt-Assertion': f.token } }), f.env);
 assert.equal((await r.json()).status, 'empty'); assert.equal(f.row(), undefined);
});
test('bounded input, null and array fail without creating campaign', async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 for (const body of [null, [], 'x'.repeat(5000)]) denied(await f.call('/preview', body));
 assert.equal(f.row(), undefined);
});
test('review and approval cannot be skipped or replayed', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.call('/preview'); const preview = f.stageToken;
 denied(await f.call('/approve')); denied(await f.call('/dispatch'));
 await f.call('/review'); const review = f.stageToken;
 denied(await f.call('/review', { token: preview }));
 await f.call('/approve'); denied(await f.call('/approve', { token: review })); assert.equal(f.sends, 0);
});
test('client-edited signed capability fails', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.call('/preview');
 const parts = f.stageToken.split('.'); const p = JSON.parse(Buffer.from(parts[1], 'base64url')); p.stage = 'approved';
 parts[1] = Buffer.from(JSON.stringify(p)).toString('base64url'); denied(await f.call('/dispatch', { token: parts.join('.') }));
});
for (const step of ['/review','/approve','/dispatch']) test(`active session invalidation rechecked at ${step}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 for (const s of ['/preview','/review','/approve']) { if (s === step) break; await f.call(s); }
 f.revoke(); denied(await f.call(step)); assert.equal(f.sends, 0);
});
test('a different signed JWT for same sub cannot adopt session', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.call('/preview');
 const token = await access({ jti: 'new-session' });
 denied(await f.call('/review', undefined, { headers: { 'Cf-Access-Jwt-Assertion': token } }));
});
for (const cookie of ['', '__Host-canary=invented', '__Host-canary=11111111-1111-4111-8111-111111111111', '__Host-canary=x; __Host-canary=y']) test(`cookie/session binding ${cookie}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.call('/preview');
 denied(await f.call('/review', undefined, { headers: { Cookie: cookie } }));
});
for (const patch of [
 { CANARY_OWNER_MAILBOX: 'other@personal.test' }, { CANARY_CAMPAIGN_ID: '22222222-2222-4222-8222-222222222222' },
 { SESSION_EPOCH: 'revoked-session-epoch' }, { OWNER_PRINCIPAL: 'other' },
 { APPROVAL_SIGNING_KEY: 'Y'.repeat(64) }, { MFA_CONTRACT: 'policy-browser-flag' },
 { CANARY_SEND_ENABLED: 'true' }, { CANARY_SEND_ENABLED: 'false' }, { DEPLOYMENT_STAGE: 'staging' },
 { RESEND_API_KEY: '' }, { CANARY_OWNER_MAILBOX: 'Owner <owner@personal.test>' },
 { CANARY_OWNER_MAILBOX: 'owner@personal.test,other@personal.test' }
]) test(`configuration invalidates approval: ${Object.keys(patch)[0]} ${Object.values(patch)[0].slice(0,25)}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.approved(); Object.assign(f.env, patch);
 denied(await f.call('/dispatch')); assert.equal(f.sends, 0); assert.equal(f.row().status, 'approved');
});
test('expired approval cannot dispatch and cannot be replaced', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.approved(); f.advance(300);
 denied(await f.call('/dispatch')); denied(await f.call('/preview')); assert.equal(f.sends, 0);
});
test('two worker instances and two SQLite connections race: one dispatch winner', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.approved();
 const token = f.stageToken;
 const results = await Promise.all([
  f.call('/dispatch', { token }),
  f.call('/dispatch', { token }, {}, f.second, { ...f.env, CANARY_DB: database(f.b) })
 ]);
 assert.deepEqual(results.map(r => r.response.status).sort(), [200,503]); assert.equal(f.sends, 1); assert.equal(f.row().status, 'accepted');
});
test('concurrent previews cannot consume two campaigns', async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 const results = await Promise.all([f.call('/preview'), f.call('/preview', {}, {}, f.second, { ...f.env, CANARY_DB: database(f.b) })]);
 assert.deepEqual(results.map(r => r.response.status).sort(), [201,503]); assert.equal(f.a.prepare('SELECT count(*) AS n FROM canary_campaign').get().n, 1);
});
test('release hard block leaves approved record unclaimed even with all runtime flags', async t => {
 const f = await fixture({ dispatchAuthorized: false }); t.after(() => f.cleanup()); await f.approved();
 denied(await f.call('/dispatch')); assert.equal(f.sends, 0); assert.equal(f.row().status, 'approved');
});
for (const [name, transport, status] of [
 ['timeout', async () => { throw new Error('timeout'); }, 'UNKNOWN'],
 ['bad json', async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }), 'UNKNOWN'],
 ['HTML', async () => new Response('<html>provider error</html>', { headers: { 'Content-Type': 'text/html' } }), 'UNKNOWN'],
 ['500', async () => new Response('{"name":"server_error"}', { status: 500, headers: { 'Content-Type': 'application/json' } }), 'UNKNOWN'],
 ['429', async () => new Response('{"name":"rate_limit"}', { status: 429, headers: { 'Content-Type': 'application/json' } }), 'UNKNOWN'],
 ['mixed success', async () => new Response('{"id":"22222222-2222-4222-8222-222222222222","error":true}', { headers: { 'Content-Type': 'application/json' } }), 'UNKNOWN'],
 ['oversized response', async () => new Response('x'.repeat(4097), { headers: { 'Content-Type': 'application/json' } }), 'UNKNOWN'],
 ['refusal', async () => new Response('{"name":"validation_error"}', { status: 422, headers: { 'Content-Type': 'application/json' } }), 'refused']
]) test(`${name} is permanent ${status}, never retry even across rollout`, async t => {
 const f = await fixture({ transport }); t.after(() => f.cleanup()); await f.approved();
 const r = await f.call('/dispatch'); assert.equal(r.data.status, status); assert.equal(f.row().status, status);
 denied(await f.call('/dispatch', undefined, {}, createCandidate(f.deps))); denied(await f.call('/preview')); assert.equal(f.sends, 1);
});
test('provider call observes durable claim and exact immutable wire payload', async t => {
 let f;
 f = await fixture({ transport: async (url, init) => {
  assert.equal(f.b.prepare('SELECT status FROM canary_campaign').get().status, 'submitted');
  assert.equal(url, 'https://api.resend.com/emails'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, `Bearer ${f.env.RESEND_API_KEY}`);
  assert.match(init.headers['Idempotency-Key'], new RegExp(`^owner-canary/${f.env.CANARY_CAMPAIGN_ID}/${f.row().digest}$`));
  assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['from','subject','text','to']);
  assert.equal(init.body, JSON.stringify(JSON.parse(f.row().snapshot).payload)); assert.ok(init.signal instanceof AbortSignal);
  return new Response('{"id":"22222222-2222-4222-8222-222222222222"}', { headers: { 'Content-Type': 'application/json' } });
 } }); t.after(() => f.cleanup()); await f.approved(); assert.equal((await f.call('/dispatch')).data.status, 'accepted');
});
test('crash after durable claim forbids dispatch with no provider call', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.approved();
 f.a.prepare("UPDATE canary_campaign SET status='submitted', claimed=? WHERE status='approved'").run(1800000000);
 denied(await f.call('/dispatch', undefined, {}, f.second)); denied(await f.call('/preview')); assert.equal(f.sends, 0);
});
test('failed outcome persistence stays submitted/UNKNOWN and cannot retry', async t => {
 let f; f = await fixture({ transport: async () => {
  f.a.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON canary_campaign WHEN OLD.status='submitted' BEGIN SELECT RAISE(ABORT,'disk fixture'); END");
  return new Response('{"id":"22222222-2222-4222-8222-222222222222"}', { headers: { 'Content-Type': 'application/json' } });
 } }); t.after(() => f.cleanup()); await f.approved();
 const r = await f.call('/dispatch'); assert.equal(r.data.status, 'UNKNOWN'); assert.equal(r.response.status, 503);
 assert.equal(f.row().status, 'submitted'); denied(await f.call('/dispatch')); assert.equal(f.sends, 1);
});
test('database forbids snapshot edits, re-review, reset, replacement and deletion', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.approved();
 for (const sql of ["DELETE FROM canary_campaign", "UPDATE canary_campaign SET snapshot='edited'", "UPDATE canary_campaign SET digest='" + 'a'.repeat(64) + "'", "UPDATE canary_campaign SET status='reviewed'", "UPDATE canary_campaign SET expires=expires+1", 'UPDATE canary_campaign SET id=2', 'INSERT OR REPLACE INTO canary_campaign SELECT * FROM canary_campaign']) assert.throws(() => f.a.exec(sql));
 await f.call('/dispatch');
 assert.throws(() => f.a.exec("UPDATE canary_campaign SET status='approved'"));
 assert.throws(() => f.a.exec("UPDATE canary_campaign SET provider_id='changed'"));
});
test('expiry while claim is in flight consumes slot without contacting provider', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.approved();
 const original = f.env.CANARY_DB;
 f.env.CANARY_DB = { prepare(sql) {
  const statement = original.prepare(sql);
  return { bind(...args) {
   const bound = statement.bind(...args);
   return { async first() {
    const result = await bound.first();
    if (sql.includes('SET status=?') && args[0] === 'submitted') f.advance(301);
    return result;
   } };
  } };
 } };
 const result = await f.call('/dispatch');
 assert.equal(result.data.status, 'UNKNOWN'); assert.equal(f.sends, 0); assert.equal(f.row().status, 'UNKNOWN');
 denied(await f.call('/dispatch'));
});
test('concurrent approvals cannot mint two usable approval capabilities', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.call('/preview'); await f.call('/review');
 const token = f.stageToken;
 const results = await Promise.all([f.call('/approve', { token }), f.call('/approve', { token }, {}, f.second, { ...f.env, CANARY_DB: database(f.b) })]);
 assert.deepEqual(results.map(r => r.response.status).sort(), [200,503]);
 assert.equal(f.row().status, 'approved'); assert.equal(f.sends, 0);
 assert.equal((await f.call('/dispatch')).data.status, 'accepted'); assert.equal(f.sends, 1);
});
test('durable audit stores hashes instead of JWT, browser capability or session cookie', async t => {
 const f = await fixture(); t.after(() => f.cleanup()); await f.approved();
 const audit = JSON.stringify(f.row());
 for (const secret of [f.token, f.stageToken, f.cookie.split('=')[1], f.env.RESEND_API_KEY, f.env.APPROVAL_SIGNING_KEY]) assert.ok(!audit.includes(secret));
 assert.ok(f.row().reviewed); assert.ok(f.row().approved);
});
