import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, jwk } from './helpers.mjs';
import { createWorker } from '../src/worker.mjs';
import { claimSend } from '../src/store.mjs';
import { rehearseResend, resendFuture } from '../src/resend.future.mjs';
const environment = () => ({ DEPLOYMENT_STAGE:'production', SEND_MODE:'live', ALLOW_REAL_SEND:'true', RESEND_API_KEY:'offline-placeholder',
 OUTBOUND_SENDER_ALLOWLIST:JSON.stringify(['support@bigsoxstudios.com']), OUTBOUND_RECIPIENT_ALLOWLIST:JSON.stringify(['person@example.test']) });
const intent = () => ({ id:crypto.randomUUID(), sender:'support@bigsoxstudios.com', recipient:'person@example.test', subject:'Re: offline canary', body:'PRIVATE_BODY_SENTINEL', inReplyTo:'<parent@example.test>', references:['<root@example.test>'] });
const noFetch = () => assert.fail('unexpected provider invocation');

for (const mode of ['mock','live']) test(`staging rejects injected transport with production flags in ${mode} mode`, async t => {
 const f = await fixture(t, { env:{ SEND_MODE:mode, DEPLOYMENT_STAGE:'production', ALLOW_REAL_SEND:'true', RESEND_API_KEY:'fake-live-key' } });
 const session = await f.session(), id = await f.seed(), review = await f.review(id);
 let calls = 0;
 const worker = createWorker({ provider:() => { calls++; assert.fail('injected provider called'); }, fetcher:async () => Response.json({keys:[jwk]}) });
 const result = await worker.fetch(new Request(`${f.env.APP_ORIGIN}/api/cases/${id}/send`, {
  method:'POST', headers:{ 'Cf-Access-Jwt-Assertion':f.jwt, Cookie:session.cookie, Origin:f.env.APP_ORIGIN, 'X-CSRF-Token':session.csrf, 'Content-Type':'application/json' },
  body:JSON.stringify({intentId:review.id,approval:review.approval})
 }), f.env);
 assert.equal(result.status,503); assert.equal(calls,0);
 assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'reserved');
});
test('mock mode ignores env-injected providers and real key; only simulator runs', async t => {
 const f = await fixture(t,{env:{SEND_MODE:'mock',DEPLOYMENT_STAGE:'production',ALLOW_REAL_SEND:'true',RESEND_API_KEY:'fake-live-key',provider:noFetch,PROVIDER:noFetch}});
 await f.session(); const id=await f.seed(); const review=await f.review(id);
 assert.equal((await (await f.send(id,review)).json()).status,'sent');
 assert.match(f.DB.sqlite.prepare('SELECT provider_id FROM outbound_intents').get().provider_id,/^mock-/);
});
test('unbranded simulation cannot inject a provider', async t => {
 const f=await fixture(t); const session=await f.session(),id=await f.seed(),r=await f.review(id);
 const worker=createWorker({simulation:{send:noFetch},fetcher:async()=>Response.json({keys:[jwk]})});
 const response=await worker.fetch(new Request(`${f.env.APP_ORIGIN}/api/cases/${id}/send`, {method:'POST',headers:{'Cf-Access-Jwt-Assertion':f.jwt,Cookie:session.cookie,Origin:f.env.APP_ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:JSON.stringify({intentId:r.id,approval:r.approval})}),f.env);
 assert.equal(response.status,503);assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'reserved');
});
test('live bridge refuses even a matching humanApproved dispatch snapshot and all gates', async () => {
 const i=intent();
 for(const a of [undefined,{...i,humanApproved:true,status:'dispatching',expires:Date.now()/1000+600}])
  await assert.rejects(resendFuture(i,environment(),noFetch,a),/integration_blocked/);
});
test('all three live gates and key are separately mandatory', async () => {
 for(const change of [{DEPLOYMENT_STAGE:'staging'},{SEND_MODE:'mock'},{ALLOW_REAL_SEND:'false'},{ALLOW_REAL_SEND:true},{RESEND_API_KEY:''},{RESEND_API_KEY:'bad\r\nkey'}])
  await assert.rejects(rehearseResend(intent(),{...environment(),...change},noFetch),/live_send_forbidden/);
});
test('rehearsal refuses actual keys and non-test customers even when explicitly allowlisted', async () => {
 await assert.rejects(rehearseResend(intent(),{...environment(),RESEND_API_KEY:'real-looking-key'},noFetch),/offline_only/);
 const i={...intent(),recipient:'person@example.com'};
 await assert.rejects(rehearseResend(i,{...environment(),OUTBOUND_RECIPIENT_ALLOWLIST:JSON.stringify([i.recipient])},noFetch),/offline_only/);
});
test('exact sender and recipient allowlists reject missing, malformed, wildcard and case mismatch', async () => {
 for(const key of ['OUTBOUND_SENDER_ALLOWLIST','OUTBOUND_RECIPIENT_ALLOWLIST']) {
  for(const value of [undefined,'*','[]','{}','["*"]','["person@example.test", "person@example.test"]','["PERSON@example.test"]','["SUPPORT@bigsoxstudios.com"]'])
   await assert.rejects(rehearseResend(intent(),{...environment(),[key]:value},noFetch),/invalid_allowlist/);
 }
});
test('wire rehearsal rejects unsafe MIME envelope/header values and oversized thread chains', async () => {
 for(const change of [
  {sender:'SUPPORT@bigsoxstudios.com'},{sender:'support@evil.test'},{recipient:'person@example.test,other@example.test'},
  {recipient:'person@example.test\r\nBcc: x@example.test'},{subject:'subject\0bad'},{subject:'subject\nBcc: bad'}, {subject:'bad\u2028header'},
  {inReplyTo:'<a@example.test>\r\nBcc: bad'},{references:'<a@example.test>'},{references:[null]},{references:Array(21).fill('<a@example.test>')},
  {inReplyTo:null,references:['<orphan@example.test>']},
  {references:Array.from({length:20},(_,n)=>`<${n}${'x'.repeat(190)}@example.test>`)},
  {id:'------------------------------------'},{body:'x'.repeat(10001)}
 ]) await assert.rejects(rehearseResend({...intent(),...change},environment(),noFetch),/invalid_/);
});
for(const field of ['sender','body','subject','case_id','session_hash','revision']) test(`review HMAC rejects changed ${field}`,async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed(),r=await f.review(id);
 const values={sender:'hello@bigsoxstudios.com',body:'changed',subject:'changed',case_id:await f.seed({key:'second'}),session_hash:'different',revision:99};
 f.DB.sqlite.prepare(`UPDATE outbound_intents SET ${field}=?`).run(values[field]);
 assert.equal((await f.send(id,r)).status,403);assert.equal(f.calls(),0);
});
test('D1 claim compares the complete verified snapshot and current case envelope atomically',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();await f.review(id);
 const i=f.DB.sqlite.prepare('SELECT * FROM outbound_intents').get();
 for(const field of ['case_id','recipient','sender','subject','body','session_hash','approval_expires','revision'])
  assert.equal(await claimSend(f.DB,{...i,[field]:field==='revision'||field==='approval_expires'?i[field]+1:'changed'}),null);
 f.DB.sqlite.prepare("UPDATE cases SET requester_email='changed@example.test' WHERE id=?").run(id);
 assert.equal(await claimSend(f.DB,i),null);assert.equal(f.calls(),0);
});
test('D1 compare-and-set has one winner across independently loaded approvals',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();await f.review(id);
 const rows=Array.from({length:20},()=>f.DB.sqlite.prepare('SELECT * FROM outbound_intents').get());
 assert.equal((await Promise.all(rows.map(i=>claimSend(f.DB,i)))).filter(Boolean).length,1);
});
test('cross-case intent remains denied with the correct token and same owner session',async t=>{
 const f=await fixture(t);await f.session();const a=await f.seed(),b=await f.seed({key:'other'}),r=await f.review(a);
 assert.equal((await f.send(b,r)).status,403);assert.equal(f.calls(),0);
});
test('provider response byte limits, declared length and JSON schema fail UNKNOWN with cancellation',async()=>{
 for(const response of [
  new Response('x'.repeat(16385)),new Response('{}',{headers:{'Content-Length':'16385'}}),
  new Response('{}',{headers:{'Content-Length':'bad'}}),new Response('{}',{headers:{'Content-Length':'1'}}),
  new Response('invalid json'),Response.json({id:'x'.repeat(129)}),Response.json({id:'private\r\nvalue'}),Response.json({id:42}),Response.json(null),
  new Response(new Uint8Array([255,254]))
 ]) {
  let calls=0;assert.deepEqual(await rehearseResend(intent(),environment(),async()=>{calls++;return response;}),{status:'UNKNOWN'});assert.equal(calls,1);
 }
 let canceled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(16385));},cancel(){canceled=true;}});
 assert.equal((await rehearseResend(intent(),environment(),async()=>new Response(stream))).status,'UNKNOWN');assert.equal(canceled,true);
});
test('exact response byte boundary is accepted; redirects already followed are UNKNOWN',async()=>{
 const text=JSON.stringify({id:'stub',padding:'x'.repeat(16358)});assert.equal(new TextEncoder().encode(text).length,16384);
 assert.equal((await rehearseResend(intent(),environment(),async()=>new Response(text))).status,'sent');
 const response=Response.json({id:'stub'});Object.defineProperty(response,'redirected',{value:true});
 assert.equal((await rehearseResend(intent(),environment(),async()=>response)).status,'UNKNOWN');
});
for(const phase of ['fetch','body']) test(`10-second deadline bounds stalled ${phase}, cancels and never retries`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,signal,canceled=false;
 const pending=rehearseResend(intent(),environment(),async(_,init)=>{
  calls++;signal=init.signal;
  return phase==='fetch'?new Promise(()=>{}):new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){canceled=true;}}));
 });
 await new Promise(resolve=>setImmediate(resolve)); t.mock.timers.tick(9999);assert.equal(signal.aborted,false);
 t.mock.timers.tick(1);assert.deepEqual(await pending,{status:'UNKNOWN'});assert.equal(signal.aborted,true);assert.equal(calls,1);
 if(phase==='body') assert.equal(canceled,true);
});
test('transport is called without receiver; errors and provider bodies never leak to logs/results',async t=>{
 const logs=[];for(const key of ['log','warn','info','error','debug'])t.mock.method(console,key,(...args)=>logs.push(args));
 let calls=0;
 const result=await rehearseResend(intent(),environment(),function(url,init){
  assert.equal(this,undefined);calls++;assert.equal(url,'https://api.resend.com/emails');assert.equal(init.redirect,'manual');
  throw Error('fake-private-key person@example.test PRIVATE_BODY_SENTINEL');
 });
 assert.deepEqual(result,{status:'UNKNOWN'});assert.equal(calls,1);assert.deepEqual(logs,[]);
});
test('staging graph and migrations remain isolated from outbound rehearsal',async()=>{
 const visited=new Set();async function walk(file){if(visited.has(file))return;visited.add(file);const source=await readFile(new URL(`../src/${file}`,import.meta.url),'utf8');assert.doesNotMatch(source,/resend\.future|rehearseResend|api\.resend\.com/);for(const m of source.matchAll(/from ['"]\.\/(.*?)['"]/g))await walk(m[1]);}
 await walk('worker.mjs');
});
