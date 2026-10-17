import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stepupFixture } from './stepup-fixtures.mjs';
import { enrollmentAssets } from '../src/enrollment-assets.mjs';

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
