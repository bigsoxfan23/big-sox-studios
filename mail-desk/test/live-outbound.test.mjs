import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, token, jwk, origin, folderMigration } from './helpers.mjs';
import { moveFolders } from '../src/folders.mjs';
import { b64 } from '../src/security.mjs';
import { createOfflineOutbound, createProductionCandidate, recoverLiveUncertain } from '../src/outbound.candidate.mjs';
import { parseVerifiedHeaders } from '../src/outbound.provenance.mjs';
const migration = await readFile(new URL('../migrations/0004_outbound_approval.sql', import.meta.url), 'utf8');
const migration5 = await readFile(new URL('../migrations/0005_simple_replies.sql', import.meta.url), 'utf8');
const ingress = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']);
const sender = 'support@bigsoxstudios.com', owner = 'owner@example.test';
const rows = (f, table) => f.DB.sqlite.prepare(`SELECT * FROM ${table}`).all();
async function sign(e) { return b64(await crypto.subtle.sign('Ed25519', ingress.privateKey, new TextEncoder().encode(e))); }
async function capture(f, { name='parent', parent, time=Math.floor(Date.now()/1000)-10, changes={}, headers } = {}) {
 const pairs = headers ?? [['From',owner],['To',sender],['Message-ID',`<${name}@example.test>`],
  ...(parent ? [['In-Reply-To',`<${parent}@example.test>`],['References',`<${parent}@example.test>`]] : [])];
 const raw = new TextEncoder().encode(pairs.map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\nContent-Type: text/plain\r\n\r\nFixture inbound');
 await f.worker.email({ from:owner, to:sender, rawSize:raw.length, raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),
  headers:new Headers(pairs), setReject(){assert.fail('fixture rejected');}, async forward(){} },
 {...f.env,ENABLE_INBOUND_EMAIL:'true',INBOUND_FORWARD_TO:owner}, {});
 const r = rows(f,'email_receipts').at(-1), m = rows(f,'email_receipt_messages').find(v=>v.receipt_key===r.receipt_key).message_id;
 f.DB.sqlite.prepare('UPDATE email_receipts SET created_at=? WHERE receipt_key=?').run(time,r.receipt_key);
 f.DB.sqlite.prepare('UPDATE messages SET created_at=? WHERE id=?').run(time,m);
 const e = { policy:'maildesk-ingress-v1', receiptKey:r.receipt_key, caseId:r.case_id, messageId:m,
  envelopeFrom:owner, envelopeTo:sender, receivedAt:time, messageCreatedAt:time,
  dmarc:'pass', authenticatedMailbox:owner, headerIntegrity:true, verifierEvent:crypto.randomUUID(), rawHeaders:pairs, ...changes };
 return {r,m,e};
}
async function persist(f, captured, {e=captured.e, signature} = {}) {
 const serialized=JSON.stringify(e);
 f.DB.sqlite.prepare('INSERT INTO outbound_provenance VALUES (?,?,?,?,?,?)').run(captured.r.receipt_key,captured.m,'maildesk-ingress-v1',serialized,signature ?? await sign(serialized),Math.floor(Date.now()/1000));
}
async function setup(t, { response=()=>Response.json({id:'offline-acceptance'}), provenance=true, changes={}, migrate=true, fullSchema=false, env={}, claims={amr:['mfa']} }={}) {
 const f = await fixture(t,{notion:true,cleanup:false});
 if(migrate) f.DB.sqlite.exec(migration);
 if(fullSchema) f.DB.sqlite.exec(migration5);
 f.DB.sqlite.exec(folderMigration);
 const captured=await capture(f,{changes});
 if(provenance && migrate) await persist(f,captured);
 const id=captured.r.case_id;
 f.DB.sqlite.prepare("UPDATE cases SET draft='Owner reviewed reply',revision=1 WHERE id=?").run(id);
 Object.assign(f.env,{DEPLOYMENT_STAGE:'production',SEND_MODE:'live',ALLOW_REAL_SEND:'true',RESEND_API_KEY:'offline-placeholder',
  LIVE_APPROVAL_SECRET:'offline-live-approval-secret-independent-000000',OUTBOUND_START_UNIX:'0',
  OUTBOUND_SENDER_ALLOWLIST:JSON.stringify([sender]),OUTBOUND_RECIPIENT_ALLOWLIST:JSON.stringify([owner]),...env});
 let calls=0; const seen=[];
 const stub=async (url,init)=>{calls++;seen.push({url,init});return response(url,init);};
 const fetcher=async url=>{assert.equal(url,`${f.env.ACCESS_ISSUER}/cdn-cgi/access/certs`);return Response.json({keys:[jwk]});};
 const make=()=>createOfflineOutbound({fetcher,providerStub:stub,ingressPublicKey:ingress.publicKey});
 const candidate=make(), jwt=await token(claims);let cookie,csrf;
 async function request(path,data,headers={}, worker=candidate) {
  return worker.fetch(new Request(origin+path,{method:data===undefined?'GET':'POST',headers:{
   'Cf-Access-Jwt-Assertion':jwt,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf}),...headers},
   ...(data===undefined?{}:{body:JSON.stringify(data)})}),f.env);
 }
 async function session(){const r=await request('/api/live/session');const v=await r.json();cookie=r.headers.get('Set-Cookie')?.split(';')[0];csrf=v.csrf;return {r,v};}
 const route=action=>`/api/live/cases/${id}/${action}`;
 async function review(revision=1){const r=await request(route('review'),{revision});assert.equal(r.status,200,await r.clone().text());return r.json();}
 async function approve(r){const res=await request(route('approve'),{intentId:r.id,approval:r.approval});assert.equal(res.status,200,await res.clone().text());return res.json();}
 const send=(a,headers={},worker=candidate)=>request(route('send'),{intentId:a.id,approval:a.approval},headers,worker);
 return {...f,captured,id,request,session,review,approve,send,route,make,calls:()=>calls,seen,fetcher};
}

test('0004 upgrades populated 0003 without modifying/backfilling any old record; old worker remains compatible',async t=>{
 const f=await fixture(t,{notion:true});const captured=await capture(f);
 const synthetic=await f.seed();await f.session();await f.send(synthetic,await f.review(synthetic));
 f.DB.sqlite.prepare("INSERT INTO notion_links VALUES (?,?,'linked',1)").run(captured.r.case_id,crypto.randomUUID());
 f.DB.sqlite.prepare("INSERT INTO notion_activity_links VALUES (?, ?, ?, 'linked', 1)").run(captured.m,captured.r.case_id,crypto.randomUUID());
 f.DB.sqlite.prepare('INSERT INTO notion_sync_backoff VALUES (?,1)').run(captured.r.case_id);
 const tables=['cases','messages','email_receipts','email_receipt_messages','notion_links','notion_activity_links','notion_sync_backoff','outbound_intents','sync_jobs','audit_events','inbound_dedupe'];
 const before=tables.map(k=>rows(f,k));f.DB.sqlite.exec(migration);
 assert.deepEqual(tables.map(k=>rows(f,k)),before);
 assert.equal(rows(f,'outbound_provenance').length,0);assert.equal(rows(f,'live_outbound_reviews').length,0);
 assert.deepEqual(f.DB.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 const legacy=await fixture(t,{notion:true});legacy.DB.sqlite.exec(migration);await legacy.session();
 const id=await legacy.seed();const review=await legacy.review(id);assert.equal((await legacy.send(id,review)).status,200);
});
test('complete separate review/approve/send accepts fake canary once and preserves thread/provider outcome',async t=>{
 const f=await setup(t);await f.session();const r=await f.review();assert.equal(f.calls(),0);
 assert.equal(r.snapshot.recipient,owner);assert.equal(r.snapshot.inReplyTo,'<parent@example.test>');
 assert.equal(r.snapshot.provenance,JSON.stringify(f.captured.e));
 assert.equal((await f.send(r)).status,403); // review token cannot send
 const a=await f.approve(r);assert.equal(f.calls(),0);
 const response=await f.send(a);assert.equal(response.status,200);assert.equal((await response.json()).status,'sent');
 assert.equal((await (await f.send(a)).json()).status,'sent');assert.equal(f.calls(),1);
 const payload=JSON.parse(f.seen[0].init.body);
 assert.deepEqual(payload.headers,{'In-Reply-To':'<parent@example.test>',References:'<parent@example.test>'});
 assert.equal(f.seen[0].init.headers['Idempotency-Key'],r.id);
 assert.equal(rows(f,'live_outbound_reviews')[0].provider_id,'offline-acceptance');
 assert.equal(rows(f,'messages').filter(m=>m.direction==='outbound').length,1);
 assert.equal(rows(f,'sync_jobs').length,1); // existing queue untouched
 assert.equal(rows(f,'audit_events').filter(e=>e.event==='live_acceptance_sent').length,1);
});
test('independent candidate invocations and overlapping double-clicks have one atomic claim',async t=>{
 let release,entered=false;const held=new Promise(resolve=>{release=()=>resolve(Response.json({id:'one'}));});
 const f=await setup(t,{response:()=>{entered=true;return held;}});await f.session();const a=await f.approve(await f.review());
 const requests=Array.from({length:12},()=>f.send(a,{},f.make()));
 while(!entered) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rows(f,'live_outbound_reviews')[0].status,'dispatching');release();
 assert.ok((await Promise.all(requests)).every(r=>r.status===200));assert.equal(f.calls(),1);
});
for(const field of ['snapshot_json','case_id','receipt_key','message_id','revision','session_hash','approval_expires','purpose','created_at','id']) test(`DB freezes approval field ${field}`,async t=>{
 const f=await setup(t);await f.session();await f.review();
 assert.throws(()=>f.DB.sqlite.prepare(`UPDATE live_outbound_reviews SET ${field}=?`).run(field==='revision'||field==='approval_expires'||field==='created_at'?123:'changed'));
 assert.equal(f.calls(),0);
});
for(const [name,sql] of [
 ['provenance',"UPDATE outbound_provenance SET evidence_json='{}'"],['receipt',"UPDATE email_receipts SET envelope_from='evil@example.test'"],
 ['message',"UPDATE messages SET body='changed'"],['mapping',"UPDATE email_receipt_messages SET message_id='missing'"],
 ['delete evidence','DELETE FROM outbound_provenance'],['delete mapping','DELETE FROM email_receipt_messages'],['delete review','DELETE FROM live_outbound_reviews']
]) test(`DB protects ${name} after capture`,async t=>{
 const f=await setup(t);await f.session();await f.review();assert.throws(()=>f.DB.sqlite.exec(sql));
});
for(const state of ['sent','failed','UNKNOWN','dispatching','reserved']) test(`DB disallows reserved to ${state}`,async t=>{
 const f=await setup(t);await f.session();await f.review();assert.throws(()=>f.DB.sqlite.prepare('UPDATE live_outbound_reviews SET status=?').run(state));
});
for(const [label,change] of [
 ['DMARC missing',{dmarc:undefined}],['DMARC fail',{dmarc:'fail'}],['unverified exact mailbox',{authenticatedMailbox:'different@example.test'}],
 ['header integrity absent',{headerIntegrity:false}],['forged case',{caseId:crypto.randomUUID()}],['forged receipt',{receiptKey:'forged'}],
 ['forged mapped message',{messageId:crypto.randomUUID()}],['forged envelope',{envelopeFrom:'different@example.test'}],
 ['wrong studio recipient',{envelopeTo:'hello@bigsoxstudios.com'}],['false timestamp',{receivedAt:1}]
]) test(`signed fixture with ${label} fails closed`,async t=>{
 const f=await setup(t,{changes:change});await f.session();assert.equal((await f.request(f.route('review'),{revision:1})).status,409);assert.equal(f.calls(),0);
});
for(const kind of ['missing','forged']) test(`${kind} provenance cannot become review authority`,async t=>{
 const f=await setup(t,{provenance:false});if(kind==='forged')await persist(f,f.captured,{signature:'forged'});
 await f.session();assert.equal((await f.request(f.route('review'),{revision:1})).status,409);assert.equal(f.calls(),0);
});
for(const [name,modify] of [
 ['duplicate Message-ID',p=>[...p,['Message-ID','<second@example.test>']]],
 ['duplicate From',p=>[...p,['fRoM',owner]]],['forged Reply-To',p=>[...p,['Reply-To','evil@example.test']]],
 ['unverified From',p=>p.map(x=>x[0]==='From'?['From','evil@example.test']:x)],
 ['folded header',p=>p.map(x=>x[0]==='Message-ID'?['Message-ID','<parent@example.test>\r\n Bcc: evil']:x)],
 ['multi ID',p=>p.map(x=>x[0]==='Message-ID'?['Message-ID','<a@example.test> <b@example.test>']:x)],
 ['encoded ID',p=>p.map(x=>x[0]==='Message-ID'?['Message-ID','=?UTF-8?Q?bad?=']:x)],
 ['orphan reference',p=>[...p,['References','<unknown@example.test>']]],
 ['unsafe header name',p=>[...p,['X Bad','value']]],['control value',p=>[...p,['X-Test','bad\0value']]]
]) test(`adversarial lossless headers: ${name}`,async t=>{
 const base=[['From',owner],['To',sender],['Message-ID','<parent@example.test>']];
 if(name==='orphan reference') {const f=await setup(t,{changes:{rawHeaders:modify(base)}});await f.session();assert.equal((await f.request(f.route('review'),{revision:1})).status,409);}
 else assert.throws(()=>parseVerifiedHeaders(modify(base),owner));
});
for(const [name,sql] of [
 ['unforwarded',"UPDATE email_receipts SET forward_state='UNKNOWN'"],['wrong envelope',"UPDATE email_receipts SET envelope_from='evil@example.test'"],
 ['wrong support mailbox',"UPDATE email_receipts SET envelope_to='hello@bigsoxstudios.com'"],['cross case mapping',"UPDATE messages SET case_id=(SELECT id FROM cases WHERE channel='members' LIMIT 1)"],
 ['non support case',"UPDATE cases SET channel='members'"],['unmapped',"DELETE FROM email_receipt_messages"]
]) test(`persisted inbound ${name} denied`,async t=>{
 const f=await setup(t,{provenance:false});await f.seed();f.DB.sqlite.exec(sql);
 if(name!=='unmapped' && name!=='cross case mapping' && name!=='unforwarded')await persist(f,f.captured);
 await f.session();assert.equal((await f.request(f.route('review'),{revision:1})).status,409);assert.equal(f.calls(),0);
});
test('cutoff equality and missing 0004 fail closed',async t=>{
 for(const opts of [{env:{OUTBOUND_START_UNIX:String(Math.floor(Date.now()/1000)-10)}},{migrate:false}]){
  const f=await setup(t,opts);await f.session();assert.ok([409,503].includes((await f.request(f.route('review'),{revision:1})).status));assert.equal(f.calls(),0);
 }
});
for(const change of [{DEPLOYMENT_STAGE:'staging'},{SEND_MODE:'mock'},{ALLOW_REAL_SEND:'false'},{ALLOW_REAL_SEND:true},
 {RESEND_API_KEY:'real-looking-key'},{OUTBOUND_START_UNIX:'-1'},{LIVE_APPROVAL_SECRET:'short'},
 {OUTBOUND_SENDER_ALLOWLIST:'["*"]'},{OUTBOUND_RECIPIENT_ALLOWLIST:'["other@example.test"]'}]) test(`closed candidate gate ${JSON.stringify(change)}`,async t=>{
 const f=await setup(t,{env:change});await f.session();assert.equal((await f.request(f.route('review'),{revision:1})).status,503);assert.equal(f.calls(),0);
});
for(const amr of [undefined,[],['pwd']]) test(`owner MFA required ${JSON.stringify(amr)}`,async t=>{
 const f=await setup(t,{claims:{amr}});assert.equal((await f.session()).r.status,401);assert.equal(f.calls(),0);
});
test('non-owner Access JWT cannot enter candidate',async t=>{
 const f=await setup(t,{claims:{amr:['mfa'],email:'other@example.test'}});assert.equal((await f.session()).r.status,401);
});
for(const headers of [{Origin:'https://evil.test'},{'X-CSRF-Token':'forged'},{Cookie:'forged'},{'Sec-Fetch-Site':'cross-site'}]) test(`candidate CSRF and origin ${JSON.stringify(headers)}`,async t=>{
 const f=await setup(t);await f.session();assert.equal((await f.request(f.route('review'),{revision:1},headers)).status,403);assert.equal(f.calls(),0);
});
for(const field of ['recipient','sender','headers','humanApproved','receiptKey','body']) test(`client-controlled ${field} rejected at every candidate phase`,async t=>{
 const f=await setup(t);await f.session();const r=await f.review();
 for(const [action,data] of [['review',{revision:1}],['approve',{intentId:r.id,approval:r.approval}],['send',{intentId:r.id,approval:r.approval}]])
  assert.equal((await f.request(f.route(action),{...data,[field]:'forged'})).status,400);
 assert.equal(f.calls(),0);
});
test('expired approval, replay and cross-case/session approval are denied',async t=>{
 const f=await setup(t);await f.session();const r=await f.review(),a=await f.approve(r);
 assert.equal((await f.request(f.route('approve'),{intentId:r.id,approval:r.approval})).status,409);
 const other=crypto.randomUUID();assert.equal((await f.request(`/api/live/cases/${other}/send`,{intentId:a.id,approval:a.approval})).status,403);
 assert.equal((await f.send(a,{'Cf-Access-Jwt-Assertion':await token({amr:['mfa'],sub:'other-session'})})).status,403);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+601000});assert.equal((await f.send(a)).status,409);assert.equal(f.calls(),0);
});
for(const change of ["UPDATE cases SET revision=revision+1,draft='changed'", "UPDATE cases SET requester_email='different@example.test'", "UPDATE cases SET subject='changed'"])
 test(`current case mutation blocks reviewed send: ${change}`,async t=>{
  const f=await setup(t);await f.session();const a=await f.approve(await f.review());f.DB.sqlite.exec(change);assert.equal((await f.send(a)).status,409);assert.equal(f.calls(),0);
 });
for(const status of [400,401,403,429,500,302]) test(`coordinator HTTP ${status} terminal outcome and replay`,async t=>{
 const f=await setup(t,{response:()=>new Response(null,{status})});await f.session();const a=await f.approve(await f.review());
 const expected=[400,401,403].includes(status)?'failed':'UNKNOWN';assert.equal((await (await f.send(a)).json()).status,expected);
 await f.send(a);assert.equal(f.calls(),1);assert.equal(rows(f,'messages').filter(m=>m.direction==='outbound').length,0);
 if(expected==='UNKNOWN'){
  assert.throws(()=>f.DB.sqlite.exec("UPDATE cases SET draft='retry',revision=2"));
  assert.throws(()=>f.DB.sqlite.exec("UPDATE live_outbound_reviews SET status='approved'"));
 }
});
test('transport failure is UNKNOWN; persistence failure leaves dispatching; neither can retry',async t=>{
 for(const failPersist of [false,true]){
  const f=await setup(t,{response:()=>{if(!failPersist)throw Error('private');return Response.json({id:'accepted'});}});
  await f.session();const a=await f.approve(await f.review());
  if(failPersist)f.DB.sqlite.exec("CREATE TRIGGER fail_outcome BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'offline'); END");
  const response=await f.send(a);assert.equal(response.status,failPersist?503:200);
  assert.equal(rows(f,'live_outbound_reviews')[0].status,failPersist?'dispatching':'UNKNOWN');
  await f.send(a);assert.equal(f.calls(),1);await recoverLiveUncertain(f.DB,Math.floor(Date.now()/1000)+1);
  assert.equal(rows(f,'live_outbound_reviews')[0].status,'UNKNOWN');assert.equal(rows(f,'messages').filter(m=>m.direction==='outbound').length,0);
 }
});
for(const phase of ['fetch','body'])test(`coordinator ${phase} deadline locks UNKNOWN without retry`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let entered=false;
 const f=await setup(t,{response:()=>{entered=true;return phase==='fetch'?new Promise(()=>{}):new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}));}});
 await f.session();const a=await f.approve(await f.review()),pending=f.send(a);
 while(!entered)await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(10000);
 assert.equal((await (await pending).json()).status,'UNKNOWN');await f.send(a);assert.equal(f.calls(),1);
});
test('real candidate stays blocked even with valid fixture evidence, approval, all flags and injected provider',async t=>{
 const f=await setup(t);await f.session();const a=await f.approve(await f.review());let injected=0;
 const worker=createProductionCandidate({fetcher:f.fetcher,provider:()=>{injected++;assert.fail('injected');}});
 const res=await f.send(a,{},worker);assert.equal(res.status,503);assert.equal((await res.json()).error,'verified_ingress_unavailable');
 assert.equal(f.calls(),0);assert.equal(injected,0);assert.equal(rows(f,'live_outbound_reviews')[0].status,'approved');
});

test('verified generic support chain is preserved; unverified ancestor never reaches provider',async t=>{
 for(const authenticated of [true,false]){
  const f=await setup(t,{provenance:authenticated});
  const reply=await capture(f,{name:'reply',parent:'parent',time:Math.floor(Date.now()/1000)-5});await persist(f,reply);
  await f.session();const res=await f.request(f.route('review'),{revision:1});
  assert.equal(res.status,authenticated?200:409);
  if(authenticated){const a=await f.approve(await res.json());await f.send(a);
   assert.deepEqual(JSON.parse(f.seen[0].init.body).headers,{'In-Reply-To':'<reply@example.test>',References:'<parent@example.test> <reply@example.test>'});
  }else assert.equal(f.calls(),0);
 }
});
test('new inbound message, even without provenance, invalidates approved older receipt',async t=>{
 const f=await setup(t);await f.session();const a=await f.approve(await f.review());
 await capture(f,{name:'later',parent:'parent',time:Math.floor(Date.now()/1000)-1});
 assert.equal((await f.send(a)).status,409);assert.equal(f.calls(),0);
});
test('ambiguous equal-time inbound messages fail closed',async t=>{
 const f=await setup(t);await capture(f,{name:'tie',parent:'parent',time:f.captured.e.receivedAt});
 await f.session();assert.equal((await f.request(f.route('review'),{revision:1})).status,409);
});
test('claim independently rejects current case mutation after validation and before D1 UPDATE',async t=>{
 const f=await setup(t);await f.session();const a=await f.approve(await f.review());
 const prepare=f.DB.prepare.bind(f.DB);let changed=false;
 f.DB.prepare=sql=>{
  if(sql.startsWith('UPDATE live_outbound_reviews SET status=') && !changed){
   changed=true;f.DB.sqlite.exec("UPDATE cases SET revision=2,draft='raced change'");
  }
  return prepare(sql);
 };
 assert.equal((await f.send(a)).status,409);assert.equal(f.calls(),0);assert.equal(rows(f,'live_outbound_reviews')[0].status,'approved');
});
test('claim independently rejects arrival after validation and before D1 UPDATE',async t=>{
 const f=await setup(t);await f.session();const a=await f.approve(await f.review());
 const prepare=f.DB.prepare.bind(f.DB);let changed=false;
 f.DB.prepare=sql=>{
  if(sql.startsWith('UPDATE live_outbound_reviews SET status=') && !changed){
   changed=true;f.DB.sqlite.prepare("INSERT INTO messages VALUES (?,?,'inbound','later',?,NULL)").run(crypto.randomUUID(),f.id,Math.floor(Date.now()/1000));
  }
  return prepare(sql);
 };
 assert.equal((await f.send(a)).status,409);assert.equal(f.calls(),0);
});
test('legacy mock and new candidate cannot claim the same revision',async t=>{
 const f=await setup(t);await f.session();const r=await f.review();
 f.DB.sqlite.prepare("INSERT INTO outbound_intents VALUES (?,?,1,?,?,?,?,'session',9999999999,'reserved',NULL,1,1)")
  .run(crypto.randomUUID(),f.id,owner,sender,'test','body');
 assert.throws(()=>f.DB.sqlite.exec("UPDATE outbound_intents SET status='dispatching'"));
 // An already existing legacy intent also blocks new candidate approval.
 assert.equal((await f.request(f.route('approve'),{intentId:r.id,approval:r.approval})).status,409);
});
test('production session reports pending; no live UI or asset route is exposed',async t=>{
 const f=await setup(t);await f.session();
 const worker=createProductionCandidate({fetcher:f.fetcher});
 const res=await f.request('/api/live/session',undefined,{},worker);assert.equal(res.status,200);
 const session=await res.json();assert.equal(session.liveAvailable,false);assert.match(session.state,/pending/);
 assert.equal((await f.request('/',undefined,{},worker)).status,405);assert.equal(f.calls(),0);
});

test('forged or changed approval cannot approve or send',async t=>{
 const f=await setup(t);await f.session();const r=await f.review();
 assert.equal((await f.request(f.route('approve'),{intentId:r.id,approval:r.approval+'changed'})).status,403);
 const a=await f.approve(r);assert.equal((await f.send({...a,approval:a.approval+'changed'})).status,403);assert.equal(f.calls(),0);
});
test('unclaimed malformed body and subject fail before review or wire',async t=>{
 for(const [column,value] of [['draft','bad\0body'],['subject','bad\r\nBcc: injected']]){
  const f=await setup(t);f.DB.sqlite.prepare(`UPDATE cases SET ${column}=?`).run(value);await f.session();
  assert.equal((await f.request(f.route('review'),{revision:1})).status,409);assert.equal(f.calls(),0);
 }
});
test('failed atomic dispatch claim cannot issue a provider request',async t=>{
 const f=await setup(t);await f.session();const a=await f.approve(await f.review());
 f.DB.sqlite.exec("CREATE TRIGGER skip_claim BEFORE UPDATE ON live_outbound_reviews WHEN NEW.status='dispatching' BEGIN SELECT RAISE(IGNORE); END");
 assert.equal((await f.send(a)).status,409);assert.equal(f.calls(),0);assert.equal(rows(f,'live_outbound_reviews')[0].status,'approved');
});

test('recovery during a delayed acceptance stays UNKNOWN and cannot report sent or retry',async t=>{
 let release,entered=false;const held=new Promise(resolve=>{release=()=>resolve(Response.json({id:'late-acceptance'}));});
 const f=await setup(t,{response:()=>{entered=true;return held;}});await f.session();const a=await f.approve(await f.review());
 const pending=f.send(a);while(!entered)await new Promise(resolve=>setImmediate(resolve));
 await recoverLiveUncertain(f.DB,Math.floor(Date.now()/1000)+1);release();
 assert.equal((await (await pending).json()).status,'UNKNOWN');assert.equal(rows(f,'messages').filter(m=>m.direction==='outbound').length,0);
 await f.send(a);assert.equal(f.calls(),1);
});
test('zero-row finalization cannot persist an accepted thread or falsely report sent',async t=>{
 const f=await setup(t);await f.session();const a=await f.approve(await f.review());
 f.DB.sqlite.exec("CREATE TRIGGER skip_outcome BEFORE UPDATE ON live_outbound_reviews WHEN NEW.status='sent' BEGIN SELECT RAISE(IGNORE); END");
 assert.equal((await f.send(a)).status,503);assert.equal(rows(f,'live_outbound_reviews')[0].status,'dispatching');
 assert.equal(rows(f,'messages').filter(m=>m.direction==='outbound').length,0);await f.send(a);assert.equal(f.calls(),1);
});

// Genuine captured ingress, signed evidence, and the complete folder migration.
async function moveCandidate(f, action) {
 const {version}=f.DB.sqlite.prepare('SELECT version FROM case_folders WHERE case_id=?').get(f.id);
 const result=await moveFolders(f.DB,{action,cases:[{id:f.id,version}]});
 assert.equal(result.results[0].ok,true,JSON.stringify(result));
 return f.DB.sqlite.prepare('SELECT revision FROM cases WHERE id=?').get(f.id).revision;
}
function removeCandidateFolder(f) {
 f.DB.sqlite.prepare('DELETE FROM case_folder_sync WHERE case_id=?').run(f.id);
 f.DB.sqlite.prepare('DELETE FROM case_folders WHERE case_id=?').run(f.id);
}
function removeFolderSchema(f) {
 f.DB.sqlite.exec('DROP TRIGGER case_folder_initial; DROP TRIGGER case_folder_changed; DROP TRIGGER case_folder_transition; DROP TABLE case_folder_sync; DROP TABLE case_folders;');
}

test('offline candidate permits Archive only with current review and separate approval',async t=>{
 const f=await setup(t,{fullSchema:true});await f.session();
 const revision=await moveCandidate(f,'archive');
 assert.equal((await f.request(f.route('review'),{revision:1})).status,409);
 const r=await f.review(revision);
 assert.equal((await f.send(r)).status,403);assert.equal(f.calls(),0);
 const a=await f.approve(r);
 assert.equal((await (await f.send(a)).json()).status,'sent');assert.equal(f.calls(),1);
 assert.equal(rows(f,'case_folders')[0].folder,'archive');
});

test('offline approved reply cannot send from Trash or revive after Restore; fresh approval is required',async t=>{
 const f=await setup(t,{fullSchema:true});await f.session();
 const archivedRevision=await moveCandidate(f,'archive');
 const r=await f.review(archivedRevision),a=await f.approve(r);
 const immutable=rows(f,'live_outbound_reviews');
 const trashRevision=await moveCandidate(f,'trash');
 const denied=await f.request(f.route('review'),{revision:trashRevision});
 assert.equal(denied.status,409);assert.equal((await denied.json()).error,'case_trashed');
 assert.equal((await f.send(a)).status,409);assert.equal(f.calls(),0);
 const restoredRevision=await moveCandidate(f,'restore');
 assert.equal((await f.send(a)).status,409);
 assert.equal((await f.request(f.route('approve'),{intentId:r.id,approval:r.approval})).status,409);
 assert.equal((await f.request(f.route('review'),{revision:archivedRevision})).status,409);
 assert.equal(f.calls(),0);assert.deepEqual(rows(f,'live_outbound_reviews'),immutable);
 const fresh=await f.review(restoredRevision);
 assert.notEqual(fresh.id,r.id);
 assert.equal((await f.send(fresh)).status,403);
 assert.equal((await f.send({...fresh,approval:a.approval})).status,403);assert.equal(f.calls(),0);
 const approved=await f.approve(fresh);
 assert.equal((await (await f.send(approved)).json()).status,'sent');assert.equal(f.calls(),1);
 assert.deepEqual(rows(f,'live_outbound_reviews').find(i=>i.id===r.id),immutable[0]);
});

test('reserved offline review cannot be approved in Trash or after Restore',async t=>{
 const f=await setup(t,{fullSchema:true});await f.session();const r=await f.review();
 const immutable=rows(f,'live_outbound_reviews');
 await moveCandidate(f,'trash');
 const approve=()=>f.request(f.route('approve'),{intentId:r.id,approval:r.approval});
 assert.equal((await approve()).status,409);
 const revision=await moveCandidate(f,'restore');
 assert.equal((await approve()).status,409);assert.equal(f.calls(),0);
 assert.deepEqual(rows(f,'live_outbound_reviews'),immutable);
 await f.approve(await f.review(revision));assert.equal(f.calls(),0);
});

for(const phase of ['review','approve','send']) for(const missing of ['folder row','0006 schema'])
 test(`offline ${phase} fails closed without ${missing}`,async t=>{
  const f=await setup(t,{fullSchema:true});await f.session();
  const r=phase==='review'?null:await f.review();
  const a=phase==='send'?await f.approve(r):r;
  const immutable=rows(f,'live_outbound_reviews');
  if(missing==='folder row')removeCandidateFolder(f);else removeFolderSchema(f);
  const res=await f.request(f.route(phase),phase==='review'?{revision:1}:{intentId:a.id,approval:a.approval});
  assert.equal(res.status,missing==='folder row'?409:503);
  assert.equal((await res.json()).error,missing==='folder row'?'case_folder_unavailable':'folder_migration_required');
  assert.equal(f.calls(),0);assert.deepEqual(rows(f,'live_outbound_reviews'),immutable);
 });

for(const phase of ['review','approve','send']) for(const race of ['trash','trash with stale revision','missing folder row'])
 test(`atomic offline ${phase} rejects ${race} after preflight`,async t=>{
  const f=await setup(t,{fullSchema:true});await f.session();
  const r=phase==='review'?null:await f.review();
  const a=phase==='send'?await f.approve(r):r;
  const immutable=rows(f,'live_outbound_reviews');
  const prepare=f.DB.prepare.bind(f.DB);let changed=false;
  f.DB.prepare=sql=>{
   const boundary=phase==='review'?sql.startsWith('INSERT INTO live_outbound_reviews'):sql.startsWith('UPDATE live_outbound_reviews SET status=');
   if(boundary && !changed){
    changed=true;
    if(race==='missing folder row')removeCandidateFolder(f);
    else {
     // Fault injection isolates the folder predicate from revision invalidation.
     // Ordinary Trash races still exercise both 0006 triggers.
     if(race==='trash with stale revision')f.DB.sqlite.exec('DROP TRIGGER case_folder_changed');
     f.DB.sqlite.prepare("UPDATE case_folders SET folder='trash',version=version+1,invalidated_revision=(SELECT revision+1 FROM cases WHERE id=case_id) WHERE case_id=?").run(f.id);
    }
   }
   return prepare(sql);
  };
  const res=await f.request(f.route(phase),phase==='review'?{revision:1}:{intentId:a.id,approval:a.approval});
  assert.equal(changed,true);assert.equal(res.status,409);assert.equal(f.calls(),0);
  assert.deepEqual(rows(f,'live_outbound_reviews'),immutable);
  assert.equal(rows(f,'messages').filter(m=>m.direction==='outbound').length,0);
 });
