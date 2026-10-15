import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.mjs';
import { syntheticIntake } from '../src/intake.synthetic.mjs';
import { recoverUncertain, now } from '../src/store.mjs';
import { runMockSync, mapNotion, DATA_SOURCE, ACTIVITY_SOURCE, NOTION_VERSION } from '../src/notion.mjs';
import { resendFuture } from '../src/resend.future.mjs';

test('duplicate and concurrent inbound creates exactly one opaque case and message',async t=>{
 const f=await fixture(t);const ids=await Promise.all(Array.from({length:10},()=>syntheticIntake(f.DB,input())));
 assert.equal(new Set(ids).size,1);assert.match(ids[0],/^[a-f0-9-]{36}$/);
 for (const table of ['cases','messages','inbound_dedupe']) assert.equal(f.DB.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
 assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM sync_jobs').get().n,1);assert.equal(f.calls(),0);
});
test('synthetic intake rejects non-synthetic and real recipients',async t=>{const f=await fixture(t);await assert.rejects(syntheticIntake(f.DB,input({synthetic:false})));await assert.rejects(syntheticIntake(f.DB,input({requester_email:'person@real.invalid'})));});
test('loading, composing and reviewing never calls provider; send without approval denied',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();await f.request('/');await f.request('/api/cases');await f.request(`/api/cases/${id}`);
 const r=await f.review(id);assert.equal(f.calls(),0);assert.equal((await f.send(id,{id:r.id,approval:'forged'})).status,403);assert.equal(f.calls(),0);
 const intent=f.DB.sqlite.prepare('SELECT * FROM outbound_intents').get();assert.equal(intent.status,'reserved');assert.equal(intent.sender,'members@bigsoxstudios.com');assert.equal(intent.recipient,'person@example.test');
});
test('duplicate and concurrent Send invokes provider once and persists all sent effects',async t=>{
 let unblock;const gate=new Promise(resolve=>{unblock=resolve;});const f=await fixture(t,{provider:async i=>{await gate;return {status:'sent',id:`mock-${i.id}`};}});
 await f.session();const id=await f.seed();const r=await f.review(id);
 const requests=Array.from({length:12},()=>f.send(id,r));
 // Release after one dispatch entered the provider; keep concurrent claims overlapping.
 while(f.calls()===0) await new Promise(resolve=>setTimeout(resolve,1));
 assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'dispatching');unblock();
 const responses=await Promise.all(requests);assert.ok(responses.every(x=>x.status===200));assert.equal(f.calls(),1);
 assert.equal((await (await f.send(id,r)).json()).status,'sent');assert.equal(f.calls(),1);
 assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM messages WHERE direction=\'outbound\'').get().n,1);
 assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM sync_jobs').get().n,2);
 assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE event='delivery_sent'").get().n,1);
});
test('stale review cannot send edited revision; new review binds latest text',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();const old=await f.review(id,'first');const fresh=await f.review(id,'changed');
 assert.equal((await f.send(id,old)).status,409);assert.equal(f.calls(),0);assert.equal((await (await f.send(id,fresh)).json()).status,'sent');assert.equal(f.calls(),1);
 assert.equal(f.DB.sqlite.prepare("SELECT body FROM messages WHERE direction='outbound'").get().body,'changed');
});
test('approval binds case and session; expired approval cannot send',async t=>{
 const f=await fixture(t);await f.session();const a=await f.seed();const b=await f.seed({key:'other'});const r=await f.review(a);
 assert.equal((await f.send(b,r)).status,403);
 const {token}=await import('./helpers.mjs');assert.equal((await f.send(a,r,{headers:{'Cf-Access-Jwt-Assertion':await token({sub:'different'})}})).status,403);
 f.DB.sqlite.prepare('UPDATE outbound_intents SET approval_expires=?').run(now()-1);
 assert.equal((await f.send(a,r)).status,403);assert.equal(f.calls(),0);
});
test('recipient, sender and body changes invalidate signed approval',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.review(id);f.DB.sqlite.prepare("UPDATE outbound_intents SET recipient='evil@example.test'").run();
 assert.equal((await f.send(id,r)).status,403);assert.equal(f.calls(),0);
});
for(const [label,provider] of [['timeout',async()=>{throw new DOMException('Synthetic timeout','TimeoutError');}],['ambiguous response',async()=>({})],['explicit uncertainty',async()=>({status:'UNKNOWN'})]]) {
 test(`${label} persists UNKNOWN and never retries, including new drafts`,async t=>{
  const f=await fixture(t,{provider});await f.session();const id=await f.seed();const r=await f.review(id);
  assert.equal((await (await f.send(id,r)).json()).status,'UNKNOWN');await f.send(id,r);assert.equal(f.calls(),1);
  assert.equal((await f.request(`/api/cases/${id}/draft`,{revision:r.revision,body:'try again'})).status,409);
  assert.equal((await f.request(`/api/cases/${id}/review`,{revision:r.revision})).status,409);await recoverUncertain(f.DB,now()+1);assert.equal(f.calls(),1);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM sync_jobs').get().n,1);
 });
}
test('failed intent is terminal for that revision and is not retried',async t=>{const f=await fixture(t,{provider:async()=>({status:'failed'})});await f.session();const id=await f.seed();const r=await f.review(id);assert.equal((await (await f.send(id,r)).json()).status,'failed');await f.send(id,r);assert.equal(f.calls(),1);});
test('crash after dispatch claim never reclaims; offline recovery marks UNKNOWN',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.review(id);
 f.DB.sqlite.prepare("UPDATE outbound_intents SET status='dispatching',updated_at=?").run(now()-1000);
 await f.send(id,r);assert.equal(f.calls(),0);await recoverUncertain(f.DB);assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'UNKNOWN');await f.send(id,r);assert.equal(f.calls(),0);
});
test('sent persistence failure rolls back message/sync and leaves dispatching, never resends',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.review(id);
 f.DB.sqlite.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON sync_jobs BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
 assert.equal((await f.send(id,r)).status,503);assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'dispatching');
 assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM messages WHERE direction='outbound'").get().n,0);
 await f.send(id,r);assert.equal(f.calls(),1);await recoverUncertain(f.DB,now()+1);assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'UNKNOWN');
});
test('sent plus Notion failure persists sent and retries only bounded sync jobs',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.review(id);await f.send(id,r);
 f.DB.sqlite.prepare("UPDATE sync_jobs SET status='done' WHERE kind='case_created'").run();
 let attempts=0;const fail=async()=>{attempts++;throw new Error('synthetic Notion failure');};
 assert.equal((await runMockSync(f.DB,f.env,fail)).processed,0);assert.equal(attempts,0);
 const env={...f.env,NOTION_SYNC_MODE:'mock'};
 await runMockSync(f.DB,env,fail);let job=f.DB.sqlite.prepare('SELECT * FROM sync_jobs WHERE kind=\'delivery_sent\'').get();assert.equal(job.status,'pending');assert.equal(job.attempts,1);assert.ok(job.next_attempt>=now()+29);
 await runMockSync(f.DB,env,fail);assert.equal(attempts,1);
 for(let n=0;n<4;n++){f.DB.sqlite.prepare('UPDATE sync_jobs SET next_attempt=0 WHERE kind=\'delivery_sent\'').run();await runMockSync(f.DB,env,fail);}
 job=f.DB.sqlite.prepare('SELECT * FROM sync_jobs WHERE kind=\'delivery_sent\'').get();assert.equal(job.status,'dead');assert.equal(attempts,5);
 await f.send(id,r);assert.equal(f.calls(),1);assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'sent');
});
test('mock sync success completes job independently',async t=>{const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.review(id);await f.send(id,r);const payloads=[];await runMockSync(f.DB,{NOTION_SYNC_MODE:'mock'},async p=>{payloads.push(p);});assert.equal(payloads[0].parent.data_source_id,DATA_SOURCE);assert.deepEqual(Object.keys(payloads[1].properties),['Reply State']);assert.equal(f.DB.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'done');assert.equal(f.calls(),1);});
for(const channel of ['members','support','hello']) test(`Notion dry-run mapping ${channel} uses sole existing source, no sequence writes`,()=>{
 const c={...input({channel}),id:crypto.randomUUID()};const mapped=mapNotion(c),p=mapped.properties;
 assert.deepEqual(mapped.parent,{type:'data_source_id',data_source_id:'103d8328-de8b-4b7f-8986-000ce40450b5'});assert.equal(ACTIVITY_SOURCE,'17401fd3-c5f4-46bb-b516-c420b6e3ce24');assert.equal(NOTION_VERSION,'2025-09-03');
 assert.equal(p.Title.title[0].text.content,c.subject);assert.equal(p['Ticket Family'].select.name,'Service Management');assert.equal(p['Ticket Kind'].select.name,{members:'Membership',support:'Incident / Support',hello:'General inquiry'}[channel]);assert.equal(p.Status.select.name,'Inbox');assert.equal(p['Request Channel'].select.name,`${channel}@`);
 assert.equal(p['Requester Name'].rich_text[0].text.content,c.requester_name);assert.equal(p['Requester Email'].email,c.requester_email);assert.equal(p['External Case ID'].rich_text[0].text.content,c.id);
 assert.equal(p['Membership Decision'].select.name,channel==='members'?'Pending':'Not applicable');assert.equal(p['Reply State'].select.name,'Needs approval');assert.equal(p['Assigned To'].select.name,'Greg');assert.equal(p.Priority.select.name,'Normal');assert.equal(p['Project / System'].select.name,channel==='members'?'Members Portal':'Other');
 assert.ok(!('Reference' in p));assert.ok(!('Notion Sequence' in p));assert.equal(Object.keys(p).length,13);
});
for (const mode of ['live','disabled','',undefined]) test(`staging cannot reach provider in mode ${mode}`,async t=>{
 const f=await fixture(t,{env:{SEND_MODE:mode,ALLOW_REAL_SEND:'true',DEPLOYMENT_STAGE:'production',RESEND_API_KEY:'synthetic-placeholder'}});await f.session();const id=await f.seed();const r=await f.review(id);assert.equal((await f.send(id,r)).status,503);assert.equal(f.calls(),0);
});
test('future Resend adapter requires independent flags and never fetches in staging',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error('no network allowed');};const i={id:crypto.randomUUID(),sender:'members@bigsoxstudios.com',recipient:'person@example.test',subject:'test',body:'test'};
 for(const env of [{},{DEPLOYMENT_STAGE:'staging',SEND_MODE:'live',ALLOW_REAL_SEND:'true',RESEND_API_KEY:'synthetic-placeholder'},{DEPLOYMENT_STAGE:'production',SEND_MODE:'live',ALLOW_REAL_SEND:'false',RESEND_API_KEY:'synthetic-placeholder'}]) await assert.rejects(resendFuture(i,env,fetcher),/live_send_forbidden/);
 assert.equal(calls,0);
});
test('future adapter uses official stable idempotency key; ambiguous errors UNKNOWN',async()=>{
 const i={id:crypto.randomUUID(),sender:'hello@bigsoxstudios.com',recipient:'person@example.test',subject:'test',body:'<untrusted>'};const env={DEPLOYMENT_STAGE:'production',SEND_MODE:'live',ALLOW_REAL_SEND:'true',RESEND_API_KEY:'synthetic-placeholder'};
 const result=await resendFuture(i,env,async(url,init)=>{assert.equal(url,'https://api.resend.com/emails');assert.equal(init.headers['Idempotency-Key'],i.id);assert.equal(init.headers['Resend-Idempotency-Key'],i.id);assert.equal(JSON.parse(init.body).text,'<untrusted>');assert.ok(!('html' in JSON.parse(init.body)));return Response.json({id:'synthetic-provider-id'});}, {...i,humanApproved:true,status:'dispatching',expires:Date.now()/1000+60});assert.equal(result.status,'sent');
 for(const response of [new Response('',{status:500}),new Response('',{status:429}),Response.json({}),new Response('invalid json')]) assert.equal((await resendFuture(i,env,async()=>response,{...i,humanApproved:true,status:'dispatching',expires:Date.now()/1000+60})).status,'UNKNOWN');
 assert.equal((await resendFuture(i,env,async()=>{throw Error('timeout');},{...i,humanApproved:true,status:'dispatching',expires:Date.now()/1000+60})).status,'UNKNOWN');
});
test('actual unresolved dispatch hits watchdog, becomes UNKNOWN, and is never retried',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=await fixture(t,{provider:()=>new Promise(()=>{})});await f.session();const id=await f.seed();const r=await f.review(id);
 const pending=f.send(id,r);while(f.calls()===0) await new Promise(resolve=>setImmediate(resolve));
 // Let the Promise.race timeout register after the provider callback.
 await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(10000);
 assert.equal((await (await pending).json()).status,'UNKNOWN');await f.send(id,r);assert.equal(f.calls(),1);
});
test('otherwise valid signed approval expires after ten minutes',async t=>{
 const f=await fixture(t);await f.session();const id=await f.seed();const r=await f.review(id);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+601000});
 const response=await f.send(id,r);assert.equal(response.status,409);assert.equal((await response.json()).error,'approval_expired');assert.equal(f.calls(),0);
});
test('sync can complete initial case before any send and recovers only its own stale leases',async t=>{
 const f=await fixture(t);await f.seed();
 f.DB.sqlite.prepare("UPDATE sync_jobs SET status='running',next_attempt=0,attempts=1").run();
 let calls=0;await runMockSync(f.DB,{NOTION_SYNC_MODE:'mock'},async()=>{calls++;});
 assert.equal(calls,1);assert.equal(f.calls(),0);assert.equal(f.DB.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'done');
});
test('late synthetic lease completion cannot overwrite a newer completed attempt',async t=>{
 const f=await fixture(t);await f.seed();let release,entered=false;
 const gate=new Promise((_,reject)=>{release=()=>reject(new Error('old synthetic callback'));});
 const old=runMockSync(f.DB,{NOTION_SYNC_MODE:'mock'},async()=>{entered=true;await gate;});
 while(!entered) await new Promise(resolve=>setImmediate(resolve));
 t.mock.timers.enable({apis:['Date'],now:Date.now()+301000});
 await runMockSync(f.DB,{NOTION_SYNC_MODE:'mock'});release();await old;
 const job=f.DB.sqlite.prepare('SELECT status,attempts FROM sync_jobs').get();assert.equal(job.status,'done');assert.equal(job.attempts,2);assert.equal(f.calls(),0);
});
