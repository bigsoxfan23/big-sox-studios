import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequestOnboarding} from '../../portal/request-onboarding.mjs';
import {createWelcomeReview} from '../../portal/welcome-review.mjs';
import {createWelcomeDelivery,simulatedWelcomeProvider} from '../../portal/welcome-delivery.mjs';
const schemas=['membership/migrations/0001_membership.sql','portal/schema.sql','portal/migrations/0004-request-onboarding.sql','portal/migrations/0005-welcome-intents.sql'];
const content={message:'Welcome, synthetic friend!',password:'synthetic-only-secret'};
function adapter(sqlite){const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return{results:sqlite.prepare(sql).all(...args)};},async run(){return sqlite.prepare(sql).run(...args);}});return{prepare:sql=>wrap(sql),async batch(ss){sqlite.exec('BEGIN');try{for(const s of ss)await s.run();sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}
async function fixture(options={}){
 const requests=new DatabaseSync(':memory:'),members=new DatabaseSync(':memory:'),at=Math.floor(Date.now()/1000),clock={at};
 requests.exec(readFileSync(new URL('../../'+schemas[0],import.meta.url),'utf8'));for(const path of schemas.slice(1))members.exec(readFileSync(new URL('../../'+path,import.meta.url),'utf8'));
 members.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").run(at);
 requests.prepare("INSERT INTO membership_requests(id,email_hash,email,status,created_at,updated_at) VALUES('request','hash','friend@example.test','approved',?,?)").run(at*1000,at*1000);
 const memberDb=adapter(members),onboarding=createRequestOnboarding({requestDb:adapter(requests),memberDb,sourceDatabase:'source',actorId:'owner',expiresAt:at+600,jellyfinOrigin:'https://jellyfin.example.test',now:()=>clock.at});
 await onboarding.link('request',1);await onboarding.markJellyfinReady('request',1,{expectedRevision:1,confirmed:true,username:'friend',url:'https://jellyfin.example.test/'});
 const review=createWelcomeReview({onboarding,actorId:'owner',sessionBinding:'s'.repeat(64),signingKey:'k'.repeat(64),expiresAt:at+600,jellyfinOrigin:'https://jellyfin.example.test',memberLoginUrl:'https://members.example.test/app',now:()=>clock.at});
 const opts={memberDb,onboarding,review,sourceDatabase:'source',actorId:'owner',expiresAt:at+600,now:()=>clock.at,...options};
 const api=createWelcomeDelivery(opts),preview=await review.preview('request',1,content),confirmation={review:preview.review,confirmed:true};
 return {requests,members,memberDb,onboarding,review,opts,api,clock,confirmation,send:()=>api.send('request',1,content,confirmation),count:t=>members.prepare(`SELECT count(*) n FROM ${t}`).get().n};
}
test('simulated delivery records durable secret-free intent/audit, never activates or grants',async()=>{
 const f=await fixture(),result=await f.send();assert.equal(result.state,'accepted');assert.equal(result.mode,'simulated');assert.equal(result.activated,false);assert.equal(result.delivered,false);
 assert.equal(f.count('welcome_intents'),1);assert.equal(f.count('audit_events'),4);
 assert.equal(f.members.prepare("SELECT status FROM members WHERE role='member'").get().status,'pending');for(const t of ['identities','invitations','service_grants'])assert.equal(f.count(t),0);
 const stored=JSON.stringify(f.members.prepare('SELECT * FROM welcome_intents').all())+JSON.stringify(f.members.prepare('SELECT * FROM audit_events').all());assert.ok(!stored.includes(content.password));assert.ok(!stored.includes(content.message));assert.ok(!stored.includes(f.confirmation.review));
 assert.equal((await f.api.status('request',1))[0].state,'accepted');await assert.rejects(f.send());assert.equal(f.count('welcome_intents'),1);
});
test('concurrent confirmed submissions dispatch exactly once',async()=>{
 let calls=0;const f=await fixture({provider:async({intentId})=>{calls++;return{state:'accepted',providerId:'mock-'+intentId};}});
 const results=await Promise.allSettled([f.send(),f.send()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls,1);assert.equal(f.count('welcome_intents'),1);
});
for(const outcome of ['UNKNOWN','throw'])test(`${outcome} locks retry without activating`,async()=>{
 const f=await fixture({provider:simulatedWelcomeProvider({outcome})});assert.equal((await f.send()).state,'UNKNOWN');await assert.rejects(f.send());assert.equal(f.count('welcome_intents'),1);
});
test('definite provider refusal allows a fresh explicitly confirmed attempt, never automatic retry',async()=>{
 let calls=0;const f=await fixture({provider:async({intentId})=>{calls++;return calls===1?{state:'failed'}:{state:'accepted',providerId:'mock-'+intentId};}});assert.equal((await f.send()).state,'failed');assert.equal(calls,1);
 await assert.rejects(f.send());assert.equal(calls,1);
 const original=f.confirmation.review;f.confirmation.review='0'+original;await assert.rejects(f.send());assert.equal(calls,1);
 f.confirmation.review=(await f.review.preview('request',1,content)).review;
 assert.equal((await f.send()).state,'accepted');assert.equal(calls,2);assert.equal(f.count('welcome_intents'),2);assert.equal((await f.api.status('request',1))[0].state,'accepted');
});
test('timeout and malformed provider acceptance lock UNKNOWN; no provider content is persisted',async()=>{
 for(const provider of [()=>new Promise(()=>{}),async()=>({state:'accepted',providerId:'real-or-untrusted-id'}),async()=>null]){
  const f=await fixture({provider,timeoutMs:5});assert.equal((await f.send()).state,'UNKNOWN');await assert.rejects(f.send());
 }
});
test('lost completion write leaves durable dispatch lock and refuses another transport',async()=>{
 let calls=0;const f=await fixture({provider:async({intentId})=>{calls++;return{state:'accepted',providerId:'mock-'+intentId};}});
 f.members.exec("CREATE TRIGGER lose_finish BEFORE UPDATE ON welcome_intents BEGIN SELECT RAISE(ABORT,'synthetic write loss'); END;");await assert.rejects(f.send());assert.equal(f.members.prepare('SELECT state FROM welcome_intents').get().state,'dispatching');await assert.rejects(f.send());assert.equal(calls,1);
});
test('proof, request withdrawal, Owner revoke and SQL deadline fail before any provider call',async()=>{
 for(const kind of ['proof','withdrawal','owner','deadline']){
  let calls=0;const f=await fixture({provider:async()=>{calls++;return{state:'UNKNOWN'};}});
  if(kind==='proof')f.confirmation.confirmed=false;if(kind==='withdrawal')f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");if(kind==='owner')f.members.exec("UPDATE members SET status='revoked' WHERE id='owner'");if(kind==='deadline')f.members.function('unixepoch',{varargs:true},()=>f.opts.expiresAt);
  await assert.rejects(f.send());assert.equal(calls,0);assert.equal(f.count('welcome_intents'),0);
 }
});
test('durable metadata cannot be edited, deleted or falsely finalized twice',async()=>{
 const f=await fixture();await f.send();for(const sql of ["DELETE FROM welcome_intents","UPDATE welcome_intents SET state='failed',provider_id=NULL","UPDATE welcome_intents SET recipient='other@example.test'"])assert.throws(()=>f.members.exec(sql));assert.deepEqual(f.members.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('live mode cannot be enabled by constructor/configuration',async()=>{
 const f=await fixture();assert.throws(()=>createWelcomeDelivery({...f.opts,mode:'live'}));
});
test('review deadline crossing after confirmation or at SQL claim cannot dispatch',async()=>{
 for(const phase of ['after-confirm','sql-claim','after-claim']){
  let calls=0;const f=await fixture({provider:async()=>{calls++;return{state:'UNKNOWN'};}}),base=f.clock.at,until=base+300;
  f.clock.at=until-1;let reads=0;
  const onboarding={async read(...args){const row=await f.onboarding.read(...args);reads++;if((phase==='after-confirm'&&reads===1)||(phase==='after-claim'&&reads===2))f.clock.at=until;return row;}};
  if(phase==='sql-claim')f.members.function('unixepoch',{varargs:true},()=>until);
  const api=createWelcomeDelivery({...f.opts,onboarding});
  if(phase==='after-claim'){const r=await api.send('request',1,content,f.confirmation);assert.equal(r.state,'failed');assert.equal(f.count('welcome_intents'),1);}
  else{await assert.rejects(api.send('request',1,content,f.confirmation));assert.equal(f.count('welcome_intents'),0);}
  assert.equal(calls,0,phase);
 }
});
test('actual workerd/D1 claim, one-use failure retry, UNKNOWN lock and audits keep all credentials transient',async()=>{
 const {Miniflare,NoOpLog,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'welcome-runtime',compatibilityDate:'2026-10-14',modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['REQUESTS','MEMBERS'],outboundService:()=>{throw Error('External services forbidden');}}));
 try{
  const requestDb=await mf.getD1Database('REQUESTS'),memberDb=await mf.getD1Database('MEMBERS'),probe=new Map([[requestDb,{sqlite:new DatabaseSync(':memory:'),seen:new Set()}],[memberDb,{sqlite:new DatabaseSync(':memory:'),seen:new Set()}]]);
  for(const [db,paths]of [[requestDb,schemas.slice(0,1)],[memberDb,schemas.slice(1)]])for(const path of paths){
   const p=probe.get(db);p.sqlite.exec(readFileSync(new URL('../../'+path,import.meta.url),'utf8'));
   const objects=p.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().filter(x=>!p.seen.has(x.name));
   await db.batch(objects.map(x=>db.prepare(x.sql)));objects.forEach(x=>p.seen.add(x.name));
  }
  const at=Math.floor(Date.now()/1000);await memberDb.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").bind(at).run();
  for(const [id,email]of [['request','friend@example.test'],['unknown','unknown@example.test']])await requestDb.prepare("INSERT INTO membership_requests(id,email_hash,email,status,created_at,updated_at) VALUES(?,?,?,'approved',?,?)").bind(id,id,email,at*1000,at*1000).run();
  const onboarding=createRequestOnboarding({requestDb,memberDb,sourceDatabase:'source',actorId:'owner',expiresAt:at+600,jellyfinOrigin:'https://jellyfin.example.test'});
  for(const id of ['request','unknown']){await onboarding.link(id,1);await onboarding.markJellyfinReady(id,1,{expectedRevision:1,confirmed:true,username:'synthetic',url:'https://jellyfin.example.test/'});}
  const review=createWelcomeReview({onboarding,actorId:'owner',sessionBinding:'s'.repeat(64),signingKey:'k'.repeat(64),expiresAt:at+600,jellyfinOrigin:'https://jellyfin.example.test',memberLoginUrl:'https://members.example.test/app'});
  let calls=0;const api=createWelcomeDelivery({memberDb,onboarding,review,sourceDatabase:'source',actorId:'owner',expiresAt:at+600,provider:async({intentId})=>++calls===1?{state:'failed'}:{state:'accepted',providerId:'mock-'+intentId}});
  let proof=(await review.preview('request',1,content)).review;assert.equal((await api.send('request',1,content,{review:proof,confirmed:true})).state,'failed');await assert.rejects(api.send('request',1,content,{review:proof,confirmed:true}));assert.equal(calls,1);
  proof=(await review.preview('request',1,content)).review;const outcomes=await Promise.allSettled([api.send('request',1,content,{review:proof,confirmed:true}),api.send('request',1,content,{review:proof,confirmed:true})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls,2);
  const unknown=createWelcomeDelivery({memberDb,onboarding,review,sourceDatabase:'source',actorId:'owner',expiresAt:at+600,provider:simulatedWelcomeProvider({outcome:'UNKNOWN'})}),up=(await review.preview('unknown',1,content)).review;
  assert.equal((await unknown.send('unknown',1,content,{review:up,confirmed:true})).state,'UNKNOWN');await assert.rejects(unknown.send('unknown',1,content,{review:(await review.preview('unknown',1,content)).review,confirmed:true}));
  const stored=JSON.stringify((await memberDb.prepare('SELECT * FROM welcome_intents').all()).results)+JSON.stringify((await memberDb.prepare('SELECT * FROM audit_events').all()).results);assert.ok(!stored.includes(content.password));assert.ok(!stored.includes(content.message));assert.ok(!stored.includes(proof));
  assert.equal((await memberDb.prepare("SELECT count(*) n FROM members WHERE role='member' AND status='pending'").first()).n,2);for(const t of ['identities','invitations','service_grants'])assert.equal((await memberDb.prepare(`SELECT count(*) n FROM ${t}`).first()).n,0);
  assert.equal((await memberDb.prepare('PRAGMA quick_check').first()).quick_check,'ok');assert.deepEqual((await memberDb.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});
