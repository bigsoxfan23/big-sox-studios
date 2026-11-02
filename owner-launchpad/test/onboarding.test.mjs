import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequestOnboarding} from '../../portal/request-onboarding.mjs';
const at=()=>Math.floor(Date.now()/1000);
function adapter(sqlite) {
 let tail=Promise.resolve();
 const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:r.changes}};}});
 return {prepare:sql=>wrap(sql),batch(statements){const task=tail.then(async()=>{sqlite.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}});tail=task.catch(()=>{});return task;}};
}
function fixture() {
 const requests=new DatabaseSync(':memory:'),members=new DatabaseSync(':memory:');
 requests.exec(readFileSync(new URL('../../membership/migrations/0001_membership.sql',import.meta.url),'utf8'));
 members.exec(readFileSync(new URL('../../portal/schema.sql',import.meta.url),'utf8'));
 members.exec(readFileSync(new URL('../../portal/migrations/0004-request-onboarding.sql',import.meta.url),'utf8'));
 members.prepare("INSERT INTO members VALUES('owner','greg@example.test','owner','active',?)").run(at());
 requests.prepare("INSERT INTO membership_requests(id,email_hash,name,email,status,created_at,updated_at) VALUES('request','hash','Synthetic','new@example.test','approved',?,?)").run(at()*1000,at()*1000);
 const opts={requestDb:adapter(requests),memberDb:adapter(members),sourceDatabase:'synthetic-source',actorId:'owner',expiresAt:at()+600,jellyfinOrigin:'https://jellyfin.example.test'};
 return {requests,members,opts,api:createRequestOnboarding(opts),count:table=>members.prepare(`SELECT count(*) AS n FROM ${table}`).get().n};
}
// Exercise real schema transitions, including retained superseded history.
function invite(f,{id='legacy-current',memberId='legacy',recipient='new@example.test',issuer='owner',createdAt=at()-10,deliver=true}={}) {
 const previous=f.members.prepare('SELECT id,revision FROM invitations WHERE member_id=? ORDER BY revision DESC LIMIT 1').get(memberId);
 f.members.prepare(`INSERT INTO invitations(id,member_id,recipient,issuer_id,revision,predecessor_id,digest,created_at,expires_at,changed_at,actor_id,status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,'blocked')`).run(id,memberId,recipient,issuer,(previous?.revision??0)+1,previous?.id??null,(previous?'b':'a').repeat(64),createdAt,createdAt+604800,createdAt,issuer);
 if(deliver){
  f.members.prepare("UPDATE invitations SET status='projected',projection_receipt='synthetic',projected_at=?,changed_at=? WHERE id=?").run(createdAt,createdAt,id);
  f.members.prepare("UPDATE invitations SET status='delivered',delivery_channel='owner-private-channel',delivered_at=?,changed_at=? WHERE id=?").run(createdAt,createdAt,id);
 }
 return id;
}
function legacyFixture() {
 const f=fixture();
 f.members.prepare("INSERT INTO members VALUES('legacy','new@example.test','member','pending',?)").run(at()-20);
 invite(f,{id:'legacy-history',createdAt:at()-20});invite(f);
 return f;
}
function beforeBatch(f,change) {
 const batch=f.opts.memberDb.batch;
 f.opts.memberDb.batch=statements=>{change();return batch(statements);};
}
test('approved request creates exactly one pending regular Member and auditable link; retries converge',async()=>{
 const f=fixture();const one=await f.api.link('request',1),two=await f.api.link('request',1);
 assert.equal(one.member_id,two.member_id);assert.equal(one.role,'member');assert.equal(one.status,'pending');
 assert.equal(f.count('members'),2);assert.equal(f.count('member_onboarding'),1);assert.equal(f.count('audit_events'),1);
 for(const table of ['identities','invitations','service_grants'])assert.equal(f.count(table),0);
 assert.equal(f.requests.prepare('SELECT count(*) n FROM audit_events').get().n,1);
});
test('concurrent retries converge without duplicate member or audit',async()=>{
 const f=fixture();const results=await Promise.all([f.api.link('request',1),f.api.link('request',1)]);
 assert.equal(results[0].member_id,results[1].member_id);assert.equal(f.count('members'),2);assert.equal(f.count('audit_events'),1);
});
for(const status of ['pending','rejected','revoked','expired'])test(`request status ${status} refuses onboarding without writes`,async()=>{
 const f=fixture();f.requests.prepare('UPDATE membership_requests SET status=?').run(status);await assert.rejects(f.api.link('request',1));assert.equal(f.count('members'),1);assert.equal(f.count('audit_events'),0);
});
test('wrong Owner role, inactive Owner, stale revision, expired session, cleared PII all fail closed',async()=>{
 for(const kind of ['role','revoked','revision','expiry','cleared']){
  const f=fixture();let revision=1;
  if(kind==='role')f.members.exec("UPDATE members SET role='member' WHERE id='owner'");
  if(kind==='revoked')f.members.exec("UPDATE members SET status='revoked' WHERE id='owner'");
  if(kind==='revision')revision=2;
  if(kind==='expiry')f.api=createRequestOnboarding({...f.opts,expiresAt:1});
  if(kind==='cleared')f.requests.exec('UPDATE membership_requests SET pii_cleared_at=1');
  await assert.rejects(f.api.link('request',revision));assert.equal(f.count('members'),1);assert.equal(f.count('audit_events'),0);
 }
});
test('never adopts Owner, active, revoked or uninvited existing contact; collisions roll back',async()=>{
 for(const [recipient,role,status]of [['new@example.test','owner','active'],['new@example.test','member','pending'],['new@example.test','member','active'],['new@example.test','member','revoked'],['NEW@example.test','member','pending']]){
  const f=fixture();f.members.prepare('INSERT INTO members VALUES(?,?,?,?,?)').run('other',recipient,role,status,at());
  await assert.rejects(f.api.link('request',1));assert.equal(f.count('members'),2);assert.equal(f.count('member_onboarding'),0);
 }
});
test('audit failure rolls back pending member and link together',async()=>{
 const f=fixture();f.members.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test'); END;");
 await assert.rejects(f.api.link('request',1));assert.equal(f.count('members'),1);assert.equal(f.count('member_onboarding'),0);
});
test('note revision can advance while stable approved linkage is preserved; withdrawn request denies readiness',async()=>{
 const f=fixture();const one=await f.api.link('request',1);
 f.requests.exec("UPDATE membership_requests SET owner_note='note',revision=2");
 assert.equal((await f.api.read('request',2)).member_id,one.member_id);await assert.rejects(f.api.read('request',1));
 f.requests.exec("UPDATE membership_requests SET status='revoked',revision=3");await assert.rejects(f.api.read('request',3));
 assert.equal(f.members.prepare('SELECT status FROM members WHERE id=?').get(one.member_id).status,'pending');
});
test('manual Jellyfin readiness is confirmed, CAS guarded, audited, and never activates website access',async()=>{
 const f=fixture();await f.api.link('request',1);
 const input={expectedRevision:1,confirmed:true,username:'friend',url:'https://jellyfin.example.test/',allowedOrigin:'https://jellyfin.example.test'};
 const row=await f.api.markJellyfinReady('request',1,input);assert.equal(row.revision,2);assert.ok(row.jellyfin_ready_at);assert.equal(row.status,'pending');
 assert.equal(f.count('audit_events'),2);for(const table of ['identities','invitations','service_grants'])assert.equal(f.count(table),0);
 await assert.rejects(f.api.markJellyfinReady('request',1,input));
 assert.deepEqual(f.members.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('manual readiness rejects wrong origin, embedded credentials/query, unconfirmed and stale actions',async()=>{
 for(const change of [{confirmed:false},{expectedRevision:2},{username:'line\ncontrol'},{url:'http://jellyfin.example.test/'},{url:'https://evil.example.test/'},{url:'https://friend:secret@jellyfin.example.test/'},{url:'https://jellyfin.example.test/?password=secret'}]){
  const f=fixture();await f.api.link('request',1);await assert.rejects(f.api.markJellyfinReady('request',1,{expectedRevision:1,confirmed:true,username:'friend',url:'https://jellyfin.example.test/',allowedOrigin:'https://jellyfin.example.test',...change}));assert.equal(f.count('audit_events'),1);
 }
});

test('SQL deadline crossing during transaction rolls back pending member and audit link',async()=>{
 const f=fixture(),t=at();let reads=0;
 f.members.function('unixepoch',{varargs:true},()=>++reads===1?t:t+1);
 const api=createRequestOnboarding({...f.opts,expiresAt:t+1,now:()=>t});
 await assert.rejects(api.link('request',1));assert.equal(f.count('members'),1);assert.equal(f.count('member_onboarding'),0);assert.equal(f.count('audit_events'),0);
});
test('real local workerd/D1 creates idempotent audited pending links and manual readiness without grants',async()=>{
 const {Miniflare,NoOpLog,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'onboarding-offline',compatibilityDate:'2026-10-14',modules:true,script:'export default {fetch(){return new Response("offline")}}',d1Databases:['REQUESTS','MEMBERS'],outboundService:()=>{throw Error('External services forbidden');}}));
 try{
  const requestDb=await mf.getD1Database('REQUESTS'),memberDb=await mf.getD1Database('MEMBERS');
  const probes=new Map([[requestDb,{sqlite:new DatabaseSync(':memory:'),seen:new Set()}],[memberDb,{sqlite:new DatabaseSync(':memory:'),seen:new Set()}]]);
  for(const [database,path]of [[requestDb,'membership/migrations/0001_membership.sql'],[memberDb,'portal/schema.sql'],[memberDb,'portal/migrations/0004-request-onboarding.sql']]){
   const sql=readFileSync(new URL('../../'+path,import.meta.url),'utf8');
   // SQLite itself parses complete trigger bodies, including nested CASE END.
   const probe=probes.get(database);probe.sqlite.exec(sql);
   const objects=probe.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().filter(x=>!probe.seen.has(x.name));
   await database.batch(objects.map(x=>database.prepare(x.sql)));
   for(const x of objects)probe.seen.add(x.name);
  }
  await memberDb.prepare("INSERT INTO members VALUES('owner','greg@example.test','owner','active',?)").bind(at()).run();
  await requestDb.prepare("INSERT INTO membership_requests(id,email_hash,email,status,created_at,updated_at) VALUES('runtime','hash','runtime@example.test','approved',?,?)").bind(at()*1000,at()*1000).run();
  const api=createRequestOnboarding({requestDb,memberDb,sourceDatabase:'isolated-runtime',actorId:'owner',expiresAt:at()+600,jellyfinOrigin:'https://jellyfin.example.test'});
  const one=await api.link('runtime',1),two=await api.link('runtime',1);assert.equal(one.member_id,two.member_id);
  const ready=await api.markJellyfinReady('runtime',1,{expectedRevision:1,confirmed:true,username:'runtime',url:'https://jellyfin.example.test/'});
  assert.equal(ready.status,'pending');assert.equal((await memberDb.prepare('SELECT count(*) n FROM audit_events').first()).n,2);
  for(const table of ['identities','invitations','service_grants'])assert.equal((await memberDb.prepare(`SELECT count(*) n FROM ${table}`).first()).n,0);
 }finally{await mf.dispose();}
});

test('approved exact-email unclaimed delivered legacy invitation reuses existing pending Member and retires claim code',async()=>{
 const f=legacyFixture(),before=f.count('audit_events');
 const first=await f.api.link('request',1),again=await f.api.link('request',1);
 assert.equal(first.member_id,'legacy');assert.equal(again.member_id,'legacy');
 assert.equal(first.status,'pending');assert.equal(f.count('members'),2);
 assert.equal(f.count('member_onboarding'),1);
 assert.equal(f.count('audit_events'),before+2); // onboarding link and retired invitation
 assert.equal(f.members.prepare("SELECT status FROM invitations WHERE id='legacy-current'").get().status,'superseded');
 assert.equal(f.members.prepare("SELECT digest FROM invitations WHERE id='legacy-current'").get().digest,null);
 assert.equal(f.members.prepare("SELECT COUNT(*) n FROM invitations WHERE member_id='legacy' AND status IN ('blocked','projected','delivered')").get().n,0);
 for(const t of ['identities','service_grants','revocations','revocation_tasks'])assert.equal(f.count(t),0);
 assert.deepEqual(f.members.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('concurrent approved legacy linkage converges to one reused member without active invitation',async()=>{
 const f=legacyFixture(),before=f.count('audit_events');
 const result=await Promise.all([f.api.link('request',1),f.api.link('request',1)]);
 assert.deepEqual(result.map(x=>x.member_id),['legacy','legacy']);
 assert.equal(f.count('members'),2);assert.equal(f.count('member_onboarding'),1);
 assert.equal(f.count('audit_events'),before+2);
 assert.equal(f.members.prepare("SELECT COUNT(*) n FROM invitations WHERE member_id='legacy' AND status='delivered'").get().n,0);
});

test('legacy candidate refuses pending identity with claimed or ineligible invitation and leaves no onboarding link',async()=>{
 for(const kind of ['superseded','future-clock','bound-identity','other-onboarding','inactive-owner','wrong-issuer']){
  const f=legacyFixture();
  if(kind==='superseded')f.members.prepare("UPDATE invitations SET status='superseded',digest=NULL,changed_at=?,actor_id='owner' WHERE id='legacy-current'").run(at());
  if(kind==='future-clock')f.api=createRequestOnboarding({...f.opts,now:()=>at()+604900,expiresAt:at()+605000});
  if(kind==='bound-identity')f.members.prepare("INSERT INTO identities(provider,subject,member_id,bound_at) VALUES('otp','legacy-claimed','legacy',?)").run(at());
  if(kind==='other-onboarding')f.members.prepare("INSERT INTO member_onboarding(source_database,request_id,request_revision,member_id,actor_id,approved_at) VALUES('other-source','other-request',1,'legacy','owner',?)").run(at());
  if(kind==='inactive-owner')f.members.prepare("UPDATE members SET status='revoked' WHERE id='owner'").run();
  if(kind==='wrong-issuer'){
   f.members.prepare("INSERT INTO members VALUES('outsider','outsider@example.test','owner','active',?)").run(at());
   invite(f,{id:'other-owner-current',issuer:'outsider'});
  }
  await assert.rejects(f.api.link('request',1),undefined,kind);
  assert.equal(f.members.prepare("SELECT COUNT(*) n FROM member_onboarding WHERE request_id='request'").get().n,0,kind);
  assert.equal(f.count('members'),kind==='wrong-issuer'?3:2,kind);
 }
});

test('legacy adoption fails closed if identity is bound after request precheck but before atomic batch',async()=>{
 const f=legacyFixture();
 beforeBatch(f,()=>f.members.prepare("INSERT INTO identities(provider,subject,member_id,bound_at) VALUES('otp','race','legacy',?)").run(at()));
 await assert.rejects(f.api.link('request',1));
 assert.equal(f.count('member_onboarding'),0);
 assert.equal(f.members.prepare("SELECT status FROM invitations WHERE id='legacy-current'").get().status,'delivered');
});

test('legacy expiry crossing between onboarding INSERT and invite retirement still clears old claim',async()=>{
 const f=legacyFixture();let clock=at();
 // SQLite evaluates unixepoch('now') per statement; simulate crossing the
 // historical invitation expiry after linking but before its retirement.
 f.members.function('unixepoch',{varargs:true},()=>clock);
 const batch=f.opts.memberDb.batch;
 f.opts.memberDb.batch=statements=>batch(statements.map((stmt,index)=>index===2?{
  run(){clock+=604900;return stmt.run();}
 }:stmt));
 const linked=await f.api.link('request',1);
 assert.equal(linked.member_id,'legacy');
 assert.equal(f.count('member_onboarding'),1);
 const oldCode=f.members.prepare("SELECT status,digest FROM invitations WHERE id='legacy-current'").get();
 assert.equal(oldCode.status,'superseded');assert.equal(oldCode.digest,null);
 assert.equal(f.count('service_grants'),0);assert.equal(f.count('identities'),0);
 assert.deepEqual(f.members.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('legacy invitation transition failure rolls back onboarding and audit atomically',async()=>{
 const f=legacyFixture(),before=f.count('audit_events');
 f.members.exec("CREATE TRIGGER test_block_invitation_retirement BEFORE UPDATE ON invitations WHEN NEW.status='superseded' BEGIN SELECT RAISE(ABORT,'block retirement'); END;");
 await assert.rejects(f.api.link('request',1));
 assert.equal(f.count('member_onboarding'),0);assert.equal(f.count('audit_events'),before);
 assert.equal(f.members.prepare("SELECT status FROM invitations WHERE id='legacy-current'").get().status,'delivered');
});
