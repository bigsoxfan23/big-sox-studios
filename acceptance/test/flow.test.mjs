import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,makeDb} from './fixture.mjs';
import {PINS} from '../config.mjs';
test('private acceptance pins the actual existing staging Owner and Member Access applications, never production Owner audience',()=>{
 assert.equal(PINS.ownerAudience,'0ac97e12ea497b28dee6aa43e7b63b8a73ee9edd48579e965c0baec3ea72ed64');
 assert.equal(PINS.memberAudience,'f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe');
 assert.notEqual(PINS.ownerAudience,'e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0');
});
// No test can accidentally reach Cloudflare/Notion/Resend or any external API.
const network=globalThis.fetch;
test.before(()=>{globalThis.fetch=async()=>{throw Error('external network forbidden');};});
test.after(()=>{globalThis.fetch=network;});
const queue='/acceptance/requests/';
async function approved(f){const {res,id}=await f.submit();assert.equal(res.status,201);assert.equal((await f.dispatch(id)).status,410);assert.equal((await f.approve(id)).status,200);return id;}

test('SQLite complete synthetic run, two pinned emails, no grants, same-session revocation',async t=>{
 const f=fixture(t,{entries:true}),originalToken=f.tokens.member;
 const {res,id}=await f.submit();assert.equal(res.status,201);assert.equal(f.calls.length,2);
 assert.equal((await f.get('member','/acceptance/app')).status,403);
 assert.equal((await f.dispatch(id)).status,410);assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls.map(x=>x.kind),['notion_ticket','owner_notice']);
 assert.equal((await f.approve(id)).status,200);
 assert.equal(f.members.rows('acceptance_members')[0].status,'pending');
 assert.equal((await f.get('member','/acceptance/app')).status,403);
 const confirmation=await f.form('owner',`/acceptance/requests/${id}/send-welcome`);
 assert.match(confirmation.body,/Confirm ONE TEST welcome/);assert.match(confirmation.body,/greg.fridman@outlook.com/);
 assert.equal((await f.post('owner',`/acceptance/requests/${id}/send-welcome`,confirmation,{revision:'2',confirm:PINS.tester})).status,200);
 assert.equal((await f.get('member','/acceptance/app')).status,200);
 assert.match(await (await f.get('member','/acceptance/app')).text(),/TEST Membership Active/);
 assert.equal(f.tokens.member,originalToken);assert.equal(f.members.rows('acceptance_identities').length,1);
 assert.equal(f.members.rows('service_grants').length,0);
 assert.deepEqual(f.calls.filter(c=>c.kind!=='notion_ticket').map(c=>c.payload.to),[PINS.owner,PINS.tester]);
 for(const {payload} of f.calls){assert.equal('cc' in payload,false);assert.equal('bcc' in payload,false);assert.equal('replyTo' in payload,false);assert.doesNotMatch(JSON.stringify(payload),/password|username/i);}
 const member=f.members.rows('acceptance_members')[0];const form=await f.form('owner','/acceptance/members/');
 assert.equal((await f.post('owner',`/acceptance/members/${member.id}/remove`,form,{revision:'2'})).status,200);
 assert.equal((await f.get('member','/acceptance/app',{token:originalToken})).status,403);
 assert.equal(f.members.rows('acceptance_members')[0].status,'revoked');
 assert.equal(f.requests.rows('acceptance_requests')[0].status,'revoked');
 assert.equal(f.requests.rows('acceptance_effects').length,3);assert.equal(f.members.rows('acceptance_identities').length,1);
 assert.deepEqual(f.members.rows('acceptance_member_audit').map(a=>a.event),['pending','active','revoked']);
 assert.equal((await f.get('member','/acceptance/app/services/jellyfin')).status,403);
 assert.equal(f.calls.length,3);
});

test('exact JWT, runtime identity, host, audience, OTP and MFA fail closed',async t=>{
 const f=fixture(t);
 const cases=[
  ['member','/acceptance/request',{origin:'https://big-sox-studios-members-staging.fridman-greg.workers.dev'}],
  ['member','/acceptance/request',{origin:'https://members.bigsoxstudios.com'}],
  ['member','/acceptance/request',{origin:'http://'+PINS.memberHost}],
  ['owner',queue,{origin:'https://other.fridman-greg.workers.dev'}],
  ['owner',queue,{origin:'https://owner.bigsoxstudios.com'}],
  ['member','/acceptance/request?x=1',{}],
  ['member','/acceptance/request',{headers:{Host:'wrong.example'}}],
  ['member','/acceptance/request',{headers:{Origin:'https://wrong.example'}}],
  ['member','/acceptance/request',{token:'forged.token.signature'}],
  ['member','/acceptance/request',{token:f.jwt('member',{email:PINS.owner})}],
  ['member','/acceptance/request',{token:f.jwt('member',{email:'greg.fridman+test@outlook.com'})}],
  ['owner',queue,{token:f.jwt('owner',{email:PINS.tester})}],
  ['owner',queue,{token:f.jwt('owner',{aud:[PINS.ownerAudience,PINS.memberAudience]})}],
  ['member','/acceptance/request',{token:f.jwt('member',{aud:[PINS.ownerAudience]})}],
  ['member','/acceptance/request',{token:f.jwt('member',{exp:f.at-1})}],
  ['member','/acceptance/request',{ctx:f.context('member',PINS.owner)}],
  ['owner',queue,{ctx:f.context('owner',PINS.tester)}],
  ['member','/acceptance/request',{ctx:{access:{aud:PINS.memberAudience,getIdentity:async()=>({email:PINS.tester,idp:{type:'google'}})}}}],
 ];
 for(const [role,path,extra] of cases)assert.equal((await f.get(role,path,extra)).status,403,JSON.stringify([role,path,extra.origin]));
 const noProof=fixture(t,{verifyAccessPolicy:async()=>{throw Error('synthetic unverified policy');}});assert.equal((await noProof.get('owner',queue)).status,403);assert.equal((await noProof.get('member','/acceptance/request')).status,403);
 const fakeProof=fixture(t,{verifyAccessPolicy:async()=>({mfaVerified:true,policyVerified:true})});assert.equal((await fakeProof.get('owner',queue)).status,403);
 assert.equal(f.requests.rows('acceptance_requests').length,0);assert.equal(f.calls.length,0);
});

test('D1 pins, physical markers, legacy object aliases, missing schema and run rotation fail closed',async t=>{
 const f=fixture(t);
 for(const overrides of [
  {ACCEPTANCE_REQUESTS_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71'},
  {ACCEPTANCE_MEMBERS_ID:'613c9c18-69f9-4cf4-b7b1-afb0de49bd6d'},
  {ACCEPTANCE_REQUESTS:f.members,ACCEPTANCE_MEMBERS:f.requests},
  {ACCEPTANCE_MEMBERS:f.requests}, {DB:f.members}, {MEMBERSHIP_DB:f.requests},
  {ACCEPTANCE_TEST_RECIPIENT:'Greg.Fridman@outlook.com'}, {ACCEPTANCE_OWNER_RECIPIENT:PINS.tester},
  {ACCEPTANCE_MODE:'production'}, {ACCEPTANCE_CSRF_KEY:''},
 ]) {const before=f.requests.touches+f.members.touches;assert.equal((await f.get('member','/acceptance/request',{env:{...f.env,...overrides}})).status,503);if('DB' in overrides||'MEMBERSHIP_DB' in overrides)assert.equal(f.requests.touches+f.members.touches,before);}
 const missing=makeDb('requests',false);t.after(()=>missing.close());
 assert.equal((await f.get('member','/acceptance/request',{env:{...f.env,ACCEPTANCE_REQUESTS:missing}})).status,503);
 assert.equal((await f.submit()).res.status,201);
 assert.equal((await f.get('member','/acceptance/request',{env:{...f.env,ACCEPTANCE_RUN_ID:'synthetic-run-0002'}})).status,403);
 const legacy={prepare(){throw Error('legacy must never be accessed');},batch(){throw Error('legacy must never be accessed');}};
 assert.equal((await f.get('owner',queue,{env:{...f.env,DB:legacy,MEMBERSHIP_DB:legacy,APPROVED_REQUESTS_DB:legacy}})).status,200);
 assert.equal(f.calls.length,2);
});

test('CSRF and strict schema reject cross-session, cross-origin, missing cookie, duplicate fields and recipient injection',async t=>{
 const f=fixture(t);const form=await f.form('member','/acceptance/request');
 for(const extra of [
  {headers:{Origin:'https://evil.example'}},{headers:{'Sec-Fetch-Site':'cross-site'}},{headers:{Cookie:''}},
  {headers:{'Content-Type':'application/json'}},{token:f.jwt('member',{sub:'other-session'})},
  {body:`csrf=${form.csrf}&csrf=${form.csrf}`},
 ])assert.notEqual((await f.post('member','/acceptance/request',form,{},extra)).status,201);
 assert.equal((await f.post('member','/acceptance/request',form,{to:'somebody@example.test'})).status,409);
 assert.equal((await f.post('member','/acceptance/request',form,{source_revision:'stale'})).status,409);
 assert.equal(f.requests.rows('acceptance_requests').length,0);assert.equal(f.calls.length,0);
});

test('concurrent duplicate request, dispatch, decision and welcome consume single durable intent',async t=>{
 const f=fixture(t),form=await f.form('member','/acceptance/request');
 assert.deepEqual((await Promise.all([f.post('member','/acceptance/request',form),f.post('member','/acceptance/request',form)])).map(r=>r.status).sort(),[201,409]);
 const id=f.requests.rows('acceptance_requests')[0].id;
 const dispatch=await f.form('owner',queue);
 assert.deepEqual((await Promise.all([f.post('owner',`/acceptance/requests/${id}/dispatch`,dispatch,{confirm:PINS.owner}),f.post('owner',`/acceptance/requests/${id}/dispatch`,dispatch,{confirm:PINS.owner})])).map(r=>r.status).sort(),[410,410]);
 assert.equal(f.calls.length,2);
 const decision=await f.form('owner',queue);
 assert.deepEqual((await Promise.all([f.post('owner',`/acceptance/requests/${id}/decision`,decision),f.post('owner',`/acceptance/requests/${id}/decision`,decision)])).map(r=>r.status).sort(),[200,409]);
 const welcome=await f.form('owner',`/acceptance/requests/${id}/send-welcome`);
 assert.deepEqual((await Promise.all([f.post('owner',`/acceptance/requests/${id}/send-welcome`,welcome,{revision:'2',confirm:PINS.tester}),f.post('owner',`/acceptance/requests/${id}/send-welcome`,welcome,{revision:'2',confirm:PINS.tester})])).map(r=>r.status).sort(),[200,409]);
 assert.equal(f.calls.length,3);assert.equal(f.requests.rows('acceptance_effects').length,3);assert.equal(f.members.rows('acceptance_members').length,1);
 assert.ok(f.requests.rows('acceptance_effects').every(e=>e.attempt_count===1));
});

for(const state of ['unknown','refused','malformed','throw','uncorroborated'])test(`provider ${state} permanently consumes ticket intent; no blind retry or admission`,async t=>{
 const f=fixture(t);
 if(state==='throw')f.providers.createTicket=async()=>{throw Error('timeout');};else f.result(state==='uncorroborated'?'accepted':state);
 if(state==='uncorroborated')f.receipt(false);
 const {res,id}=await f.submit();assert.equal(res.status,409);
 const effects=f.requests.rows('acceptance_effects');assert.equal(effects.length,2);assert.equal(effects[1].state,'reserved');
 assert.equal(effects[0].state,state==='refused'?'refused':'unknown');
 const attempts=f.calls.length;f.result('accepted');f.receipt(true);
 assert.equal((await f.dispatch(id)).status,410);assert.equal(f.calls.length,attempts);
 assert.equal((await f.approve(id)).status,409);assert.equal((await f.get('member','/acceptance/app')).status,403);
 assert.throws(()=>f.requests.sqlite.exec("UPDATE acceptance_effects SET state='reserved'"),/immutable/);
 assert.throws(()=>f.requests.sqlite.exec('DELETE FROM acceptance_effects'),/immutable/);
});

test('UNKNOWN welcome never activates, cannot send again, refusal and duplicate receipt remain immutable',async t=>{
 const f=fixture(t),id=await approved(f);f.result('unknown');assert.equal((await f.welcome(id)).status,409);
 assert.equal((await f.get('member','/acceptance/app')).status,403);assert.equal(f.members.rows('acceptance_members')[0].status,'pending');
 const calls=f.calls.length;f.result('accepted');assert.equal((await f.welcome(id)).status,409);assert.equal(f.calls.length,calls);
 assert.throws(()=>f.requests.sqlite.exec("UPDATE acceptance_effects SET state='accepted',provider_id='forged' WHERE kind='test_welcome'"),/immutable/);
});

test('credentials, independent gate and scope proof missing or wrong never reserve or dispatch',async t=>{
 const f=fixture(t);const form=await f.form('member','/acceptance/request');
 for(const overrides of [{ACCEPTANCE_NOTION_CREDENTIAL:''},{ACCEPTANCE_SENDER_CREDENTIAL:''},{ACCEPTANCE_DISPATCH_GATE:''},{ACCEPTANCE_NOTION_PARENT:'wrong'},
  {ACCEPTANCE_OWNER_RECIPIENT:PINS.tester},{ACCEPTANCE_TEST_RECIPIENT:PINS.owner}])assert.notEqual((await f.post('member','/acceptance/request',form,{}, {env:{...f.env,...overrides}})).status,201);
 f.scope(false);assert.equal((await f.submit()).res.status,409);
 assert.equal(f.calls.length,0);assert.equal(f.requests.rows('acceptance_effects').length,0);assert.equal(f.requests.rows('acceptance_outbox').length,0);
});

test('Owner expires during awaited D1 read; database-time expiry prevents stale clock CAS',async t=>{
 const f=fixture(t),{id}=await f.submit();assert.equal((await f.dispatch(id)).status,410);const form=await f.form('owner',queue);
 f.requests.hook=async sql=>{if(sql==='SELECT * FROM acceptance_requests WHERE run_id=? AND id=?')f.time((f.at+301)*1000);};
 assert.equal((await f.post('owner',`/acceptance/requests/${id}/decision`,form)).status,409);
 assert.equal(f.requests.rows('acceptance_requests')[0].status,'pending');assert.equal(f.members.rows('acceptance_members').length,0);
 f.requests.hook=null;f.time(f.at*1000);
 // Node verifier clock is deliberately stale. SQLite's real clock crosses expiry
 // while the update is awaiting; SQL unixepoch() must still reject it.
 const expiry=Math.floor(Date.now()/1000)+1;
 f.tokens.owner=f.jwt('owner',{exp:expiry});const short=await f.form('owner',queue);
 f.requests.hook=async sql=>{if(sql.startsWith('UPDATE acceptance_requests SET status=\'approved\''))await new Promise(resolve=>setTimeout(resolve,1200));};
 assert.equal((await f.post('owner',`/acceptance/requests/${id}/decision`,short)).status,409);
 assert.equal(f.requests.rows('acceptance_requests')[0].status,'pending');assert.equal(f.members.rows('acceptance_members').length,0);
});

test('no grants, retained audit/identities, fresh request/version, forged env readiness cannot activate',async t=>{
 const f=fixture(t),{id}=await f.submit();
 const form=await f.form('owner',queue);
 assert.equal((await f.post('owner',`/acceptance/requests/${id}/decision`,form,{revision:'2'})).status,409);
 assert.equal((await f.post('owner','/acceptance/requests/00000000-0000-0000-0000-000000000000/decision',form)).status,409);
 assert.equal((await f.get('member','/acceptance/app',{env:{...f.env,ACCEPTANCE_ACTIVE:true,TEST_WELCOME_ACCEPTED:true}})).status,403);
 assert.throws(()=>f.members.sqlite.exec("INSERT INTO service_grants VALUES('x','x','jellyfin')"),/NEVER/);
 assert.throws(()=>f.requests.sqlite.exec('DELETE FROM acceptance_audit'),/immutable/);
 assert.throws(()=>f.requests.sqlite.exec('UPDATE acceptance_audit SET event=\'forged\''),/immutable/);
 assert.equal((await f.post('member',`/acceptance/requests/${id}/decision`,await f.form('member','/acceptance/request'))).status,403);
 assert.equal(f.members.rows('service_grants').length,0);
});

test('existing routes, original Request/env/context and session cookie pass through unchanged',async t=>{
 const f=fixture(t);const req=new Request(`https://${PINS.memberHost}/app`,{headers:{Cookie:'original=session'}}),ctx=f.context('member');
 const res=await f.member.fetch(req,f.env,ctx);assert.equal(await res.text(),'unchanged original route');assert.equal(res.headers.get('Set-Cookie'),'original=unchanged');
 assert.equal(f.baseCalls[0].req,req);assert.equal(f.baseCalls[0].environment,f.env);assert.equal(f.baseCalls[0].ctx,ctx);assert.equal(req.headers.get('Cookie'),'original=session');
 assert.equal(f.requests.touches+f.members.touches,0);
});

test('production entrypoint import graphs exclude acceptance; no deployment configuration references it',()=>{
 function graph(file,seen=new Set()){
  const url=new URL(file,import.meta.url);if(seen.has(url.href))return;seen.add(url.href);
  const code=readFileSync(url,'utf8');assert.doesNotMatch(code,/(?:from\s*|import\s*\()['"][^'"]*acceptance/);
  for(const match of code.matchAll(/(?:from\s*|import\s*\()['"](\.[^'"]+\.mjs)['"]/g))graph(new URL(match[1],url),seen);
 }
 for(const file of ['../../members-portal-production/production-otp-release-entry.mjs','../../members-portal-production/production-owner-enrollment-entry.mjs','../../owner-launchpad/src/worker.mjs','../../members-portal-staging/approved-otp-release-entry.mjs'])graph(file);
 for(const file of ['../../owner-launchpad/wrangler.production.toml','../../members-portal-staging/wrangler.staging.toml','../../members-portal-staging/wrangler.owner-release.toml'])assert.doesNotMatch(readFileSync(new URL(file,import.meta.url),'utf8'),/acceptance/);
});


test('separate staging entrypoints preserve original handlers, deny service POSTs and unsupported methods',async t=>{
 const f=fixture(t,{entries:true});
 assert.equal((await f.get('member','/app')).status,503);
 assert.equal((await f.get('owner','/')).status,401);
 assert.equal(f.requests.touches+f.members.touches,0);
 for(const role of ['member','owner']) {
  const origin=`https://${role==='owner'?PINS.ownerHost:PINS.memberHost}`;
  for(const method of ['HEAD','PUT','DELETE']) {
   const res=await f[role].fetch(new Request(origin+'/acceptance/request',{method,headers:{'Cf-Access-Jwt-Assertion':f.tokens[role]}}),f.env,f.context(role));
   assert.equal(res.status,403);assert.equal(res.headers.get('Set-Cookie'),null);
  }
 }
 assert.equal((await f.post('member','/acceptance/app/services/jellyfin',await f.form('member','/acceptance/request'))).status,403);
 assert.equal(f.calls.length,0);
});

test('crash after reservation and failed outcome persistence never free any attempt',async t=>{
 const f=fixture(t);
 f.providers.createTicket=async payload=>{f.calls.push({kind:'notion_ticket',payload});f.requests.hook=async sql=>{if(sql.startsWith('UPDATE acceptance_effects'))throw Error('synthetic persistence outage');};return {state:'accepted',providerId:'local-ticket'};};
 const {res,id}=await f.submit();assert.equal(res.status,409);assert.equal(f.calls.length,1);
 assert.ok(f.requests.rows('acceptance_effects').every(e=>e.state==='reserved'));
 f.requests.hook=null;assert.equal((await f.dispatch(id)).status,410);assert.equal(f.calls.length,1);
 assert.equal((await f.approve(id)).status,409);
});

test('expiry during scope proof prevents reservation; revoked request wins a concurrent Member activation',async t=>{
 const f=fixture(t);const originalScope=f.providers.verifyScope;
 f.providers.verifyScope=async input=>{const proof=await originalScope(input);f.time((f.at+301)*1000);return proof;};
 assert.equal((await f.submit()).res.status,409);assert.equal(f.requests.rows('acceptance_requests').length,0);assert.equal(f.requests.rows('acceptance_effects').length,0);assert.equal(f.calls.length,0);
 const g=fixture(t),approvedId=await approved(g);assert.equal((await g.welcome(approvedId)).status,200);
 // Interleave revocation immediately before the Member DB batch. The final
 // Requests authority read must deny, even if activation already began.
 g.members.hook=async sql=>{if(sql==='BATCH')g.requests.sqlite.prepare("UPDATE acceptance_requests SET status='revoked',revision=revision+1,revoked_at=unixepoch(),updated_at=unixepoch() WHERE id=?").run(approvedId);};
 assert.equal((await g.get('member','/acceptance/app')).status,403);
 assert.equal((await g.get('member','/acceptance/app')).status,403);
 assert.equal(g.members.rows('service_grants').length,0);
});

test('durable SQLite evidence rejects fabricated acceptance, duplicate receipt and forbidden state transitions',async t=>{
 const f=fixture(t),id=await approved(f);assert.equal((await f.welcome(id)).status,200);
 const e=f.requests.rows('acceptance_effects').find(e=>e.kind==='test_welcome');
 assert.throws(()=>f.requests.sqlite.prepare("UPDATE acceptance_effects SET state='accepted',provider_id='duplicate' WHERE id=?").run(e.id),/immutable/);
 assert.throws(()=>f.requests.sqlite.prepare("INSERT INTO acceptance_effects(id,request_id,kind,recipient_digest,state,created_at,updated_at) VALUES(?,?,?,?,'accepted',unixepoch(),unixepoch())").run(crypto.randomUUID(),id,'test_welcome',e.recipient_digest),/reserve TEST/);
 assert.equal((await f.get('member','/acceptance/app')).status,200);
 assert.throws(()=>f.members.sqlite.exec('DELETE FROM acceptance_identities'),/retain/);
 assert.throws(()=>f.members.sqlite.exec('DELETE FROM acceptance_member_audit'),/immutable/);
 assert.throws(()=>f.members.sqlite.exec("UPDATE acceptance_members SET status='pending'"),/invalid/);
 assert.throws(()=>f.requests.sqlite.exec('DELETE FROM acceptance_run'),/immutable/);
 assert.throws(()=>f.requests.sqlite.exec('DELETE FROM acceptance_outbox'),/immutable/);
});


test('a real local receipt timeout records UNKNOWN and late completion never unlocks the run',async t=>{
 const f=fixture(t);let resolveReceipt;
 f.providers.verifyReceipt=()=>new Promise(resolve=>{resolveReceipt=resolve;});
 const {res,id}=await f.submit();assert.equal(res.status,409);
 const ledger=f.requests.rows('acceptance_effects');assert.equal(ledger[0].state,'unknown');assert.equal(ledger[1].state,'reserved');
 resolveReceipt(true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.requests.rows('acceptance_effects')[0].state,'unknown');assert.equal((await f.dispatch(id)).status,410);assert.equal(f.calls.length,1);
});
