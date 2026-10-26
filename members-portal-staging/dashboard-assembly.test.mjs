import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createStagingDashboard,dashboardConfig} from './dashboard-assembly.mjs';
import staging from './worker.mjs';
import {fixture,epoch,envConfig,token,request,certFetch} from '../portal/test-support.mjs';

const config={...envConfig,...dashboardConfig};
const context=(changes={})=>({access:{aud:config.ACCESS_AUDIENCE,getIdentity:async()=>({email:'person@example.test',idp:{type:'onetimepin'},...changes})}});
const signed=(path='/app',changes={},origin=config.APP_ORIGIN)=>request(token({iss:config.ACCESS_ISSUER,aud:[config.ACCESS_AUDIENCE],...changes}),path,origin);
const assembly=(extra={})=>createStagingDashboard({fetcher:certFetch,now:()=>epoch*1000,...extra});
async function seed(db){
 await db.prepare("INSERT INTO members VALUES('person','person@example.test','owner','active',?)").bind(epoch).run();
 await db.prepare("INSERT INTO identities VALUES('otp','person@example.test','person',?)").bind(epoch).run();
}
async function snapshot(db){
 const tables=['members','identities','service_grants','audit_events','invitations','link_requests','revocations','projection_attempts','revocation_tasks'];
 return Promise.all(tables.map(async name=>(await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results));
}
function privateResponse(response){
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.match(response.headers.get('X-Robots-Tag'),/noindex/);
 assert.match(response.headers.get('Content-Security-Policy'),/default-src 'none'/);
}

test('original staging worker stays safe-off despite bindings and flags',async()=>{
 const response=await staging.fetch(signed(),{...config,ENABLE_PORTAL:true,PORTAL_MODE:'active'},context());
 assert.equal(response.status,503);
});

test('assembly reuses signed OTP + D1 authorization with no login writes, live roles/status/grants',async t=>{
 const {db}=await fixture(t);await seed(db);
 const app=assembly(),env={...config,DB:db};
 const get=(path='/app')=>app.fetch(signed(path),env,context());
 const before=await snapshot(db);
 let response=await get();assert.equal(response.status,200);privateResponse(response);
 const html=await response.text();assert.match(html,/<dd>Owner<\/dd>/);assert.match(html,/Services coming soon/);
 assert.doesNotMatch(html,/person@example|access-session|synthetic-only|f3ad2eeca|jellyfin|palworld/i);
 assert.match(html,/href="\/cdn-cgi\/access\/logout"/);
 const head=await app.fetch(new Request(signed(),{method:'HEAD'}),env,context());
 assert.equal(head.status,200);assert.equal(await head.text(),'');privateResponse(head);
 for(const [path,status] of [['/app/api/owner',404],['/app/unknown',404],['/app?x=1',400],['/app/services/jellyfin',403],['/app/api/services/palworld/stream',403]]){
  response=await get(path);assert.equal(response.status,status);privateResponse(response);
 }
 assert.equal((await app.fetch(new Request(signed(),{method:'POST'}),env,context())).status,405);
 assert.deepEqual(await snapshot(db),before);
 await db.prepare("INSERT INTO service_grants VALUES('person','jellyfin')").run();
 assert.equal((await get('/app/services/jellyfin')).status,404);
 await db.prepare("DELETE FROM service_grants WHERE member_id='person'").run();
 assert.equal((await get('/app/services/jellyfin')).status,403);
 for(const [role,label] of [['trusted','Trusted member'],['member','Member']]){
  await db.prepare('UPDATE members SET role=? WHERE id=?').bind(role,'person').run();
  assert.match(await (await get()).text(),new RegExp(`<dd>${label}</dd>`));
  assert.equal((await get('/app/api/owner')).status,403);
 }
 await db.prepare("UPDATE members SET status='revoked' WHERE id='person'").run();
 assert.equal((await get()).status,403);
 assert.equal((await get('/app/services/jellyfin')).status,403);
});

test('assembly pins host/issuer/audience and denies absent, mismatched or non-OTP runtime identity',async t=>{
 const {db}=await fixture(t);await seed(db);
 const app=assembly(),env={...config,DB:db};
 const before=await snapshot(db);
 for(const origin of ['https://big-sox-studios-members-staging.fridman-greg.workers.dev','https://preview.example.test','http://members-staging.bigsoxstudios.com','https://members-staging.bigsoxstudios.com:8443']){
  assert.equal((await app.fetch(signed('/app',{},origin),env,context())).status,404);
 }
 for(const changes of [{iss:envConfig.ACCESS_ISSUER},{aud:['members-test']},{aud:[config.ACCESS_AUDIENCE,'owner-test']},{exp:epoch},{email:'uninvited@example.test'}]){
  assert.equal((await app.fetch(signed('/app',changes),env,context())).status,403);
 }
 for(const ctx of [{},context({idp:{type:'google'}}),context({email:'Person@example.test'}),{access:{aud:'owner-test',getIdentity:async()=>({})}},{access:{aud:config.ACCESS_AUDIENCE,getIdentity:async()=>{throw Error('private');}}}]){
  assert.equal((await app.fetch(signed(),env,ctx)).status,403);
 }
 for(const extra of [{Host:'evil.example.test'},{Origin:'https://evil.example.test'}]){
  const req=new Request(signed(),{headers:{...Object.fromEntries(signed().headers),...extra}});
  assert.ok([403,404].includes((await app.fetch(req,env,context())).status));
 }
 // Env cannot redirect the assembly to a different issuer, audience or origin.
 const redirected={...env,...envConfig,OTP_CUSTOM_HOSTS:['members.example.test']};
 assert.equal((await app.fetch(signed('/app',{iss:envConfig.ACCESS_ISSUER,aud:['members-test']}),redirected,context())).status,403);
 assert.equal((await app.fetch(signed(),redirected,context())).status,200);
 assert.deepEqual(await snapshot(db),before);
});

test('assembly denies missing D1, unbound identity and D1 errors',async t=>{
 const {db}=await fixture(t);
 const env={...config,DB:db};
 assert.equal((await assembly().fetch(signed(),env,context())).status,403);
 await seed(db);
 assert.equal((await assembly().fetch(signed(),config,context())).status,403);
 const response=await assembly().fetch(signed(),{...env,DB:{prepare(){throw Error('private');}}},context());
 assert.equal(response.status,403);privateResponse(response);
 assert.doesNotMatch(await response.text(),/private|person@example|<dd>Owner/);
});

test('staging configs retain inert entrypoint; D1 example is existing Phase2 only',()=>{
 const active=readFileSync(new URL('./wrangler.staging.toml',import.meta.url),'utf8');
 const example=readFileSync(new URL('./wrangler.dashboard.example.toml',import.meta.url),'utf8');
 assert.match(active,/main = "worker.mjs"/);assert.doesNotMatch(active,/\[\[d1_databases\]\]/);
 assert.match(example,/main = "worker.mjs"/);
 assert.match(example,/binding = "DB"/);
 assert.match(example,/REPLACE_WITH_EXISTING_APPROVED_PHASE2_DATABASE_UUID/);
 assert.doesNotMatch(example,/21e13fa1-0ab3-4573-8d20-983c847ba0e9|migrations_dir\s*=|ENABLE_PORTAL\s*=/);
});
