import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createProductionOwnerEnrollment,productionOwnerSourceRevision} from './production-owner-enrollment-entry.mjs';
import {createProductionMemberWorker} from './production-otp-release-entry.mjs';
import {productionOwnerBoundary as boundary,productionEnrollmentMode} from '../portal/production-boundary.mjs';
import {createFirstOwnerEnrollment,enrollmentPath} from '../portal/first-owner-enrollment.mjs';
import {createFirstOwnerBootstrap} from '../portal/first-owner-bootstrap.mjs';
import {createAuthenticator} from '../portal/access.mjs';
import {epoch,token,certFetch} from '../portal/test-support.mjs';

const email='approved-owner@example.test';
const tables=['members','identities','audit_events','invitations','link_requests','revocations','service_grants',
 'revocation_tasks','projection_attempts','first_owner_bootstrap','owner_action_nonces','invitation_claim_nonces',
 'member_onboarding','welcome_intents','welcome_reconciliation_events','member_approval_holds'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const context=(recipient=email,type='onetimepin')=>({access:{aud:boundary.audience,getIdentity:async()=>({email:recipient,idp:{type}})}});
const jwt=(changes={})=>token({iss:boundary.issuer,aud:[boundary.audience],email,exp:epoch+3600,...changes});

// Only :memory: SQLite and synthetic credentials. No D1 instance, persisted
// database, account, provider request, real JWT or secret is used by this suite.
function setup(t,{nativeClock=false}={}) {
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const file of ['schema.sql','migrations/0001-first-owner-bootstrap.sql','migrations/0003-invitation-claim-nonces.sql',
  'migrations/0004-request-onboarding.sql','migrations/0005-welcome-intents.sql','migrations/0006-welcome-reconciliation.sql',
  'migrations/0007-owner-admission-withdrawal-holds.sql'])
  sqlite.exec(readFileSync(new URL('../portal/'+file,import.meta.url),'utf8'));
 let reads=0,writes=0,at=epoch;
 // Deterministic database clock; tests can advance it at SQL execution time.
 if(!nativeClock) sqlite.function('unixepoch',{varargs:true},()=>at);
 const db={prepare(sql){
  const statement=sqlite.prepare(sql);let values=[];
  return {bind(...args){values=args;return this;},
   async first(){reads++;const row=statement.get(...values);return row?{...row}:null;},
   async all(){reads++;return {results:statement.all(...values).map(row=>({...row}))};},
   async run(){writes++;return {success:true,meta:{changes:statement.run(...values).changes}};}};
 },batch(){throw Error('No batch expected');}};
 const env={APP_ORIGIN:boundary.origin,ACCESS_ISSUER:boundary.issuer,ACCESS_AUDIENCE:boundary.audience,
  OWNER_ACCESS_AUDIENCE:'e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0',
  APPROVED_REQUESTS_ID:'21e13fa1-0ab3-4573-8d20-983c847ba0e9',
  APPROVED_MEMBER_DB_ID:boundary.databaseId,BOOTSTRAP_DATABASE_ID:boundary.databaseId,
  OTP_CUSTOM_HOSTS:['members.bigsoxstudios.com'],PORTAL_PRODUCTION_MODE:'reviewed-production-12',
  PORTAL_APPROVED_OTP_ASSEMBLY:'reviewed-production-12',PORTAL_APPROVED_MEMBERS:'enabled-12-approved',
  PORTAL_SIMPLIFIED_MEMBER_UI:'enabled-12',PORTAL_MODE:productionEnrollmentMode,
  PORTAL_OWNER_ENROLLMENT:'reviewed-production-first-owner-12',OWNER_ENROLLMENT_EMAIL:email,
  OWNER_ENROLLMENT_NONCE:'n'.repeat(43),OWNER_ENROLLMENT_HMAC_KEY:Buffer.alloc(32,7).toString('base64url'),DB:db,
  APPROVED_REQUESTS_DB:{prepare(){throw Error('Requests DB must never be accessed');},batch(){throw Error('Requests DB must never be changed');}}};
 const options={now:()=>at*1000,fetcher:async url=>{
  assert.equal(url,boundary.issuer+'/cdn-cgi/access/certs');return certFetch();
 }};
 const app=createProductionOwnerEnrollment(options);
 const get=(signed=jwt(),path=enrollmentPath,extra={})=>new Request(boundary.origin+path,{headers:{'Cf-Access-Jwt-Assertion':signed,...extra}});
 const post=(form,extra={},signed=jwt(),body)=>new Request(get(signed),{method:'POST',
  headers:{...Object.fromEntries(get(signed).headers),Origin:boundary.origin,'Sec-Fetch-Site':'same-origin',
   'Content-Type':'application/x-www-form-urlencoded',Cookie:form.cookie,...extra},
  body:body??new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner'}).toString()});
 const fetch=(request,bindings=env,ctx=context())=>app.fetch(request,bindings,ctx);
 const start=async()=>{
  const response=await fetch(get());assert.equal(response.status,200);const html=await response.text();
  return {html,response,ticket:html.match(/name="ticket" value="([^"]+)"/)[1],cookie:response.headers.get('Set-Cookie').split(';')[0]};
 };
 const snapshot=()=>Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table}`).all().map(row=>({...row}))]));
 return {sqlite,db,env,options,app,get,post,fetch,start,snapshot,time:value=>{at=value;},counts:()=>({reads,writes})};
}

test('production enrollment GET is read-only and ordinary login never provisions an Owner',async t=>{
 const f=setup(t),before=f.snapshot();
 assert.equal((await f.fetch(f.get(jwt(),'/app'))).status,403);
 assert.equal((await createProductionMemberWorker(f.options).fetch(f.get(),f.env,context())).status,404);
 const form=await f.start();
 assert.deepEqual(f.snapshot(),before);assert.equal(f.counts().writes,0);
 assert.equal(form.response.headers.get('Referrer-Policy'),'same-origin');
 assert.match(form.response.headers.get('Cache-Control'),/no-store/);
 assert.match(form.response.headers.get('X-Robots-Tag'),/noindex/);
 assert.match(form.response.headers.get('Set-Cookie'),/^__Host-first-owner-confirm=.+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300$/);
 assert.match(form.html,/Confirm first Owner enrollment/);assert.doesNotMatch(form.html,/approved-owner@|<script/);
 assert.equal(form.html.includes(jwt()),false);
});

test('production confirmation commits the exact Owner, immutable receipt/binding/audit and no grants',async t=>{
 const f=setup(t),form=await f.start();
 const result=await f.fetch(f.post(form));assert.equal(result.status,200);assert.match(await result.text(),/completed/);
 assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/);
 const state=f.snapshot(),member=state.members[0],receipt=state.first_owner_bootstrap[0];
 assert.deepEqual(member,{id:member.id,recipient:email,role:'owner',status:'active',created_at:epoch});
 assert.deepEqual(state.identities,[{provider:'otp',subject:email,member_id:member.id,bound_at:epoch}]);
 assert.equal(receipt.database_id,boundary.databaseId);assert.equal(receipt.revision,productionOwnerSourceRevision);
 assert.equal(receipt.nonce,f.env.OWNER_ENROLLMENT_NONCE);assert.equal(receipt.session_digest,digest(jwt()));
 assert.equal(receipt.expires_at,epoch+300);
 assert.equal(receipt.policy_digest,digest(JSON.stringify({source:'cloudflare-managed-mfa-reliance',contextDigest:receipt.context_digest})));
 assert.equal(receipt.approval_digest,digest(JSON.stringify({source:'browser-confirmation',decision:'confirm-first-owner',
  contextDigest:receipt.context_digest,policyDigest:receipt.policy_digest,browserTicketDigest:digest(form.ticket)})));
 assert.equal(state.audit_events.length,1);assert.equal(state.audit_events[0].action,'first-owner-bootstrap');
 for(const table of tables) assert.equal(state[table].length,['members','identities','audit_events','first_owner_bootstrap'].includes(table)?1:0,table);
 for(const table of ['identities','audit_events','first_owner_bootstrap']) {
  assert.throws(()=>f.sqlite.exec(`DELETE FROM ${table}`));
 }
 assert.throws(()=>f.sqlite.exec('UPDATE first_owner_bootstrap SET at=at+1'));
 assert.equal((await f.fetch(f.get(jwt(),'/app'),{...f.env,PORTAL_OWNER_ENROLLMENT:'disabled',OWNER_ENROLLMENT_HMAC_KEY:undefined})).status,200);
 assert.equal((await createProductionOwnerEnrollment(f.options).fetch(f.post(form),f.env,context())).status,403);
 assert.deepEqual(f.snapshot(),state);
 f.sqlite.exec("UPDATE members SET status='revoked'");
 assert.equal((await f.fetch(f.get(jwt(),'/app'))).status,403);
 assert.equal((await f.fetch(f.get())).status,403);
 assert.equal((await f.fetch(f.post(form),{...f.env,OWNER_ENROLLMENT_NONCE:'z'.repeat(43)})).status,403);
});

test('production requires all exact bindings, separate gates and explicitly provisioned target/key/nonce before DB access',async t=>{
 const f=setup(t),before=f.snapshot();
 const cases=[
  {PORTAL_PRODUCTION_MODE:undefined},{PORTAL_OWNER_ENROLLMENT:undefined},{PORTAL_OWNER_ENROLLMENT:'enabled'},
  {PORTAL_MODE:'staging-enrollment-source'},{PORTAL_MODE:undefined},
  {APP_ORIGIN:'https://members-staging.bigsoxstudios.com'},{ACCESS_ISSUER:'https://wrong.cloudflareaccess.com'},
  {ACCESS_AUDIENCE:'a'.repeat(64)},{ACCESS_AUDIENCE:'f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe'},
  {OWNER_ACCESS_AUDIENCE:boundary.audience},{APPROVED_REQUESTS_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71'},
  {APPROVED_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af'},{APPROVED_MEMBER_DB_ID:'01234567-89ab-4cde-8f01-23456789abcd'},
  {BOOTSTRAP_DATABASE_ID:'wrong'},{OTP_CUSTOM_HOSTS:['members.bigsoxstudios.com','evil.test']},
  {PORTAL_APPROVED_OTP_ASSEMBLY:'reviewed-staging-12'},{PORTAL_APPROVED_MEMBERS:undefined},{PORTAL_SIMPLIFIED_MEMBER_UI:undefined},
  {DB:undefined},{APPROVED_REQUESTS_DB:undefined},{APPROVED_REQUESTS_DB:f.db},
  ...['OWNER_ENROLLMENT_EMAIL','OWNER_ENROLLMENT_NONCE','OWNER_ENROLLMENT_HMAC_KEY'].flatMap(name=>[{[name]:undefined},{[name]:''},{[name]:'invalid'}]),
  {OWNER_ENROLLMENT_HMAC_KEY:'_'.repeat(43)}
 ];
 for(const changed of cases) {
  const result=await f.fetch(f.get(),{...f.env,...changed});assert.equal(result.status,503,Object.keys(changed).join());
  assert.match(result.headers.get('Cache-Control'),/no-store/);
 }
 assert.deepEqual(f.counts(),{reads:0,writes:0});assert.deepEqual(f.snapshot(),before);
});

test('wrong hosts, ports, direct Workers URLs, unknown paths and malformed routes deny',async t=>{
 const f=setup(t),before=f.snapshot();
 for(const origin of ['https://members-staging.bigsoxstudios.com','http://members.bigsoxstudios.com',
  'https://members.bigsoxstudios.com:444','https://preview.workers.dev','https://evil.test'])
  assert.equal((await f.fetch(new Request(origin+enrollmentPath,{headers:f.get().headers}))).status,404);
 assert.equal((await f.fetch(f.get(jwt(),enrollmentPath,{Host:'evil.test'}))).status,404);
 for(const path of ['/unknown',enrollmentPath+'/']) assert.equal((await f.fetch(f.get(jwt(),path))).status,404);
 for(const method of ['HEAD','PUT','DELETE']) assert.equal((await f.fetch(new Request(f.get(),{method}))).status,403);
 assert.equal((await f.fetch(f.get(jwt(),enrollmentPath+'?recipient=other@example.test'))).status,403);
 assert.deepEqual(f.counts(),{reads:0,writes:0});assert.deepEqual(f.snapshot(),before);
});

test('only signed fresh exact production OTP identity and trusted runtime context may enroll',async t=>{
 const f=setup(t),form=await f.start(),before=f.snapshot();
 for(const signed of ['',jwt({email:'Approved-owner@example.test'}),jwt({iat:epoch-300}),jwt({iat:epoch+1}),
  jwt({exp:epoch}),jwt({iss:'https://wrong.cloudflareaccess.com'}),jwt({aud:[boundary.audience,f.env.OWNER_ACCESS_AUDIENCE]}),
  jwt({aud:['f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe']}),jwt().replace(/.$/,'!')]) {
  assert.equal((await f.fetch(f.get(signed))).status,403);
  assert.equal((await f.fetch(f.post(form,{},signed))).status,403);
 }
 for(const ctx of [{},context(email,'google'),context(email,'apple'),context('other@example.test'),
  {access:{aud:'wrong',getIdentity:context().access.getIdentity}}])
  assert.equal((await f.fetch(f.post(form),f.env,ctx)).status,403);
 const request=f.get('',enrollmentPath,{'Cf-Access-Authenticated-User-Email':email});
 assert.equal((await f.fetch(request)).status,403);
 assert.deepEqual(f.snapshot(),before);
});

test('production rejects CSRF, changed sessions/context, malformed forms and ticket/cookie replay',async t=>{
 const f=setup(t),form=await f.start(),before=f.snapshot();
 for(const extra of [{Origin:'null'},{Origin:'https://evil.test'},{Origin:''},{'Sec-Fetch-Site':'cross-site'},
  {Cookie:''},{Cookie:form.cookie+'; '+form.cookie},{Cookie:'__Host-first-owner-confirm='+'a'.repeat(43)},
  {'Content-Type':'application/json'}]) assert.equal((await f.fetch(f.post(form,extra))).status,403);
 const noOrigin=f.post(form);noOrigin.headers.delete('Origin');assert.equal((await f.fetch(noOrigin)).status,403);
 for(const body of ['x'.repeat(2049),'ticket='+form.ticket+'&decision=cancel',
  new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner',extra:'true'}).toString(),
  new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner'}).toString()+'&ticket=duplicate'])
  assert.equal((await f.fetch(f.post(form,{},jwt(),body))).status,403);
 assert.equal((await f.fetch(f.post({...form,ticket:form.ticket+'x'}))).status,403);
 assert.equal((await f.fetch(f.post(form,{},jwt({sub:'different-session'})))).status,403);
 for(const changed of [{OWNER_ENROLLMENT_NONCE:'z'.repeat(43)},
  {OWNER_ENROLLMENT_HMAC_KEY:Buffer.alloc(32,8).toString('base64url')},{OWNER_ENROLLMENT_EMAIL:'other@example.test'}])
  assert.equal((await f.fetch(f.post(form),{...f.env,...changed})).status,403);
 f.time(epoch+300);assert.equal((await f.fetch(f.post(form))).status,403);
 assert.deepEqual(f.snapshot(),before);
});

test('production cannot be reached through staging mode or a changed source revision',async t=>{
 const f=setup(t),form=await f.start(),before=f.snapshot();
 const key=await crypto.subtle.importKey('raw',Buffer.alloc(32,7),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const target={role:'owner',recipient:email,databaseId:boundary.databaseId,revision:'other-revision',nonce:f.env.OWNER_ENROLLMENT_NONCE};
 const changed=createFirstOwnerEnrollment({confirmationKey:key,target,mode:productionEnrollmentMode,now:f.options.now,
  verifyAccess:createAuthenticator(f.options)});
 assert.equal((await changed.fetch(f.post(form),f.env,context())).status,403);
 for(const mode of ['staging-enrollment-source','offline-test']) {
  const bootstrap=createFirstOwnerBootstrap({mode,target,now:f.options.now});
  await assert.rejects(bootstrap(new Request(boundary.origin+'/',{method:'POST',headers:f.get().headers}),{...f.env,PORTAL_MODE:mode},context()));
 }
 assert.deepEqual(f.snapshot(),before);
});

test('production denies existing/revoked people and incomplete/nonpristine schema',async t=>{
 const f=setup(t);
 for(const [role,status] of [['owner','active'],['owner','revoked'],['member','pending']]) {
  f.sqlite.prepare('INSERT INTO members VALUES(?,?,?,?,?)').run('existing',email,role,status,epoch);
  const before=f.snapshot();assert.equal((await f.fetch(f.get())).status,403);assert.deepEqual(f.snapshot(),before);
  f.sqlite.exec('DELETE FROM members');
 }
 f.sqlite.prepare('INSERT INTO invitation_claim_nonces VALUES(?,?,?,NULL)').run('a'.repeat(64),'b'.repeat(64),epoch+100);
 const before=f.snapshot();assert.equal((await f.fetch(f.get())).status,403);assert.deepEqual(f.snapshot(),before);
 f.sqlite.exec('DELETE FROM invitation_claim_nonces');
 for(const table of ['member_approval_holds','first_owner_bootstrap']) {
  f.sqlite.exec(`DROP TABLE ${table}`);assert.equal((await f.fetch(f.get())).status,403);
 }
 assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM members').get().n,0);
});

test('atomic SQL denies a state change after the final pristine preflight',async t=>{
 const f=setup(t),form=await f.start();let checks=0;
 const db={...f.db,prepare(sql){const statement=f.db.prepare(sql);
  if(!sql.includes(' AS pristine')) return statement;
  return {async first(){const row=await statement.first();if(++checks===2)
   f.sqlite.prepare('INSERT INTO invitation_claim_nonces VALUES(?,?,?,NULL)').run('a'.repeat(64),'b'.repeat(64),epoch+100);
   return row;}};
 }};
 const result=await f.fetch(f.post(form),{...f.env,DB:db});assert.equal(result.status,503);
 assert.match(await result.text(),/Do not retry/);
 const state=f.snapshot();for(const table of tables) assert.equal(state[table].length,table==='invitation_claim_nonces'?1:0,table);
});

test('rollback, concurrent confirmations and lost readback retain fail-closed semantics',async t=>{
 const f=setup(t),form=await f.start(),before=f.snapshot();
 f.sqlite.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 const failed=await f.fetch(f.post(form));assert.equal(failed.status,503);assert.match(await failed.text(),/Do not retry/);
 assert.deepEqual(f.snapshot(),before);f.sqlite.exec('DROP TRIGGER synthetic_failure');
 const results=await Promise.all(Array.from({length:6},()=>f.fetch(f.post(form))));
 assert.equal(results.filter(r=>r.status===200).length,1);
 const state=f.snapshot();for(const table of ['members','identities','audit_events','first_owner_bootstrap']) assert.equal(state[table].length,1);
 const g=setup(t),other=await g.start();
 const broken={...g.db,prepare(sql){if(sql.includes('SELECT m.id FROM first_owner_bootstrap')) return {bind(){return {first:async()=>null};}};return g.db.prepare(sql);}};
 const ambiguous=await g.fetch(g.post(other),{...g.env,DB:broken});assert.equal(ambiguous.status,503);assert.match(await ambiguous.text(),/inspection.*Do not retry/);
 assert.equal(g.snapshot().members.length,1);assert.equal(g.snapshot().first_owner_bootstrap.length,1);
 assert.equal((await g.fetch(g.post(other))).status,403);
});

test('production session freshness is rechecked after awaited database reads and bounds receipt expiry',async t=>{
 const f=setup(t),form=await f.start(),before=f.snapshot();let checks=0;
 const delayed={...f.db,prepare(sql){const statement=f.db.prepare(sql);if(!sql.includes(' AS pristine')) return statement;
  return {async first(){const row=await statement.first();if(++checks===2) f.time(epoch+300);return row;}};
 }};
 const result=await f.fetch(f.post(form),{...f.env,DB:delayed});assert.equal(result.status,503);assert.deepEqual(f.snapshot(),before);
 const g=setup(t);g.time(epoch+299);const short=await g.start();
 assert.equal((await g.fetch(g.post(short))).status,200);
 assert.equal(g.snapshot().first_owner_bootstrap[0].expires_at,epoch+300);
});

test('production SQL refuses proof that expires in transit after the final application check',async t=>{
 for(const elapsed of [300,-1]) {
  const f=setup(t),form=await f.start(),before=f.snapshot();
  const delayed={...f.db,prepare(sql){const statement=f.db.prepare(sql);
   if(!sql.includes('INSERT INTO first_owner_bootstrap')) return statement;
   return {bind(...values){statement.bind(...values);return this;},async run(){f.time(epoch+elapsed);return statement.run();}};
  }};
  const result=await f.fetch(f.post(form),{...f.env,DB:delayed});
  assert.equal(result.status,503);assert.match(await result.text(),/Do not retry/);assert.deepEqual(f.snapshot(),before);
 }
 // Also execute the guard with SQLite's native clock, without overriding it.
 const f=setup(t,{nativeClock:true}),at=Math.floor(Date.now()/1000);f.time(at);
 const signed=jwt({iat:at,nbf:at,exp:at+3600});
 const response=await f.fetch(f.get(signed));assert.equal(response.status,200);
 const form={ticket:(await response.text()).match(/name="ticket" value="([^"]+)"/)[1],cookie:response.headers.get('Set-Cookie').split(';')[0]};
 assert.equal((await f.fetch(f.post(form,{},signed))).status,200);
});

test('production example keeps original entrypoint and all enrollment/release switches disabled',()=>{
 const config=readFileSync(new URL('./wrangler.production.example.toml',import.meta.url),'utf8');
 assert.match(config,/^main = "\.\/production-otp-release-entry.mjs"$/m);
 assert.match(config,/PORTAL_PRODUCTION_MODE = "disabled-before-verified-release"/);
 assert.match(config,/PORTAL_MODE = "disabled-before-verified-enrollment"/);
 assert.match(config,/PORTAL_OWNER_ENROLLMENT = "disabled-before-verified-enrollment"/);
 assert.doesNotMatch(config,/^\s*(OWNER_ENROLLMENT_(EMAIL|HMAC_KEY|NONCE)|routes?)\s*=/m);
});
