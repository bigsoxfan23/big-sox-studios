import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {applySchema,envConfig,epoch,jwk,token} from './test-support.mjs';
const origin='https://owner.example.test';
const ownerToken=changes=>token({aud:['owner-test'],sub:'owner-session',...changes});
test('OFFLINE owner admin: signed Owner app JWT + synthetic trusted context + workerd D1',async t=>{
 const modules=['owner-admin','access','repository','identity','authorization','projection'].map(name=>({type:'ESModule',path:`portal/${name}.mjs`,contents:readFileSync(new URL(`./${name}.mjs`,import.meta.url),'utf8')}));
 const entry=`import {createOwnerAdminWorker} from './portal/owner-admin.mjs';
 import {createAuthenticator} from './portal/access.mjs';
 const verify=createAuthenticator({now:()=>${epoch}000,fetcher:async()=>Response.json({keys:[${JSON.stringify(jwk)}]})});
 const config=${JSON.stringify({...envConfig,APP_ORIGIN:origin,ACCESS_AUDIENCE:'owner-test',OWNER_ACCESS_AUDIENCE:'members-test'})};
 const worker=createOwnerAdminWorker({mode:'offline-test',origin:${JSON.stringify(origin)},ownerAudience:'owner-test',membersAudience:'members-test',issuer:config.ACCESS_ISSUER,now:()=>${epoch},
 authenticate:(request,env)=>verify(request,{...env,...config}),
 // TEST ONLY: explicit server-owned mapping of verified synthetic Access sessions.
 resolveOwnerActor:async claims=>({accessSubject:claims.sub,memberId:claims.sub==='owner-session'?'owner':'ordinary',role:'owner'})});
 export default {fetch(request,env){const headers=new Headers(request.headers);
 // Preserve an explicitly supplied spoof in a synthetic test header; otherwise reconstruct edge Host.
 headers.set('Host',headers.get('X-Test-Host')??new URL(request.url).host);
 return worker.fetch(new Request(request,{headers}),env);}};`;
 const mf=new Miniflare(convertV4MiniflareOptions({name:'owner-admin-offline',log:new NoOpLog(),compatibilityDate:'2026-10-24',d1Databases:{DB:'owner-admin-synthetic'},modules:[{type:'ESModule',path:'entry.mjs',contents:entry},...modules],outboundService:()=>{throw Error('no outbound traffic');}}));
 t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB'); await applySchema(db);
 await db.batch([
  db.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").bind(epoch),
  db.prepare("INSERT INTO members VALUES('ordinary','ordinary@example.test','member','active',?)").bind(epoch),
  db.prepare("INSERT INTO identities VALUES('google','ordinary-subject','ordinary',?)").bind(epoch),
  db.prepare("INSERT INTO service_grants VALUES('ordinary','jellyfin')")
 ]);
 const send=(jwt=ownerToken(),options={})=>mf.dispatchFetch(options.url??origin+'/',{...options,headers:{'Cf-Access-Jwt-Assertion':jwt,...options.headers}});
 const fresh=async(jwt=ownerToken())=>{const response=await send(jwt);assert.equal(response.status,200);const html=await response.text();return {csrf:/name="csrf" value="([^"]+)"/.exec(html)[1],cookie:response.headers.get('Set-Cookie').split(';')[0],html,response};};
 const post=(state,action,fields={},jwt=ownerToken(),extra={})=>send(jwt,{method:'POST',body:new URLSearchParams({csrf:state.csrf,action,...fields}).toString(),headers:{Origin:origin,Cookie:state.cookie,'Content-Type':'application/x-www-form-urlencoded',...extra}});
 const count=async(table)=>Number((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n);
 await t.test('root private records hidden; three sections and restrictive headers; no script/assets',async()=>{
  const {html,response}=await fresh();assert.equal((html.match(/<section>/g)??[]).length,3);assert.ok(!html.includes('ordinary@example.test'));assert.ok(!/<script|src=|href=/i.test(html));
  assert.match(response.headers.get('Cache-Control'),/no-store/);assert.match(response.headers.get('Content-Security-Policy'),/default-src 'none'/);assert.match(response.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Strict/);
 });
 await t.test('denies invalid, members, multi-audience and injected owner role JWTs',async()=>{
  for(const jwt of ['bad',token(),ownerToken({aud:['owner-test','members-test']}),ownerToken({sub:'ordinary-session',role:'owner',memberId:'owner'}),ownerToken({exp:epoch})]) assert.equal((await send(jwt)).status,403);
  assert.equal(await count('members'),2);
 });
 await t.test('host, scheme, origin, query, unknown route and method deny',async()=>{
  for(const options of [{url:'https://unknown.example.test/'},{url:'http://owner.example.test/'},{url:origin+'/?secret=no'},{url:origin+'/api/deliver'},{headers:{'X-Test-Host':'spoof.example.test'}},{headers:{Origin:'https://evil.test'}},{method:'DELETE'}]) assert.equal((await send(ownerToken(),options)).status,403);
 });
 await t.test('CSRF requires exact Origin, double submit, same-site and exact signed session',async()=>{
  const state=await fresh();
  for(const headers of [{Origin:''},{Origin:'https://evil.test'},{Cookie:''},{'Sec-Fetch-Site':'cross-site'}]) assert.equal((await post(state,'create',{contact:'deny@example.test'},ownerToken(),headers)).status,403);
  assert.equal((await post({...state,csrf:'wrong'},'view')).status,403);
  assert.equal((await post(state,'view',{},ownerToken({iat:epoch-1}))).status,403);
  assert.equal(await count('members'),2);
 });
 await t.test('bounded body and user-supplied actor/role reject without mutations',async()=>{
  for(const fields of [{actor:'owner'},{role:'owner'},{contact:'x'.repeat(8193)}]) {
   const state=await fresh();assert.equal((await post(state,'create',{contact:'deny@example.test',...fields})).status,403);
  }
  assert.equal(await count('members'),2);
 });
 let candidate;
 await t.test('create pending via repository; concurrent POST replay only creates once',async()=>{
  const state=await fresh(); const results=await Promise.all([post(state,'create',{contact:'candidate@example.test'}),post(state,'create',{contact:'candidate@example.test'})]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,403]);
  candidate=(await db.prepare("SELECT * FROM members WHERE recipient='candidate@example.test'").first()).id;
  assert.equal((await db.prepare('SELECT status FROM members WHERE id=?').bind(candidate).first()).status,'pending');
  assert.equal(await count('identities'),1);
 });
 await t.test('issue/reissue invokes repository; blocked only, digest only, never secret in response',async()=>{
  for(let revision=1;revision<=2;revision++) {
   const state=await fresh(),response=await post(state,'issue',{member:candidate});assert.equal(response.status,200);
   const html=await response.text();const rows=(await db.prepare('SELECT * FROM invitations WHERE member_id=? ORDER BY revision').bind(candidate).all()).results;
   assert.equal(rows.length,revision);assert.equal(rows.at(-1).status,'blocked');assert.equal(rows.at(-1).expires_at,epoch+604800);assert.match(rows.at(-1).digest,/^[a-f0-9]{64}$/);
   assert.ok(!html.includes(rows.at(-1).digest));assert.ok(!html.includes(rows.at(-1).id));
   assert.equal((html.match(/[A-Za-z0-9_-]{43}/g)??[]).every(value=>value===/name="csrf" value="([^"]+)"/.exec(html)[1]),true);
   if(revision===2) assert.equal(rows[0].status,'superseded');
  }
  assert.equal((await post(await fresh(),'deliver',{member:candidate})).status,403);
 });
 await t.test('contact XSS escapes in private lists',async()=>{
  const contact="<svg/onload=alert(1)>@example.test"; // valid repository local-part punctuation, unsafe HTML if unescaped
  const response=await post(await fresh(),'create',{contact});assert.equal(response.status,403); // conservative email grammar rejects angle brackets
  // Synthetic malformed imported data: even trusted storage cannot inject markup.
  await db.prepare("INSERT INTO members VALUES('xss',?,'member','pending',?)").bind('<img src=x onerror=alert(1)>',epoch).run();
  const html=await (await post(await fresh(),'view')).text();
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
 });
 await t.test('revoke is idempotent and removes live member/session service access',async()=>{
  const {createRepository}=await import('./repository.mjs');
  const {createIdentityAuthenticator}=await import('./identity.mjs');
  const {createAuthenticator}=await import('./access.mjs');
  const {certFetch,resolver,request,identityClaims}=await import('./test-support.mjs');
  const identity=await createIdentityAuthenticator({authenticate:createAuthenticator({fetcher:certFetch,now:()=>epoch*1000}),resolveVerifiedIdentity:resolver})(request(token(identityClaims('google','ordinary-subject','ordinary@example.test'))),envConfig);
  const repo=createRepository(db,{now:()=>epoch});assert.equal(await repo.authorize(identity,'jellyfin'),true);
  for(let i=0;i<2;i++) assert.equal((await post(await fresh(),'revoke',{member:'ordinary'})).status,200);
  assert.equal(await count('revocations'),1);assert.equal(await count('revocation_tasks'),6);assert.equal(await repo.authorize(identity),false);assert.equal(await repo.authorize(identity,'jellyfin'),false);
  assert.equal((await post(await fresh(),'revoke',{member:'owner'})).status,403);
 });
 await t.test('global low-cost action budget fails closed while fresh reads remain available',async()=>{
  let denied=0;
  for(let i=0;i<31;i++) {const response=await post(await fresh(),'view');if(response.status===403) denied++;else assert.equal(response.status,200);}
  assert.ok(denied>0);assert.equal((await send()).status,200);
 });
 await t.test('fresh D1 owner role read denies an already authenticated session after role removal',async()=>{
  const state=await fresh();await db.prepare("UPDATE members SET role='member' WHERE id='owner'").run();
  assert.equal((await post(state,'create',{contact:'never@example.test'})).status,403);assert.equal((await send()).status,403);
 });
});

test('owner admin factory stays inert without explicit offline dependencies',async()=>{
 const {createOwnerAdminWorker}=await import('./owner-admin.mjs');
 assert.equal((await createOwnerAdminWorker().fetch(new Request(origin),{})).status,403);
});
