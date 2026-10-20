import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { OfflineNotion, offlineUpsert, DATA_SOURCE, ACTIVITY_SOURCE, runMockSync } from '../src/notion.mjs';
import { resendFuture, rehearseResend } from '../src/resend.future.mjs';
const mockEnv={NOTION_SYNC_MODE:'mock'};
async function setup(t) {
 const f=await fixture(t),id=await f.seed();const c=f.DB.sqlite.prepare('SELECT * FROM cases').get();const job={case_id:id,kind:'case_created'};
 return {f,c,job,m:new OfflineNotion()};
}
test('offline Notion remains off by default and never accepts a live transport',async t=>{
 const {f,c,job,m}=await setup(t);
 for(const env of [{},{NOTION_SYNC_MODE:'live'}]) assert.equal((await offlineUpsert(f.DB,env,c,job,m)).status,'off');
 assert.equal((await offlineUpsert(f.DB,mockEnv,c,job,{find(){throw Error('no');}})).status,'off');assert.equal(m.calls.length,0);
});
test('offline Notion concurrent/replayed External Case ID creates at most one page and durable link',async t=>{
 const {f,c,job,m}=await setup(t);await Promise.all(Array.from({length:10},()=>offlineUpsert(f.DB,mockEnv,c,job,m)));
 await offlineUpsert(f.DB,mockEnv,c,job,m);assert.equal(m.pages.size,1);assert.equal(m.calls.filter(c=>c==='create').length,1);
 const page=[...m.pages.values()][0];assert.equal(page.payload.parent.data_source_id,DATA_SOURCE);assert.equal(page.externalId,c.id);assert.equal(f.DB.sqlite.prepare('SELECT page_id FROM notion_links').get().page_id,page.id);
 assert.equal(ACTIVITY_SOURCE,'17401fd3-c5f4-46bb-b516-c420b6e3ce24');
});
test('existing closed record is linked without resetting workflow, Reference or Sequence; delivery patch only',async t=>{
 const {f,c,job,m}=await setup(t);await offlineUpsert(f.DB,mockEnv,c,job,m);const page=[...m.pages.values()][0];
 page.payload.properties.Status={select:{name:'Closed'}};page.payload.properties.Reference={rich_text:[{text:{content:'INC-42'}}]};page.payload.properties['Notion Sequence']={number:42};
 const before=structuredClone(page.payload.properties);await offlineUpsert(f.DB,mockEnv,c,job,m);assert.deepEqual(page.payload.properties,before);
 await f.session();const review=await f.review(c.id);await f.send(c.id,review);
 await offlineUpsert(f.DB,mockEnv,c,{case_id:c.id,kind:'delivery_sent',intent_id:review.id},m);
 assert.deepEqual(page.payload.properties,{...before,'Reply State':{select:{name:'Sent'}}});assert.equal(m.pages.size,1);assert.equal(f.calls(),1);
});
test('query failure retries safely; ambiguous create never recreates and later query reconciles',async t=>{
 const {f,c,job,m}=await setup(t);const find=m.find.bind(m);m.find=async()=>{throw Error('private query detail');};await assert.rejects(offlineUpsert(f.DB,mockEnv,c,job,m));assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM notion_links').get().n,0);
 m.find=find;const create=m.create.bind(m);m.create=async(...args)=>{await create(...args);throw Error('response lost');};
 assert.equal((await offlineUpsert(f.DB,mockEnv,c,job,m)).status,'UNKNOWN');assert.equal(m.pages.size,1);
 const find2=m.find.bind(m);m.find=async()=>[];assert.equal((await offlineUpsert(f.DB,mockEnv,c,job,m)).status,'UNKNOWN');assert.equal(m.pages.size,1);
 m.find=find2;assert.equal((await offlineUpsert(f.DB,mockEnv,c,job,m)).status,'linked');assert.equal(m.calls.filter(x=>x==='create').length,1);
});
test('duplicate external IDs and unsent delivery jobs fail without overwrites',async t=>{
 const {f,c,job,m}=await setup(t);await assert.rejects(offlineUpsert(f.DB,mockEnv,c,{...job,kind:'delivery_sent',intent_id:'missing'},m),/delivery_not_sent/);assert.equal(m.pages.size,0);
 m.pages.set('a',{id:'a',externalId:c.id});m.pages.set('b',{id:'b',externalId:c.id});await assert.rejects(offlineUpsert(f.DB,mockEnv,c,job,m),/external_id_conflict/);
});
test('mock delivery executor receives only lifecycle-preserving patch',async t=>{
 const {f,c}=await setup(t);await f.session();await f.send(c.id,await f.review(c.id));const plans=[];await runMockSync(f.DB,mockEnv,async p=>plans.push(p));
 assert.deepEqual(Object.keys(plans[1].properties),['Reply State']);assert.equal(plans[1].externalCaseId,c.id);assert.equal(plans[1].data_source_id,DATA_SOURCE);
});
const live={DEPLOYMENT_STAGE:'production',SEND_MODE:'live',ALLOW_REAL_SEND:'true',RESEND_API_KEY:'offline-placeholder',OUTBOUND_SENDER_ALLOWLIST:JSON.stringify(['support@bigsoxstudios.com']),OUTBOUND_RECIPIENT_ALLOWLIST:JSON.stringify(['person@example.test'])};
const intent=()=>({id:crypto.randomUUID(),sender:'support@bigsoxstudios.com',recipient:'person@example.test',subject:'Re: test',body:'Human reviewed text',inReplyTo:'<parent@example.test>',references:['<root@example.test>']});
const approval=i=>({...i,humanApproved:true,status:'dispatching',expires:Date.now()/1000+60});
test('offline Resend rehearsal uses manual redirects, locked plain text envelope, official key and reply metadata',async()=>{
 const i=intent();let calls=0;const result=await rehearseResend(i,live,async(url,init)=>{calls++;assert.equal(init.redirect,'manual');assert.equal(init.headers['Idempotency-Key'],i.id);
 assert.deepEqual(JSON.parse(init.body),{from:i.sender,to:[i.recipient],subject:i.subject,text:i.body,headers:{'In-Reply-To':i.inReplyTo,References:'<root@example.test> <parent@example.test>'}});return Response.json({id:'stub'});});assert.equal(result.status,'sent');assert.equal(calls,1);
});
test('future Resend rejects missing/expired/unreviewed or mismatched approval before fetch',async()=>{
 const i=intent();let calls=0;const fetcher=async()=>{calls++;return Response.json({id:'stub'});};
 for(const a of [undefined,{...approval(i),humanApproved:false},{...approval(i),expires:undefined},{...approval(i),expires:0},{...approval(i),status:'UNKNOWN'}, {...approval(i),recipient:'other@example.test'}, {...approval(i),sender:'hello@bigsoxstudios.com'}, {...approval(i),body:'changed'}, {...approval(i),inReplyTo:'<forged@example.test>'}]) await assert.rejects(resendFuture(i,live,fetcher,a),/approval_required/);
 assert.equal(calls,0);
});
test('offline Resend rehearsal validates senders, single recipients and thread header injection',async()=>{
 for(const change of [{sender:'SUPPORT@bigsoxstudios.com'},{sender:'support@evil.test'},{recipient:'a@example.test,b@example.test'},{recipient:'a@example.test\r\nBcc: b@example.test'},{inReplyTo:'<a@example.test>\r\nBcc: bad'}, {references:['invalid']},{subject:'bad\r\nX: injection'}]) {
  const i={...intent(),...change};await assert.rejects(rehearseResend(i,live,()=>{throw Error('unexpected fetch');}),/invalid_/);
 }
});
test('offline Resend rehearsal redirects and ambiguous outcomes return UNKNOWN after one attempt',async()=>{
 const i=intent();for(const status of [301,302,303,307,308,409,429,500]) {let calls=0;assert.equal((await rehearseResend(i,live,async()=>{calls++;return new Response(null,{status,headers:{Location:'https://evil.example.test'}});})).status,'UNKNOWN');assert.equal(calls,1);}
 for(const status of [400,401,403,404,422]) assert.equal((await rehearseResend(i,live,async()=>new Response(null,{status}))).status,'failed');
});
