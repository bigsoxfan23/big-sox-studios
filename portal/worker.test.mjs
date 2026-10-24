import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{createWorker} from './worker.mjs';
import {createAuthenticator} from './access.mjs';
import {createWorker as createOwnerWorker} from '../owner-launchpad/src/worker.mjs';
import {fixture,epoch,envConfig,token,request,certFetch,jwk,identityClaims,resolver} from './test-support.mjs';
import {reconcileInvitation,createOfflineProjection,desiredProjection,projectAndReadback} from './projection.mjs';

const options={fetcher:certFetch,now:()=>epoch*1000,resolveVerifiedIdentity:resolver};
for(const [label,changes] of Object.entries({wrongIssuer:{iss:'https://other.cloudflareaccess.com'},wrongAudience:{aud:['owner-test']},mixedAudience:{aud:['members-test','owner-test']},expired:{exp:epoch},future:{iat:epoch+1},notYetValid:{nbf:epoch+1},missingSubject:{sub:''},badTimeType:{exp:String(epoch+600)},invalidTimes:{iat:epoch+100,exp:epoch+50}})) {
 test(`OFFLINE: signed JWT ${label} denied`,async()=>{
  const authenticate=createAuthenticator(options);
  await assert.rejects(authenticate(request(token(changes)),envConfig));
 });
}
test('OFFLINE: tampered signature, missing token, unknown key and JWKS outage deny',async()=>{
 const valid=token();
 const [a,b,c]=valid.split('.');
 const tampered=`${a}.${b}.${c[0]==='a'?'b':'a'}${c.slice(1)}`;
 for(const jwt of [tampered,'','not.a.jwt']) await assert.rejects(createAuthenticator(options)(request(jwt),envConfig));
 for(const fetcher of [async()=>{throw Error('offline');},async()=>Response.json({keys:[{...jwk,kid:'other-key'}]}),async()=>new Response(null,{status:302,headers:{Location:'https://unexpected.example.test'}}),async()=>Response.json({keys:[{...jwk,kty:'EC'}]})]) {
  await assert.rejects(createAuthenticator({...options,fetcher})(request(valid),envConfig));
 }
});
test('OFFLINE: unknown Host, workers.dev, wrong Origin, insecure transport and Host spoof denied before D1',async()=>{
 const app=createWorker(options), env={...envConfig,DB:{prepare(){throw Error('should not read');}}};
 for(const req of [request(token(),'/','https://unknown.example.test'),request(token(),'/','https://synthetic.workers.dev'),request(token(),'/','http://members.example.test'),request(token(),'/',undefined,{Host:'unknown.example.test'}),request(token(),'/',undefined,{Origin:'https://wrong.example.test'})]) {
  const response=await app.fetch(req,env); assert.equal(response.status,403); assert.match(response.headers.get('Cache-Control'),/no-store/);
 }
});
test('OFFLINE: default Worker and incomplete config remain blocked',async()=>{
 for(const config of [envConfig,{...envConfig,DB:{}},{...envConfig,ACCESS_ISSUER:''},{...envConfig,OWNER_ACCESS_AUDIENCE:'members-test'}]) {
  assert.ok((await worker.fetch(request(token(identityClaims())),config)).status>=400);
 }
 const app=createWorker(options);
 for(const config of [{...envConfig,DB:{},INVITE_SERVICE:null},{...envConfig,DB:{},PORTAL_MODE:'production'}]) assert.equal((await app.fetch(request(),config)).status,503);
});
for(const provider of ['google','otp']) test(`OFFLINE PROXY ${provider==='google'?'P1':'P2'}: uninvited ${provider} route and direct service deny without JIT`,async t=>{
 const f=await fixture(t), app=createWorker(options), env={...envConfig,DB:f.db};
 for(const path of ['/','/api/services/jellyfin']) assert.equal((await app.fetch(request(token(identityClaims(provider)),path),env)).status,403);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM members').first()).n,1);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM identities').first()).n,0);
});
test('OFFLINE PROXY P4/P5: live-session revocation and ungranted service direct URLs deny from live D1',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id), identity=await f.identity();
 await f.repo.claim(invite.id,invite.secret,identity);
 const app=createWorker(options), env={...envConfig,DB:f.db}, jwt=token(identityClaims());
 const fetchPath=path=>app.fetch(request(jwt,path),env);
 assert.equal((await fetchPath('/')).status,200);
 assert.equal((await fetchPath('/api/services/jellyfin')).status,403);
 await f.db.prepare("INSERT INTO service_grants VALUES(?,'jellyfin')").bind(id).run();
 assert.equal((await fetchPath('/api/services/jellyfin')).status,200);
 assert.equal((await fetchPath('/api/owner')).status,403);
 await f.db.prepare("UPDATE members SET role='owner' WHERE id=?").bind(id).run();
 assert.equal((await fetchPath('/api/owner')).status,200); // role change read next request
 assert.equal((await fetchPath('/api/services/palworld')).status,403); // owner also needs explicit grant
 await f.repo.revoke('owner',id);
 for(const path of ['/','/api/owner','/api/services/jellyfin']) assert.equal((await fetchPath(path)).status,403);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM service_grants WHERE member_id=?').bind(id).first()).n,0);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM revocation_tasks WHERE member_id=?').bind(id).first()).n,6);
 const audit=await f.db.prepare("SELECT action FROM audit_events WHERE member_id=? ORDER BY id DESC LIMIT 1").bind(id).first(); assert.equal(audit.action,'revoked');
});
test('OFFLINE: D1 outage fails closed on every private route',async()=>{
 const app=createWorker(options), env={...envConfig,DB:{prepare(){throw Error('synthetic database outage');}}};
 for(const path of ['/','/api/owner','/api/services/jellyfin','/unknown']) assert.equal((await app.fetch(request(token(identityClaims()),path),env)).status,403);
});
test('OFFLINE PROXY P6: owner-app JWT to members and members JWT to existing owner implementation both deny',async t=>{
 const f=await fixture(t), app=createWorker(options), env={...envConfig,DB:f.db};
 assert.equal((await app.fetch(request(token({...identityClaims(),aud:['owner-test']}),'/api/services/jellyfin'),env)).status,403);
 const owner=createOwnerWorker({fetcher:certFetch,now:()=>epoch*1000});
 const ownerEnv={ACCESS_ISSUER:envConfig.ACCESS_ISSUER,ACCESS_AUDIENCE:'owner-test',APP_ORIGIN:'https://owner.example.test',OWNER_EMAIL:'owner@example.test',MAIL_DESK_URL:'https://mail.example.test/'};
 assert.equal((await owner.fetch(request(token({email:'owner@example.test'}),'/','https://owner.example.test'),ownerEnv)).status,401);
});
test('OFFLINE: projection failures produce persisted sanitized receipts and forged/stale confirmation denies',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.repo.issue('owner',id);
 await assert.rejects(reconcileInvitation(f.repo,f.db,createOfflineProjection({failRead:true}),'owner',invite.id,epoch));
 assert.equal((await f.db.prepare('SELECT outcome FROM projection_attempts').first()).outcome,'failed-or-drift');
 await assert.rejects(f.repo.confirmProjection('owner',invite.id,{id:'forged',invitationId:invite.id,confirmed:true,verifiedAt:epoch}));
 const receipt=await projectAndReadback(f.db,f.adapter,invite.id,epoch);
 f.time(epoch+61); await assert.rejects(f.repo.confirmProjection('owner',invite.id,receipt));
 await reconcileInvitation(f.repo,f.db,f.adapter,'owner',invite.id,epoch+61);
 assert.equal((await f.db.prepare('SELECT outcome FROM projection_attempts ORDER BY id DESC LIMIT 1').first()).outcome,'confirmed');
 await f.repo.revoke('owner',id);
 const desired=await desiredProjection(f.db,epoch+61); assert.ok(!desired.some(x=>x.memberId===id));
});
