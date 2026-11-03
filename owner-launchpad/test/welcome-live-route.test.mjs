import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {welcomeFixture,seed} from './welcome-fixture.mjs';
import {hmac} from '../../membership/common.mjs';
import {welcomeLiveEnabled,expectedMemberLoginUrl} from '../src/welcome-live-route.mjs';

const providerId='550e8400-e29b-41d4-a716-446655440011';
const input={action:'preview',request_revision:'1',message:'Hello synthetic friend!',password:'transient-synthetic-secret'};
const decode=s=>s.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const extract=(html,name)=>decode(html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1]??'');
async function page(response){const html=await response.text();return {r:response,html,csrf:extract(html,'csrf'),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};}
async function ready(t,{enabled=true,send=false}={}){
 const f=await welcomeFixture();t.after(()=>{f.portal.close();f.storage.sqlite.close();});
 // Apply reviewed schema only inside an isolated in-memory synthetic fixture.
 f.portal.exec(readFileSync(new URL('../../portal/migrations/0006-welcome-reconciliation.sql',import.meta.url),'utf8'));
 if(enabled)f.env.PORTAL_WELCOME_LIVE_ROUTE='review-only-12';
 f.env.MEMBER_LOGIN_URL='https://members-staging.bigsoxstudios.com/app';
 if(send)Object.assign(f.env,{PORTAL_WELCOME_LIVE_SEND:'enabled-12',RESEND_API_KEY:'re_synthetic12345678',SENDER_EMAIL:'welcome@example.test'});
 const id=seed(f.storage,{status:'approved'}),setup=`/membership/requests/${id}/setup`,path=`/membership/requests/${id}/welcome-live`;
 assert.equal((await f.post(setup,await f.form(setup),{request_revision:'1',action:'start',confirm:'yes'})).status,303);
 assert.equal((await f.post(setup,await f.form(setup),{request_revision:'1',revision:'1',action:'jellyfin-ready',confirm:'yes',username:'synthetic',url:'https://jellyfin.example.test/'})).status,303);
 return {...f,id,path,setup,count:table=>f.portal.prepare(`SELECT count(*) n FROM ${table}`).get().n};
}
function mockProvider(t,{unknown=false,mismatch=false}={}){
 const calls=[];
 // Explicit fake fetch injection; the fixture's JWT verifier has its own JWKS
 // fetcher. No request from this test can reach an external provider.
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url,options});
  if(options.method==='POST')return unknown?new Response('',{status:503}):Response.json({id:providerId});
  return Response.json({id:providerId,to:[mismatch?'other@example.test':'visitor@example.test'],last_event:'delivered',text:'PRIVATE-PROVIDER-BODY'});
 });return calls;
}
async function preview(f,fields=input){return page(await f.post(f.path,await f.form(f.path),fields));}
const sendFields=p=>({...input,action:'send',review:extract(p.html,'review'),confirm:'yes'});
async function sent(t,options={}){const calls=mockProvider(t,options),f=await ready(t,{send:true}),p=await preview(f),s=await f.post(f.path,p,sendFields(p));assert.equal(s.status,200);return {...f,calls,p,s};}
async function receipt(f,provider=providerId){const row=f.portal.prepare('SELECT id FROM welcome_intents').get();return page(await f.post(f.path,await f.form(f.path),{action:'inspect',request_revision:'1',intent_id:row.id,provider_id:provider}));}
const receiptFields=p=>Object.fromEntries(['evidence','issued_at','expires_at','nonce','signature'].map(k=>[k,extract(p.html,k)]).concat([['action','record'],['request_revision','1'],['confirm','yes']]));

test('default OFF is 404 behind existing signed exact Owner authentication; no bypass',async t=>{
 const calls=mockProvider(t),f=await ready(t,{enabled:false});
 for(const method of ['GET','HEAD','POST','PUT'])assert.equal((await f.request(f.path,{method})).status,404);
 for(const jwt of ['',await f.token('other@example.test'),'unsigned.invalid.jwt'])assert.equal((await f.request(f.path,{headers:{'Cf-Access-Jwt-Assertion':jwt}})).status,401);
 for(const change of [{PORTAL_WELCOME_LIVE_ROUTE:'enabled-12'},{PORTAL_WELCOME_LIVE_ROUTE:'review-only-12',PORTAL_ONBOARDING:'off'},{PORTAL_WELCOME_LIVE_ROUTE:'review-only-12',APP_ORIGIN:'https://owner.bigsoxstudios.com'}])assert.equal(welcomeLiveEnabled({...f.env,...change}),false);
 assert.equal(f.count('welcome_intents'),0);assert.equal(calls.length,0);
});
test('live welcome requires a pinned environment-specific Member sign-in URL; no staging link in production',async t=>{
 assert.equal(expectedMemberLoginUrl({APP_ORIGIN:'https://owner.bigsoxstudios.com'}),'https://members.bigsoxstudios.com/app');
 assert.equal(expectedMemberLoginUrl({APP_ORIGIN:'https://bss-owner-launchpad-staging.fridman-greg.workers.dev'}),'https://members-staging.bigsoxstudios.com/app');
 assert.equal(expectedMemberLoginUrl({APP_ORIGIN:'https://unknown.example.test'}),null);
 const f=await ready(t),prepared=await f.form(f.path),before=f.portal.prepare('SELECT total_changes() n').get().n;
 for(const value of [undefined,'https://members.bigsoxstudios.com/app','https://evil.example.test/app','https://members-staging.bigsoxstudios.com/app?x=1']){
  f.env.MEMBER_LOGIN_URL=value;
  assert.equal((await f.request(f.path)).status,503);
  assert.equal((await f.post(f.path,prepared,input)).status,503);
 }
 assert.equal(f.portal.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(f.count('welcome_intents'),0);
});

test('route-only GET/HEAD and preview are read-only with CSP, escaping, no-store and secure cookie; simulation remains separate',async t=>{
 const calls=mockProvider(t),f=await ready(t),before=f.portal.prepare('SELECT total_changes() n').get().n;
 const p=await preview(f,{...input,message:'<img src=x onerror=alert(1)> & hello'});
 assert.equal(p.r.status,200);assert.match(p.html,/&lt;img/);assert.doesNotMatch(p.html,/<img/);
 assert.match(p.html,/https:\/\/members-staging\.bigsoxstudios\.com\/app/);
 assert.match(p.r.headers.get('Content-Security-Policy'),/script-src 'none'.*form-action 'self'/);
 assert.match(p.r.headers.get('Cache-Control'),/no-store/);assert.match(p.r.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Strict/);
 assert.equal((await f.request(f.path,{method:'HEAD'})).status,200);
 assert.equal((await f.request(f.path,{method:'PUT'})).status,405);
 assert.equal((await f.request(f.path+'?action=send')).status,400);
 assert.match((await f.form(`/membership/requests/${f.id}/welcome`)).html,/Staging simulation/);
 assert.equal(f.count('welcome_intents'),0);assert.equal(calls.length,0);assert.equal(f.portal.prepare('SELECT total_changes() n').get().n,before);
});
test('send/inspect/record gates and invalid credential/sender refuse before any D1 access or provider call',async t=>{
 const calls=mockProvider(t),f=await ready(t),p=await preview(f),database=f.env.PORTAL_DB,requests=f.env.MEMBERSHIP_DB;
 for(const config of [{},{PORTAL_WELCOME_LIVE_SEND:'enabled'},{PORTAL_WELCOME_LIVE_SEND:'enabled-12'},{PORTAL_WELCOME_LIVE_SEND:'enabled-12',RESEND_API_KEY:'bad',SENDER_EMAIL:'welcome@example.test'},{PORTAL_WELCOME_LIVE_SEND:'enabled-12',RESEND_API_KEY:'re_synthetic12345678',SENDER_EMAIL:'evil\n@example.test'}]){
  Object.assign(f.env,{PORTAL_WELCOME_LIVE_SEND:undefined,RESEND_API_KEY:undefined,SENDER_EMAIL:undefined},config);
  let touched=0;f.env.PORTAL_DB=f.env.MEMBERSHIP_DB={prepare(){touched++;throw Error('D1 forbidden');}};
  for(const data of [sendFields(p),{action:'inspect',request_revision:'1',intent_id:crypto.randomUUID(),provider_id:providerId},{action:'record',request_revision:'1',evidence:'{}',issued_at:'1',expires_at:'2',nonce:'x',signature:'x',confirm:'yes'}])assert.ok((await f.post(f.path,p,data)).status>=400);
  assert.equal(touched,0);f.env.PORTAL_DB=database;f.env.MEMBERSHIP_DB=requests;
 }
 assert.equal(f.count('welcome_intents'),0);assert.equal(calls.length,0);
});
test('strict forms, CSRF, Origin, changed message/proof and expired review cannot claim or dispatch',async t=>{
 const calls=mockProvider(t),f=await ready(t,{send:true}),p=await preview(f);
 for(const kind of ['csrf','origin','missing-origin','duplicate','extra','confirm','proof','message','revision','content-type','session','expired-csrf']){
  const data=sendFields(p),form={...p},headers={};
  if(kind==='csrf')form.csrf='invalid';if(kind==='origin')headers.Origin='https://evil.example.test';if(kind==='missing-origin')headers.Origin='null';
  if(kind==='extra')data.transport='live';if(kind==='confirm')data.confirm='no';if(kind==='proof')data.review='wrong';if(kind==='message')data.message='Changed';if(kind==='revision')data.request_revision='2';if(kind==='content-type')headers['Content-Type']='application/json';
  if(kind==='session'){
   const at=Date.now(),clock=t.mock.method(Date,'now',()=>at+1000);
   headers['Cf-Access-Jwt-Assertion']=await f.token();clock.mock.restore();
  }
  if(kind==='expired-csrf'){
   const jwt=await f.token(),payload=`${Date.now()-1}.${crypto.randomUUID()}`;
   const binding=await hmac(f.env.MEMBERSHIP_CSRF_KEY,'session:'+jwt);
   form.csrf=payload+'.'+await hmac(f.env.MEMBERSHIP_CSRF_KEY,binding+':'+payload);
   form.cookie='__Host-bss-membership-csrf='+form.csrf;headers['Cf-Access-Jwt-Assertion']=jwt;
  }
  let response;
  if(kind==='duplicate')response=await f.request(f.path,{method:'POST',headers:{Origin:f.env.APP_ORIGIN,'Content-Type':'application/x-www-form-urlencoded',Cookie:p.cookie},body:new URLSearchParams({csrf:p.csrf,...data}).toString()+'&confirm=yes'});
  else response=await f.post(f.path,form,data,headers);
  assert.ok(response.status>=400,kind);
 }
 assert.equal(f.count('welcome_intents'),0);assert.equal(calls.length,0);
});
test('synthetic accepted dispatch claims once, never claims delivery or activates; no message/credential persistence',async t=>{
 const f=await sent(t),html=await f.s.text();assert.match(html,/Provider accepted/);assert.match(html,/Acceptance is not delivery/);
 assert.doesNotMatch(html,/transient-synthetic-secret|Hello synthetic friend|re_synthetic/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'POST');assert.equal(f.calls[0].url,'https://api.resend.com/emails');
 assert.match(f.calls[0].options.headers['Idempotency-Key'],/^bss-welcome\//);
 assert.equal((await f.post(f.path,f.p,sendFields(f.p))).status,409);assert.equal(f.calls.length,1);
 assert.equal(f.count('welcome_intents'),1);assert.equal(f.portal.prepare('SELECT state FROM welcome_intents').get().state,'accepted');
 const stored=JSON.stringify(f.portal.prepare('SELECT * FROM welcome_intents').all())+JSON.stringify(f.portal.prepare('SELECT * FROM audit_events').all());
 assert.doesNotMatch(stored,/transient-synthetic-secret|Hello synthetic friend|re_synthetic/);
 assert.equal(f.portal.prepare("SELECT status FROM members WHERE role='member'").get().status,'pending');
 for(const table of ['identities','service_grants','invitations'])assert.equal(f.count(table),0);
});
test('corroborated receipt proof is per-session, CSRF-bound and one-use; immutable evidence preserves UNKNOWN lock',async t=>{
 const f=await sent(t,{unknown:true});assert.match(await f.s.text(),/Outcome UNKNOWN/);
 const p=await receipt(f);assert.equal(p.r.status,200);assert.match(p.html,/Review corroborated receipt/);assert.doesNotMatch(p.html,/PRIVATE-PROVIDER-BODY/);
 const data=receiptFields(p);
 const outcomes=await Promise.all([f.post(f.path,p,data),f.post(f.path,p,data)]);
 assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);assert.equal(f.count('welcome_reconciliation_events'),1);
 assert.equal((await f.post(f.path,p,data)).status,409);
 const row=f.portal.prepare('SELECT * FROM welcome_reconciliation_events').get();assert.equal(row.provider_status,'delivered');
 assert.throws(()=>f.portal.prepare('UPDATE welcome_reconciliation_events SET provider_status=?').run('failed'));
 assert.throws(()=>f.portal.prepare('DELETE FROM welcome_reconciliation_events').run());
 assert.equal(f.portal.prepare('SELECT state FROM welcome_intents').get().state,'UNKNOWN');
 assert.equal((await f.post(f.path,f.p,sendFields(f.p))).status,409);
 assert.equal(f.calls.filter(x=>x.options.method==='POST').length,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='welcome-live-reconciliation-delivered'").get().n,1);
 assert.equal(f.portal.prepare("SELECT status FROM members WHERE role='member'").get().status,'pending');assert.equal(f.count('service_grants'),0);
});
test('receipt tampering, changed CSRF, wrong request, uncorroborated ID, revoked Owner and expiry cannot persist',async t=>{
 const f=await sent(t),p=await receipt(f),data=receiptFields(p);
 for(const kind of ['evidence','nonce','signature','confirm','csrf','wrong-request','provider-id','expired','owner']){
  const fields={...data},form={...p};let path=f.path,clockMock;
  if(kind==='evidence')fields.evidence=JSON.stringify({...JSON.parse(fields.evidence),providerStatus:'failed'});
  if(kind==='nonce')fields.nonce='0'.repeat(32);if(kind==='signature')fields.signature='0'.repeat(64);if(kind==='confirm')fields.confirm='no';
  if(kind==='csrf')Object.assign(form,await f.form(f.path));
  if(kind==='wrong-request'){const other=seed(f.storage,{status:'approved'});path=`/membership/requests/${other}/welcome-live`;}
  if(kind==='provider-id'){
   const r=await receipt(f,'550e8400-e29b-41d4-a716-446655440099');assert.ok(r.r.status>=400);continue;
  }
  if(kind==='expired'){const at=Date.now();clockMock=t.mock.method(Date,'now',()=>at+121000);}
  if(kind==='owner')f.portal.prepare("UPDATE members SET status='revoked' WHERE role='owner'").run();
  assert.ok((await f.post(path,form,fields)).status>=400,kind);
  clockMock?.mock.restore();
 }
 assert.equal(f.count('welcome_reconciliation_events'),0);
});
test('independent readback mismatch cannot mint receipt proof; expiry and revoked source block sends',async t=>{
 const f=await sent(t,{mismatch:true}),p=await receipt(f);assert.equal(p.r.status,200);assert.match(p.html,/could not be corroborated/);assert.equal(extract(p.html,'signature'),'');
 assert.equal(f.count('welcome_reconciliation_events'),0);
 const g=await ready(t,{send:true}),review=await preview(g),at=Date.now();
 const clock=t.mock.method(Date,'now',()=>at+301000);assert.equal((await g.post(g.path,review,sendFields(review))).status,409);
 clock.mock.restore();
 await g.storage.prepare("UPDATE membership_requests SET status='revoked',revision=2 WHERE id=?").bind(g.id).run();
 assert.equal((await g.post(g.path,review,sendFields(review))).status,409);assert.equal(g.count('welcome_intents'),0);
});
