import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {createAuthenticator} from './access.mjs';
import {createOtpAuthenticator} from './otp-identity.mjs';
import {createMemberDashboard} from './member-dashboard.mjs';
import {fixture,epoch,envConfig,token,request,certFetch,jwk,applySchema} from './test-support.mjs';

const config={...envConfig,OTP_CUSTOM_HOSTS:['members.example.test']};
const ctx=(email='person@example.test',type='onetimepin',aud=config.ACCESS_AUDIENCE)=>({access:{aud,getIdentity:async()=>({email,idp:{type}})}});
function options(extra={}) {return {now:()=>epoch*1000,verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>epoch*1000}),...extra};}
async function seed(db,id='person',role='owner',provider='otp',subject='person@example.test') {
 await db.prepare('INSERT INTO members VALUES(?,?,?,\'active\',?)').bind(id,subject,role,epoch).run();
 await db.prepare('INSERT INTO identities VALUES(?,?,?,?)').bind(provider,subject,id,epoch).run();
}
async function snapshot(db) {
 const tables=['members','identities','service_grants','audit_events','invitations','link_requests','revocations','projection_attempts','revocation_tasks'];
 return Promise.all(tables.map(async name=>(await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results));
}

test('OFFLINE OTP: exact namespace, D1 role, zero writes, per-request revocation and grants',async t=>{
 const {db}=await fixture(t); await seed(db);
 const app=createMemberDashboard(options()); const env={...config,DB:db};
 const get=(path='/',context=ctx(),jwt=token())=>app.fetch(request(jwt,path),env,context);
 const before=await snapshot(db);
 let response=await get(); assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/<dd>Owner<\/dd>/); assert.match(html,/Services coming soon/);
 assert.match(html,/href="\/cdn-cgi\/access\/logout"/);
 assert.match(html,/href="\/ui-preview"/);
 const preview=await get('/ui-preview');
 assert.equal(preview.status,200);
 assert.match(await preview.text(),/href="\/"/);
 assert.doesNotMatch(html,/person@example|access-session|synthetic-approval|jellyfin|palworld|mfa verified/i);
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.equal(response.headers.get('CDN-Cache-Control'),'no-store');
 for (const service of ['jellyfin','palworld','status','unknown']) {
  for (const path of [`/services/${service}`,`/api/services/${service}`,`/services/${service}/stream`]) assert.equal((await get(path)).status,403);
 }
 assert.deepEqual(await snapshot(db),before);
 await db.prepare("INSERT INTO service_grants VALUES('person','jellyfin')").run();
 assert.equal((await get('/services/jellyfin')).status,404); // never proxies or redirects
 await db.prepare("DELETE FROM service_grants WHERE member_id='person'").run();
 assert.equal((await get('/services/jellyfin')).status,403);
 await db.prepare("UPDATE members SET role='member' WHERE id='person'").run();
 response=await get(); assert.match(await response.text(),/<dd>Member<\/dd>/);
 assert.equal((await get('/api/owner')).status,403);
 await db.prepare("UPDATE members SET status='revoked' WHERE id='person'").run();
 assert.equal((await get()).status,403); assert.equal((await get('/services/jellyfin')).status,403);
});

test('OFFLINE OTP: Google/Apple same email and Google-only D1 binding cannot auto-link',async t=>{
 const {db}=await fixture(t); await seed(db,'person','owner','google');
 const app=createMemberDashboard(options()),env={...config,DB:db},before=await snapshot(db);
 for (const type of ['onetimepin','google','apple','otp','OneTimePin',undefined]) {
  assert.equal((await app.fetch(request(),env,ctx('person@example.test',type))).status,403);
 }
 assert.deepEqual(await snapshot(db),before);
});

test('OFFLINE OTP: trusted runtime type, exact JWT email/audience and safe user id required',async()=>{
 const authenticate=createOtpAuthenticator(options());
 assert.equal((await authenticate(request(),config,ctx())).subject,'person@example.test');
 assert.equal((await authenticate(request(token({email:'Case+tag@EXAMPLE.test'})),config,ctx('Case+tag@EXAMPLE.test'))).subject,'Case+tag@EXAMPLE.test');
 const cases=[
  [token(),ctx('Person@example.test')],[token(),ctx('person@EXAMPLE.test')],
  [token(),ctx('other@example.test')],[token(),ctx('person@example.test','google')],
  [token(),{}],[token(),{access:{aud:config.ACCESS_AUDIENCE,getIdentity:async()=>({email:'person@example.test',idp:'onetimepin'})}}],
  [token(),ctx('person@example.test','onetimepin',['members-test'])],
  [token(),ctx('person@example.test','onetimepin','owner-test')],
  [token({aud:['members-test','owner-test']}),ctx()],[token({aud:['owner-test']}),ctx()],
  [token({iss:'https://wrong.cloudflareaccess.com'}),ctx()],[token({exp:epoch}),ctx()],
  [token({sub:'<script>private</script>'}),ctx()],[token({sub:''}),ctx()],
  [token({email:'bad\n@example.test'}),ctx('bad\n@example.test')],
  [token({email:undefined}),ctx()],
  [token().replace(/.$/,'!'),ctx()]
 ];
 for (const [jwt,context] of cases) await assert.rejects(authenticate(request(jwt,'/',config.APP_ORIGIN,{
  'Cf-Access-Authenticated-User-Email':'person@example.test','X-Identity-Provider':'onetimepin'
 }),config,context));
});

test('OFFLINE OTP: custom host only; disabled flags, unknown routes, methods, errors and PII stay private',async t=>{
 const {db}=await fixture(t); await seed(db,'person','owner'); const env={...config,DB:db};
 const app=createMemberDashboard(options());
 for (const origin of ['https://wrong.example.test','https://anything.workers.dev','https://preview.pages.dev','http://members.example.test']) {
  assert.equal((await app.fetch(request(token(),'/',origin),env,ctx())).status,403);
 }
 for (const extra of [{Host:'evil.example.test'},{Origin:'https://evil.example.test'}]) {
  assert.equal((await app.fetch(request(token(),'/',config.APP_ORIGIN,extra),env,ctx())).status,403);
 }
 for (const custom of [undefined,[],['members.example.test','extra.example.test']]) {
  assert.equal((await app.fetch(request(),{...env,OTP_CUSTOM_HOSTS:custom},ctx())).status,403);
 }
 for (const [path,status] of [['/unknown',404],['/api/owner',404],['/cdn-cgi/access/logout',404],['/?email=private',400]]) {
  const response=await app.fetch(request(token(),path),env,ctx()); assert.equal(response.status,status);
  assert.match(response.headers.get('Cache-Control'),/no-store/);
 }
 const head=await app.fetch(new Request(request(),{method:'HEAD'}),env,ctx()); assert.equal(head.status,200); assert.equal(await head.text(),'');
 assert.equal((await app.fetch(new Request(request(),{method:'POST'}),env,ctx())).status,405);
 await db.prepare("UPDATE members SET role='trusted' WHERE id='person'").run();
 assert.match(await (await app.fetch(request(),env,ctx())).text(),/Trusted member/);
 for (const broken of [{prepare(){throw Error('private-email@example.test');}}, {prepare(){return {bind(){return {first:async()=>({id:'<script>private</script>',role:'owner',status:'active',grants:'[]'})};}};}}]) {
  const response=await app.fetch(request(),{...env,DB:broken},ctx()); assert.equal(response.status,403);
  assert.doesNotMatch(await response.text(),/private|script|@/);
 }
});

test('OFFLINE OTP: full isolated dashboard in workerd with signed JWT and real ephemeral D1',async t=>{
 const names=['invitation-claim','member-dashboard','owner-members-view','owner-member-actions','repository','projection','access-policy-readback','studio-ui','otp-identity','access','identity','authorization'];
 const modules=names.map(name=>({type:'ESModule',path:`portal/${name}.mjs`,contents:readFileSync(new URL(`./${name}.mjs`,import.meta.url),'utf8')}));
 const entry=`import {createMemberDashboard} from './portal/member-dashboard.mjs';
 import {createAuthenticator} from './portal/access.mjs';
 const app=createMemberDashboard({now:()=>${epoch}000,
 verifyAccess:createAuthenticator({now:()=>${epoch}000,fetcher:async()=>Response.json({keys:[${JSON.stringify(jwk)}]})})});
 export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);
 return app.fetch(new Request(request,{headers}),{...env,...${JSON.stringify(config)}},
 {access:{aud:'members-test',getIdentity:async()=>({email:'person@example.test',idp:{type:'onetimepin'}})}});}};`;
 const mf=new Miniflare(convertV4MiniflareOptions({name:'otp-runtime-offline',log:new NoOpLog(),compatibilityDate:'2026-10-24',d1Databases:{DB:'otp-synthetic'},
  modules:[{type:'ESModule',path:'entry.mjs',contents:entry},...modules],outboundService:()=>{throw Error('no outbound traffic allowed');}}));
 t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB'); await applySchema(db); await seed(db);
 const get=path=>mf.dispatchFetch(config.APP_ORIGIN+path,{headers:{'Cf-Access-Jwt-Assertion':token()}});
 const response=await get('/'); assert.equal(response.status,200); assert.match(await response.text(),/Owner/);
 assert.equal((await get('/services/jellyfin')).status,403);
 await db.prepare("UPDATE members SET status='revoked' WHERE id='person'").run();
 assert.equal((await get('/')).status,403);
});

// Signed session expiry must be rechecked across asynchronous identity and D1 reads.
for (const stage of ['identity','database']) test(`OFFLINE OTP: ${stage} wait expires signed JWT`,async t=>{
 const {db}=await fixture(t);await seed(db);let at=epoch;
 const now=()=>at*1000;
 const app=createMemberDashboard(options({now,verifyAccess:createAuthenticator({fetcher:certFetch,now})}));
 const delayed={prepare(sql){return {bind(...args){return {async first(){
  const row=await db.prepare(sql).bind(...args).first();at=epoch+10;return row;
 }};}};}};
 const context=ctx();context.access.getIdentity=async()=>{
  if(stage==='identity') at=epoch+10;
  return {email:'person@example.test',idp:{type:'onetimepin'}};
 };
 const response=await app.fetch(request(token({exp:epoch+10})),{...config,DB:stage==='database'?delayed:db},context);
 assert.equal(response.status,403);assert.match(response.headers.get('Cache-Control'),/no-store/);
});
