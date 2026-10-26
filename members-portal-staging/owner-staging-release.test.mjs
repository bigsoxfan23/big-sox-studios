import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createOwnerStagingRelease,phase2DatabaseId} from './owner-staging-release.mjs';
import {dashboardConfig} from './dashboard-assembly.mjs';
import {applySchema,epoch,envConfig,token,request,certFetch} from '../portal/test-support.mjs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {b64} from '../portal/access.mjs';

const jwt=()=>token({iss:dashboardConfig.ACCESS_ISSUER,aud:[dashboardConfig.ACCESS_AUDIENCE]});
const session=(path='/owner/enroll',origin=dashboardConfig.APP_ORIGIN)=>request(jwt(),path,origin);
const context=(type='onetimepin')=>({access:{aud:dashboardConfig.ACCESS_AUDIENCE,getIdentity:async()=>({idp:{type},email:'person@example.test'})}});
const app=()=>createOwnerStagingRelease({fetcher:certFetch,now:()=>epoch*1000});
const count=async(db,table)=>(await db.prepare('SELECT COUNT(*) AS n FROM '+table).first()).n;
async function setup(t){
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'task12-owner-release',modules:true,
  script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-24',
  d1Databases:{DB:'empty-task12-release'},outboundService:()=>{throw Error('no network');}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await applySchema(db);await applySchema(db,'./migrations/0001-first-owner-bootstrap.sql');
 const env={...envConfig,DB:db,PORTAL_MODE:'staging-enrollment-source',BOOTSTRAP_DATABASE_ID:phase2DatabaseId,
  DIAGNOSTIC_OWNER_EMAIL:'person@example.test',
  OWNER_ENROLLMENT_NONCE:b64(crypto.getRandomValues(new Uint8Array(32))),
  OWNER_ENROLLMENT_HMAC_KEY:b64(crypto.getRandomValues(new Uint8Array(32)))};
 return {db,env};
}

test('staging release preserves original Phase1 without enrollment secrets',async()=>{
 const response=await app().fetch(session('/'),{},context());
 assert.equal(response.status,403); // No real signed Cloudflare token; original Worker denies.
 const failed=await app().fetch(session(),{},context());
 assert.equal(failed.status,503);
 assert.match(failed.headers.get('Cache-Control'),/no-store/);
});

test('first Owner requires a real user click; same OTP session binds atomic D1 and D1 authorizes dashboard',async t=>{
 const {db,env}=await setup(t);
 const candidate=app();
 const first=await candidate.fetch(session(),env,context());
 assert.equal(first.status,200);
 assert.equal(await count(db,'members'),0);
 assert.equal(await count(db,'first_owner_bootstrap'),0);
 const markup=await first.text();
 const ticket=markup.match(/name="ticket" value="([^"]+)"/)?.[1];
 assert.ok(ticket);
 const cookie=first.headers.get('Set-Cookie').split(';')[0];
 const post=new Request(session(),{method:'POST',headers:{
  'Cf-Access-Jwt-Assertion':jwt(),
  'Content-Type':'application/x-www-form-urlencoded',
  Cookie:cookie,Origin:dashboardConfig.APP_ORIGIN,
  'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document','Sec-Fetch-User':'?1'
 },body:new URLSearchParams({ticket,decision:'confirm-first-owner'}).toString()});
 const repeat=post.clone();
 const success=await candidate.fetch(post,env,context());
 assert.equal(success.status,200);
 assert.equal(await count(db,'members'),1);
 assert.equal(await count(db,'identities'),1);
 assert.equal(await count(db,'first_owner_bootstrap'),1);
 assert.equal(await count(db,'audit_events'),1);
 assert.equal((await candidate.fetch(repeat,env,context())).status,403); // D1 singleton makes replay noncommittable
 const dashboard=await candidate.fetch(session('/app'),env,context());
 assert.equal(dashboard.status,200);
 assert.match(await dashboard.text(),/<dd>Owner<\/dd>/);
 const retired={...env,OWNER_ENROLLMENT_HMAC_KEY:undefined,OWNER_ENROLLMENT_NONCE:undefined};
 assert.equal((await candidate.fetch(session('/app'),retired,context())).status,200);
 assert.equal((await candidate.fetch(session('/owner/enroll'),retired,context())).status,503);

 await db.prepare("UPDATE members SET status='revoked'").run();
 assert.equal((await candidate.fetch(session('/app'),env,context())).status,403);
});

test('release denies wrong identity, host, secret, and absent D1',async t=>{
 const {db,env}=await setup(t);const candidate=app();
 assert.equal((await candidate.fetch(session(),env,context('google'))).status,403);
 assert.equal((await candidate.fetch(session('/owner/enroll','https://big-sox-studios-members-staging.fridman-greg.workers.dev'),env,context())).status,403);
 assert.equal((await candidate.fetch(session(),{...env,DB:undefined},context())).status,503);
 assert.equal((await candidate.fetch(session(),{...env,OWNER_ENROLLMENT_HMAC_KEY:'bad'},context())).status,503);
 assert.equal((await candidate.fetch(session(),{...env,BOOTSTRAP_DATABASE_ID:'wrong'},context())).status,503);
 assert.equal(await count(db,'members'),0);
});

test('one release instance reuses Access signing keys but checks current D1 roles each time',async t=>{
 const {db,env}=await setup(t);
 await db.prepare("INSERT INTO members VALUES('owner','person@example.test','owner','active',?)").bind(epoch).run();
 await db.prepare("INSERT INTO identities VALUES('otp','person@example.test','owner',?)").bind(epoch).run();
 let keyFetches=0;
 const candidate=createOwnerStagingRelease({now:()=>epoch*1000,fetcher:async(...args)=>{keyFetches++;return certFetch(...args);}});
 assert.equal((await candidate.fetch(session('/app'),env,context())).status,200);
 assert.equal((await candidate.fetch(session('/app'),env,context())).status,200);
 assert.equal(keyFetches,1);
 await db.prepare("UPDATE members SET status='revoked'").run();
 assert.equal((await candidate.fetch(session('/app'),env,context())).status,403);
 assert.equal(keyFetches,1);
});

test('release config pins existing separate Owner Access audience and exact Phase2 D1',()=>{
 const settings=readFileSync(new URL('./wrangler.owner-release.toml',import.meta.url),'utf8');
 const ownerConfig=readFileSync(new URL('../owner-launchpad/wrangler.production.toml',import.meta.url),'utf8');
 const value=/^ACCESS_AUDIENCE = "([^"]+)"$/m.exec(ownerConfig)?.[1];
 assert.ok(value);assert.notEqual(value,dashboardConfig.ACCESS_AUDIENCE);
 assert.match(settings,new RegExp('^OWNER_ACCESS_AUDIENCE = "'+value+'"$', 'm'));
 assert.match(settings,/binding = "DB"/);
 assert.match(settings,new RegExp('database_id = "'+phase2DatabaseId+'"'));
 assert.doesNotMatch(settings,/bss-membership-requests|migrations_dir/);
});
