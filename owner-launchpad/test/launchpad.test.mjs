import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.mjs';
import { b64, createAuthenticator } from '../src/security.mjs';
import { readFileSync } from 'node:fs';

const encode = value => b64(new TextEncoder().encode(JSON.stringify(value)));
const time = 1800000000000;
const seconds = time / 1000;
const env = { ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic-audience', OWNER_EMAIL: 'owner@example.test', APP_ORIGIN: 'https://launchpad.example.test', MAIL_DESK_URL: 'https://mail.example.test/' };
async function key(kid) {
 const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
 return { pair, jwk: { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg:'RS256', use:'sig' } };
}
const first = await key('first'), second = await key('rotated');
async function token(changes = {}, headerChanges = {}, signer = first) {
 const header = { alg:'RS256', kid:signer.jwk.kid, typ:'JWT', ...headerChanges };
 const claims = { iss:env.ACCESS_ISSUER, aud:[env.ACCESS_AUDIENCE], email:env.OWNER_EMAIL, exp:seconds+3600, nbf:seconds-10, iat:seconds-10, ...changes };
 const body = `${encode(header)}.${encode(claims)}`;
 return `${body}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.pair.privateKey, new TextEncoder().encode(body)))}`;
}
function fixture(fetcher, config = env) {
 const calls = []; let clock = time;
 const worker = createWorker({ now:() => clock, fetcher:async function(url, options) {
  assert.equal(this, undefined, 'workerd fetch must be called unbound');
  calls.push(url); assert.equal(url, `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`);
  assert.equal(options.redirect, 'manual'); assert.ok(options.signal instanceof AbortSignal);
  return fetcher ? fetcher(url, options) : Response.json({ keys:[first.jwk] });
 } });
 return { calls, advance:ms => { clock += ms; }, request:async (jwt, path='/', options={}) => worker.fetch(new Request(new URL(path, config.APP_ORIGIN || env.APP_ORIGIN), { ...options, headers:{ ...(jwt ? { 'Cf-Access-Jwt-Assertion':jwt } : {}), ...options.headers } }), config) };
}
async function denied(response, status=401) {
 assert.equal(response.status, status); const body = await response.text();
 assert.ok(!body.includes('Mail Desk') && !body.includes(env.MAIL_DESK_URL) && !body.includes(env.OWNER_EMAIL));
 assert.ok(!body.includes('PRIVATE_SENTINEL'));
 assert.equal(response.headers.get('Cache-Control'), 'no-store');
 assert.equal(response.headers.get('Location'), null);
}
function deferred() {
 let resolve, reject;
 const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
 return { promise, resolve, reject };
}
const drain = () => new Promise(resolve => setImmediate(resolve));
function heldFetch() {
 const started = deferred(), result = deferred();
 return { started: started.promise, ...result, fetch: () => { started.resolve(); return result.promise; } };
}

test('24 valid-owner requests share cold and expired JWKS refreshes', async () => {
 const jwt = await token(); let flight = heldFetch();
 const f = fixture(() => flight.fetch());
 for (const expectedCalls of [1, 2]) {
  let completed = 0;
  const requests = Array.from({length:24}, () => f.request(jwt).then(r => { completed++; return r; }));
  await flight.started; await drain();
  assert.equal(f.calls.length, expectedCalls); assert.equal(completed, 0);
  flight.resolve(Response.json({keys:[first.jwk]}));
  for (const response of await Promise.all(requests)) assert.equal(response.status, 200);
  assert.equal((await f.request(jwt)).status, 200); assert.equal(f.calls.length, expectedCalls);
  f.advance(300000); flight = heldFetch();
 }
});

test('single flight covers streamed JWKS reading and isolates issuers', async () => {
 const other = {...env, ACCESS_ISSUER:'https://other.cloudflareaccess.com'};
 const jwt = await token(), otherJwt = await token({iss:other.ACCESS_ISSUER});
 const started = deferred(); let body, calls = 0;
 const authenticate = createAuthenticator({now:() => time, fetcher:async url => {
  calls++;
  if (url === `${other.ACCESS_ISSUER}/cdn-cgi/access/certs`) return Response.json({keys:[first.jwk]});
  assert.equal(url, `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`);
  return new Response(new ReadableStream({start(controller) { body = controller; started.resolve(); }}));
 }});
 const request = jwt => new Request(env.APP_ORIGIN, {headers:{'Cf-Access-Jwt-Assertion':jwt}});
 let completed = 0;
 const requests = Array.from({length:24}, () => authenticate(request(jwt), env).then(() => { completed++; }));
 await started.promise; await drain(); assert.equal(calls, 1); assert.equal(completed, 0);
 await authenticate(request(otherJwt), other); assert.equal(calls, 2); assert.equal(completed, 0);
 body.enqueue(new TextEncoder().encode(JSON.stringify({keys:[first.jwk]}))); body.close();
 await Promise.all(requests); assert.equal(completed, 24); assert.equal(calls, 2);
});

for (const failure of ['network', 'invalid whole set']) test(`concurrent ${failure} failure retires keys and shares negative cache and recovery`, async () => {
 const jwt = await token(); let flight;
 const f = fixture(() => flight ? flight.fetch() : Response.json({keys:[first.jwk]}));
 assert.equal((await f.request(jwt)).status, 200);
 f.advance(300000); flight = heldFetch();
 const requests = Array.from({length:24}, () => f.request(jwt));
 await flight.started; await drain(); assert.equal(f.calls.length, 2);
 if (failure === 'network') flight.reject(Error('PRIVATE_SENTINEL'));
 else flight.resolve(Response.json({keys:[first.jwk, null]}));
 for (const response of await Promise.all(requests)) await denied(response);
 const unknown = await token({}, {kid:'unknown'});
 f.advance(29999);
 for (const response of await Promise.all(Array.from({length:24}, (_, i) => f.request(i % 2 ? jwt : unknown)))) await denied(response);
 assert.equal(f.calls.length, 2);
 f.advance(1); flight = heldFetch();
 const recovery = Array.from({length:24}, () => f.request(jwt));
 await flight.started; await drain(); assert.equal(f.calls.length, 3);
 flight.resolve(Response.json({keys:[first.jwk]}));
 for (const response of await Promise.all(recovery)) assert.equal(response.status, 200);
 assert.equal(f.calls.length, 3);
});

test('concurrent rotation joins known and distinct unknown kids, removes old keys and preserves cooldown', async () => {
 const old = await token(), rotated = await token({}, {}, second);
 const unknowns = await Promise.all(Array.from({length:24}, (_, i) => token({}, {kid:`unknown-${i}`})));
 let flight;
 const f = fixture(() => flight ? flight.fetch() : Response.json({keys:[first.jwk]}));
 assert.equal((await f.request(old)).status, 200); flight = heldFetch();
 const rotation = Array.from({length:24}, () => f.request(rotated));
 await flight.started;
 let completed = 0;
 const others = [old, ...unknowns].map(jwt => f.request(jwt).then(r => { completed++; return r; }));
 await drain(); assert.equal(f.calls.length, 2); assert.equal(completed, 0);
 flight.resolve(Response.json({keys:[second.jwk]}));
 for (const response of await Promise.all(rotation)) assert.equal(response.status, 200);
 for (const response of await Promise.all(others)) await denied(response);
 f.advance(29999);
 for (const response of await Promise.all(unknowns.map(jwt => f.request(jwt)))) await denied(response);
 assert.equal(f.calls.length, 2);
 f.advance(1); flight = heldFetch();
 const retry = unknowns.map(jwt => f.request(jwt));
 await flight.started; await drain(); assert.equal(f.calls.length, 3);
 flight.resolve(Response.json({keys:[second.jwk]}));
 for (const response of await Promise.all(retry)) await denied(response);
 assert.equal((await f.request(rotated)).status, 200); assert.equal(f.calls.length, 3);
});

test('failed concurrent rotation denies previously known keys until negative cache expires', async () => {
 const jwt = await token(), unknown = await token({}, {kid:'new'}); let flight;
 const f = fixture(() => flight ? flight.fetch() : Response.json({keys:[first.jwk]}));
 assert.equal((await f.request(jwt)).status, 200); flight = heldFetch();
 const rotation = f.request(unknown); await flight.started;
 const known = Array.from({length:24}, () => f.request(jwt));
 await drain(); assert.equal(f.calls.length, 2);
 flight.reject(Error('PRIVATE_SENTINEL'));
 for (const response of await Promise.all([rotation, ...known])) await denied(response);
 f.advance(29999); await denied(await f.request(jwt)); assert.equal(f.calls.length, 2);
 f.advance(1); flight = undefined;
 assert.equal((await f.request(jwt)).status, 200); assert.equal(f.calls.length, 3);
});

for (const recovery of ['success', 'failure']) for (const late of ['success', 'failure']) test(`timed-out shared refresh cannot overwrite newer ${recovery} with late ${late}`, async t => {
 const old = await token(), rotated = await token({}, {}, second);
 const stalled = heldFetch(); let signal;
 const f = fixture((url, options) => {
  if (f.calls.length === 1) { signal = options.signal; return stalled.fetch(); }
  if (recovery === 'failure') throw Error('PRIVATE_SENTINEL');
  return Response.json({keys:[second.jwk]});
 });
 t.mock.timers.enable({apis:['setTimeout']});
 const requests = Array.from({length:24}, () => f.request(old));
 await stalled.started; await drain(); assert.equal(f.calls.length, 1);
 t.mock.timers.tick(4999); await drain(); assert.equal(signal.aborted, false);
 t.mock.timers.tick(1);
 for (const response of await Promise.all(requests)) await denied(response);
 assert.equal(signal.aborted, true);
 f.advance(29999); await denied(await f.request(rotated)); assert.equal(f.calls.length, 1);
 f.advance(1);
 const recovered = await f.request(rotated);
 if (recovery === 'success') assert.equal(recovered.status, 200);
 else await denied(recovered);
 assert.equal(f.calls.length, 2);
 if (late === 'success') stalled.resolve(Response.json({keys:[first.jwk]}));
 else stalled.reject(Error('PRIVATE_SENTINEL'));
 await drain();
 if (recovery === 'failure') {
  for (const response of await Promise.all([f.request(old), f.request(rotated)])) await denied(response);
  assert.equal(f.calls.length, 2);
  return;
 }
 assert.equal((await f.request(rotated)).status, 200);
 // The recovered set's first unknown-kid refresh also returns only the new key.
 await denied(await f.request(old)); assert.equal(f.calls.length, 3);
 assert.equal((await f.request(rotated)).status, 200);
});

test('approved production deployment config pins private owner-only Access app, with no public URL or secret in source', () => {
 const config = readFileSync(new URL('../wrangler.production.toml', import.meta.url), 'utf8');
 const declared = new Map([...config.matchAll(/^([A-Z_]+) = "([^"]*)"$/gm)].map(([,name,value]) => [name,value]));
 assert.equal(config.match(/^name = "([^"]+)"$/m)?.[1], 'bss-owner-launchpad');
 assert.equal(declared.get('ACCESS_ISSUER'), 'https://old-hill-995d.cloudflareaccess.com');
 assert.equal(declared.get('ACCESS_AUDIENCE'), 'e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0');
 assert.equal(declared.get('APP_ORIGIN'), 'https://owner.bigsoxstudios.com');
 assert.equal(declared.get('MAIL_DESK_URL'), 'https://bss-mail-desk-staging.fridman-greg.workers.dev/');
 assert.match(config, /^workers_dev = false$/m);
 assert.match(config, /^preview_urls = false$/m);
 assert.doesNotMatch(config, /^routes?\s*=/m);
 assert.doesNotMatch(config, /^OWNER_EMAIL\s*=/m);
 assert.equal([...declared.keys()].length, 4);
});

test('offline deployment configuration pins actual protected Mail Desk and remains fail closed', () => {
 const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
 assert.match(config, /^MAIL_DESK_URL = "https:\/\/bss-mail-desk-staging\.fridman-greg\.workers\.dev\/"$/m);
 assert.match(config, /^ACCESS_ISSUER = ""$/m);
 assert.match(config, /^ACCESS_AUDIENCE = ""$/m);
 assert.match(config, /^APP_ORIGIN = ""$/m);
 assert.match(config, /^workers_dev = false$/m);
 assert.match(config, /^preview_urls = false$/m);
 assert.doesNotMatch(config, /OWNER_EMAIL\s*=/m);
});

test('owner GET and HEAD: two exact destinations, no secrets or scripts; strict headers', async () => {
 const f = fixture(); const jwt = await token();
 const response = await f.request(jwt); assert.equal(response.status,200);
 const html = await response.text();
 assert.deepEqual([...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]), ['https://bigsoxstudios.com/admin/', env.MAIL_DESK_URL]);
 for (const secret of [jwt, env.OWNER_EMAIL, env.ACCESS_AUDIENCE, env.ACCESS_ISSUER]) assert.ok(!html.includes(secret));
 assert.ok(!html.includes('<script') && !html.includes('<form') && !html.includes('src='));
 for (const [name,value] of Object.entries({ 'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','strict-transport-security':'max-age=31536000' })) assert.equal(response.headers.get(name),value);
 assert.match(response.headers.get('content-security-policy'), /script-src 'none'/);
 assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
 const head = await f.request(jwt,'/',{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
 assert.deepEqual([...head.headers], [...response.headers]); assert.equal(f.calls.length,1);
 assert.equal((await fixture().request(await token({aud:env.ACCESS_AUDIENCE}))).status,200);
});

for (const [name, changes] of [
 ['wrong issuer',{iss:'https://evil.example.test'}], ['wrong audience',{aud:['other']}], ['audience substring',{aud:`x${env.ACCESS_AUDIENCE}`}], ['mixed audience',{aud:[env.ACCESS_AUDIENCE,4]}],
 ['wrong email',{email:'editor@example.test'}], ['case mismatch',{email:'Owner@example.test'}], ['expired',{exp:seconds}], ['future nbf',{nbf:seconds+1}], ['future iat',{iat:seconds+1}],
 ['missing exp',{exp:undefined}], ['missing nbf',{nbf:undefined}], ['missing iat',{iat:undefined}], ['string exp',{exp:String(seconds+100)}], ['fraction iat',{iat:seconds-0.5}], ['negative iat',{iat:-1}], ['unsafe date',{exp:Number.MAX_SAFE_INTEGER+1}],
]) test(`reject ${name}`, async () => { const f=fixture(); await denied(await f.request(await token(changes))); assert.equal(f.calls.length,0); });

for (const [name, header] of [['none algorithm',{alg:'none'}], ['HS256',{alg:'HS256'}], ['critical header',{crit:[]}], ['remote key',{jku:'https://evil.example.test'}], ['embedded key',{jwk:first.jwk}], ['x5u',{x5u:'https://evil.example.test'}], ['b64 override',{b64:false}], ['missing kid',{kid:undefined}]])
 test(`reject ${name}`,async()=>{const f=fixture();await denied(await f.request(await token({},header))); assert.equal(f.calls.length,0);});

test('missing, malformed, unsigned, tampered and forged tokens; no cookie/header fallback',async()=>{
 const good=await token(); const parts=good.split('.');
 for(const jwt of [undefined,'garbage','a.b.c',`${parts[0]}.${parts[1]}.`,`${parts[0]}.${encode({email:env.OWNER_EMAIL})}.${parts[2]}`,`${encode(null)}.${parts[1]}.${parts[2]}`,`${parts[0]}.${encode([])}.${parts[2]}`,good+'=', 'x'.repeat(16384),await token({}, {kid:first.jwk.kid},second)]) await denied(await fixture().request(jwt));
 await denied(await fixture().request(undefined,'/',{headers:{Cookie:`CF_Authorization=${good}`, 'Cf-Access-Authenticated-User-Email':env.OWNER_EMAIL}}));
});

test('rotation refreshes unknown kid once, verifies new signature and throttles unknown kids',async()=>{
 let keys=[first.jwk]; const f=fixture(()=>Response.json({keys}));
 assert.equal((await f.request(await token())).status,200); keys=[second.jwk];
 assert.equal((await f.request(await token({}, {}, second))).status,200); assert.equal(f.calls.length,2);
 await denied(await f.request(await token({}, {kid:'unknown'}))); assert.equal(f.calls.length,2);
 f.advance(30001); await denied(await f.request(await token({}, {kid:'unknown'}))); assert.equal(f.calls.length,3);
});

test('expired JWKS never falls back on network error; removed key loses access',async()=>{
 let mode=0;const f=fixture(()=> {if(mode===1)throw Error('PRIVATE_SENTINEL');return Response.json({keys:mode===2?[second.jwk]:[first.jwk]});});
 assert.equal((await f.request(await token())).status,200); f.advance(300001); mode=1; await denied(await f.request(await token()));
 mode=2; f.advance(30001); await denied(await f.request(await token()));
});

const badJwks = [null, {}, {keys:[]}, {keys:Array(21).fill(first.jwk)}, {keys:[first.jwk, first.jwk]}, {keys:[{...first.jwk,kty:'EC'}]}, {keys:[{...first.jwk,alg:'HS256'}]}, {keys:[{...first.jwk,use:'enc'}]}, {keys:[{...first.jwk,key_ops:['sign']}]}, {keys:[{...first.jwk,n:'bad'}]}, {keys:[{...first.jwk,e:'Ag'}]}, {keys:[{...first.jwk,d:'private'}]}, {keys:[first.jwk,null]}];
for (const [index,data] of badJwks.entries()) test(`reject invalid full JWKS ${index}`,async()=>{await denied(await fixture(()=>Response.json(data)).request(await token()));});
for(const status of [301,302,307,308,401,403,404,429,500]) test(`reject JWKS HTTP ${status}`,async()=>{ const f=fixture(()=>new Response('PRIVATE_SENTINEL',{status,headers:{Location:'https://evil.example.test'}})); await denied(await f.request(await token())); assert.equal(f.calls.length,1); });
test('JWKS network, invalid JSON, oversized response and timeout fail closed',async()=>{
 for(const fetcher of [()=>{throw Error('PRIVATE_SENTINEL');},()=>new Response('{bad'),()=>new Response('x'.repeat(65537)),()=>new Promise(()=>{})]) await denied(await fixture(fetcher).request(await token()));
});

test('verified owner root queries redirect to a fixed clean path with all security headers',async()=>{
 const f=fixture(), jwt=await token();
 const clean=await f.request(jwt);
 const queries=['?return=synthetic','?redirect_url=https://evil.example.test/&x=%22%3E%3Cscript%3Ealert(1)%3C/script%3E','?redirect_url=//evil.example.test/','?redirect_url=%2Fadmin%2F'];
 for(const query of queries) for(const method of ['GET','HEAD']) {
  const response=await f.request(jwt,'/'+query,{method});
  assert.equal(response.status,302);
  assert.equal(response.headers.get('Location'),'/');
  assert.equal(new URL(response.headers.get('Location'),env.APP_ORIGIN).href,env.APP_ORIGIN+'/');
  assert.equal(await response.text(),'');
  assert.deepEqual([...response.headers].filter(([name])=>name!=='location'),[...clean.headers]);
  const next=await f.request(jwt,response.headers.get('Location'),{method});
  assert.equal(next.status,200);
  assert.equal(next.headers.get('Location'),null);
  if(method==='HEAD') assert.equal(await next.text(),'');
 }
});
test('root queries require full owner JWT verification and preserve origin and method checks',async()=>{
 const path='/?redirect_url=https://evil.example.test/&x=%3Cscript%3Ealert(1)%3C/script%3E';
 const forged=await token({}, {}, second);
 for(const jwt of [undefined,'garbage',await token({email:'editor@example.test'}),await token({exp:seconds}),forged]) {
  for(const method of ['GET','HEAD']) {
   const response=await fixture().request(jwt,path,{method});
   if(method==='HEAD') assert.equal(await response.clone().text(),'');
   await denied(response);
  }
 }
 const jwt=await token();
 for(const method of ['POST','PUT','DELETE','OPTIONS','PATCH']) {
  await denied(await fixture().request(undefined,path,{method}));
  const response=await fixture().request(jwt,path,{method});
  await denied(response,405); assert.equal(response.headers.get('Allow'),'GET, HEAD');
 }
 await denied(await fixture().request(jwt,path,{headers:{Origin:'https://evil.example.test'}}),403);
 await denied(await fixture().request(jwt,'https://evil.example.test'+path),403);
});
test('every asset/path requires auth; authenticated unknown paths are 404; no reflections',async()=>{
 const jwt=await token();
 for(const path of ['/favicon.ico','/robots.txt','/style.css','/app.js','/admin/','/public/index.html','/cdn-cgi/access/certs','//evil.example.test/','/%3Cscript%3Ealert(1)%3C/script%3E','/unknown?redirect_url=https://evil.example.test&x=%22%3E%3Cscript%3E']) {
  const expected = new URL(path,env.APP_ORIGIN).origin === env.APP_ORIGIN ? 401 : 403;
  await denied(await fixture().request(undefined,path),expected);
  await denied(await fixture().request(jwt,path),expected===403?403:404);
 }
 const head=await fixture().request(jwt,'/unknown?redirect_url=https://evil.example.test',{method:'HEAD'});
 await denied(head.clone(),404); assert.equal(await head.text(),'');
});
test('wrong request origin and Origin header fail before key fetch',async()=>{
 for(const [path,headers] of [['https://evil.example.test/',{}],['http://launchpad.example.test/',{}],['/',{Origin:'null'}],['/',{Origin:'https://evil.example.test'}]]) {const f=fixture();await denied(await f.request(await token(),path,{headers}),403);assert.equal(f.calls.length,0);}
 assert.equal((await fixture().request(await token(),'/',{headers:{Origin:env.APP_ORIGIN}})).status,200);
});
test('GET/HEAD only; unsupported methods cannot bypass auth; HEAD denials have no body',async()=>{
 for(const method of ['POST','PUT','DELETE','OPTIONS','PATCH']) {await denied(await fixture().request(undefined,'/',{method}));const r=await fixture().request(await token(),'/',{method});await denied(r,405);assert.equal(r.headers.get('Allow'),'GET, HEAD');}
 const head=await fixture().request(undefined,'/',{method:'HEAD'});assert.equal(head.status,401);assert.equal(await head.text(),'');
});
test('missing and unsafe config fails closed, including destinations that could inject HTML',async()=>{
 for(const field of Object.keys(env)) {const f=fixture(undefined,{...env,[field]:''});await denied(await f.request(await token()));assert.equal(f.calls.length,0);}
 for(const change of [{ACCESS_ISSUER:'https://evil.example.test'},{ACCESS_ISSUER:env.ACCESS_ISSUER+'/'},{APP_ORIGIN:'http://launchpad.example.test'},{MAIL_DESK_URL:'javascript:alert(1)'},{MAIL_DESK_URL:'https://user:password@mail.example.test/'},{MAIL_DESK_URL:'https://mail.example.test/?next=https://evil.example.test'},{MAIL_DESK_URL:'https://mail.example.test/" onmouseover="alert(1)'},{MAIL_DESK_URL:'https://mail.example.test/#x'}]) await denied(await fixture(undefined,{...env,...change}).request(await token()));
});

 test('CSP authorizes exactly the bundled CSS by SHA-256',async()=>{
 const response=await fixture().request(await token()); const html=await response.text();
 const style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 const hash=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(style)))));
 assert.ok(response.headers.get('Content-Security-Policy').includes(`style-src 'sha256-${hash}'`));
 });
 test('failed rotation is negatively cached; existing keys are not used after refresh failure',async()=>{
 let fail=false;const f=fixture(()=>{if(fail)throw Error('PRIVATE_SENTINEL');return Response.json({keys:[first.jwk]});});
 const jwt=await token();assert.equal((await f.request(jwt)).status,200);fail=true;
 await denied(await f.request(await token({}, {kid:'new'})));
 for(let i=0;i<3;i++)await denied(await f.request(jwt));assert.equal(f.calls.length,2);
 fail=false;f.advance(30001);assert.equal((await f.request(jwt)).status,200);
 });
 test('JWKS body reading also has a deadline',async()=>{
 await denied(await fixture(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}))).request(await token()));
 });
