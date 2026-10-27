import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {createFirstOwnerEnrollment,enrollmentPath} from './first-owner-enrollment.mjs';
import inertAssembly,{createStagingOwnerEnrollment} from '../members-portal-staging/owner-enrollment-assembly.mjs';
import {dashboardConfig} from '../members-portal-staging/dashboard-assembly.mjs';
import {createAuthenticator} from './access.mjs';
import {applySchema,epoch,envConfig,certFetch,token,request} from './test-support.mjs';

const target={recipient:'person@example.test',role:'owner',databaseId:'synthetic-only',revision:'reviewed-revision',nonce:'n'.repeat(32)};
const context=(email=target.recipient,type='onetimepin')=>({access:{aud:envConfig.ACCESS_AUDIENCE,getIdentity:async()=>({email,idp:{type}})}});
const tables=['members','identities','audit_events','invitations','link_requests','revocations','service_grants','revocation_tasks','projection_attempts','first_owner_bootstrap'];
async function snapshot(db) {return Promise.all(tables.map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results));}
async function setup(t) {
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'enrollment-offline',modules:true,
  script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-24',d1Databases:{DB:'synthetic'},outboundService:()=>{throw Error('no network');}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await applySchema(db);await applySchema(db,'./migrations/0001-first-owner-bootstrap.sql');
 let at=epoch;
 const options={target,now:()=>at*1000,confirmationKey:await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']),
  verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>at*1000})};

 const env={...envConfig,PORTAL_MODE:'staging-enrollment-source',OTP_CUSTOM_HOSTS:['members.example.test'],BOOTSTRAP_DATABASE_ID:target.databaseId,DB:db};
 const app=createFirstOwnerEnrollment(options);
 const get=(jwt=token(),path=enrollmentPath,extra={})=>request(jwt,path,env.APP_ORIGIN,extra);
 const fetch=(req,ctx=context(),bindings=env)=>app.fetch(req,bindings,ctx);
 const start=async()=>{
  const response=await fetch(get());assert.equal(response.status,200);const html=await response.text();
  const ticket=html.match(/name="ticket" value="([^"]+)"/)[1];
  return {ticket,cookie:response.headers.get('Set-Cookie').split(';')[0],html,response};
 };
 const post=(form,headers={},jwt=token(),body)=>new Request(get(jwt),{method:'POST',headers:{...Object.fromEntries(get(jwt).headers),Origin:env.APP_ORIGIN,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document','Sec-Fetch-User':'?1','Content-Type':'application/x-www-form-urlencoded',Cookie:form.cookie,...headers},body:body??new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner'}).toString()});
 return {db,env,app,options,fetch,get,start,post,time:value=>{at=value;}};
}

test('enrollment GET is read-only; explicit browser POST commits one atomic Owner and denies replay after restart',async t=>{
 const f=await setup(t),before=await snapshot(f.db),form=await f.start();
 assert.deepEqual(await snapshot(f.db),before);
 assert.match(form.html,/<form method="post" action="\/owner\/enroll">/);assert.doesNotMatch(form.html,/<script|person@|eyJpc3|synthetic-approval/);
 assert.match(form.response.headers.get('Set-Cookie'),/Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300/);
 assert.match(form.response.headers.get('Content-Security-Policy'),/form-action 'self'/);
 const result=await f.fetch(f.post(form));assert.equal(result.status,200);assert.match(await result.text(),/completed/);
 const state=await snapshot(f.db);for(const index of [0,1,2,9]) assert.equal(state[index].length,1);
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const receipt=state[9][0],browserTicketDigest=digest(form.ticket);
 assert.equal(receipt.policy_digest,digest(JSON.stringify({source:'cloudflare-managed-mfa-reliance',contextDigest:receipt.context_digest})));
 assert.equal(receipt.approval_digest,digest(JSON.stringify({source:'browser-confirmation',decision:'confirm-first-owner',contextDigest:receipt.context_digest,policyDigest:receipt.policy_digest,browserTicketDigest})));
 assert.equal(receipt.approval_audit_id,`browser-${browserTicketDigest}`);
 assert.equal(state[0][0].role,'owner');assert.equal(state[1][0].provider,'otp');assert.equal(state[1][0].subject,target.recipient);
 const restarted=createFirstOwnerEnrollment(f.options);
 assert.equal((await restarted.fetch(f.post(form),f.env,context())).status,403);
 assert.equal((await f.fetch(f.get())).status,403);assert.deepEqual(await snapshot(f.db),state);
});

test('enrollment denies CSRF, API posts, malformed form, missing GET, altered cookie/ticket with no writes',async t=>{
 const f=await setup(t),form=await f.start(),before=await snapshot(f.db);
 const cases=[
  f.post({...form,ticket:''}),f.post({...form,ticket:form.ticket+'x'}),f.post({...form,cookie:''}),f.post({...form,cookie:'__Host-first-owner-confirm='+'a'.repeat(43)}),
  f.post(form,{Cookie:form.cookie+'; '+form.cookie}),
  ...['Origin','Content-Type'].flatMap(name=>[f.post(form,{[name]:''}),f.post(form,{[name]:'cross-site'})]),
  f.post(form,{'Sec-Fetch-Site':'cross-site'}),
  f.post(form,{},token(),'x'.repeat(2049)),f.post(form,{},token(),new URLSearchParams({ticket:form.ticket,decision:'cancel'}).toString()),
  f.post(form,{},token(),new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner',extra:'true'}).toString()),
  f.post(form,{},token(),new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner'}).toString()+'&ticket=duplicate'),
  ...['HEAD','PUT','DELETE'].map(method=>new Request(f.get(),{method})),f.get(token(),enrollmentPath+'?commit=true'),f.get(token(),enrollmentPath,{Origin:'https://evil.test'})
 ];
 for(const req of cases) {const response=await f.fetch(req);assert.equal(response.status,403);assert.match(response.headers.get('Cache-Control'),/no-store/);}
 assert.deepEqual(await snapshot(f.db),before);
});

test('POST accepts missing browser fetch metadata when exact Origin, token and cookie are valid',async t=>{
 const f=await setup(t),form=await f.start();
 const headers=new Headers(f.post(form).headers);
 for(const name of ['Sec-Fetch-Site','Sec-Fetch-Mode','Sec-Fetch-Dest','Sec-Fetch-User'])headers.delete(name);
 headers.set('Content-Type','application/x-www-form-urlencoded; charset=UTF-8');
 const req=new Request(f.get(),{method:'POST',headers,
  body:new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner'}).toString()});
 assert.equal((await f.fetch(req)).status,200);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM first_owner_bootstrap').first()).n,1);
});
test('POST does not rely on mode, destination or user Fetch Metadata as click proof',async t=>{
 const f=await setup(t),form=await f.start();
 const req=f.post(form,{'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty','Sec-Fetch-User':'?0'});
 assert.equal((await f.fetch(req)).status,200);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM first_owner_bootstrap').first()).n,1);
});
test('Chrome may confirm without Origin when signed ticket, cookie and OTP match',async t=>{
 const f=await setup(t),form=await f.start();
 const headers=new Headers(f.post(form).headers);
 headers.delete('Origin');
 const req=new Request(f.get(),{method:'POST',headers,
  body:new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner'}).toString()});
 assert.equal((await f.fetch(req)).status,200);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM first_owner_bootstrap').first()).n,1);
});
test('missing Origin does not bypass cross-site and cookie protection',async t=>{
 const f=await setup(t),form=await f.start();
 for(const overrides of [
  {'Origin':undefined,'Sec-Fetch-Site':'cross-site'},
  {'Origin':undefined,Cookie:''},
  {'Origin':undefined,Cookie:'__Host-first-owner-confirm=wrong'},
  {Origin:'null'}
 ]) {
  const h=new Headers(f.post(form).headers);
  for(const [key,value] of Object.entries(overrides)) {
   if(value===undefined) h.delete(key); else h.set(key,value);
  }
  const req=new Request(f.get(),{method:'POST',headers:h,
   body:new URLSearchParams({ticket:form.ticket,decision:'confirm-first-owner'}).toString()});
  assert.equal((await f.fetch(req)).status,403);
 }
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM first_owner_bootstrap').first()).n,0);
});

test('explicit cross-site requests deny before DB and show safe stage',async t=>{
 const f=await setup(t),form=await f.start();
 const response=await f.fetch(f.post(form,{'Sec-Fetch-Site':'cross-site'}));
 assert.equal(response.status,403);
 assert.match(await response.text(),/Check: browser-site/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM first_owner_bootstrap').first()).n,0);
});

test('precommit error returns a non-sensitive stage code',async t=>{
 const f=await setup(t),form=await f.start();
 const res=await f.fetch(f.post(form,{Origin:'https://wrong.example.test'}));
 assert.equal(res.status,403);
 assert.match(await res.text(),/Check: browser-origin/);
});

test('signed OTP deep-link GET after cross-site Cloudflare redirect is safe and read-only',async t=>{
 const f=await setup(t),before=await snapshot(f.db);
 const request=f.get(token(),enrollmentPath,{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'});
 const response=await f.fetch(request);
 assert.equal(response.status,200);
 assert.match(await response.text(),/Confirm first Owner enrollment/);
 assert.deepEqual(await snapshot(f.db),before);
 const form=await f.start();
 assert.equal((await f.fetch(f.post(form,{'Sec-Fetch-Site':'cross-site'}))).status,403);
 assert.deepEqual(await snapshot(f.db),before);
});

test('enrollment binds confirmation to session, exact recipient, target, expiry and trusted runtime OTP',async t=>{
 const f=await setup(t),form=await f.start(),before=await snapshot(f.db);
 for(const jwt of [token({sub:'another-session'}),token({email:'Person@example.test'}),token({aud:['members-test','owner-test']}),token({iss:'https://wrong.cloudflareaccess.com'}),token({exp:epoch}),token({iat:epoch+1}),token().replace(/.$/,'!')])
  assert.equal((await f.fetch(f.post(form,{},jwt))).status,403);
 for(const ctx of [{},context(target.recipient,'google'),context('other@example.test'),{access:{aud:'wrong',getIdentity:async()=>{throw Error('no');}}}])
  assert.equal((await f.fetch(f.post(form),ctx)).status,403);
 for(const changes of [
  {target:{...target,nonce:'z'.repeat(32)}},{target:{...target,revision:'different'}},
  {target:undefined},{target:{...target,recipient:undefined}},{target:{...target,databaseId:'wrong'}}
 ]) assert.equal((await createFirstOwnerEnrollment({...f.options,...changes}).fetch(f.post(form),f.env,context())).status,403);
 for(const bindings of [{...f.env,DB:undefined},{...f.env,BOOTSTRAP_DATABASE_ID:'wrong'}]) assert.equal((await f.fetch(f.post(form),context(),bindings)).status,403);
 for(const url of ['https://evil.test/owner/enroll','http://members.example.test/owner/enroll','https://members.example.test:444/owner/enroll','https://preview.workers.dev/owner/enroll'])
  assert.equal((await f.fetch(new Request(url,f.get()))).status,403);
 f.time(epoch+300);assert.equal((await f.fetch(f.post(form))).status,403);
 assert.deepEqual(await snapshot(f.db),before);
});

test('source and assembly defaults remain disabled regardless of flags/bindings',async t=>{
 const f=await setup(t),before=await snapshot(f.db);
 for(const app of [createFirstOwnerEnrollment(),createFirstOwnerEnrollment({...f.options,confirmationKey:undefined}),createFirstOwnerEnrollment({...f.options,confirmationKey:{}}),inertAssembly])
  assert.equal((await app.fetch(f.get(),{...f.env,ENABLE_OWNER_ENROLLMENT:true},context())).status,404);
 assert.equal((await f.fetch(f.get(),context(),{...f.env,PORTAL_MODE:'production'})).status,404);
 assert.deepEqual(await snapshot(f.db),before);
});

test('competing browser confirmations have one winner; rollback and ambiguous readback fail closed',async t=>{
 const f=await setup(t),form=await f.start(),before=await snapshot(f.db);
 await f.db.prepare("CREATE TRIGGER synthetic_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END;").run();
 let response=await f.fetch(f.post(form));assert.equal(response.status,503);assert.match(await response.text(),/inspection/);
 assert.deepEqual(await snapshot(f.db),before);await f.db.prepare('DROP TRIGGER synthetic_failure').run();
 const results=await Promise.all(Array.from({length:6},()=>f.fetch(f.post(form))));assert.equal(results.filter(r=>r.status===200).length,1);
 const state=await snapshot(f.db);for(const index of [0,1,2,9]) assert.equal(state[index].length,1);
});

test('confirmation is rechecked at commit after authentication and D1 await; ambiguous success never offers retry',async t=>{
 const f=await setup(t),form=await f.start(),before=await snapshot(f.db);
 let reads=0;
 const delayed={prepare(sql){const statement=f.db.prepare(sql);if(!sql.includes(' AS records')) return statement;return {async first(){const row=await statement.first();if(++reads===2) f.time(epoch+300);return row;}};}};
 assert.equal((await f.fetch(f.post(form),context(),{...f.env,DB:delayed})).status,503);assert.deepEqual(await snapshot(f.db),before);
 f.time(epoch);const broken={prepare(sql){if(sql.includes('SELECT m.id FROM first_owner_bootstrap')) return {bind(){return {first:async()=>null};}};return f.db.prepare(sql);}};
 const result=await f.fetch(f.post(form),context(),{...f.env,DB:broken});assert.equal(result.status,503);assert.match(await result.text(),/Do not retry/);
 assert.equal((await f.fetch(f.post(form))).status,403);assert.equal((await snapshot(f.db))[9].length,1);
});

test('staging source composition pins custom host/issuer/audience and requires deliberate server wiring',async t=>{
 const f=await setup(t),app=createStagingOwnerEnrollment({...f.options,fetcher:certFetch});
 const jwt=token({iss:dashboardConfig.ACCESS_ISSUER,aud:[dashboardConfig.ACCESS_AUDIENCE]});
 const ctx={access:{aud:dashboardConfig.ACCESS_AUDIENCE,getIdentity:context().access.getIdentity}};
 const req=new Request(dashboardConfig.APP_ORIGIN+enrollmentPath,{headers:{'Cf-Access-Jwt-Assertion':jwt}});
 const env={...f.env,APP_ORIGIN:'https://evil.test',ACCESS_ISSUER:'https://wrong.cloudflareaccess.com',ACCESS_AUDIENCE:'wrong'};
 const login=()=>app.fetch(new Request(dashboardConfig.APP_ORIGIN+'/app',{headers:req.headers}),env,ctx);
 const pristine=await snapshot(f.db);assert.equal((await login()).status,403);assert.deepEqual(await snapshot(f.db),pristine);
 const get=await app.fetch(req,env,ctx);assert.equal(get.status,200);
 const form={cookie:get.headers.get('Set-Cookie').split(';')[0],ticket:(await get.text()).match(/name="ticket" value="([^"]+)"/)[1]};
 const postHeaders=new Headers(f.post(form).headers);
 postHeaders.set('Cf-Access-Jwt-Assertion',jwt);postHeaders.set('Origin',dashboardConfig.APP_ORIGIN);
 const post=new Request(req,{method:'POST',headers:postHeaders,body:await f.post(form).text()});
 assert.equal((await app.fetch(post,env,ctx)).status,200);
 const enrolled=await snapshot(f.db);assert.equal((await login()).status,200);assert.deepEqual(await snapshot(f.db),enrolled);
 await f.db.prepare("UPDATE members SET role='member'").run();
 assert.match(await (await login()).text(),/<dd>Member<\/dd>/);
 await f.db.prepare("UPDATE members SET status='revoked'").run();
 assert.equal((await login()).status,403);
 assert.equal((await app.fetch(f.get(),env,context())).status,403);
});

test('missing approved target/DB and wrong HMAC key deny without writes',async t=>{
 const f=await setup(t),before=await snapshot(f.db),form=await f.start();
 for(const target of [undefined,{}, {...f.options.target,recipient:''}])
  assert.equal((await createFirstOwnerEnrollment({...f.options,target}).fetch(f.get(),f.env,context())).status,403);
 assert.equal((await f.fetch(f.get(),context(),{...f.env,DB:undefined})).status,403);
 const key=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']);
 assert.equal((await createFirstOwnerEnrollment({...f.options,confirmationKey:key}).fetch(f.post(form),f.env,context())).status,403);
 assert.deepEqual(await snapshot(f.db),before);
});
