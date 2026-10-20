import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stepupFixture } from './stepup-fixtures.mjs';
import { enrollmentAssets } from '../src/enrollment-assets.mjs';
import { access } from './helpers.mjs';

const accessNavigation = {
 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'
};

test('signed owner Safari post-Access document GET loads HTML without state changes or sending dependencies', async t => {
 const s = await stepupFixture(t);
 // A static document needs neither D1 nor provider/signing keys or transport.
 const env = { ...s.f.env };
 for (const key of ['CANARY_DB', 'RESEND_API_KEY', 'APPROVAL_SIGNING_KEY']) delete env[key];
 const before = s.f.a.prepare('SELECT total_changes() n').get().n;
 const response = await s.enrollment.fetch(new Request(env.APP_ORIGIN + '/', { headers: {
  'Cf-Access-Jwt-Assertion': s.token, ...accessNavigation
 } }), env);
 assert.equal(response.status, 200);
 assert.equal(await response.text(), enrollmentAssets['/'].body);
 assert.match(response.headers.get('content-type'), /text\/html/);
 assert.equal(response.headers.get('set-cookie'), null);
 assert.equal(response.headers.get('location'), null);
 assert.equal(response.headers.get('access-control-allow-origin'), null);
 assert.equal(s.f.a.prepare('SELECT total_changes() n').get().n, before);
 assert.equal(s.f.a.prepare('SELECT count(*) n FROM stepup_candidate').get().n, 0);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});

for (const [name, patch] of [
 ['missing assertion', null], ['unsigned assertion', 'unsigned'],
 ['different signed subject', { sub: 'other-owner' }], ['different signed email', { email: 'other@identity.test' }],
 ['expired signed owner', { exp: 1800000000 }]
]) test(`post-Access document navigation denies ${name}`, async t => {
 const s = await stepupFixture(t);
 const token = patch && typeof patch === 'object' ? await access({ amr: undefined, ...patch }) : patch;
 const headers = { ...accessNavigation };
 if (token) headers['Cf-Access-Jwt-Assertion'] = token;
 const r = await s.enrollment.fetch(new Request(s.f.env.APP_ORIGIN + '/', { headers }), s.f.env);
 assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'enrollment_unavailable' });
});

for (const [name, path, headers, origin] of [
 ['cors document', '/', { ...accessNavigation, 'Sec-Fetch-Mode': 'cors' }],
 ['no-cors document', '/', { ...accessNavigation, 'Sec-Fetch-Mode': 'no-cors' }],
 ['image', '/', { ...accessNavigation, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' }],
 ['script', '/', { ...accessNavigation, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
 ['frame', '/', { ...accessNavigation, 'Sec-Fetch-Dest': 'iframe' }],
 ['missing mode', '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' }],
 ['missing destination', '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }],
 ['missing navigation metadata', '/', { 'Sec-Fetch-Site': 'cross-site' }],
 ['untrusted Origin', '/', { ...accessNavigation, Origin: 'https://evil.test' }],
 ['null Origin', '/', { ...accessNavigation, Origin: 'null' }],
 ['URL origin mismatch', '/', accessNavigation, 'https://evil.test'],
 ['cross-site script asset', '/enroll.js', { ...accessNavigation, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
 ['document navigation to script asset', '/enroll.js', accessNavigation],
 ['same-site document', '/', { ...accessNavigation, 'Sec-Fetch-Site': 'same-site' }]
]) test(`enrollment GET denies ${name}`, async t => {
 const s = await stepupFixture(t);
 const r = await s.enrollment.fetch(new Request((origin ?? s.f.env.APP_ORIGIN) + path, { headers: {
  'Cf-Access-Jwt-Assertion': s.token, ...headers
 } }), s.f.env);
 assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'enrollment_unavailable' });
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});

for (const path of ['/', '/enroll.js']) {
 for (const site of [undefined, 'none', 'same-origin']) test(`${path} retains GET support with Fetch Site ${site}`, async t => {
  const s = await stepupFixture(t);
  const headers = { 'Cf-Access-Jwt-Assertion': s.token, Origin: s.f.env.APP_ORIGIN };
  if (site) headers['Sec-Fetch-Site'] = site;
  if (site === 'same-origin') {
   headers['Sec-Fetch-Mode'] = path === '/' ? 'navigate' : 'no-cors';
   headers['Sec-Fetch-Dest'] = path === '/' ? 'document' : 'script';
  }
  const r = await s.enrollment.fetch(new Request(s.f.env.APP_ORIGIN + path, { headers }), s.f.env);
  assert.equal(r.status, 200); assert.equal(await r.text(), enrollmentAssets[path].body);
 });
}

for (const path of ['/stepup/session', '/enroll/register/options', '/enroll/register/verify', '/enroll/prove/options', '/enroll/prove/verify']) {
 test(`${path} POST rejects cross-site document metadata even with valid owner and session`, async t => {
  const s = await stepupFixture(t); await s.session(s.enrollment);
  const before = s.f.a.prepare('SELECT total_changes() n').get().n;
  const { r, data } = await s.call(path, {}, { target: s.enrollment, headers: accessNavigation });
  assert.equal(r.status, 503); assert.deepEqual(data, { error: 'enrollment_unavailable' });
  assert.equal(s.f.a.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
 });
}

test('enrollment browser requires separate explicit clicks; real registration/possession produce public fingerprint only', async t => {
 const s = await stepupFixture(t), calls = [], prompts = [];
 const elements = { '#result': { textContent: '' }, '#create': { disabled: false }, '#prove': { disabled: true } };
 function credential(serialized) {
  const binary = value => Uint8Array.from(Buffer.from(value, 'base64url')).buffer;
  return { id: serialized.id, rawId: binary(serialized.rawId), type: serialized.type,
   response: Object.fromEntries(Object.entries(serialized.response).map(([k, v]) => [k, binary(v)])),
   getClientExtensionResults: () => ({}) };
 }
 const context = vm.createContext({ document: { querySelector: key => elements[key] }, atob, btoa, Uint8Array,
  navigator: { credentials: {
   async create({ publicKey }) {
    prompts.push('create'); assert.equal(publicKey.authenticatorSelection.userVerification, 'required');
    assert.deepEqual(Array.from(publicKey.pubKeyCredParams, x => x.alg), [-7]);
    assert.equal(publicKey.rp.id, 'canary.test'); assert.equal(publicKey.attestation, 'none');
    return credential(s.auth.register(Buffer.from(publicKey.challenge).toString('base64url')));
   },
   async get({ publicKey }) {
    prompts.push('get'); assert.equal(publicKey.userVerification, 'required'); assert.equal(publicKey.rpId, 'canary.test');
    return credential(s.auth.assert(Buffer.from(publicKey.challenge).toString('base64url')));
   }
  } },
  async fetch(path, init) {
   calls.push(path); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error');
   const { r, data } = await s.call(path, JSON.parse(init.body), { target: s.enrollment });
   return Response.json(data, { status: r.status });
  }
 });
 vm.runInContext(enrollmentAssets['/enroll.js'].body, context);
 assert.deepEqual(prompts, []); assert.deepEqual(calls, []);
 await elements['#create'].onclick();
 assert.deepEqual(prompts, ['create']); assert.equal(elements['#prove'].disabled, false);
 assert.doesNotMatch(elements['#result'].textContent, /sha256:/);
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
 await elements['#prove'].onclick();
 assert.deepEqual(prompts, ['create', 'get']);
 const result = JSON.parse(elements['#result'].textContent);
 assert.equal(result.fingerprint, await s.fingerprint()); assert.equal(result.sendAuthority, false);
 assert.equal(result.trusted, false); assert.equal(result.possessionVerified, true);
 assert.equal(elements['#prove'].disabled, true);
 assert.ok(calls.every(path => path.startsWith('/enroll/') || path === '/stepup/session'));
 assert.equal(s.f.row(), undefined); assert.equal(s.f.sends, 0);
});

test('enrollment assets require signed owner and exact origin; CSP uses self-hosted scripts', async t => {
 const s = await stepupFixture(t);
 for (const path of ['/', '/enroll.js']) {
  const request = new Request(s.f.env.APP_ORIGIN + path, { headers: { 'Cf-Access-Jwt-Assertion': s.token } });
  const response = await s.enrollment.fetch(request, s.f.env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  const unauthorized = await s.enrollment.fetch(new Request(s.f.env.APP_ORIGIN + path), s.f.env);
  assert.equal(unauthorized.status, 503);
  const cross = await s.enrollment.fetch(new Request(s.f.env.APP_ORIGIN + path, { headers: {
   'Cf-Access-Jwt-Assertion': s.token, Origin: 'https://evil.test'
  } }), s.f.env);
  assert.equal(cross.status, 503);
 }
});
