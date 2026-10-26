import test from 'node:test';
import assert from 'node:assert/strict';
import defaultStaging, {createStagingWorker} from './worker.mjs';
import {createMemberDashboard} from '../portal/member-dashboard.mjs';
import {createAuthenticator} from '../portal/access.mjs';
import {fixture,epoch,envConfig,token,request,certFetch} from '../portal/test-support.mjs';

const origin='https://members-staging.bigsoxstudios.com';
const config={...envConfig,APP_ORIGIN:origin,OTP_CUSTOM_HOSTS:['members-staging.bigsoxstudios.com']};
const context=(type='onetimepin',aud=config.ACCESS_AUDIENCE,email='person@example.test')=>({access:{aud,getIdentity:async()=>({email,idp:{type}})}});
const approval=()=>({
 source:'cloudflare-effective-policy-readback',issuer:config.ACCESS_ISSUER,
 audience:config.ACCESS_AUDIENCE,origin,independentMfaRequired:true,otpIdentityShapeVerified:true,
 policyDigest:'a'.repeat(64),ownerApprovalAuditId:'synthetic-approval',ownerApprovalCount:1,
 verifiedAt:epoch,expiresAt:epoch+300
});
const signed=(path='/app',claims={},url=origin)=>request(token(claims),path,url);
const dashboard=(extra={})=>createMemberDashboard({
 verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>epoch*1000}),
 verifyActivation:async()=>approval(),now:()=>epoch*1000,mountPath:'/app',...extra
});

test('staging app is disabled by default, including if environment tries to enable it',async()=>{
 const env={...config,ENABLE_PORTAL:'true',DB:{prepare(){throw Error('no DB expected');}}};
 for(const path of ['/app','/app/api/owner','/app/services/jellyfin']){
  const response=await defaultStaging.fetch(signed(path),env,context());
  assert.equal(response.status,503); assert.match(response.headers.get('Cache-Control'),/no-store/);
 }
 const direct=await defaultStaging.fetch(signed('/app',{},'https://big-sox-studios-members-staging.fridman-greg.workers.dev'),env,context());
 assert.equal(direct.status,404);
});

test('synthetic trusted adapter mounts actual D1 Owner dashboard without JIT or exposing data',async t=>{
 const {db}=await fixture(t);
 const env={...config,DB:db};
 const app=createStagingWorker({memberApp:dashboard()});
 await db.prepare("INSERT INTO members VALUES('person','person@example.test','owner','active',?)").bind(epoch).run();
 await db.prepare("INSERT INTO identities VALUES('otp','person@example.test','person',?)").bind(epoch).run();
 const get=(path='/app',ctx=context(),claims={})=>app.fetch(signed(path,claims),env,ctx);
 let response=await get();
 assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/<dd>Owner<\/dd>/);
 assert.match(html,/Services coming soon/);
 assert.doesNotMatch(html,/person@example.test|synthetic-approval|access-session|f3ad2eeca58fc7/i);
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.equal((await get('/app/api/owner')).status,404);
 assert.equal((await get('/app/services/jellyfin')).status,403);
 assert.equal((await get('/app/api/services/palworld')).status,403);
 assert.equal((await get('/app',context('google'))).status,403);
 assert.equal((await get('/app',context('onetimepin','owner-test'))).status,403);
 assert.equal((await get('/app',context(),{aud:['owner-test']})).status,403);
 assert.equal((await get('/app',context(),{email:'other@example.test'})).status,403);
 assert.equal((await get('/app',context(),{iss:'https://other.cloudflareaccess.com'})).status,403);
 assert.equal((await get('/app?x=1')).status,400);
 assert.equal((await app.fetch(new Request(signed('/app'),{method:'POST'}),env,context())).status,405);
 await db.prepare("UPDATE members SET role='trusted' WHERE id='person'").run();
 assert.match(await (await get()).text(),/Trusted member/);
 assert.equal((await get('/app/api/owner')).status,403);
 await db.prepare("UPDATE members SET status='revoked' WHERE id='person'").run();
 assert.equal((await get()).status,403);
 assert.equal((await get('/app/services/jellyfin')).status,403);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM identities").first()).n,1);
});

test('staging app fails closed on absent attestation, missing D1, bad host and direct bypass',async t=>{
 const {db}=await fixture(t);
 const env={...config,DB:db};
 const insecure=createStagingWorker({memberApp:dashboard({verifyActivation:undefined})});
 assert.equal((await insecure.fetch(signed(),env,context())).status,503);
 const app=createStagingWorker({memberApp:dashboard()});
 assert.equal((await app.fetch(signed('/app',{},'https://big-sox-studios-members-staging.fridman-greg.workers.dev'),env,context())).status,404);
 assert.equal((await app.fetch(signed('/app',{},'https://unknown.example.test'),env,context())).status,404);
 assert.equal((await app.fetch(signed('/app',{},'http://members-staging.bigsoxstudios.com'),env,context())).status,404);
 assert.equal((await app.fetch(signed('/app'),{...config,DB:undefined},context())).status,403);
 assert.equal((await app.fetch(signed('/app'),env,context())).status,403); // uninvited
 const spoof= new Request(signed('/app'),{headers:{...Object.fromEntries(signed('/app').headers),'Host':'evil.example.test'}});
 assert.equal((await app.fetch(spoof,env,context())).status,404);
});
