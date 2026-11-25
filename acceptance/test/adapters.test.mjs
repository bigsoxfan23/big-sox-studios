import {prepareOperatorLease,applyOperatorLease} from '../operator/renewal.mjs';
import {preflightFixture} from './attestation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {PINS,sha256} from '../config.mjs';
import {createStagingProviders} from '../adapters.mjs';
import {providerPayload} from '../providers.mjs';
import {verifyOperatorAttestation} from '../attestation.mjs';
import {signAttestation,hash} from './attestation-fixture.mjs';
const network=globalThis.fetch;
test.before(()=>{globalThis.fetch=async()=>{throw Error('external network forbidden');};});
test.after(()=>{globalThis.fetch=network;});
const childId='11111111-1111-4111-8111-111111111111';
const emailId='22222222-2222-4222-8222-222222222222';
const noticeSubject='TEST request awaiting review',welcomeSubject='TEST welcome — no service access';
const page=(id=childId)=>({object:'page',id,archived:false,in_trash:false,public_url:null,parent:{type:'page_id',page_id:PINS.parent},properties:{title:{title:[{plain_text:'Task12 Acceptance — TEST Ticket'}]}}});
function wired(t,options={}) {
 const wire=[];let f;
 const wireFetcher=async(url,init)=>{
  const body=init.body?JSON.parse(init.body):null;
  wire.push({url,init,body});
  assert.equal(init.redirect,'manual');assert.ok(init.signal instanceof AbortSignal);
  // Both intents must exist and outbox be locked BEFORE even the parent GET.
  assert.equal(f.requests.rows('acceptance_effects').filter(e=>e.kind!=='test_welcome').length,2);
  assert.equal(f.requests.rows('acceptance_outbox')[0].state,'locked');
  let value;
  if(url===`https://api.notion.com/v1/pages/${PINS.parent}`) {
   assert.equal(init.method,'GET');value=page(PINS.parent);
  } else if(url==='https://api.notion.com/v1/pages') {
   assert.equal(init.method,'POST');value=page();
  } else if(url===`https://api.notion.com/v1/pages/${childId}`) {
   assert.equal(init.method,'GET');value=page();
  } else if(url==='https://api.resend.com/emails') {
   assert.equal(init.method,'POST');value={id:emailId};
   // Durable accepted Notion evidence is required before the Gmail notice.
   assert.equal(f.requests.rows('acceptance_effects').find(e=>e.kind==='notion_ticket').state,'accepted');
  } else throw Error('nonallowlisted URL');
  if(options.respond)return options.respond({url,init,body,value,wire,f});
  return Response.json(value);
 };
 f=fixture(t,{entries:true,realAdapters:true,wireFetcher});
 return {...f,wire};
}
async function attestation(f,token=f.tokens.member) {
 return verifyOperatorAttestation({request:new Request(`https://${PINS.memberHost}/acceptance/request`,{headers:{'Cf-Access-Jwt-Assertion':token}}),
  claims:JSON.parse(Buffer.from(token.split('.')[1],'base64url')),env:{...f.env,ACCEPTANCE_OPERATOR_ATTESTATION:signAttestation(f.env,f.preflight,token,f.at)},role:'member',now:f.now,readTrustedPreflight:f.readTrustedPreflight});
}

test('actual staging adapters: Member POST reserves both, Notion GET/POST/GET then exact Gmail notice; Owner approves and confirms Outlook welcome once',async t=>{
 const f=wired(t),form=await f.form('member','/acceptance/request');
 assert.match(form.body,/creates one private TEST Notion ticket/);assert.equal(f.wire.length,0);
 const results=await Promise.all([1,2].map(()=>f.post('member','/acceptance/request',form)));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const id=f.requests.rows('acceptance_requests')[0].id;
 assert.deepEqual(f.wire.map(x=>x.init.method),['GET','POST','GET','POST']);
 const notion=f.wire[1];assert.deepEqual(notion.body.parent,{type:'page_id',page_id:PINS.parent});
 assert.deepEqual(Object.keys(notion.body),['parent','properties','children']);
 assert.equal(notion.init.headers.Authorization,`Bearer ${f.env.ACCEPTANCE_NOTION_CREDENTIAL}`);
 assert.equal(notion.body.properties.title.title[0].text.content,'Task12 Acceptance — TEST Ticket');
 assert.match(notion.body.children[0].paragraph.rich_text[0].text.content,/TEST only\. No service grants/);
 assert.equal((await f.dispatch(id)).status,410);
 assert.doesNotMatch((await f.form('owner','/acceptance/requests/')).body,/\/dispatch/);
 assert.equal((await f.approve(id)).status,200);
 assert.equal((await f.get('member','/acceptance/app')).status,403);
 const confirmation=await f.form('owner',`/acceptance/requests/${id}/send-welcome`);
 assert.match(confirmation.body,/Confirm ONE TEST welcome/);
 assert.equal((await f.post('owner',`/acceptance/requests/${id}/send-welcome`,confirmation,{revision:'2',confirm:PINS.tester})).status,200);
 assert.equal((await f.welcome(id)).status,409);
 const emails=f.wire.filter(x=>x.url==='https://api.resend.com/emails');assert.equal(emails.length,2);
 for(const [i,mail] of emails.entries()) {
  assert.deepEqual(Object.keys(mail.body),['from','to','subject','text']);
  assert.equal(mail.body.from,'support@bigsoxstudios.com');
  assert.deepEqual(mail.body.to,[i===0?PINS.owner:PINS.tester]);
  assert.equal(mail.body.subject,i===0?noticeSubject:welcomeSubject);
  assert.equal(mail.init.headers.Authorization,`Bearer ${f.env.ACCEPTANCE_SENDER_CREDENTIAL}`);
  assert.match(mail.init.headers['Idempotency-Key'],/^[a-f0-9-]{36}$/);
 }
 assert.equal((await f.get('member','/acceptance/app')).status,200);
 const member=f.members.rows('acceptance_members')[0],revoke=await f.form('owner','/acceptance/members/');
 assert.equal((await f.post('owner',`/acceptance/members/${member.id}/remove`,revoke,{revision:'2'})).status,200);
 assert.equal((await f.get('member','/acceptance/app')).status,403);assert.equal(f.wire.length,5);
 assert.equal(f.members.rows('service_grants').length,0);
});

for(const [name,changes] of Object.entries({
 'expired':f=>({expiresAt:f.at}), 'future':f=>({issuedAt:f.at+1}), 'overlong':f=>({issuedAt:f.at-1,expiresAt:f.at+300}),
 'wrong run':()=>({runId:'another-test-run'}), 'wrong nonce':()=>({nonceDigest:hash('other')}),
 'wrong audience':()=>({audience:PINS.ownerAudience}), 'wrong revision':()=>({revision:'other'}),
 'wrong operator':()=>({operator:PINS.tester}), 'wrong independent readback':()=>({preflightDigest:hash('fabricated')}),
}))test(`HMAC operator attestation rejects ${name} before any D1 or provider access`,async t=>{
 const f=wired(t),token=signAttestation(f.env,f.preflight,f.tokens.member,f.at,changes(f));
 assert.equal((await f.get('member','/acceptance/request',{env:{ACCEPTANCE_OPERATOR_ATTESTATION:token}})).status,403);
 assert.equal(f.requests.touches+f.members.touches,0);assert.equal(f.wire.length,0);
});

test('missing/tampered HMAC and env MFA flags cannot replace independent preflight, Access signature or runtime identity',async t=>{
 const f=wired(t),valid=signAttestation(f.env,f.preflight,f.tokens.member,f.at);
 const [data,signature]=valid.split('.');const altered=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(data,'base64url')),expiresAt:f.at+1})).toString('base64url');
 for(const token of [undefined,'',`${altered}.${signature}`,`${data}.${signature.slice(0,-2)}AA`]) {
  assert.equal((await f.get('member','/acceptance/request',{env:{ACCEPTANCE_OPERATOR_ATTESTATION:token,MFA_VERIFIED:true,BINDINGS_VERIFIED:true}})).status,403);
 }
 const missing=fixture(t,{readTrustedPreflight:undefined});assert.equal((await missing.get('member','/acceptance/request')).status,403);
 const jwt=f.tokens.member.split('.');jwt[2]=Buffer.alloc(256).toString('base64url');
 assert.equal((await f.get('member','/acceptance/request',{token:jwt.join('.')})).status,403);
 assert.equal((await f.get('member','/acceptance/request',{ctx:{access:{aud:PINS.memberAudience,getIdentity:async()=>({email:PINS.tester,idp:{type:'google'}})}}})).status,403);
 assert.equal((await f.get('member','/acceptance/request',{ctx:{}})).status,403);
 assert.equal(f.requests.touches+f.members.touches,0);assert.equal(f.wire.length,0);
});

for(const [name,mutate] of Object.entries({
 'MFA':p=>{p.access.independentMfa=false;},'allowlist':p=>{p.access.twoIdentityOnly=false;},'OTP':p=>{p.access.memberOtp=false;},
 'Access audience':p=>{p.access.memberAudience='production';},'Requests physical UUID':p=>{p.bindings[0].physicalId=PINS.membersId;},
 'Members isolation':p=>{p.bindings[1].isolated=false;},'two distinct readbacks':p=>{p.bindings[1].readbackDigest=p.bindings[0].readbackDigest;},
 'grant readback':p=>{p.bindings[0].zeroGrants=false;},'private Notion parent':p=>{p.notion.privateParent=false;},
 'Notion destination-only key':p=>{p.notion.destinationOnly=false;},'Notion destination':p=>{p.notion.parent=childId;},
 'Notion credential':p=>{p.notion.credentialDigest=hash('other');},'Resend sending-only key':p=>{p.resend.sendingOnly=false;},
 'Resend domain limitation':p=>{p.resend.domainLimited=false;},'verified sender':p=>{p.resend.senderVerified=false;},
 'invalid free quota':p=>{p.resend.freeQuotaRemaining=-1;},'paid fallback':p=>{p.resend.paidFallback=true;},'no spend':p=>{p.resend.zeroSpend=false;},
 'sender pin':p=>{p.resend.sender='attacker@bigsoxstudios.com';},'scope freshness':p=>{p.observedAt-=301;},'revoked proof':p=>{p.revoked=true;},
}))test(`even freshly signed synthetic attestation cannot bypass ${name} evidence requirements`,async t=>{
 const f=wired(t);mutate(f.preflight);
 assert.equal((await f.get('member','/acceptance/request')).status,403);
 assert.equal(f.requests.touches+f.members.touches,0);assert.equal(f.wire.length,0);
});

test('preflight revocation denies original session with no additional network or D1 access',async t=>{
 const f=wired(t);assert.equal((await f.get('member','/acceptance/request')).status,200);
 const before=f.requests.touches+f.members.touches;f.preflight.revoked=true;
 assert.equal((await f.get('member','/acceptance/request')).status,403);
 assert.equal(f.requests.touches+f.members.touches,before);assert.equal(f.wire.length,0);
});

for(const [name,mutate] of Object.entries({
 'wrong page':v=>{v.id=childId;},'archived':v=>{v.archived=true;},'trash':v=>{v.in_trash=true;},'public':v=>{v.public_url='https://notion.site/public';},'database':v=>{v.object='database';},
}))test(`Notion parent GET rejects ${name}; never POSTs or sends`,async t=>{
 const f=wired(t,{respond:({value})=>{mutate(value);return Response.json(value);}});
 assert.equal((await f.submit()).res.status,409);assert.equal(f.wire.length,1);
 assert.equal(f.requests.rows('acceptance_effects')[0].state,'unknown');
 assert.equal(f.requests.rows('acceptance_effects')[1].state,'reserved');
 assert.equal((await f.submit()).res.status,409);assert.equal(f.wire.length,1);
});

for(const mode of ['wrong child parent','wrong receipt parent','wrong receipt title','redirect','malformed','timeout','429'])test(`Notion ${mode} consumes attempts forever without Gmail notice`,async t=>{
 const f=wired(t,{respond:({url,init,value})=>{
  if(mode==='redirect' && init.method==='POST')return new Response(null,{status:302,headers:{Location:'https://evil.example'}});
  if(mode==='malformed' && init.method==='POST')return new Response('{',{headers:{'Content-Type':'application/json'}});
  if(mode==='timeout' && init.method==='POST')throw Error('synthetic socket timeout');
  if(mode==='429' && init.method==='POST')return Response.json({error:'rate limit'},{status:429});
  if(mode==='wrong child parent' && init.method==='POST')value.parent.page_id=childId;
  if(mode==='wrong receipt parent' && url.endsWith(childId))value.parent.page_id=childId;
  if(mode==='wrong receipt title' && url.endsWith(childId))value.properties.title.title=[];
  return Response.json(value);
 }});
 const {res,id}=await f.submit();assert.equal(res.status,409);
 assert.equal(f.requests.rows('acceptance_effects')[0].state,'unknown');
 assert.equal((await f.dispatch(id)).status,410);assert.equal((await f.submit()).res.status,409);
 assert.equal(f.wire.some(x=>x.url.includes('resend')),false);
});

for(const mode of ['redirect','malformed','timeout','429','missing id'])test(`Resend ${mode} is terminal UNKNOWN; no retry endpoint`,async t=>{
 const f=wired(t,{respond:({url,value})=>{
  if(url.includes('resend')) {
   if(mode==='redirect')return new Response(null,{status:307,headers:{Location:'https://evil.example'}});
   if(mode==='malformed')return new Response('{',{headers:{'Content-Type':'application/json'}});
   if(mode==='timeout')throw Error('synthetic timeout after write');
   if(mode==='429')return Response.json({error:'rate limit'},{status:429});
   return Response.json({});
  }
  return Response.json(value);
 }});
 const {res,id}=await f.submit();assert.equal(res.status,409);
 assert.deepEqual(f.requests.rows('acceptance_effects').map(e=>e.state),['accepted','unknown']);
 assert.equal((await f.approve(id)).status,409);assert.equal((await f.dispatch(id)).status,410);assert.equal((await f.submit()).res.status,409);
 assert.equal(f.wire.length,4);assert.equal(f.members.rows('service_grants').length,0);
});

test('adapter rejects injected sender/recipient/CC/BCC/subject/text/parent and wrong credentials before transport',async t=>{
 const f=fixture(t),proof=await attestation(f);let calls=0;
 const adapters=createStagingProviders({fetcher:async()=>{calls++;throw Error('no transport expected');},now:f.now});
 const payload=providerPayload('owner_notice',{id:crypto.randomUUID()},crypto.randomUUID(),await sha256(PINS.owner));
 for(const change of [{from:'hello@bigsoxstudios.com'},{to:'fridman.greg+test@gmail.com'},{to:PINS.tester},{cc:[PINS.owner]},{bcc:[PINS.tester]},
  {subject:'TEST other'},{subject:'request awaiting review'},{text:'TEST arbitrary'},{reply_to:PINS.owner},{headers:{X:'test'}}]) {
  await assert.rejects(adapters.send({...payload,...change},{credential:f.env.ACCEPTANCE_SENDER_CREDENTIAL,attestation:proof,signal:new AbortController().signal}));
 }
 await assert.rejects(adapters.send(payload,{credential:'another-credential',attestation:proof,signal:new AbortController().signal}));
 await assert.rejects(adapters.send(payload,{credential:f.env.ACCEPTANCE_SENDER_CREDENTIAL,attestation:{...proof},signal:new AbortController().signal}));
 const ticket=providerPayload('notion_ticket',{id:crypto.randomUUID(),run_id:f.env.ACCEPTANCE_RUN_ID},crypto.randomUUID());
 for(const change of [{parent:childId},{title:'Real ticket'},{runId:'other-run'},{children:[]},{status:'approved'}])await assert.rejects(adapters.createTicket({...ticket,...change},{credential:f.env.ACCEPTANCE_NOTION_CREDENTIAL,attestation:proof,signal:new AbortController().signal}));
 assert.equal(calls,0);
});

test('Member reservation rolls back request/run/outbox and both effects if the second effect cannot be inserted',async t=>{
 const f=wired(t);
 f.requests.sqlite.exec("CREATE TRIGGER synthetic_reservation_failure BEFORE INSERT ON acceptance_effects WHEN NEW.kind='owner_notice' BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END;");
 assert.equal((await f.submit()).res.status,409);
 for(const table of ['acceptance_run','acceptance_requests','acceptance_effects','acceptance_outbox','acceptance_audit'])assert.equal(f.requests.rows(table).length,0,table);
 assert.equal(f.wire.length,0);
});

test('stale verifier clock cannot leave a partial Member reservation after database-time expiry',async t=>{
 const f=wired(t),expiry=Math.floor(Date.now()/1000)+1;f.tokens.member=f.jwt('member',{exp:expiry});
 const form=await f.form('member','/acceptance/request');assert.equal(form.res.status,200);
 f.requests.hook=async sql=>{if(sql==='BATCH')await new Promise(resolve=>setTimeout(resolve,1200));};
 assert.equal((await f.post('member','/acceptance/request',form)).status,409);
 for(const table of ['acceptance_run','acceptance_requests','acceptance_effects','acceptance_outbox'])assert.equal(f.requests.rows(table).length,0,table);
 assert.equal(f.wire.length,0);
});

test('runtime OTP tamper between identity reads fails closed despite a signed preflight',async t=>{
 const f=wired(t);let reads=0;
 const ctx={access:{aud:PINS.memberAudience,getIdentity:async()=>({email:PINS.tester,idp:{type:++reads===1?'onetimepin':'google'}})}};
 assert.equal((await f.get('member','/acceptance/request',{ctx})).status,403);
 assert.equal(f.requests.touches+f.members.touches,0);assert.equal(f.wire.length,0);
});

test('runtime sender/key substitutions cannot be authorized by env readiness flags',async t=>{
 const f=wired(t);
 for(const change of [{ACCEPTANCE_VERIFIED_SENDER:undefined},{ACCEPTANCE_VERIFIED_SENDER:'hello@bigsoxstudios.com'},
  {ACCEPTANCE_NOTION_CREDENTIAL:'different-notion-runtime-credential'}, {ACCEPTANCE_SENDER_CREDENTIAL:'different-resend-runtime-credential'},
  {ACCEPTANCE_ATTESTATION_KEY:f.env.ACCEPTANCE_CSRF_KEY},{ACCEPTANCE_ATTESTATION_KEY:f.env.ACCEPTANCE_RUN_NONCE}]) {
  assert.equal((await f.get('member','/acceptance/request',{env:{...change,MFA_VERIFIED:true,SENDER_VERIFIED:true}})).status,403);
 }
 assert.equal(f.requests.touches+f.members.touches,0);assert.equal(f.wire.length,0);
});


async function renewablePair(f,at,generation) {
 const proof=preflightFixture(f.env,at);
 for(const role of ['owner','member'])await applyOperatorLease({db:f.requests,
  row:prepareOperatorLease({role,env:f.env,proof,at,generation})});
 return proof;
}
test('default staging verifier requires renewable signed D1 proof and denies ENV fallback, replay and tamper',async t=>{
 const f=fixture(t,{entries:true,verifyAccessPolicy:undefined,readTrustedPreflight:undefined});
 assert.equal((await f.get('member','/acceptance/request')).status,403);
 f.env.ACCEPTANCE_TRUSTED_PREFLIGHT=JSON.stringify(f.preflight);
 assert.equal((await f.get('owner','/acceptance/requests/')).status,403);
 await renewablePair(f,f.at,1);
 assert.equal((await f.get('member','/acceptance/request')).status,200);
 assert.equal((await f.get('owner','/acceptance/requests/')).status,200);
 assert.equal(f.requests.rows('acceptance_requests').length,0);
 assert.equal(f.requests.rows('acceptance_preflight_history').length,2);
 const row=f.requests.rows('acceptance_preflight_lease').find(x=>x.role==='member');
 await assert.rejects(f.requests.prepare('UPDATE acceptance_preflight_lease SET snapshot_json=? WHERE role=?')
  .bind(JSON.stringify({...f.preflight,access:{...f.preflight.access,independentMfa:false}}),'member').run());
 await assert.rejects(applyOperatorLease({db:f.requests,row:{...row,generation:1}}));
 assert.equal((await f.get('member','/acceptance/request')).status,200);
 f.time((f.at+301)*1000);
 assert.equal((await f.get('member','/acceptance/request')).status,403);
});
test('operator renewal preserves run and audit across long multi-browser acceptance; stale/replay/revoke fail closed',async t=>{
 const f=fixture(t,{entries:true,verifyAccessPolicy:undefined,readTrustedPreflight:undefined});
 // Same signed Owner/Member Access sessions survive; only operator proof renews.
 f.tokens.member=f.jwt('member',{exp:f.at+7200});
 f.tokens.owner=f.jwt('owner',{exp:f.at+7200});
 await renewablePair(f,f.at,1);
 const {res,id}=await f.submit();assert.equal(res.status,201);
 assert.equal(f.calls.length,2);
 f.time((f.at+360)*1000);
 assert.equal((await f.get('owner','/acceptance/requests/')).status,403);
 await renewablePair(f,f.at+360,2);
 assert.equal((await f.approve(id)).status,200);
 f.time((f.at+720)*1000);
 await renewablePair(f,f.at+720,3);
 assert.equal((await f.welcome(id)).status,200);
 f.time((f.at+1080)*1000);
 await renewablePair(f,f.at+1080,4);
 assert.equal((await f.get('member','/acceptance/app')).status,200);
 assert.equal(f.requests.rows('acceptance_effects').length,3);
 assert.equal(f.calls.length,3);
 f.time((f.at+1440)*1000);
 await renewablePair(f,f.at+1440,5);
 const member=f.members.rows('acceptance_members')[0];
 const ownerForm=await f.form('owner','/acceptance/members/');
 assert.equal((await f.post('owner','/acceptance/members/'+member.id+'/remove',ownerForm,{revision:'2',confirm:'TEST'})).status,200);
 assert.equal((await f.get('member','/acceptance/app')).status,403);
 assert.equal(f.requests.rows('acceptance_effects').length,3);
 assert.equal(f.calls.length,3);
 assert.equal(f.members.rows('service_grants').length,0);
 assert.equal(f.requests.rows('acceptance_preflight_history').length,10);
 await assert.rejects(f.requests.prepare('UPDATE acceptance_preflight_lease SET generation=1 WHERE role=?').bind('member').run());
 await f.requests.prepare('UPDATE acceptance_preflight_lease SET revoked=1 WHERE role=?').bind('member').run();
 assert.equal((await f.get('member','/acceptance/app')).status,403);
 await assert.rejects(applyOperatorLease({db:f.requests,row:prepareOperatorLease({
  role:'member',env:f.env,proof:preflightFixture(f.env,f.at+1500),at:f.at+1500,generation:6})}));
 assert.equal(f.requests.rows('acceptance_preflight_history').length,11);
});


test('quota is required for each irreversible TEST send, but not after sends are consumed',async t=>{
 const f=fixture(t,{entries:true});
 f.preflight.resend.freeQuotaRemaining=1;
 const missing=await f.submit();assert.equal(missing.res.status,409);
 assert.equal(f.requests.rows('acceptance_requests').length,0);
 assert.equal(f.calls.length,0);
 f.preflight.resend.freeQuotaRemaining=2;
 const {res,id}=await f.submit();assert.equal(res.status,201);
 assert.equal(f.calls.length,2);
 assert.equal((await f.approve(id)).status,200);
 f.preflight.resend.freeQuotaRemaining=0;
 assert.equal((await f.welcome(id)).status,409);
 assert.equal(f.calls.length,2);
 assert.equal(f.requests.rows('acceptance_effects').length,2);
 f.preflight.resend.freeQuotaRemaining=1;
 assert.equal((await f.welcome(id)).status,200);
 f.preflight.resend.freeQuotaRemaining=0;
 assert.equal((await f.get('member','/acceptance/app')).status,200);
 assert.equal(f.calls.length,3);
 assert.equal(f.members.rows('service_grants').length,0);
});
