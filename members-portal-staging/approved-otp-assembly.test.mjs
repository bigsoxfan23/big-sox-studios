// Source contribution: Codex CLI (OpenAI coding agent), 2026-11-01.
// Synthetic only: no Access approval, provider operation or real Member action.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createApprovedOtpAssembly,approvedOtpConfig} from './approved-otp-assembly.mjs';
import staging from './worker.mjs';
import {ACCESS_ISSUER,createStagingWorker} from './worker.mjs';
import {fixture as workerdFixture,applySchema,epoch,token,request,certFetch} from '../portal/test-support.mjs';
import {d1,rows,sql} from '../portal/test/welcome-live-fixture.mjs';
import {database,seed} from '../tests/membership-fixtures.mjs';
import {createRequestOnboarding} from '../portal/request-onboarding.mjs';

const config=approvedOtpConfig,host=new URL(config.APP_ORIGIN).host;
const signed=(path='/app',claims={},origin=config.APP_ORIGIN,headers={})=>request(
 token({iss:config.ACCESS_ISSUER,aud:[config.ACCESS_AUDIENCE],...claims}),path,origin,headers);
const context=(identity={},aud=config.ACCESS_AUDIENCE)=>({access:{aud,getIdentity:async()=>({
 email:'person@example.test',idp:{type:'onetimepin'},...identity
})}});
function offline(t){
 t.mock.method(Date,'now',()=>epoch*1000);
 t.mock.method(globalThis,'fetch',async url=>{
  assert.equal(String(url),`${ACCESS_ISSUER}/cdn-cgi/access/certs`);
  return certFetch();
 });
}
const assembly=()=>createApprovedOtpAssembly({fetcher:async url=>{
 assert.equal(String(url),`${ACCESS_ISSUER}/cdn-cgi/access/certs`);return certFetch();
},now:()=>epoch*1000});
function privateResponse(response){
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.match(response.headers.get('X-Robots-Tag'),/noindex/);
 assert.match(response.headers.get('Content-Security-Policy'),/default-src 'none'/);
 assert.equal(response.headers.get('Set-Cookie'),null);
}
async function fixture(t,{mode='live',workerd=false}={}){
 offline(t);
 const requests=database();t.after(()=>requests.sqlite.close());
 let db,sqlite;
 if(workerd){
  ({db}=await workerdFixture(t));
  await applySchema(db,'./migrations/0004-request-onboarding.sql');
  await applySchema(db,'./migrations/0005-welcome-intents.sql');
  await applySchema(db,'./migrations/0007-owner-admission-withdrawal-holds.sql');
 }else{
  sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  for(const path of ['portal/schema.sql','portal/migrations/0004-request-onboarding.sql','portal/migrations/0005-welcome-intents.sql','portal/migrations/0007-owner-admission-withdrawal-holds.sql'])sqlite.exec(sql(path));
  db=d1(sqlite);
  await db.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").bind(epoch).run();
 }
 // Reuse existing onboarding code and in-memory integration fixture adapters.
 seed(requests,{id:'request',hash:'synthetic-hash',status:'approved',email:'person@example.test'});
 const onboarding=createRequestOnboarding({memberDb:db,requestDb:requests,sourceDatabase:config.APPROVED_REQUESTS_ID,
  actorId:'owner',expiresAt:epoch+600,now:()=>epoch,jellyfinOrigin:'https://jellyfin.example.test'});
 const member=(await onboarding.link('request',1)).member_id;
 await onboarding.markJellyfinReady('request',1,{expectedRevision:1,confirmed:true,username:'synthetic',url:'https://jellyfin.example.test/'});
 // Future LIVE receipt is inserted locally, never sent or asserted as real.
 await db.prepare(`INSERT INTO welcome_intents(id,source_database,request_id,member_id,actor_id,onboarding_revision,
  recipient,confirmation_digest,mode,state,created_at,updated_at)
  VALUES('synthetic-welcome',?,'request',?,'owner',2,'person@example.test',?,?,'dispatching',?,?)`)
  .bind(config.APPROVED_REQUESTS_ID,member,'f'.repeat(64),mode,epoch,epoch).run();
 await db.prepare("UPDATE welcome_intents SET state='accepted',provider_id='synthetic-provider'").run();
 const env={...config,OTP_CUSTOM_HOSTS:[host],DB:db,APPROVED_REQUESTS_DB:requests,JELLYFIN_ORIGIN:'https://jellyfin.example.test'};
 const snapshot=async()=>{
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' ORDER BY name").all()).results;
  return [await Promise.all(tables.map(async({name})=>[name,(await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results])),rows(requests.sqlite)];
 };
 return {env,db,requests,member,snapshot,app:assembly()};
}

test('every exact assembly gate is mandatory, before JWT/runtime identity/D1 or mutation; no invite fallback',async t=>{
 const f=await fixture(t),before=await f.snapshot();let reads=0;
 const app=createApprovedOtpAssembly({fetcher:()=>{reads++;throw Error('must not authenticate');}});
 const ctx={access:{aud:config.ACCESS_AUDIENCE,getIdentity:()=>{reads++;throw Error('must not read identity');}}};
 const changes=[];
 for(const [key,value] of Object.entries(config)){
  changes.push({[key]:undefined},{[key]:`${value} `});
 }
 changes.push({APP_ORIGIN:'https://preview.example.test'},{ACCESS_ISSUER:'https://other.cloudflareaccess.com'},
  {ACCESS_AUDIENCE:config.OWNER_ACCESS_AUDIENCE},{OWNER_ACCESS_AUDIENCE:config.ACCESS_AUDIENCE},
  {OTP_CUSTOM_HOSTS:undefined},{OTP_CUSTOM_HOSTS:host},{OTP_CUSTOM_HOSTS:[]},
  {OTP_CUSTOM_HOSTS:[host,'preview.example.test']},{OTP_CUSTOM_HOSTS:['*.bigsoxstudios.com']},
  {DB:undefined},{DB:config.APPROVED_MEMBER_DB_ID},{DB:{}},{DB:{prepare(){}}},
  {APPROVED_REQUESTS_DB:undefined},{APPROVED_REQUESTS_DB:config.APPROVED_REQUESTS_ID},
  {APPROVED_REQUESTS_DB:{}},{APPROVED_REQUESTS_DB:{prepare(){}}},{DB:f.db,APPROVED_REQUESTS_DB:f.db});
 const trap={prepare(){reads++;throw Error('D1 before gate');},batch(){reads++;throw Error('D1 before gate');}};
 for(const patch of changes){
  const env={...f.env,DB:trap,APPROVED_REQUESTS_DB:{...trap},...patch,PORTAL_INVITATIONS:'enabled-12-2'};
  for(const path of ['/app','/app/invite']){
   const r=await app.fetch(signed(path),env,ctx);assert.equal(r.status,503,JSON.stringify(patch));privateResponse(r);
  }
 }
 assert.equal(reads,0);assert.deepEqual(await f.snapshot(),before);
 const head=await app.fetch(new Request(signed(),{method:'HEAD'}),{},ctx);
 assert.equal(head.status,503);assert.equal(await head.text(),'');
});

test('exact custom host only, no public route, alias, workers.dev or hostile Origin',async t=>{
 const f=await fixture(t),before=await f.snapshot();
 for(const origin of ['https://big-sox-studios-members-staging.fridman-greg.workers.dev','https://bigsoxstudios.com',
  'https://preview.example.test','http://'+host,'https://'+host+':8443']){
  for(const path of ['/app','/app/services/jellyfin'])assert.equal((await f.app.fetch(signed(path,{},origin),f.env,context())).status,404);
 }
 for(const [headers,status] of [[{Host:'evil.example.test'},404],[{Origin:'https://evil.example.test'},403],[{Origin:'null'},403]]){
  assert.equal((await f.app.fetch(signed('/app',{},config.APP_ORIGIN,headers),f.env,context())).status,status);
 }
 assert.deepEqual(await f.snapshot(),before);
});

test('flags never replace signed JWT and exact runtime OTP identity',async t=>{
 const f=await fixture(t),before=await f.snapshot();
 for(const claims of [{iss:'https://other.cloudflareaccess.com'},{aud:[config.OWNER_ACCESS_AUDIENCE]},
  {aud:[config.ACCESS_AUDIENCE,config.OWNER_ACCESS_AUDIENCE]},{exp:epoch},{iat:epoch+1},
  {email:'unknown@example.test'},{sub:''}]){
  assert.equal((await f.app.fetch(signed('/app',claims),f.env,context())).status,403);
 }
 for(const ctx of [{},context({},config.OWNER_ACCESS_AUDIENCE),context({idp:{type:'google'}}),context({email:'Person@example.test'}),
  {access:{aud:config.ACCESS_AUDIENCE,getIdentity:async()=>{throw Error('private');}}}]){
  assert.equal((await f.app.fetch(signed(),f.env,ctx)).status,403);
 }
 const jwt=signed().headers.get('Cf-Access-Jwt-Assertion'),parts=jwt.split('.');
 parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
 for(const jwtValue of [null,'invalid',parts.join('.')]){
  const headers=jwtValue?{'Cf-Access-Jwt-Assertion':jwtValue}:{};
  const r=await f.app.fetch(new Request(config.APP_ORIGIN+'/app',{headers}),f.env,context());assert.equal(r.status,403);privateResponse(r);
 }
 assert.deepEqual(await f.snapshot(),before);
});

for(const workerd of [false,true])test(`synthetic approved LIVE OTP first login and repeat checks (${workerd?'workerd D1':'SQLite D1 adapter'})`,async t=>{
 const f=await fixture(t,{workerd}),get=(path='/app')=>f.app.fetch(signed(path),f.env,context());
 const r=await get();assert.equal(r.status,200);privateResponse(r);
 const html=await r.text();assert.match(html,/Welcome to the studio/);assert.doesNotMatch(html,/Owner workspace|Private invitation code|Manage members/);
 const count=async table=>(await f.db.prepare(`SELECT count(*) n FROM ${table}`).first()).n;
 assert.equal(await count('identities'),1);assert.equal(await count('service_grants'),0);
 assert.equal((await f.db.prepare('SELECT status FROM members WHERE id=?').bind(f.member).first()).status,'active');
 const after=await f.snapshot();assert.equal((await get()).status,200);assert.deepEqual(await f.snapshot(),after);
 assert.equal((await f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='first-approved-login'").first()).n,1);
 assert.equal((await get('/app/services/jellyfin')).status,403);
 // Existing session observes source approval withdrawal on its next request.
 await f.requests.prepare("UPDATE membership_requests SET status='revoked',revision=2 WHERE id='request'").run();
 assert.equal((await get()).status,403);assert.equal((await get('/app/services/jellyfin')).status,403);
 // Member revocation also denies that same signed session independently.
 await f.requests.prepare("UPDATE membership_requests SET status='approved',revision=3 WHERE id='request'").run();
 await f.db.prepare("INSERT INTO revocations VALUES('synthetic-revoke',?,'owner',?)").bind(f.member,epoch).run();
 assert.equal((await get()).status,403);assert.equal((await get('/app/services/jellyfin')).status,403);
 assert.equal(await count('identities'),1);assert.equal(await count('service_grants'),0);
});

for(const workerd of [false,true])test(`simulation-only welcome cannot activate or admit an existing binding (${workerd?'workerd D1':'SQLite D1 adapter'})`,async t=>{
 const f=await fixture(t,{mode:'simulated',workerd}),before=await f.snapshot();
 for(const path of ['/app','/app/services/jellyfin','/app/invite'])assert.equal((await f.app.fetch(signed(path),f.env,context())).status,403);
 assert.deepEqual(await f.snapshot(),before);
 await f.db.prepare("INSERT INTO identities VALUES('otp','person@example.test',?,?)").bind(f.member,epoch).run();
 await f.db.prepare("UPDATE members SET status='active' WHERE id=?").bind(f.member).run();
 const bound=await f.snapshot();
 assert.equal((await f.app.fetch(signed(),f.env,context())).status,403);
 assert.deepEqual(await f.snapshot(),bound);
});
test('invalid first-login path/method and D1 failures remain private and do not activate',async t=>{
 const f=await fixture(t),before=await f.snapshot();
 for(const [path,method,status] of [['/app?unexpected=value','GET',400],['/app/manage','GET',403],['/app/invite','GET',403],['/app','POST',403]]){
  assert.equal((await f.app.fetch(new Request(signed(path),{method}),f.env,context())).status,status);
 }
 for(const key of ['DB','APPROVED_REQUESTS_DB']){
  const r=await f.app.fetch(signed(),{...f.env,[key]:{prepare(){throw Error('private D1 failure');},batch(){throw Error('private');}}},context());
  assert.equal(r.status,403);privateResponse(r);assert.doesNotMatch(await r.text(),/private D1|person@example/);
 }
 assert.deepEqual(await f.snapshot(),before);
});

test('legacy defaults/configs unchanged; root and prior Owner diagnostic still use original worker',async t=>{
 const f=await fixture(t),before=await f.snapshot(),original=createStagingWorker();
 assert.equal((await staging.fetch(signed(),f.env,context())).status,503);
 for(const [path,extra,ctx] of [['/',{},context()],['/owner/identity-check',{},context()],
  ['/owner/identity-check',{DIAGNOSTIC_OWNER_EMAIL:'person@example.test'},context()]]){
  const req=signed(path),env={...f.env,...extra},a=await f.app.fetch(req,env,ctx),b=await original.fetch(req,env,ctx);
  assert.equal(a.status,b.status);
  if(path==='/')assert.equal(await a.text(),await b.text());
  else {
   const html=await a.text();assert.match(html,/Not found|Identity field check/);
   if(a.status===200)assert.match(html,/mfaEvidenceEstablished<\/dt><dd>false/);
  }
 }
 assert.deepEqual(await f.snapshot(),before);
 for(const file of ['wrangler.staging.toml','wrangler.owner-release.toml','wrangler.dashboard.example.toml']){
  assert.doesNotMatch(readFileSync(new URL(file,import.meta.url),'utf8'),/approved-otp-assembly|PORTAL_APPROVED_OTP_ASSEMBLY/);
 }
});
