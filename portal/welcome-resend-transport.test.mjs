import test from 'node:test';
import assert from 'node:assert/strict';
import {createResendWelcomeTransport,welcomeReconciliationStatus} from './welcome-resend-transport.mjs';
const id='550e8400-e29b-41d4-a716-446655440000', providerId='550e8400-e29b-41d4-a716-446655440011';
const msg=Object.freeze({intentId:id,recipient:'friend@example.test',subject:'Welcome to Big Sox Studios',text:'Synthetic Jellyfin temporary password: FAKE-ONLY'});
const key='re_abcdefgh12345678',sender='welcome@example.test';
function adapter(fetcher,config={}){return createResendWelcomeTransport({enabled:true,apiKey:key,sender,fetcher,...config});}
test('transport is disabled without explicit opt-in and cannot network',async()=>{
 let calls=0;const a=createResendWelcomeTransport({fetcher:async()=>{calls++;}});
 await assert.rejects(a.send(msg));await assert.rejects(a.inspect({providerId,recipient:msg.recipient}));
 assert.equal(calls,0);
});
test('live send requires server-only config and exact bound metadata',async()=>{
 for(const config of [{apiKey:'bad'},{sender:'evil\nBcc: other@example.test'},{sender:'Attacker <evil@example.test>'},{timeoutMs:9000}])
  assert.throws(()=>createResendWelcomeTransport({enabled:true,apiKey:key,sender,fetcher:async()=>new Response(),...config}));
 let calls=0;const a=adapter(async()=>{calls++;return Response.json({id:providerId})});
 for(const change of [{recipient:'Friend@example.test'},{subject:'Different subject'},{intentId:'bad'},{text:''}])
  await assert.rejects(a.send({...msg,...change}));
 assert.equal(calls,0);
});
test('accepted response preserves one intent ID; never claims delivery or activation',async()=>{
 const seen=[],a=adapter(async(url,opt)=>{seen.push({url,opt});return Response.json({id:providerId})});
 const out=await a.send(msg);assert.equal(out.state,'accepted');assert.equal(out.providerId,providerId);
 assert.equal(out.activationAuthorized,false);assert.equal(out.delivered,false);assert.equal(seen.length,1);
 assert.equal(seen[0].url,'https://api.resend.com/emails');assert.equal(seen[0].opt.method,'POST');
 assert.equal(seen[0].opt.redirect,'manual');assert.equal(seen[0].opt.cache,'no-store');
 assert.equal(seen[0].opt.headers['Idempotency-Key'],'bss-welcome/'+id);
 assert.deepEqual(JSON.parse(seen[0].opt.body),{from:sender,to:[msg.recipient],subject:msg.subject,text:msg.text});
});
test('uncertain, malformed, conflict, rate-limited or timed-out outcomes stay locked without retries',async()=>{
 for(const response of [new Response('',{status:302,headers:{Location:'https://redirect.example.invalid'}}),
  new Response('',{status:409}),new Response('',{status:429}),new Response('',{status:503}),
  Response.json({}),Response.json({id:'other'}),null]){
  let calls=0;const a=adapter(async()=>{calls++;if(response===null)throw Error('provider could have accepted');return response});
  const out=await a.send(msg);assert.equal(out.state,'UNKNOWN');assert.equal(out.mayRetry,false);assert.equal(out.activationAuthorized,false);assert.equal(calls,1);
 }
 const t=adapter(()=>new Promise(()=>{}),{timeoutMs:5}),out=await t.send(msg);
 assert.equal(out.state,'UNKNOWN');assert.equal(out.mayRetry,false);
});
test('definite provider refusal is not an accepted message',async()=>{
 for(const status of [400,401,403,422]){const out=await adapter(async()=>new Response('',{status})).send(msg);
  assert.equal(out.state,'failed');assert.equal(out.activationAuthorized,false);}
});
test('read-only lookup checks provider ID and exact recipient without exposing body',async()=>{
 let requests=0;
 const a=adapter(async(url,opt)=>{requests++;assert.equal(opt.method,'GET');assert.equal(url,'https://api.resend.com/emails/'+providerId);
  assert.equal(opt.redirect,'manual');
  return Response.json({id:providerId,to:[msg.recipient],last_event:'delivered',text:'SECRET-DO-NOT-RETURN'});});
 const result=await a.inspect({providerId,recipient:msg.recipient});
 assert.equal(result.state,'provider-observed');assert.equal(result.providerStatus,'delivered');
 assert.equal(result.activationAuthorized,false);assert.equal(JSON.stringify(result).includes('SECRET'),false);
 assert.equal((await a.inspect({providerId:'bad',recipient:msg.recipient})).state,'UNKNOWN');assert.equal(requests,1);
 const mismatch=await adapter(async()=>Response.json({id:providerId,to:['other@example.test'],last_event:'delivered'})).inspect({providerId,recipient:msg.recipient});
 assert.equal(mismatch.state,'UNKNOWN');
});
test('UNKNOWN and dispatching reconciliation remain locked and require manual Owner evidence',()=>{
 for(const state of ['UNKNOWN','dispatching']){const out=welcomeReconciliationStatus({state,mode:'live'});
  assert.equal(out.state,'locked');assert.equal(out.requiresOwnerReview,true);assert.equal(out.activationAuthorized,false);assert.equal(out.mayRetry,false);}
 assert.throws(()=>welcomeReconciliationStatus({state:'accepted',mode:'live'}));
});
