import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createIdentityAuthenticator} from '../../portal/identity.mjs';
import {simplifiedMemberDashboard,loadSimplifiedMember} from '../../portal/simplified-member-dashboard.mjs';
import {prepareMemberRemoval,executeMemberRemoval,manualJellyfinReminder} from '../src/member-removal.mjs';
const clock=()=>Math.floor(Date.now()/1000),origin='https://owner.example.test',jellyfinOrigin='https://jellyfin.example.test';
const jwt='a'.repeat(90)+'.claims.signature';
const sourceSql=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
function adapter(sqlite) {
 const stmt=(sql,args=[])=>({bind(...v){return stmt(sql,v);},async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){const r=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:r.changes}};}});
 return {prepare:sql=>stmt(sql)};
}
async function branded({provider='google',subject='google-member',email='friend@example.test',expiresAt=clock()+600}={}) {
 return createIdentityAuthenticator({authenticate:async()=>({sub:'access-subject',exp:expiresAt}),resolveVerifiedIdentity:async()=>({accessSubject:'access-subject',emailVerified:true,stableSubjectVerified:true,mfaVerified:true,provider,subject,email,expiresAt})})(new Request('https://members.example.test/'),{});
}
function fixture({memberStatus='active'}={}) {
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(sourceSql('portal/schema.sql'));sqlite.exec(sourceSql('portal/migrations/0004-request-onboarding.sql'));
 sqlite.prepare("INSERT INTO members VALUES('owner','greg@example.test','owner','active',?)").run(clock());
 sqlite.prepare("INSERT INTO members VALUES('friend','friend@example.test','member',?,?)").run(memberStatus,clock());
 sqlite.prepare("INSERT INTO members VALUES('other','other@example.test','member','pending',?)").run(clock());
 sqlite.prepare("INSERT INTO identities VALUES('google','google-member','friend',?)").run(clock());
 const db=adapter(sqlite),get=new Request(origin+'/membership/members/friend/remove',{headers:{'Cf-Access-Jwt-Assertion':jwt}});
 return{sqlite,db,get,expiresAt:clock()+600,count:table=>sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n};
}
function post(prepared,change={}) {
 const body=new URLSearchParams({csrf:prepared.csrf,member:prepared.memberId,confirm:'yes',...(change.fields||{})});
 return new Request(origin+'/membership/members/friend/remove',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded','Cf-Access-Jwt-Assertion':jwt,Cookie:prepared.cookie.split(';')[0],...(change.headers||{})},body});
}
function ready(f,{grant=true,url=jellyfinOrigin+'/'}={}) {
 f.sqlite.prepare("INSERT INTO member_onboarding(source_database,request_id,request_revision,member_id,actor_id,approved_at) VALUES('source','request',1,'friend','owner',?)").run(clock());
 f.sqlite.prepare("UPDATE member_onboarding SET jellyfin_ready_at=?,jellyfin_username='friend',jellyfin_url=?,revision=2").run(clock(),url);
 if(grant)f.sqlite.exec("INSERT INTO service_grants VALUES('friend','jellyfin')");
}
test('branded active Member dashboard shows only manually ready, explicitly granted Jellyfin and no Owner controls',async()=>{
 const f=fixture();ready(f);const html=await simplifiedMemberDashboard(f.db,await branded(),{jellyfinOrigin});
 assert.ok(html.includes('Welcome to the studio'));assert.ok(html.includes('Open Jellyfin'));assert.ok(html.includes('separate Jellyfin username and password'));
 assert.ok(html.includes('Coming Soon'));assert.ok(!html.includes('Owner workspace'));assert.ok(!html.includes('/manage'));assert.ok(!html.includes('Temporary password'));
 assert.ok(html.includes(jellyfinOrigin+'/'));
});
test('active membership alone and readiness without a grant never expose a Jellyfin link',async()=>{
 for(const config of [null,{grant:false}]){const f=fixture();if(config)ready(f,config);const m=await loadSimplifiedMember(f.db,await branded(),{jellyfinOrigin});assert.equal(m.jellyfinReady,false);assert.equal(m.jellyfinURL,null);}
});
test('grant without manual readiness never exposes a service link',async()=>{
 const f=fixture();f.sqlite.exec("INSERT INTO service_grants VALUES('friend','jellyfin')");const html=await simplifiedMemberDashboard(f.db,await branded(),{jellyfinOrigin});assert.ok(!html.includes('Open Jellyfin'));assert.ok(html.includes('Getting ready'));
});
test('forged identities, wrong exact recipient and Owner identities cannot use the Member-only surface',async()=>{
 const f=fixture();await assert.rejects(loadSimplifiedMember(f.db,{provider:'google',subject:'google-member',email:'friend@example.test',expiresAt:clock()+600},{jellyfinOrigin}));
 await assert.rejects(loadSimplifiedMember(f.db,await branded({email:'Friend@example.test'}),{jellyfinOrigin}));
 await assert.rejects(loadSimplifiedMember(f.db,await branded({provider:'apple'}),{jellyfinOrigin}));
 f.sqlite.prepare("INSERT INTO identities VALUES('google','google-owner','owner',?)").run(clock());await assert.rejects(loadSimplifiedMember(f.db,await branded({subject:'google-owner',email:'greg@example.test'}),{jellyfinOrigin}));
});
test('pending, revoked, trusted and unbound identities fail closed',async()=>{
 const pending=fixture({memberStatus:'pending'});await assert.rejects(loadSimplifiedMember(pending.db,await branded(),{jellyfinOrigin}));
 for(const change of ["UPDATE members SET status='revoked' WHERE id='friend'","UPDATE members SET role='trusted' WHERE id='friend'"]){const f=fixture();f.sqlite.exec(change);await assert.rejects(loadSimplifiedMember(f.db,await branded(),{jellyfinOrigin}));}
 const f=fixture();await assert.rejects(loadSimplifiedMember(f.db,await branded({subject:'not-bound'}),{jellyfinOrigin}));
});
test('expired or deadline-crossing identities fail even if the D1 read began while valid',async()=>{
 const f=fixture(),at=clock();await assert.rejects(loadSimplifiedMember(f.db,await branded({expiresAt:at}),{jellyfinOrigin,now:()=>at}));
 let reads=0;await assert.rejects(loadSimplifiedMember(f.db,await branded({expiresAt:at+1}),{jellyfinOrigin,now:()=>reads++===0?at:at+1}));
});
test('unsafe service URLs never appear in a granted-ready dashboard',async()=>{
 for(const url of ['https://evil.example.test/','http://jellyfin.example.test/','https://user:password@jellyfin.example.test/','https://jellyfin.example.test/?password=secret','https://jellyfin.example.test/#secret']){const f=fixture();ready(f,{url});await assert.rejects(loadSimplifiedMember(f.db,await branded(),{jellyfinOrigin}));}
});
test('confirmed removal uses existing revocation audit/tasks and immediately denies an old identity on its next request',async()=>{
 const f=fixture();ready(f);const identity=await branded();await loadSimplifiedMember(f.db,identity,{jellyfinOrigin});
 const prepared=await prepareMemberRemoval(f.db,f.get,'owner','friend',f.expiresAt),out=await executeMemberRemoval(f.db,post(prepared),'owner',f.expiresAt,{appOrigin:origin});
 assert.equal(out.status,'revoked');assert.equal(out.reminder,manualJellyfinReminder);assert.ok(out.reminder.includes('manually'));assert.ok(out.reminder.includes('does not revoke Jellyfin'));
 assert.equal(f.count('revocations'),1);assert.equal(f.count('service_grants'),0);assert.equal(f.count('identities'),1);assert.ok(f.count('revocation_tasks')>0);
 assert.throws(()=>f.sqlite.exec("UPDATE members SET status='active' WHERE id='friend'"));assert.equal(f.count('members'),3);
 assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE id='owner'").get().status,'active');await assert.rejects(loadSimplifiedMember(f.db,identity,{jellyfinOrigin}));
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE action='revoked'").get().n,1);
 assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.sqlite.prepare('PRAGMA quick_check').get().quick_check,'ok');
 await assert.rejects(executeMemberRemoval(f.db,post(prepared),'owner',f.expiresAt,{appOrigin:origin}));assert.equal(f.count('revocations'),1);
});
test('confirmed removal also closes a synthetic pending Member without identity or service activation',async()=>{
 const f=fixture(),p=await prepareMemberRemoval(f.db,f.get,'owner','other',f.expiresAt);
 const out=await executeMemberRemoval(f.db,post(p),'owner',f.expiresAt,{appOrigin:origin});assert.equal(out.status,'revoked');
 assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE id='other'").get().status,'revoked');assert.equal(f.count('identities'),1);assert.equal(f.count('service_grants'),0);assert.equal(f.count('revocations'),1);
});
test('removal refuses Owner, self, trusted role, revoked target or non-Owner actor',async()=>{
 for(const [actor,target]of [['owner','owner'],['friend','owner'],['friend','other']]){const f=fixture();await assert.rejects(prepareMemberRemoval(f.db,f.get,actor,target,f.expiresAt));assert.equal(f.count('revocations'),0);}
 for(const sql of ["UPDATE members SET role='trusted' WHERE id='friend'","UPDATE members SET status='revoked' WHERE id='friend'"]){const f=fixture();f.sqlite.exec(sql);await assert.rejects(prepareMemberRemoval(f.db,f.get,'owner','friend',f.expiresAt));}
});
test('missing confirmation, CSRF, wrong Origin/Host/session and extra fields reject removal without mutation',async()=>{
 const changes=[{fields:{confirm:'no'}},{fields:{csrf:'bad'}},{fields:{unexpected:'value'}},{headers:{Origin:'https://evil.example.test'}},{headers:{Host:'evil.example.test'}},{headers:{'Sec-Fetch-Site':'cross-site'}},{headers:{Cookie:''}},{headers:{'Cf-Access-Jwt-Assertion':'b'.repeat(90)+'.claims.signature'}}];
 for(const change of changes){const f=fixture(),p=await prepareMemberRemoval(f.db,f.get,'owner','friend',f.expiresAt);await assert.rejects(executeMemberRemoval(f.db,post(p,change),'owner',f.expiresAt,{appOrigin:origin}));assert.equal(f.count('revocations'),0);assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE id='friend'").get().status,'active');}
});
test('removal nonce is bound to exact target and cannot revoke another regular Member',async()=>{
 const f=fixture(),p=await prepareMemberRemoval(f.db,f.get,'owner','friend',f.expiresAt);
 await assert.rejects(executeMemberRemoval(f.db,post(p,{fields:{member:'other'}}),'owner',f.expiresAt,{appOrigin:origin}));assert.equal(f.count('revocations'),0);
});
test('Owner revocation and session expiry after form preparation prevent removal',async()=>{
 for(const kind of ['owner','expiry']){const f=fixture(),p=await prepareMemberRemoval(f.db,f.get,'owner','friend',f.expiresAt);if(kind==='owner')f.sqlite.exec("UPDATE members SET status='revoked' WHERE id='owner'");await assert.rejects(executeMemberRemoval(f.db,post(p),'owner',f.expiresAt,{appOrigin:origin,now:kind==='expiry'?()=>f.expiresAt:clock}));assert.equal(f.count('revocations'),0);}
});
test('SQL deadline crossing after nonce consumption does not revoke a Member',async()=>{
 const f=fixture(),at=clock(),deadline=at+10,p=await prepareMemberRemoval(f.db,f.get,'owner','friend',deadline);
 let calls=0;f.sqlite.function('unixepoch',{varargs:true},()=>++calls<=2?at:deadline);
 await assert.rejects(executeMemberRemoval(f.db,post(p),'owner',deadline,{appOrigin:origin,now:()=>at}));assert.equal(f.count('revocations'),0);assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE id='friend'").get().status,'active');
});
test('concurrent duplicate removal submissions create one revocation and one audit',async()=>{
 const f=fixture(),p=await prepareMemberRemoval(f.db,f.get,'owner','friend',f.expiresAt);
 const results=await Promise.allSettled([executeMemberRemoval(f.db,post(p),'owner',f.expiresAt,{appOrigin:origin}),executeMemberRemoval(f.db,post(p),'owner',f.expiresAt,{appOrigin:origin})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.count('revocations'),1);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE action='revoked'").get().n,1);
});
test('real local workerd/D1 nonce consumption and existing revocation triggers deny a previously authorized dashboard',async()=>{
 const {Miniflare,NoOpLog,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'member-experience-offline',compatibilityDate:'2026-10-14',modules:true,script:'export default {fetch(){return new Response("offline")}}',d1Databases:['MEMBERS'],outboundService:()=>{throw Error('External services forbidden');}}));
 try{
  const db=await mf.getD1Database('MEMBERS'),probe=new DatabaseSync(':memory:');
  probe.exec(sourceSql('portal/schema.sql'));probe.exec(sourceSql('portal/migrations/0004-request-onboarding.sql'));
  const objects=probe.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();await db.batch(objects.map(x=>db.prepare(x.sql)));probe.close();
  const at=clock();await db.batch([db.prepare("INSERT INTO members VALUES('owner','greg@example.test','owner','active',?)").bind(at),db.prepare("INSERT INTO members VALUES('friend','friend@example.test','member','active',?)").bind(at),db.prepare("INSERT INTO identities VALUES('google','google-member','friend',?)").bind(at)]);
  const identity=await branded();await loadSimplifiedMember(db,identity,{jellyfinOrigin});
  const get=new Request(origin+'/membership/members/friend/remove',{headers:{'Cf-Access-Jwt-Assertion':jwt}}),p=await prepareMemberRemoval(db,get,'owner','friend',at+600);
  const results=await Promise.allSettled([executeMemberRemoval(db,post(p),'owner',at+600,{appOrigin:origin}),executeMemberRemoval(db,post(p),'owner',at+600,{appOrigin:origin})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await db.prepare('SELECT count(*) n FROM revocations').first()).n,1);
  await assert.rejects(loadSimplifiedMember(db,identity,{jellyfinOrigin}));assert.equal((await db.prepare("SELECT count(*) n FROM audit_events WHERE action='revoked'").first()).n,1);
  assert.equal((await db.prepare('SELECT count(*) n FROM service_grants').first()).n,0);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 }finally{await mf.dispose();}
});
