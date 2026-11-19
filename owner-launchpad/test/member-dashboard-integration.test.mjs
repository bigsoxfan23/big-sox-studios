import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberDashboard} from '../../portal/member-dashboard.mjs';
import {welcomeFixture,seed} from './welcome-fixture.mjs';
const origin='https://members-staging.bigsoxstudios.com';
async function fixture({mode='live'}={}){
 const f=await welcomeFixture(),id=seed(f.storage,{status:'approved'}),setup=`/membership/requests/${id}/setup`,p=await f.form(setup);
 await f.post(setup,p,{action:'start',request_revision:'1',confirm:'yes'});const linked=await f.form(setup);await f.post(setup,linked,{action:'jellyfin-ready',request_revision:'1',revision:'1',confirm:'yes',username:'synthetic',url:'https://jellyfin.example.test/'});
 const member=f.portal.prepare("SELECT id,recipient FROM members WHERE role='member'").get(),at=Math.floor(Date.now()/1000);
 // Synthetic future LIVE receipt, not an actual provider operation or grant.
 f.portal.prepare("INSERT INTO welcome_intents(id,source_database,request_id,member_id,actor_id,onboarding_revision,recipient,confirmation_digest,mode,state,created_at,updated_at) VALUES('synthetic-welcome',?,? ,?,'owner',2,?,?,?,'dispatching',?,?)").run(f.env.ONBOARDING_SOURCE_ID,id,member.id,member.recipient,'f'.repeat(64),mode,at,at);
 f.portal.exec("UPDATE welcome_intents SET state='accepted',provider_id='synthetic-provider'");
 const env={ACCESS_ISSUER:f.env.ACCESS_ISSUER,ACCESS_AUDIENCE:'member-aud',OWNER_ACCESS_AUDIENCE:'owner-aud',APP_ORIGIN:origin,OTP_CUSTOM_HOSTS:['members-staging.bigsoxstudios.com'],DB:f.env.PORTAL_DB,
  PORTAL_APPROVED_MEMBERS:'enabled-12-approved',PORTAL_SIMPLIFIED_MEMBER_UI:'enabled-12',APPROVED_REQUESTS_DB:f.storage,APPROVED_REQUESTS_ID:f.env.ONBOARDING_SOURCE_ID,APPROVED_MEMBER_DB_ID:f.env.ONBOARDING_MEMBER_DB_ID,JELLYFIN_ORIGIN:f.env.JELLYFIN_ORIGIN};
 let email=member.recipient,idp='onetimepin';const claims=()=>({iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUDIENCE],sub:'synthetic-access',email,iat:at-1,exp:at+600});
 const worker=createMemberDashboard({verifyAccess:async()=>claims(),mountPath:'/app'}),request=(path,options={})=>worker.fetch(new Request(origin+path,options),env,{access:{aud:env.ACCESS_AUDIENCE,getIdentity:async()=>({email,idp:{type:idp}})}});
 return{...f,id,member,memberEnv:env,request,setIdentity:(value,provider='onetimepin')=>{email=value;idp=provider;}};
}
test('OTP first login with approved live receipt opens Member UI without invitation code or automatic service grant',async()=>{
 const f=await fixture(),r=await f.request('/app');assert.equal(r.status,200);const html=await r.text();assert.match(html,/Welcome to the studio/);assert.match(html,/Jellyfin|Getting ready|Coming Soon/);assert.doesNotMatch(html,/Owner workspace|Manage members|Private invitation code/);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM identities').get().n,1);assert.equal(f.portal.prepare('SELECT count(*) n FROM service_grants').get().n,0);assert.equal((await f.request('/app')).status,200);assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='first-approved-login'").get().n,1);
});
test('Member direct Jellyfin link needs manual readiness and explicit grant, then revocation blocks old session',async()=>{
 const f=await fixture();await f.request('/app');assert.equal((await f.request('/app/services/jellyfin')).status,403);
 f.portal.prepare("INSERT INTO service_grants VALUES(?,'jellyfin')").run(f.member.id);const permitted=await f.request('/app/services/jellyfin');assert.equal(permitted.status,303);assert.equal(permitted.headers.get('Location'),'https://jellyfin.example.test/');
 f.portal.prepare("INSERT INTO revocations VALUES('synthetic-revoke',?,'owner',unixepoch('now'))").run(f.member.id);assert.equal((await f.request('/app')).status,403);assert.equal((await f.request('/app/services/jellyfin')).status,403);assert.equal(f.portal.prepare('SELECT count(*) n FROM identities').get().n,1);
});
test('simulated welcome, unknown email, Google IDP and source withdrawal deny admission',async()=>{
 const sim=await fixture({mode:'simulated'});assert.equal((await sim.request('/app')).status,403);assert.equal(sim.portal.prepare('SELECT count(*) n FROM identities').get().n,0);
 const f=await fixture();f.setIdentity('unknown@example.test');assert.equal((await f.request('/app')).status,403);f.setIdentity(f.member.recipient,'google');assert.equal((await f.request('/app')).status,403);f.setIdentity(f.member.recipient);
 await f.request('/app');await f.storage.prepare("UPDATE membership_requests SET status='revoked',revision=2 WHERE id=?").bind(f.id).run();assert.equal((await f.request('/app')).status,403);
});
test('unexpected query, mount, method, Owner path, missing binding or wrong pin cannot cause first activation',async()=>{
 for(const kind of ['query','mount','method','owner-path','binding','pin']){
  const f=await fixture();if(kind==='binding')delete f.memberEnv.APPROVED_REQUESTS_DB;if(kind==='pin')f.memberEnv.APPROVED_MEMBER_DB_ID='wrong';
  const path=kind==='query'?'/app?unexpected=value':kind==='mount'?'/outside':kind==='owner-path'?'/app/manage':'/app';
  const r=await f.request(path,kind==='method'?{method:'POST'}:{});assert.equal(r.status,kind==='query'?400:403);assert.equal(f.portal.prepare('SELECT count(*) n FROM identities').get().n,0);assert.equal(f.portal.prepare('SELECT status FROM members WHERE id=?').get(f.member.id).status,'pending');
 }
});
test('new flags are safe-off and preserve existing Owner dashboard authorization',async()=>{
 const f=await fixture();f.memberEnv.PORTAL_APPROVED_MEMBERS='off';assert.equal((await f.request('/app')).status,403);assert.equal(f.portal.prepare('SELECT count(*) n FROM identities').get().n,0);
 f.portal.prepare("INSERT INTO identities VALUES('otp','owner@example.test','owner',unixepoch('now'))").run();f.setIdentity('owner@example.test');f.memberEnv.PORTAL_APPROVED_MEMBERS='enabled-12-approved';const r=await f.request('/app');assert.equal(r.status,200);assert.match(await r.text(),/Owner workspace/);
});
