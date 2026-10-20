import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, token } from './helpers.mjs';
import { prepareReply, sendReply, replyEnabled } from '../src/reply.resend.mjs';
import { recoverUncertain, now } from '../src/store.mjs';
const migration = await readFile(new URL('../migrations/0005_simple_replies.sql',import.meta.url),'utf8');
const owner = 'fridman.greg@gmail.com';
const env = { DEPLOYMENT_STAGE:'staging', SEND_MODE:'live', ALLOW_REAL_SEND:'true', MAILDESK_REPLY_ACTIVATION:'owner-self-v1', MAILDESK_RECIPIENT_ALLOWLIST:JSON.stringify([owner]), OWNER_EMAIL:owner, RESEND_API_KEY:'re_OFFLINE_SYNTHETIC_NOT_A_REAL_KEY_0000' };
const intent = () => ({ id:crypto.randomUUID(), sender:'support@bigsoxstudios.com', recipient:owner, subject:'Offline reply', body:'Exact reviewed body <b>inert</b>' });
async function setup(t, { transport=async()=>Response.json({id:'11111111-1111-4111-8111-111111111111'}), migrate=true }={}) {
 let calls=0; const seen=[];
 const f=await fixture(t,{env,notion:true,replyTransport:async(url,options)=>{calls++;seen.push({url,options});return transport(url,options);}});
 if(migrate) f.DB.sqlite.exec(migration);
 await f.session();
 const raw=new TextEncoder().encode(`From: ${owner}\r\nTo: support@bigsoxstudios.com\r\nSubject: Offline inbound\r\nMessage-ID: <offline-simple@example.test>\r\nContent-Type: text/plain\r\n\r\nOwner test.`);
 await f.worker.email({from:owner,to:'support@bigsoxstudios.com',rawSize:raw.length,raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),headers:new Headers(),setReject(){assert.fail('unexpected reject');},async forward(){}}, {...f.env,ENABLE_INBOUND_EMAIL:'true',INBOUND_FORWARD_TO:owner},{});
 const id=f.DB.sqlite.prepare('SELECT id FROM cases').get().id;
 const send = (r,more={},headers) => f.request(`/api/cases/${id}/send`,{intentId:r.id,approval:r.approval,confirmed:true,...more},headers ? {headers}:{});
 return {...f,id,sendReply:send,wireCalls:()=>calls,seen};
}
for(const [name,changes] of Object.entries({mode:{SEND_MODE:'mock'},allow:{ALLOW_REAL_SEND:'false'},stage:{DEPLOYMENT_STAGE:'production'},activation:{MAILDESK_REPLY_ACTIVATION:'off'},list:{MAILDESK_RECIPIENT_ALLOWLIST:'["other@example.test"]'},expanded:{MAILDESK_RECIPIENT_ALLOWLIST:JSON.stringify([owner,'other@example.test'])},owner:{OWNER_EMAIL:'other@example.test'},missingKey:{RESEND_API_KEY:undefined},badKey:{RESEND_API_KEY:'bad\r\ncredential'}})) test(`real preflight denies ${name}`,()=>{
 assert.equal(replyEnabled({...env,...changes}),false);assert.throws(()=>prepareReply(intent(),{...env,...changes}),/reply_preflight_rejected/);
});
for(const [n,changes] of [{sender:'hello@bigsoxstudios.com'},{recipient:'customer@example.test'},{recipient:owner+'\r\nBcc: bad@example.test'},{subject:'x\r\ny'},{subject:'x'.repeat(999)},{body:'x'.repeat(10001)},{body:'\0'},{body:'   '},{id:'bad'}].entries()) test(`preflight rejects unsafe snapshot ${n}`,()=>assert.throws(()=>prepareReply({...intent(),...changes},env)));
test('single wire request uses exact snapshot, stable idempotency, abort signal, no threading/HTML',async()=>{
 const i=intent(), p=prepareReply(i,env), stages=[];
 assert.ok(new TextEncoder().encode(p.key).length<=256);assert.equal(prepareReply(i,env).key,p.key);
 const result=await sendReply(p,env,async s=>stages.push(s),async(url,o)=>{
  assert.equal(url,'https://api.resend.com/emails');assert.equal(o.redirect,'manual');assert.ok(o.signal instanceof AbortSignal);
  assert.equal(o.headers['Idempotency-Key'],p.key);assert.equal(o.headers.Authorization,`Bearer ${env.RESEND_API_KEY}`);
  assert.deepEqual(JSON.parse(o.body),{from:i.sender,to:[i.recipient],subject:i.subject,text:i.body});return Response.json({id:'11111111-1111-4111-8111-111111111111'});
 });
 assert.equal(result.status,'sent');assert.deepEqual(stages,['fetch_started','response_http_200','provider_accepted']);assert.ok(!JSON.stringify({result,stages}).includes(env.RESEND_API_KEY));
});
for(const status of [400,401,403,404,413,422,429,302,408,409,500,502,503]) test(`provider HTTP ${status} classified without leaking body`,async()=>{
 const stages=[];let calls=0;
 const r=await sendReply(prepareReply(intent(),env),env,async s=>stages.push(s),async()=>{calls++;return new Response('SECRET RAW PRIVATE BODY',{status});});
 assert.equal(calls,1);assert.equal(r.status,[400,401,403,404,413,422,429].includes(status)?'failed':'UNKNOWN');assert.ok(!JSON.stringify({r,stages}).includes('PRIVATE'));
});
for(const [name,response] of [['nonJSON',()=>new Response('private text')],['empty',()=>Response.json({})],['badId',()=>Response.json({id:'secret\r\nraw'})],['keyEcho',()=>Response.json({id:env.RESEND_API_KEY})],['oversize',()=>new Response('x'.repeat(5000))]]) test(`provider ${name} never claims success`,async()=>{
 assert.equal((await sendReply(prepareReply(intent(),env),env,async()=>{},async()=>response())).status,'UNKNOWN');
});
test('fetch rejection drops exception text and never retries',async()=>{
 let calls=0;const stages=[];const r=await sendReply(prepareReply(intent(),env),env,async s=>stages.push(s),async()=>{calls++;throw Error(env.RESEND_API_KEY+' private');});
 assert.deepEqual(r,{status:'UNKNOWN',stage:'fetch_rejected'});assert.equal(calls,1);assert.ok(!JSON.stringify(stages).includes('private'));
});
test('deadline aborts in-flight fetch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal,started;const entered=new Promise(r=>started=r);
 const pending=sendReply(prepareReply(intent(),env),env,async()=>{},async(url,o)=>{signal=o.signal;started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private')),{once:true}));});
 await entered;t.mock.timers.tick(8000);assert.equal((await pending).status,'UNKNOWN');assert.equal(signal.aborted,true);
});
test('deadline cancels stalled response body',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false,reading;const entered=new Promise(r=>reading=r);
 const pending=sendReply(prepareReply(intent(),env),env,async()=>{},async()=>new Response(new ReadableStream({pull(){reading();},cancel(){cancelled=true;}})));
 await entered;await new Promise(r=>setImmediate(r));t.mock.timers.tick(8000);assert.equal((await pending).status,'UNKNOWN');assert.equal(cancelled,true);
});
test('existing worker live flow enforces confirmation, owner, CSRF and at-most-one dispatch',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await setup(t,{transport:async()=>{await gate;return Response.json({id:'11111111-1111-4111-8111-111111111111'});}});const r=await f.review(f.id);
 assert.equal(r.mode,'live');assert.equal(f.wireCalls(),0);assert.equal((await f.sendReply(r,{confirmed:false})).status,400);
 assert.equal((await f.sendReply(r,{}, {'Cf-Access-Jwt-Assertion':await token({email:'other@example.test'})})).status,401);
 assert.equal((await f.sendReply(r,{}, {'X-CSRF-Token':null})).status,403);
 const pending=Array.from({length:5},()=>f.sendReply(r));while(!f.wireCalls()) await new Promise(r=>setImmediate(r));release();
 assert.ok((await Promise.all(pending)).every(r=>r.status===200));assert.equal(f.wireCalls(),1);assert.equal((await (await f.sendReply(r)).json()).status,'sent');
 assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM messages WHERE direction='outbound'").get().n,1);
 const events=f.DB.sqlite.prepare('SELECT event FROM audit_events').all();assert.ok(events.some(r=>r.event==='reply_provider_accepted'));assert.ok(!JSON.stringify(events).includes(env.RESEND_API_KEY));
});
for(const kind of ['uncertain','persistence','crash']) test(`live ${kind} cannot resend or edit`,async t=>{
 const f=await setup(t,{transport:async()=>{if(kind==='uncertain') throw Error('private');return Response.json({id:'11111111-1111-4111-8111-111111111111'});}});const r=await f.review(f.id);
 if(kind==='persistence') f.DB.sqlite.exec("CREATE TRIGGER fail_sync BEFORE INSERT ON sync_jobs BEGIN SELECT RAISE(ABORT,'private'); END");
 if(kind==='crash') f.DB.sqlite.prepare("UPDATE outbound_intents SET status='dispatching',updated_at=?").run(now()-1000);
 const res=await f.sendReply(r);if(kind==='uncertain') assert.equal((await res.json()).status,'UNKNOWN');
 const calls=f.wireCalls();await f.sendReply(r);await recoverUncertain(f.DB,now()+1);await f.sendReply(r);assert.equal(f.wireCalls(),calls);
 assert.equal((await f.request(`/api/cases/${f.id}/draft`,{revision:r.revision,body:'retry'})).status,409);
});
test('preflight rejection precedes claim and stores only generic stage',async t=>{
 const f=await setup(t);const r=await f.review(f.id);f.env.RESEND_API_KEY='invalid-private';assert.equal((await f.sendReply(r)).status,503);assert.equal(f.wireCalls(),0);
 assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'reserved');assert.ok(f.DB.sqlite.prepare("SELECT event FROM audit_events WHERE event='reply_preflight_rejected'").get());
});
test('real review requires 0005 and genuine inbound; synthetic case cannot activate',async t=>{
 const f=await setup(t,{migrate:false});await assert.rejects(f.review(f.id),/reply_migration_required/);assert.equal(f.wireCalls(),0);
 const g=await fixture(t,{env,notion:true});g.DB.sqlite.exec(migration);await g.session();const id=await g.seed({channel:'support'});
 g.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run(owner);await assert.rejects(g.review(id),/reply_inbound_required/);assert.equal(g.calls(),0);
});
test('mode switch, changed recipient, stale revision and expired review cannot dispatch',async t=>{
 const f=await setup(t);const r=await f.review(f.id);f.env.SEND_MODE='mock';assert.equal((await f.sendReply(r)).status,503);f.env.SEND_MODE='live';
 f.DB.sqlite.prepare("UPDATE cases SET requester_email='customer@example.test'").run();assert.equal((await f.sendReply(r)).status,409);assert.equal(f.wireCalls(),0);
 f.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run(owner);const fresh=await f.review(f.id,'new revision');assert.equal((await f.sendReply(r)).status,409);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+601000});assert.equal((await f.sendReply(fresh)).status,409);assert.equal(f.wireCalls(),0);
});
test('real snapshot and terminal records are immutable',async t=>{
 const f=await setup(t);const r=await f.review(f.id);assert.throws(()=>f.DB.sqlite.exec("UPDATE outbound_intents SET body='tampered'"),/immutable_reply_snapshot|unsafe_reply_transition/);await f.sendReply(r);
 assert.throws(()=>f.DB.sqlite.exec("UPDATE outbound_intents SET status='reserved'"),/unsafe_reply_transition/);assert.throws(()=>f.DB.sqlite.exec('DELETE FROM outbound_intents'),/durable_reply/);
});
test('0005 preserves populated 0004 records, receipts, Notion links and triggers',async t=>{
 const f=await fixture(t,{notion:true});await f.session();const id=await f.seed();await f.send(id,await f.review(id));
 f.DB.sqlite.exec(await readFile(new URL('../migrations/0004_outbound_approval.sql',import.meta.url),'utf8'));
 const tables=f.DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
 const before=Object.fromEntries(tables.map(name=>[name,f.DB.sqlite.prepare(`SELECT * FROM ${name}`).all()]));
 const triggers=f.DB.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
 f.DB.sqlite.exec(migration);
 for(const name of tables) assert.deepEqual(f.DB.sqlite.prepare(`SELECT * FROM ${name}`).all(),before[name],name);
 for(const tr of triggers) assert.deepEqual(f.DB.sqlite.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(tr.name),tr);
 const next=await f.seed({key:'another-case'});const review=await f.review(next);assert.equal(review.mode,'mock');assert.equal((await (await f.send(next,review)).json()).status,'sent');
});
test('mock review cannot become a real send when activation flags change',async t=>{
 const f=await setup(t);f.env.SEND_MODE='mock';const r=await f.review(f.id);f.env.SEND_MODE='live';
 assert.equal((await f.sendReply(r)).status,503);assert.equal(f.wireCalls(),0);
 assert.equal((await f.request(`/api/cases/${f.id}/review`,{revision:r.revision})).status,409);
});
test('accepted provider response with failed durable commit returns uncertainty',async t=>{
 const f=await setup(t);const r=await f.review(f.id);
 f.DB.sqlite.exec("CREATE TRIGGER fail_sync BEFORE INSERT ON sync_jobs BEGIN SELECT RAISE(ABORT,'private'); END");
 const res=await (await f.sendReply(r)).json();assert.equal(res.status,'UNKNOWN');assert.equal(res.stage,'storage_unconfirmed');
 assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'dispatching');await f.sendReply(r);assert.equal(f.wireCalls(),1);
});
test('late provider acceptance cannot override durable UNKNOWN from interruption recovery',async t=>{
 let f;
 f=await setup(t,{transport:async()=>{await recoverUncertain(f.DB,now()+1);return Response.json({id:'11111111-1111-4111-8111-111111111111'});}});const r=await f.review(f.id);
 assert.equal((await (await f.sendReply(r)).json()).status,'UNKNOWN');assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'UNKNOWN');
 await f.sendReply(r);assert.equal(f.wireCalls(),1);
});
test('adapter independently denies disabled flags and forged preparation without starting fetch',async()=>{
 let calls=0;const transport=async()=>{calls++;assert.fail('forbidden transport');};const p=prepareReply(intent(),env);
 for(const changes of [{ALLOW_REAL_SEND:'false'},{SEND_MODE:'mock'},{DEPLOYMENT_STAGE:'production'},{RESEND_API_KEY:undefined}]) await assert.rejects(sendReply(p,{...env,...changes},async()=>{},transport),/reply_preflight_rejected/);
 await assert.rejects(sendReply({...p},env,async()=>{},transport),/reply_preflight_rejected/);assert.equal(calls,0);assert.ok(Object.isFrozen(p));
});
test('worker checks all activation flags before claiming a reviewed live intent',async t=>{
 const f=await setup(t);const r=await f.review(f.id);
 for(const changes of [{ALLOW_REAL_SEND:'false'},{SEND_MODE:'mock'},{DEPLOYMENT_STAGE:'production'},{MAILDESK_REPLY_ACTIVATION:'off'},{MAILDESK_RECIPIENT_ALLOWLIST:'[]'},{RESEND_API_KEY:'bad'}]) {
  Object.assign(f.env,env,changes);assert.equal((await f.sendReply(r)).status,503);assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'reserved');
 }
 assert.equal(f.wireCalls(),0);
});
