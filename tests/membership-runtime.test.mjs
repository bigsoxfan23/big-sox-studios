import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';

const origin='https://bigsoxstudios.com';
const valid={name:'Synthetic Visitor',email:'runtime@example.test',reason:'Synthetic runtime check',acknowledgement:true,token:'synthetic-token'};
// Explicit source modules and synthetic bindings only: no Wrangler config, credentials,
// persistent storage, real subrequests, or production resources are loaded.
async function runtime(workerSource=readFileSync(new URL('../membership/worker.mjs',import.meta.url),'utf8'),reply=()=>Response.json({success:false,'error-codes':['invalid-input-response']})) {
 const calls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({
  log:new NoOpLog(),name:'membership-test',compatibilityDate:'2026-09-29',
  modules:[
   {type:'ESModule',path:'entry.mjs',contents:`
    import {createWorker} from './membership/worker.mjs';
    const failures=[];
    const worker=createWorker({logFailure:step=>failures.push(step)});
    const env={
     MEMBERSHIP_DB:{prepare(){throw Error('unexpected synthetic database write');}},
     EMAIL_HMAC_KEY:'e'.repeat(32),RATE_HMAC_KEY:'r'.repeat(32),TURNSTILE_SECRET_KEY:'s'.repeat(32),
     REQUEST_LIMITER:{async limit(){return {success:true};}}
    };
    export default {fetch(request){
     if(new URL(request.url).pathname==='/runtime-failures') return Response.json(failures);
     return worker.fetch(request,env);
    }};
   `},
   {type:'ESModule',path:'membership/worker.mjs',contents:workerSource},
   {type:'ESModule',path:'membership/common.mjs',contents:readFileSync(new URL('../membership/common.mjs',import.meta.url),'utf8')}
  ],
  outboundService:async request=>{
   const body=new URLSearchParams(await request.text());
   calls.push({url:request.url,method:request.method,contentType:request.headers.get('Content-Type'),fields:[...body.keys()],secret:body.get('secret'),token:body.get('response')});
   return reply();
  }
 }));
 return {mf,calls,failures:async()=> (await mf.dispatchFetch(`${origin}/runtime-failures`)).json(),request:body=>mf.dispatchFetch(`${origin}/api/membership/requests`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify(body)})};
}

test('workerd sends Siteverify form with timeout and reads invalid-token JSON as HTTP 400',async()=>{
 const f=await runtime();
 try {
  assert.equal((await f.request({})).status,400);
  assert.equal(f.calls.length,0);
  assert.equal((await f.request(valid)).status,400);
  assert.deepEqual(f.calls,[{url:'https://challenges.cloudflare.com/turnstile/v0/siteverify',method:'POST',contentType:'application/x-www-form-urlencoded;charset=UTF-8',fields:['secret','response'],secret:'s'.repeat(32),token:valid.token}]);
 } finally {await f.mf.dispose();}
});

test('workerd rejects the original error redirect mode before any Siteverify request',async()=>{
 const source=readFileSync(new URL('../membership/worker.mjs',import.meta.url),'utf8');
 assert.ok(source.includes("redirect:'manual'"));
 const f=await runtime(source.replace("redirect:'manual'","redirect:'error'"));
 try {
  assert.equal((await f.request(valid)).status,503);
  assert.equal(f.calls.length,0);
  assert.deepEqual(await f.failures(),['siteverify_fetch']);
 } finally {await f.mf.dispose();}
});

for (const status of [301,302,303,307,308,500]) test(`workerd rejects Siteverify HTTP ${status} without a follow-up subrequest`,async()=>{
 const f=await runtime(undefined,()=>new Response(null,{status,headers:{Location:'https://redirect.example.test/should-not-receive-token'}}));
 try {
  assert.equal((await f.request(valid)).status,503);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.deepEqual(await f.failures(),['siteverify_status']);
 } finally {await f.mf.dispose();}
});

test('workerd timeout aborts a stalled Siteverify fetch and records only the fetch stage',async()=>{
 const source=readFileSync(new URL('../membership/worker.mjs',import.meta.url),'utf8');
 assert.ok(source.includes('AbortSignal.timeout(5000)'));
 // Shorten only the timeout for this test; keep the real workerd fetch/signal path.
 const f=await runtime(source.replace('AbortSignal.timeout(5000)','AbortSignal.timeout(20)'),async()=>{
  await new Promise(resolve=>setTimeout(resolve,100));
  return Response.json({success:false});
 });
 try {
  assert.equal((await f.request(valid)).status,503);
  assert.deepEqual(await f.failures(),['siteverify_fetch']);
 } finally {await f.mf.dispose();}
});
