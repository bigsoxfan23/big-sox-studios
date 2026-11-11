import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createApprovedMemberAdmission} from '../../portal/approved-member-admission.mjs';
import {createRequestOnboarding} from '../../portal/request-onboarding.mjs';
import {createOtpAuthenticator} from '../../portal/otp-identity.mjs';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const memberSchemas=['portal/schema.sql','portal/migrations/0004-request-onboarding.sql','portal/migrations/0005-welcome-intents.sql','portal/migrations/0007-owner-admission-withdrawal-holds.sql'];
const at=()=>Math.floor(Date.now()/1000);
function adapter(sqlite){const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return{results:sqlite.prepare(sql).all(...args)};},async run(){return sqlite.prepare(sql).run(...args);}});return{prepare:sql=>wrap(sql),async batch(ss){sqlite.exec('BEGIN');try{for(const s of ss)await s.run();sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}
async function identity(email='friend@example.test',{clock=at,expiresAt=clock()+600,idp='onetimepin'}={}){
 const env={ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUDIENCE:'member-aud',OWNER_ACCESS_AUDIENCE:'owner-aud',APP_ORIGIN:'https://members.example.test',OTP_CUSTOM_HOSTS:['members.example.test']};
 const claims={iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUDIENCE],sub:'synthetic-access-subject',email,iat:clock()-1,exp:expiresAt};
 // Only this isolated test fixture injects already-verified Access claims.
 return createOtpAuthenticator({verifyAccess:async()=>claims,now:()=>clock()*1000})(new Request(env.APP_ORIGIN+'/app'),env,{access:{aud:env.ACCESS_AUDIENCE,getIdentity:async()=>({email,idp:{type:idp}})}});
}
async function seed(requestDb,memberDb,now,{mode='live',outcome='accepted'}={}){
 await requestDb.prepare("INSERT INTO membership_requests(id,email_hash,email,status,created_at,updated_at) VALUES('request','hash','friend@example.test','approved',?,?)").bind(now*1000,now*1000).run();
 await memberDb.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").bind(now).run();await memberDb.prepare("INSERT INTO members VALUES('friend','friend@example.test','member','pending',?)").bind(now).run();
 await memberDb.prepare("INSERT INTO member_onboarding(source_database,request_id,request_revision,member_id,actor_id,approved_at) VALUES('source','request',1,'friend','owner',?)").bind(now).run();
 await memberDb.prepare("UPDATE member_onboarding SET jellyfin_ready_at=?,jellyfin_username='synthetic-not-real',jellyfin_url='https://jellyfin.example.test/',revision=2").bind(now).run();
 // A synthetic future live-acceptance receipt, never an actual email delivery.
 await memberDb.prepare("INSERT INTO welcome_intents(id,source_database,request_id,member_id,actor_id,onboarding_revision,recipient,confirmation_digest,mode,state,created_at,updated_at) VALUES('synthetic-welcome','source','request','friend','owner',2,'friend@example.test',?,?, 'dispatching',?,?)").bind('a'.repeat(64),mode,now,now).run();
 if(outcome!=='dispatching')await memberDb.prepare('UPDATE welcome_intents SET state=?,provider_id=?').bind(outcome,outcome==='accepted'?'synthetic-provider-id':null).run();
}
async function fixture(options={}){
 const requests=new DatabaseSync(':memory:'),members=new DatabaseSync(':memory:');requests.exec(read('membership/migrations/0001_membership.sql'));for(const s of memberSchemas)members.exec(read(s));
 const clock={at:at()},requestDb=adapter(requests),memberDb=adapter(members);await seed(requestDb,memberDb,clock.at,options);
 const opts={memberDb,requestDb,sourceDatabase:'source',now:()=>clock.at};
 return{requests,members,clock,opts,api:createApprovedMemberAdmission(opts),identity:await identity('friend@example.test',{clock:()=>clock.at}),count:t=>members.prepare(`SELECT count(*) n FROM ${t}`).get().n};
}
test('approved OTP first login binds and activates once without a claim code or service grant',async()=>{
 const f=await fixture(),before=f.count('audit_events'),one=await f.api.admit(f.identity),two=await f.api.admit(f.identity);assert.equal(one.id,'friend');assert.deepEqual(two,one);assert.equal(one.role,'member');assert.equal(one.status,'active');
 assert.equal(f.count('identities'),1);assert.equal(f.count('audit_events'),before+1);assert.equal(f.count('service_grants'),0);assert.equal(f.count('invitations'),0);
 assert.equal(f.members.prepare('SELECT subject FROM identities').get().subject,'friend@example.test');assert.equal(f.members.prepare("SELECT status FROM members WHERE id='owner'").get().status,'active');
 assert.deepEqual(f.members.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('concurrent first login converges to one immutable binding, one activation audit',async()=>{
 const f=await fixture(),result=await Promise.allSettled([f.api.admit(f.identity),f.api.admit(f.identity)]);assert.ok(result.some(x=>x.status==='fulfilled'));assert.equal(f.count('identities'),1);assert.equal(f.members.prepare("SELECT count(*) n FROM audit_events WHERE action='first-approved-login'").get().n,1);
});
test('later private-note revision preserves an already approved binding without creating a second audit',async()=>{
 const f=await fixture();await f.api.admit(f.identity);const before=f.count('audit_events');f.requests.exec("UPDATE membership_requests SET owner_note='synthetic note',revision=2");assert.equal((await f.api.admit(f.identity)).id,'friend');assert.equal(f.count('identities'),1);assert.equal(f.count('audit_events'),before);
});
test('simulated success and failed, uncertain or in-flight delivery cannot authorize first login',async()=>{
 for(const config of [{mode:'simulated'},{outcome:'failed'},{outcome:'UNKNOWN'},{outcome:'dispatching'}]){const f=await fixture(config);await assert.rejects(f.api.admit(f.identity));assert.equal(f.count('identities'),0);assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');}
});
test('unapproved, cleared, mismatched and withdrawn requests deny without new identity or activation',async()=>{
 for(const update of ["status='pending'","status='rejected'","status='revoked'","status='expired'","pii_cleared_at=1","email='other@example.test'"]){const f=await fixture();f.requests.exec('UPDATE membership_requests SET '+update);await assert.rejects(f.api.admit(f.identity));assert.equal(f.count('identities'),0);}
});
test('forged and Google-like objects, exact-email mismatch, Owner and unregistered identities reject',async()=>{
 const f=await fixture();for(const who of [{provider:'otp',subject:'friend@example.test',expiresAt:at()+600},{provider:'google',subject:'friend@example.test',expiresAt:at()+600},await identity('Friend@example.test'),await identity('unknown@example.test'),await identity('owner@example.test')])await assert.rejects(f.api.admit(who));assert.equal(f.count('identities'),0);assert.equal(f.count('members'),2);
 await assert.rejects(identity('friend@example.test',{idp:'google'}));
});
test('missing readiness, changed setup revision, wrong role and revoked Member reject',async()=>{
 for(const sql of ["UPDATE member_onboarding SET jellyfin_ready_at=NULL,jellyfin_username=NULL,jellyfin_url=NULL","UPDATE member_onboarding SET revision=3","UPDATE members SET role='owner' WHERE id='friend'","UPDATE members SET role='trusted' WHERE id='friend'","UPDATE members SET status='revoked' WHERE id='friend'"]){const f=await fixture();f.members.exec(sql);await assert.rejects(f.api.admit(f.identity));assert.equal(f.count('identities'),0);}
});
test('existing provider bindings are never silently linked by contact email',async()=>{
 for(const sql of ["INSERT INTO identities VALUES('google','synthetic-google','friend',1)","INSERT INTO identities VALUES('otp','friend@example.test','owner',1)"]){const f=await fixture();f.members.exec(sql);await assert.rejects(f.api.admit(f.identity));assert.equal(f.count('identities'),1);assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');}
});
test('expired proof and SQL deadline crossing roll back first identity and activation together',async()=>{
 const f=await fixture();f.clock.at=f.identity.expiresAt;await assert.rejects(f.api.admit(f.identity));assert.equal(f.count('identities'),0);
 const g=await fixture(),before=g.count('audit_events');let reads=0;g.members.function('unixepoch',{varargs:true},()=>++reads===1?g.clock.at:g.identity.expiresAt);await assert.rejects(g.api.admit(g.identity));assert.equal(g.count('identities'),0);assert.equal(g.count('audit_events'),before);assert.equal(g.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');
});
test('failed activation audit cannot leave an unaudited active Member',async()=>{
 const f=await fixture();f.members.exec("CREATE TRIGGER fail_first_audit BEFORE INSERT ON audit_events WHEN NEW.action='first-approved-login' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");await assert.rejects(f.api.admit(f.identity));assert.equal(f.count('identities'),0);assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');
});
test('previously valid OTP session cannot bypass Member revocation or approval withdrawal',async()=>{
 for(const kind of ['member','request']){const f=await fixture();await f.api.admit(f.identity);if(kind==='member')f.members.exec("INSERT INTO revocations VALUES('synthetic-revoke','friend','owner',unixepoch('now'))");else f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");await assert.rejects(f.api.admit(f.identity));assert.equal(f.count('identities'),1);assert.equal(f.count('service_grants'),0);}
});
test('real local workerd/D1 concurrent admission, immutable audit, and stale-session revocation denial',async()=>{
 const {Miniflare,NoOpLog,convertV4MiniflareOptions}=await import('miniflare');const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'approved-admission-offline',compatibilityDate:'2026-10-14',modules:true,script:'export default {fetch(){return new Response("offline")}}',d1Databases:['REQUESTS','MEMBERS'],outboundService:()=>{throw Error('External services forbidden');}}));
 try{
  const requestDb=await mf.getD1Database('REQUESTS'),memberDb=await mf.getD1Database('MEMBERS');
  for(const [db,paths]of [[requestDb,['membership/migrations/0001_membership.sql']],[memberDb,memberSchemas]]){const probe=new DatabaseSync(':memory:');for(const p of paths)probe.exec(read(p));await db.batch(probe.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map(x=>db.prepare(x.sql)));probe.close();}
  await seed(requestDb,memberDb,at());const who=await identity(),api=createApprovedMemberAdmission({requestDb,memberDb,sourceDatabase:'source'}),results=await Promise.allSettled([api.admit(who),api.admit(who)]);assert.ok(results.some(x=>x.status==='fulfilled'));
  assert.equal((await memberDb.prepare('SELECT count(*) n FROM identities').first()).n,1);assert.equal((await memberDb.prepare("SELECT count(*) n FROM audit_events WHERE action='first-approved-login'").first()).n,1);assert.equal((await memberDb.prepare('SELECT count(*) n FROM service_grants').first()).n,0);
  await memberDb.prepare("INSERT INTO revocations VALUES('runtime-revoke','friend','owner',?)").bind(at()).run();await assert.rejects(api.admit(who));assert.equal((await memberDb.prepare('PRAGMA quick_check').first()).quick_check,'ok');assert.deepEqual((await memberDb.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});

function ownerHold(f,change={}) {
 return createRequestOnboarding({requestDb:f.opts.requestDb,memberDb:f.opts.memberDb,
  sourceDatabase:'source',actorId:'owner',expiresAt:f.clock.at+600,now:()=>f.clock.at,...change});
}
test('Owner withdrawal hold wins before first-login batch: no identity, active Member, or grant',async()=>{
 const f=await fixture(),prior=f.count('audit_events'),api=ownerHold(f);
 const batch=f.opts.memberDb.batch;
 let calls=0;
 f.opts.memberDb.batch=async statements=>{
  calls++;
  await api.holdAdmission('request',1);
  f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");
  return batch(statements);
 };
 await assert.rejects(f.api.admit(f.identity));
 assert.equal(calls,1);
 assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');
 assert.equal(f.count('identities'),0);
 assert.equal(f.count('service_grants'),0);
 assert.equal(f.members.prepare("SELECT count(*) n FROM audit_events WHERE action='first-approved-login'").get().n,0);
 assert.equal(f.count('member_approval_holds'),1);
 assert.equal(f.count('audit_events'),prior+1);
 await assert.rejects(f.api.admit(f.identity));
 assert.deepEqual(f.members.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('admission wins before Owner hold: later withdrawal preserves already active Member but blocks sessions',async()=>{
 const f=await fixture(),prior=f.count('audit_events');
 await f.api.admit(f.identity);
 await ownerHold(f).holdAdmission('request',1);
 // The hold alone must deny this still-approved request and existing OTP session.
 await assert.rejects(f.api.admit(f.identity));
 assert.equal(f.requests.prepare("SELECT status FROM membership_requests WHERE id='request'").get().status,'approved');
 assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'active');
 f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");
 assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'active');
 assert.equal(f.count('identities'),1);
 assert.equal(f.count('member_approval_holds'),1);
 assert.equal(f.count('audit_events'),prior+2);
 await assert.rejects(f.api.admit(f.identity));
 assert.equal(f.count('service_grants'),0);
});
test('non-Owner cannot create the first admission hold or mutate an approved request',async()=>{
 const f=await fixture(),prior=f.count('audit_events');
 await assert.rejects(ownerHold(f,{actorId:'friend'}).holdAdmission('request',1));
 assert.equal(f.count('member_approval_holds'),0);
 assert.equal(f.count('audit_events'),prior);
 assert.deepEqual({...f.requests.prepare("SELECT status,revision FROM membership_requests WHERE id='request'").get()},{status:'approved',revision:1});
 assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');
});
test('Owner withdrawal hold is immutable, owner-authorized, idempotent and prevents later admission',async()=>{
 const f=await fixture(),api=ownerHold(f),prior=f.count('audit_events');
 assert.deepEqual(await api.holdAdmission('request',1),{requestId:'request',held:true});
 assert.deepEqual(await api.holdAdmission('request',1),{requestId:'request',held:true});
 assert.equal(f.count('audit_events'),prior+1);
 assert.equal(f.count('member_approval_holds'),1);
 assert.throws(()=>f.members.exec("UPDATE member_approval_holds SET request_revision=3"),/immutable Owner approval hold/);
 assert.throws(()=>f.members.exec("DELETE FROM member_approval_holds"),/retain Owner approval hold/);
 await assert.rejects(ownerHold(f,{actorId:'friend'}).holdAdmission('request',1));
 await assert.rejects(ownerHold(f,{expiresAt:1}).holdAdmission('request',1));
 await assert.rejects(f.api.admit(f.identity));
 assert.equal(f.count('identities'),0);
 assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');
});
test('missing admission-hold migration fails closed, not falling back to unsafe activation',async()=>{
 const f=await fixture();
 f.members.exec('DROP TABLE member_approval_holds');
 await assert.rejects(f.api.admit(f.identity));
 assert.equal(f.count('identities'),0);
 assert.equal(f.members.prepare("SELECT status FROM members WHERE id='friend'").get().status,'pending');
});
