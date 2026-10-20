import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, token, jwk } from './helpers.mjs';
import { b64, authenticate } from '../src/security.mjs';
for (const path of ['/', '/app.js', '/styles.css','/api/session','/api/cases','/api/not-a-route']) {
 test(`JWT required for ${path}`,async t => { const f = await fixture(t); const r = await f.request(path,undefined,{ headers:{ 'Cf-Access-Jwt-Assertion':null, 'Cf-Access-Authenticated-User-Email':'owner@example.test', Cookie:'CF_Authorization=forged' } }); assert.equal(r.status,401); assert.deepEqual(await r.json(),{ error:'unauthorized' }); });
}
for (const [name, claims, header] of [
 ['wrong issuer',{ iss:'https://evil.example.test' }], ['wrong audience',{ aud:['other'] }], ['wrong owner',{ email:'other@example.test' }], ['owner case mismatch',{ email:'Owner@example.test' }],
 ['expired',{ exp:1 }], ['future nbf',{ nbf:9999999999 }], ['future iat',{ iat:9999999999 }], ['missing nbf',{ nbf:undefined }], ['missing iat',{ iat:undefined }], ['missing exp',{ exp:undefined }],
 ['fractional exp',{ exp:9999999999.1 }], ['wrong algorithm',{}, { alg:'HS256' }], ['unknown key',{}, { kid:'evil' }], ['critical header',{}, { crit:['evil'] }]
]) test(`JWT denies ${name}`,async t => { const f=await fixture(t); assert.equal((await f.request('/api/cases',undefined,{ headers:{ 'Cf-Access-Jwt-Assertion':await token(claims,header) } })).status,401); });
for (const bad of ['invalid','e30.e30.invalid','a.b.c.d']) test(`JWT denies malformed ${bad}`,async t=>{ const f=await fixture(t); assert.equal((await f.request('/api/session',undefined,{headers:{'Cf-Access-Jwt-Assertion':bad}})).status,401); });
test('JWT denies forged RSA signature',async t=> { const f=await fixture(t); const parts=f.jwt.split('.'); parts[2]=b64(new Uint8Array(256)); assert.equal((await f.request('/api/session',undefined,{headers:{'Cf-Access-Jwt-Assertion':parts.join('.')}})).status,401); });
test('empty configuration fails closed',async t=>{ const f=await fixture(t,{env:{ACCESS_AUDIENCE:''}}); assert.equal((await f.request('/')).status,401); assert.equal(f.fetches(),0); });
test('valid JWT uses trusted cached JWKS and secure session headers',async t=>{ const f=await fixture(t); const s=await f.session(); assert.equal(s.r.status,200); assert.match(s.r.headers.get('Set-Cookie'),/__Host-maildesk=.*; Secure; HttpOnly; SameSite=Strict; Path=\//); await f.request('/api/cases'); assert.equal(f.fetches(),1); assert.equal(s.r.headers.get('Cache-Control'),'no-store'); assert.match(s.r.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/); assert.equal(s.r.headers.get('Access-Control-Allow-Origin'),null); });
for (const [name,headers] of [ ['missing Origin',{Origin:null}], ['wrong Origin',{Origin:'https://evil.example.test'}], ['null Origin',{Origin:'null'}], ['missing CSRF',{'X-CSRF-Token':null}], ['forged CSRF',{'X-CSRF-Token':'forged'}], ['missing cookie',{Cookie:null}], ['forged cookie',{Cookie:'__Host-maildesk=forged'}], ['cross-site metadata',{'Sec-Fetch-Site':'cross-site'}] ]) {
 test(`POST blocks ${name}`,async t=> {const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.request(`/api/cases/${id}/draft`,{revision:0,body:'reply'},{headers});assert.equal(r.status,403);assert.equal(f.calls(),0);assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM audit_events').get().n,1);});
}
test('CSRF cannot cross authenticated JWT sessions',async t=>{ const f=await fixture(t);await f.session();const id=await f.seed(); assert.equal((await f.request(`/api/cases/${id}/draft`,{revision:0,body:'reply'},{headers:{'Cf-Access-Jwt-Assertion':await token({sub:'different-session'})}})).status,403); });
for (const field of ['to','from','recipient','sender','cc','bcc','html']) test(`rejects forged ${field} at draft, review and send`,async t=>{ const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.review(id);for(const [action,data] of [['draft',{revision:r.revision,body:'safe'}],['review',{revision:r.revision}],['send',{intentId:r.id,approval:r.approval}]]) assert.equal((await f.request(`/api/cases/${id}/${action}`,{...data,[field]:'forged@example.test'})).status,400);assert.equal(f.calls(),0); });
test('rejects oversized streamed JSON and declared length',async t=>{const f=await fixture(t);await f.session();const id=await f.seed();assert.equal((await f.request(`/api/cases/${id}/draft`,{revision:0,body:'x'.repeat(21000)})).status,413);assert.equal((await f.request(`/api/cases/${id}/draft`,{revision:0,body:'safe'},{headers:{'Content-Length':'999999'}})).status,413);assert.equal((await f.request(`/api/cases/${id}/draft`,{revision:0,body:'safe'},{headers:{'Content-Length':'1'}})).status,400);});
test('rejects invalid JSON, wrong content type and unknown fields',async t=>{const f=await fixture(t);await f.session();const id=await f.seed();assert.equal((await f.request(`/api/cases/${id}/draft`,'{')).status,400);assert.equal((await f.request(`/api/cases/${id}/draft`,{body:'safe',revision:0},{headers:{'Content-Type':'text/plain'}})).status,415);assert.equal((await f.request(`/api/cases/${id}/review`,{revision:0,extra:true})).status,400);});
test('D1 atomic rate limit applies across concurrent POSTs',async t=>{const f=await fixture(t);await f.session();const id=await f.seed();const responses=await Promise.all(Array.from({length:35},()=>f.request(`/api/cases/${id}/draft`,{revision:0,body:'safe'})));assert.equal(responses.filter(r=>r.status===429).length,5);assert.equal(f.DB.sqlite.prepare('SELECT count FROM rate_limits').get().count,35);});
test('no inbound route, send on GET, or public preflight',async t=>{const f=await fixture(t);await f.session();const id=await f.seed();await f.review(id);assert.equal((await f.request(`/api/cases/${id}/send`)).status,405);assert.equal((await f.request('/api/inbound',{})).status,404);assert.equal((await f.request('/api/cases',undefined,{method:'OPTIONS'})).status,405);assert.equal(f.calls(),0);});

// Cloudflare's Workers runtime rejects Request redirect mode "error" before fetching JWKS.
test('JWKS fetch uses manual redirects and verifies a valid signed JWT', async t => {
 const f = await fixture(t);
 let requests = 0;
 const auth = await authenticate(new Request(f.env.APP_ORIGIN, { headers: { 'Cf-Access-Jwt-Assertion': f.jwt } }), f.env, async (url, options) => {
  requests++;
  assert.equal(url, `${f.env.ACCESS_ISSUER}/cdn-cgi/access/certs`);
  assert.equal(options.redirect, 'manual');
  assert.ok(options.signal instanceof AbortSignal);
  return Response.json({ keys: [jwk] });
 });
 assert.equal(requests, 1);
 assert.equal(typeof auth.session, 'string');
});
test('JWKS redirects fail closed without following the redirect', async t => {
 const f = await fixture(t);
 for (const status of [301, 302, 307, 308]) {
  let requests = 0;
  await assert.rejects(authenticate(new Request(f.env.APP_ORIGIN, { headers: { 'Cf-Access-Jwt-Assertion': f.jwt } }), f.env, async (url, options) => {
   requests++;
   assert.equal(options.redirect, 'manual');
   return new Response(null, { status, headers: { Location: 'https://untrusted.example.test/keys' } });
  }), error => error.status === 401 && error.message === 'unauthorized');
  assert.equal(requests, 1);
 }
});
