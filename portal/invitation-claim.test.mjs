import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,epoch,envConfig,token,certFetch,applySchema} from './test-support.mjs';
import {createAuthenticator} from './access.mjs';
import {createMemberDashboard} from './member-dashboard.mjs';
import {createOtpAuthenticator} from './otp-identity.mjs';
import {handleInvitationClaim} from './invitation-claim.mjs';
const config={...envConfig,OTP_CUSTOM_HOSTS:['members.example.test'],PORTAL_INVITATIONS:'enabled-12-2'};
const context=email=>({access:{aud:config.ACCESS_AUDIENCE,getIdentity:async()=>({email,idp:{type:'onetimepin'}})}});
const testSessions=new Map();
const jwt=email=>{if(!testSessions.has(email))testSessions.set(email,token({email,iat:Math.floor(Date.now()/1000)-1,nbf:Math.floor(Date.now()/1000)-1}));return testSessions.get(email);};
function request(email,path='/app/invite',extra={}) {return new Request(config.APP_ORIGIN+path,{...extra,headers:{'Cf-Access-Jwt-Assertion':jwt(email),...extra.headers}});}
async function setup(t) {
 const f=await fixture(t);await applySchema(f.db,'./migrations/0003-invitation-claim-nonces.sql');
 const app=createMemberDashboard({mountPath:'/app',now:()=>f.now()*1000,verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>f.now()*1000})});
 const env={...config,DB:f.db};
 const fetch=(r,email='person@example.test')=>app.fetch(r,env,context(email));
 async function form(email='person@example.test') {const r=await fetch(request(email),email),html=await r.text();assert.equal(r.status,200);return {csrf:/name="csrf" value="([^"]+)"/.exec(html)[1],cookie:r.headers.get('Set-Cookie').split(';')[0]};}
 async function claim(invite,session,email='person@example.test',extra={}) {return fetch(request(email,'/app/invite',{method:'POST',headers:{Origin:config.APP_ORIGIN,'Content-Type':'application/x-www-form-urlencoded',Cookie:session.cookie,...extra},body:new URLSearchParams({csrf:session.csrf,invitation:invite.id,proof:invite.secret}).toString()}),email);}
 return {...f,app,env,fetch,form,claim};
}
test('Task12.2 OTP claim is recipient-specific, atomic, audited and grants no services; replay and subsequent login',async t=>{
 const f=await setup(t),member=await f.pending(),invite=await f.ready(member);
 const wrong=await f.claim(invite,await f.form('wrong@example.test'),'wrong@example.test');assert.equal(wrong.status,403);assert.doesNotMatch(await wrong.text(),/person@example/);
 const sessions=[await f.form(),await f.form()];
 const replies=await Promise.all(sessions.map(s=>f.claim(invite,s)));assert.equal(replies.filter(r=>r.status===200).length,1);assert.equal(replies.filter(r=>[403,409].includes(r.status)).length,1);
 assert.equal((await f.db.prepare('SELECT status FROM members WHERE id=?').bind(member).first()).status,'active');
 assert.deepEqual((await f.db.prepare('SELECT provider,subject FROM identities WHERE member_id=?').bind(member).all()).results,[{provider:'otp',subject:'person@example.test'}]);
 assert.equal((await f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE artifact_id=? AND action='claimed'").bind(invite.id).first()).n,1);
 assert.equal((await f.db.prepare('SELECT count(*) AS n FROM service_grants').first()).n,0);
 assert.equal((await f.claim(invite,await f.form())).status,409);
 assert.equal((await f.fetch(request('person@example.test','/app'))).status,200);
});
test('Task12.2 invalid, blocked, canceled, expired and superseded links cannot activate; no uninvited registration',async t=>{
 const f=await setup(t),member=await f.pending(),invite=await f.ready(member);
 assert.equal((await f.claim({...invite,secret:'A'.repeat(43)},await f.form())).status,403);
 await f.repo.cancelInvitation('owner',invite.id);assert.equal((await f.claim(invite,await f.form())).status,409);
 const fresh=await f.ready(member);const newer=await f.ready(member);
 assert.equal((await f.claim(fresh,await f.form())).status,409);
 f.time(epoch+604801);assert.equal((await f.claim(newer,await f.form())).status,409);
 const expired=await f.db.prepare('SELECT status,digest FROM invitations WHERE id=?').bind(newer.id).first();assert.deepEqual(expired,{status:'expired',digest:null});
 assert.equal((await f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE artifact_id=? AND action='expired'").bind(newer.id).first()).n,1);
 assert.equal((await f.db.prepare('SELECT status FROM members WHERE id=?').bind(member).first()).status,'pending');
 assert.equal((await f.fetch(request('uninvited@example.test','/app'),'uninvited@example.test')).status,403);
});
test('Task12.2 CSRF, Origin null, session binding and unbranded identity denied',async t=>{
 const f=await setup(t),invite=await f.ready(await f.pending()),s=await f.form();
 assert.equal((await f.claim(invite,s,'person@example.test',{Origin:'null'})).status,403);
 assert.equal((await f.claim(invite,{...s,cookie:'__Host-bss-invitation-claim='+'A'.repeat(43)})).status,403);
 assert.equal((await f.claim(invite,s,'wrong@example.test')).status,403);
 await assert.rejects(handleInvitationClaim(request('person@example.test'),f.env,{provider:'otp',subject:'person@example.test',expiresAt:epoch+1000},'/app',()=>epoch));
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'delivered');
});
test('Task12.2 secret-free sign-in URL, CSP hash scoped, no secret in GET response, fallback and feature gate',async t=>{
 const f=await setup(t);const r=await f.fetch(request('person@example.test'));const html=await r.text();
 assert.match(r.headers.get('Content-Security-Policy'),/script-src 'sha256-/);assert.equal(r.headers.get('Referrer-Policy'),'same-origin');
 assert.match(html,/history.replaceState/);assert.match(html,/Private invitation code/);assert.doesNotMatch(html,/localStorage|sessionStorage|fetch\(/);
 assert.equal((await f.app.fetch(request('person@example.test'),{...f.env,PORTAL_INVITATIONS:undefined},context('person@example.test'))).status,403);
});

test('Task12.2 Owner releases only freshly projected invitations as separate code; no projection leaves blocked',async t=>{
 const f=await setup(t),member=await f.pending();f.time(Math.floor(Date.now()/1000));
 await f.db.prepare("INSERT INTO identities VALUES('otp','owner@example.test','owner',?)").bind(epoch).run();
 const {desiredProjection,projectAndReadback}=await import('./projection.mjs');
 const build=projectInvitation=>createMemberDashboard({mountPath:'/app',now:()=>f.now()*1000,verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>f.now()*1000}),projectInvitation});
 const env={...f.env,PORTAL_OWNER_CONTROLS:'enabled-12-1'},email='owner@example.test';
 async function issue(app,action='issue',previous) {
  const get=await app.fetch(request(email,'/app/manage'),env,context(email));const html=await get.text();
  const csrf=/name="csrf" value="([^"]+)"/.exec(html)[1];
  return app.fetch(request(email,'/app/manage',{method:'POST',headers:{Origin:config.APP_ORIGIN,'Content-Type':'application/x-www-form-urlencoded',Cookie:get.headers.get('Set-Cookie').split(';')[0]},body:new URLSearchParams({csrf,action,member,...(previous?{previous}:{})}).toString()}),env,context(email));
 }
 // Adapter is synthetic, injected server-side only; no browser/env flag mints receipts.
 const app=build(async(db,id,at)=>{for(const entry of await desiredProjection(db,at))await f.adapter.project(entry);return projectAndReadback(db,f.adapter,id,at);});
 const response=await issue(app);assert.equal(response.status,200);const html=await response.text();
 assert.match(html,/Sign-in link/);assert.match(html,/Private invitation code/);assert.doesNotMatch(html,/\/invite#/);
 const code=/id="claim-code" readonly>([^<]+)/.exec(html)[1],id=code.split('.')[0];
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(id).first()).status,'projected');
 assert.match(html,/Confirm private delivery/);
 const deliveryCsrf=/name="csrf" value="([^"]+)"/.exec(html)[1];
 const delivery=await app.fetch(request(email,'/app/manage',{method:'POST',headers:{Origin:config.APP_ORIGIN,'Content-Type':'application/x-www-form-urlencoded',Cookie:response.headers.get('Set-Cookie').split(';')[0]},body:new URLSearchParams({csrf:deliveryCsrf,action:'deliver',member:id}).toString()}),env,context(email));assert.equal(delivery.status,303);
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(id).first()).status,'delivered');
 const denied=await issue(build(async()=>{throw Error('no inventory');}),'reissue',id);assert.equal(denied.status,409);
 const last=await f.db.prepare('SELECT id,status FROM invitations WHERE member_id=? ORDER BY revision DESC LIMIT 1').bind(member).first();assert.equal(last.status,'blocked');
 assert.doesNotMatch(await denied.text(),new RegExp(code));
 const expiredDuringProjection=await issue(build(async()=>{f.time(epoch+700000);throw Error('readback wait');}),'reissue',last.id);
 assert.equal(expiredDuringProjection.status,409);assert.match(await expiredDuringProjection.text(),/No invitation code was released.*current invitation status/);
 f.time(Math.floor(Date.now()/1000));
});

test('Task12.2 identity collision rolls back claim, activation and audit together',async t=>{
 const f=await setup(t),member=await f.pending(),invite=await f.ready(member);
 await f.db.prepare("INSERT INTO identities VALUES('otp','person@example.test','owner',?)").bind(epoch).run();
 assert.equal((await f.claim(invite,await f.form())).status,403);
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'delivered');
 assert.equal((await f.db.prepare('SELECT status FROM members WHERE id=?').bind(member).first()).status,'pending');
 assert.equal((await f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='claimed'").first()).n,0);
});

test('Task12.2 session expiring during nonce D1 wait cannot claim',async t=>{
 const f=await setup(t),invite=await f.ready(await f.pending()),s=await f.form();
 const realPrepare=f.db.prepare.bind(f.db);
 const delayedDb={prepare(sql){const statement=realPrepare(sql);if(!sql.startsWith('UPDATE invitation_claim_nonces'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();f.time(epoch+700000);return row;}};}};}};
 const response=await f.app.fetch(request('person@example.test','/app/invite',{method:'POST',headers:{Origin:config.APP_ORIGIN,'Content-Type':'application/x-www-form-urlencoded',Cookie:s.cookie},body:new URLSearchParams({csrf:s.csrf,invitation:invite.id,proof:invite.secret}).toString()}),{...f.env,DB:delayedDb},context('person@example.test'));
 assert.equal(response.status,403);
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'delivered');
});

test('Task12.2 forged and stale receipt rejection retains blocked state; disabled delivery cannot mutate',async t=>{
 const f=await setup(t);f.time(Math.floor(Date.now()/1000));
 const {createRepository}=await import('./repository.mjs');const {desiredProjection,projectAndReadback}=await import('./projection.mjs');
 const repo=createRepository(f.db,{now:f.now,sessionExpiresAt:f.now()+1000});const invite=await repo.issue('owner',await f.pending());
 await assert.rejects(repo.confirmProjection('owner',invite.id,{id:'forged',verifiedAt:f.now(),invitationId:invite.id}));
 for(const entry of await desiredProjection(f.db,f.now()))await f.adapter.project(entry);
 const receipt=await projectAndReadback(f.db,f.adapter,invite.id,f.now());
 f.time(f.now()+61);await assert.rejects(repo.confirmProjection('owner',invite.id,receipt));
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'blocked');
 f.time(Math.floor(Date.now()/1000));const valid=await projectAndReadback(f.db,f.adapter,invite.id,f.now());await repo.confirmProjection('owner',invite.id,valid);
 await f.db.prepare("INSERT INTO identities VALUES('otp','owner@example.test','owner',?)").bind(f.now()).run();
 const env={...f.env,PORTAL_OWNER_CONTROLS:'enabled-12-1',PORTAL_INVITATIONS:undefined};
 const get=await f.app.fetch(request('owner@example.test','/app/manage'),env,context('owner@example.test'));const csrf=/name="csrf" value="([^"]+)"/.exec(await get.text())[1];
 const response=await f.app.fetch(request('owner@example.test','/app/manage',{method:'POST',headers:{Origin:config.APP_ORIGIN,'Content-Type':'application/x-www-form-urlencoded',Cookie:get.headers.get('Set-Cookie').split(';')[0]},body:new URLSearchParams({csrf,action:'deliver',member:invite.id}).toString()}),env,context('owner@example.test'));
 assert.equal(response.status,403);assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'projected');
});

test('Task12.2 DB clock rejects nonce expired during slow form even with stale JS clock',async t=>{
 const f=await setup(t),realNow=Math.floor(Date.now()/1000),staleNow=realNow-1000;
 const authenticate=createOtpAuthenticator({verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>realNow*1000}),now:()=>realNow*1000});
 const identity=await authenticate(request('person@example.test'),f.env,context('person@example.test'));
 const get=await handleInvitationClaim(request('person@example.test'),f.env,identity,'/app',()=>staleNow);
 const csrf=/name="csrf" value="([^"]+)"/.exec(await get.text())[1];
 const post=request('person@example.test','/app/invite',{method:'POST',headers:{Origin:config.APP_ORIGIN,'Content-Type':'application/x-www-form-urlencoded',Cookie:get.headers.get('Set-Cookie').split(';')[0]},body:new URLSearchParams({csrf,invitation:'synthetic',proof:'A'.repeat(43)}).toString()});
 await assert.rejects(handleInvitationClaim(post,f.env,identity,'/app',()=>staleNow));
 assert.equal((await f.db.prepare('SELECT count(*) AS n FROM invitation_claim_nonces WHERE used_at IS NOT NULL').first()).n,0);
});
