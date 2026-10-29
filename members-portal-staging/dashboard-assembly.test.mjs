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

test('owner-only studio UI preview is branded, read-only and role gated',async t=>{
 const {db}=await fixture(t);await seed(db);
 const app=assembly(),env={...config,DB:db},before=await snapshot(db);
 let response=await app.fetch(signed('/app'),env,context());
 let html=await response.text();
 assert.equal(response.status,200);
 assert.match(html,/Big Sox Studios/);
 assert.match(html,/Your studio, your space/);
 assert.match(html,/name="viewport"/);
 assert.match(html,/brand\/logo\/big-sox-studios-mark.webp/);
 assert.match(html,/href="\/app\/ui-preview"/);
 assert.match(response.headers.get('Content-Security-Policy'),/img-src https:\/\/bigsoxstudios.com/);
 response=await app.fetch(signed('/app/ui-preview'),env,context());
 assert.equal(response.status,200);html=await response.text();
 assert.match(html,/Design preview only/);assert.match(html,/Invite expired/);
 assert.doesNotMatch(html,/<form|<script|person@example|ticket=/);
 assert.deepEqual(await snapshot(db),before);
 await db.prepare("UPDATE members SET role='member' WHERE id='person'").run();
 assert.equal((await app.fetch(signed('/app/ui-preview'),env,context())).status,403);
 html=await (await app.fetch(signed('/app'),env,context())).text();
 assert.doesNotMatch(html,/\/app\/ui-preview|Owner workspace/);
});

test('owner-only members view is read-only and uses current role',async t=>{
 const {db}=await fixture(t);await seed(db);
 const app=assembly(),env={...config,DB:db},before=await snapshot(db);
 let res=await app.fetch(signed('/app/manage'),env,context());
 assert.equal(res.status,200);
 const html=await res.text();
 assert.match(html,/Manage your studio/);
 assert.match(html,/person@example.test/);
 assert.match(html,/owner\.bigsoxstudios\.com\/membership\/requests\//);
 assert.match(html,/Recent activity/);
 assert.doesNotMatch(html,/<form|<script|ticket=/);
 assert.deepEqual(await snapshot(db),before);
 await db.prepare("UPDATE members SET role='member' WHERE id='person'").run();
 assert.equal((await app.fetch(signed('/app/manage'),env,context())).status,403);
 await db.prepare("UPDATE members SET role='owner',status='revoked' WHERE id='person'").run();
 assert.equal((await app.fetch(signed('/app/manage'),env,context())).status,403);
});

test('Owner member view stays available as immutable audit history grows',async t=>{
 const {db}=await fixture(t);await seed(db);
 for(let i=0;i<62;i++) await db.prepare('INSERT INTO audit_events(actor_id,member_id,action,at) VALUES(?,?,?,?)').bind('person','person','test-event',epoch+i).run();
 const app=assembly(),env={...config,DB:db};
 const before=await snapshot(db),response=await app.fetch(signed('/app/manage'),env,context());
 assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/Showing the latest 60 events/);
 assert.equal((html.match(/test-event/g)||[]).length,60);
 assert.deepEqual(await snapshot(db),before);
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


test('12.1 Owner controls stay safe-off and, when staged, use one-use D1 CSRF for pending/invite/reissue/cancel',async t=>{
 const {db}=await fixture(t);await seed(db);
 const app=assembly();
 const readonly=await app.fetch(signed('/app/manage'),{...config,DB:db},context());
 assert.equal(readonly.status,200);
 assert.equal(readonly.headers.get('Set-Cookie'),null);
 assert.doesNotMatch(await readonly.text(),/Create pending member|name="csrf"/);
 const disabledPost=await app.fetch(new Request(signed('/app/manage'),{method:'POST'}),{...config,DB:db},context());
 assert.equal(disabledPost.status,405);

 const env={...config,DB:db,PORTAL_OWNER_CONTROLS:'enabled-12-1'};
 const get=async()=> {
  const response=await app.fetch(signed('/app/manage'),env,context());
  assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Security-Policy'),/form-action 'self'/);
  const html=await response.text(),csrf=/name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  assert.ok(csrf);
  const cookie=response.headers.get('Set-Cookie');
  assert.match(cookie,/Secure; HttpOnly; SameSite=Strict/);
  return {csrf,cookie:cookie.split(';')[0],html};
 };
 const post=async(page,action,fields={},overrides={})=>{
  const initial=signed('/app/manage'),headers=new Headers(initial.headers);
  headers.set('Origin',config.APP_ORIGIN);
  headers.set('Cookie',page.cookie);
  headers.set('Content-Type','application/x-www-form-urlencoded');
  for(const [key,value] of Object.entries(overrides))headers.set(key,value);
  const req=new Request(initial,{method:'POST',headers,body:new URLSearchParams({csrf:page.csrf,action,...fields}).toString()});
  return app.fetch(req,env,context());
 };
 const count=async(table)=>Number((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n);
 const head=await app.fetch(new Request(signed('/app/manage'),{method:'HEAD'}),env,context());
 assert.equal(head.status,200);assert.equal(head.headers.get('Set-Cookie'),null);
 assert.equal(await count('owner_action_nonces'),0);

 let form=await get();
 assert.match(form.html,/Create pending member/);
 assert.equal(await count('owner_action_nonces'),1);
 assert.equal((await post(form,'create',{contact:'approved@example.test'})).status,303);
 assert.equal((await post(form,'create',{contact:'duplicate@example.test'})).status,403);
 assert.equal(await count('members'),3);
 assert.equal(await count('identities'),1);
 const pending=await db.prepare("SELECT id,status FROM members WHERE recipient='approved@example.test'").first();
 assert.equal(pending.status,'pending');

 const a=await get(),b=await get();
 const results=await Promise.all([post(a,'issue',{member:pending.id}),post(b,'issue',{member:pending.id})]);
 assert.deepEqual(results.map(x=>x.status).sort(),[303,403]);
 let rows=(await db.prepare('SELECT id,revision,status,digest FROM invitations WHERE member_id=? ORDER BY revision').bind(pending.id).all()).results;
 assert.equal(rows.length,1);assert.equal(rows[0].status,'blocked');assert.match(rows[0].digest,/^[0-9a-f]{64}$/);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM identities').first()).n,1);

 form=await get();
 assert.equal((await post(form,'reissue',{member:pending.id,previous:rows[0].id})).status,303);
 rows=(await db.prepare('SELECT id,revision,status,digest FROM invitations WHERE member_id=? ORDER BY revision').bind(pending.id).all()).results;
 assert.equal(rows.length,2);assert.equal(rows[0].status,'superseded');assert.equal(rows[0].digest,null);
 assert.equal(rows[1].status,'blocked');assert.equal(rows[1].revision,2);

 form=await get();
 assert.equal((await post(form,'cancel',{member:rows[1].id})).status,303);
 const cancelled=await db.prepare('SELECT status,digest FROM invitations WHERE id=?').bind(rows[1].id).first();
 assert.deepEqual(cancelled,{status:'revoked',digest:null});
 assert.ok(await count('audit_events')>=5);
 assert.equal(await count('service_grants'),0);
 assert.equal(await count('identities'),1);

 form=await get();
 const blocked=await post(form,'issue',{member:'person'},{'Sec-Fetch-Site':'cross-site'});
 assert.equal(blocked.status,403);
 assert.equal((await post(form,'cancel',{member:rows[1].id},{Origin:'https://cross-origin.example'})).status,403);
 assert.equal((await post(form,'issue',{member:'person'},{Cookie:''})).status,403);
 assert.equal((await post(form,'issue',{member:'person'})).status,403); // cannot invite active Owner
 const last=await get();
 assert.match(last.html,/approved@example.test/);
 assert.match(last.html,/Recent activity/);
 assert.doesNotMatch(last.html,/name="secret"|claim\?token=/);
 await db.prepare("UPDATE members SET role='member' WHERE id='person'").run();
 assert.equal((await app.fetch(signed('/app/manage'),env,context())).status,403);
});
