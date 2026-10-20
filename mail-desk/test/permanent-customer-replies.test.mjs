import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { customerReplies, replyPolicy, prepareReply, sendReply } from '../src/reply.resend.mjs';
import { claimSend } from '../src/store.mjs';
const migration = await readFile(new URL('../migrations/0005_simple_replies.sql', import.meta.url), 'utf8');
const owner = 'fridman.greg@gmail.com', customer = 'Customer+Ticket@external.example.test';
const ownerEnv = { DEPLOYMENT_STAGE:'staging', SEND_MODE:'live', ALLOW_REAL_SEND:'true', MAILDESK_REPLY_ACTIVATION:'owner-self-v1', MAILDESK_RECIPIENT_ALLOWLIST:JSON.stringify([owner]), OWNER_EMAIL:owner, RESEND_API_KEY:'re_OFFLINE_SYNTHETIC_NOT_A_REAL_KEY_0000' };
const env = { ...ownerEnv, MAILDESK_REPLY_ACTIVATION:'owner-reviewed-customers-v2', MAILDESK_CUSTOMER_REPLIES:'enabled', MAILDESK_CUSTOMER_RECIPIENT_POLICY:'exact-forwarded-requester-v2', MAILDESK_CUSTOMER_TEST_RECIPIENT:'', MAILDESK_CUSTOMER_TEST_EXPIRES_AT:'' };
const snapshot = recipient => ({ id:crypto.randomUUID(), sender:'support@bigsoxstudios.com', recipient, subject:'Exact subject', body:'Exact plain text <script>inert</script>' });
async function setup(t, { settings = env, transport = async()=>Response.json({id:'11111111-1111-4111-8111-111111111111'}) } = {}) {
 let calls = 0; const seen = [];
 const f = await fixture(t, { env:settings, notion:true, replyTransport:async(url, options)=>{calls++; seen.push({url,options}); return transport(url,options);} });
 f.DB.sqlite.exec(migration); await f.session();
 async function inbound(from = customer, to = 'support@bigsoxstudios.com', headers = {}) {
  const raw = new TextEncoder().encode('From: header-spoof@example.test\r\nReply-To: redirect@example.test\r\nSubject: Offline\r\n\r\nOffline incoming.');
  await f.worker.email({from,to,headers:new Headers(headers),rawSize:raw.length,raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),setReject(){assert.fail('unexpected rejection');},async forward(){}}, {...f.env,ENABLE_INBOUND_EMAIL:'true',INBOUND_FORWARD_TO:owner}, {});
  return f.DB.sqlite.prepare('SELECT case_id FROM email_receipts ORDER BY rowid DESC LIMIT 1').get().case_id;
 }
 const id = await inbound();
 const send = r => f.request(`/api/cases/${id}/send`, {intentId:r.id,approval:r.approval,confirmed:true});
 async function reviewResponse() {
  const c = f.DB.sqlite.prepare('SELECT revision FROM cases WHERE id=?').get(id);
  const d = await f.request(`/api/cases/${id}/draft`, {revision:c.revision, body:'Exact reply <b>inert</b>'});
  assert.equal(d.status,200);
  return f.request(`/api/cases/${id}/review`, {revision:(await d.json()).revision});
 }
 return {...f,id,inbound,send,reviewResponse,seen,wireCalls:()=>calls};
}
test('existing owner settings and absent customer flags cannot activate customers',()=>{
 assert.equal(replyPolicy(ownerEnv),'owner-self-v1'); assert.equal(customerReplies(ownerEnv),false);
 assert.throws(()=>prepareReply(snapshot(customer),ownerEnv));
 assert.equal(customerReplies({}),false);
 assert.equal(customerReplies({...env,MAILDESK_CUSTOMER_REPLIES:undefined,MAILDESK_CUSTOMER_RECIPIENT_POLICY:undefined}),false);
});
for (const [key,value] of Object.entries({MAILDESK_CUSTOMER_REPLIES:'true',MAILDESK_CUSTOMER_RECIPIENT_POLICY:'allow-all',MAILDESK_REPLY_ACTIVATION:'owner-reviewed-customers',ALLOW_REAL_SEND:'false',SEND_MODE:'mock',DEPLOYMENT_STAGE:'production',OWNER_EMAIL:customer,RESEND_API_KEY:'invalid',MAILDESK_RECIPIENT_ALLOWLIST:JSON.stringify([owner,customer])})) test(`customer gate rejects incorrect ${key}`,()=>{
 const settings = {...env,[key]:value}; assert.equal(customerReplies(settings),false);
 assert.throws(()=>prepareReply(snapshot(customer),settings));
});
for (const recipient of ['postmaster@example.test','mailer-daemon@example.test','noreply@example.test','no-reply+tag@example.test','support@bigsoxstudios.com','bad\r\nBcc:x@example.test','a\0b@example.test','a..b@example.test']) test(`customer unsafe mailbox ${JSON.stringify(recipient)} rejected`,()=>assert.throws(()=>prepareReply(snapshot(recipient),env)));
test('customer preparation cannot cross back into owner policy or disabled flags',async()=>{
 const prepared = prepareReply(snapshot(customer),env);
 for (const settings of [ownerEnv,{...env,MAILDESK_CUSTOMER_REPLIES:'off'}]) await assert.rejects(sendReply(prepared,settings,async()=>{},async()=>assert.fail('no HTTP')));
});
test('mocked customer provider exchange uses envelope recipient, ignoring spoofed From and Reply-To',async t=>{
 const f = await setup(t); const r = await f.review(f.id,'Exact reply <b>inert</b>');
 assert.equal(r.to,customer);assert.equal(r.policy,'owner-reviewed-customers-v2');assert.equal(r.mode,'live');assert.equal(f.wireCalls(),0);
 const response = await f.send(r);assert.equal(response.status,200);assert.equal((await response.json()).status,'sent');
 assert.equal(f.wireCalls(),1);assert.equal(f.seen[0].url,'https://api.resend.com/emails');
 assert.deepEqual(JSON.parse(f.seen[0].options.body),{from:'support@bigsoxstudios.com',to:[customer],subject:r.subject,text:r.body});
 // Evidence establishes a route only: the envelope itself could also be spoofed.
 assert.equal((await f.session()).v.replyPolicy,'owner-reviewed-customers-v2');
});
const corruptions = {
 'mismatched envelope sender': f=>f.DB.sqlite.prepare('UPDATE email_receipts SET envelope_from=?').run('attacker@example.test'),
 'case recipient forged': f=>f.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run('forged@example.test'),
 'UNKNOWN receipt': f=>f.DB.sqlite.exec("UPDATE email_receipts SET forward_state='UNKNOWN'"),
 'unforwarded receipt': f=>f.DB.sqlite.exec("UPDATE email_receipts SET forward_state='claimed'"),
 'wrong support envelope': f=>f.DB.sqlite.exec("UPDATE email_receipts SET envelope_to='hello@bigsoxstudios.com'"),
 'wrong case channel': f=>f.DB.sqlite.exec("UPDATE cases SET channel='hello'"),
 'missing receipt linkage': f=>f.DB.sqlite.exec('DELETE FROM email_receipt_messages'),
 'receipt linked to outbound message': f=>f.DB.sqlite.exec("UPDATE messages SET direction='outbound'"),
 'unmapped inbound message': f=>f.DB.sqlite.prepare("INSERT INTO messages VALUES (?,?,'inbound','unmapped',1,NULL)").run(crypto.randomUUID(),f.id),
 'synthetic intake marker': f=>f.DB.sqlite.prepare('INSERT INTO inbound_dedupe VALUES (?,?,?)').run('synthetic',f.id,1),
 'case recipient NUL suffix': f=>f.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run(customer+'\0attacker'),
 'receipt recipient NUL suffix': f=>f.DB.sqlite.prepare('UPDATE email_receipts SET envelope_from=?').run(customer+'\0attacker'),
 'stored subject NUL suffix': f=>f.DB.sqlite.prepare('UPDATE cases SET subject=?').run('Offline\0hidden'),
 'case recipient header injection': f=>f.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run('bad@example.test\r\nBcc: bad@example.test')
};
for (const [name,corrupt] of Object.entries(corruptions)) for (const phase of ['review','dispatch']) test(`customer ${phase} rejects ${name}`,async t=>{
 const f = await setup(t); let r;
 if (phase==='dispatch') r = await f.review(f.id);
 corrupt(f);
 const response = phase==='review' ? await f.reviewResponse() : await f.send(r);
 assert.ok([403,409].includes(response.status),`${response.status}: ${await response.text()}`);assert.equal(f.wireCalls(),0);
});
for (const phase of ['review','dispatch']) test(`customer ${phase} rejects ambiguous linked senders even with one valid receipt`,async t=>{
 const f = await setup(t); let r;if(phase==='dispatch') r=await f.review(f.id);
 const other = await f.inbound('other@example.test');
 f.DB.sqlite.prepare('UPDATE email_receipts SET case_id=? WHERE case_id=?').run(f.id,other);
 f.DB.sqlite.prepare('UPDATE messages SET case_id=? WHERE case_id=?').run(f.id,other);
 const response = phase==='review' ? await f.reviewResponse() : await f.send(r);
 assert.equal(response.status,403);assert.equal(f.wireCalls(),0);
});
test('synthetic case cannot get a live customer review',async t=>{
 const f=await setup(t);const c=await f.seed({channel:'support',requester_email:'Synthetic@example.test'});
 f.DB.sqlite.prepare('UPDATE cases SET requester_email=? WHERE id=?').run(customer,c);
 await assert.rejects(f.review(c),/reply_inbound_required/);assert.equal(f.wireCalls(),0);
});
test('atomic customer claim rechecks evidence after preflight',async t=>{
 const f=await setup(t);const r=await f.review(f.id);const i=f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id);
 f.DB.sqlite.exec("UPDATE email_receipts SET forward_state='UNKNOWN'");
 assert.equal(await claimSend(f.DB,i,true,true),null);assert.equal(f.wireCalls(),0);
});
test('owner and customer review signatures cannot cross policies, including owner destination',async t=>{
 const f=await setup(t,{settings:ownerEnv});f.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run(owner);f.DB.sqlite.prepare('UPDATE email_receipts SET envelope_from=?').run(owner);
 const r=await f.review(f.id);Object.assign(f.env,env);
 assert.equal((await f.send(r)).status,403);assert.equal(f.wireCalls(),0);
 const customerReview=await f.request(`/api/cases/${f.id}/review`,{revision:r.revision});
 assert.equal(customerReview.status,200); // Fresh v2 approval may address any eligible exact requester, including owner.
 Object.assign(f.env,ownerEnv);assert.equal(f.wireCalls(),0);
});
test('customer concurrent confirmations attempt at most one provider request',async t=>{
 let release;const gate=new Promise(r=>release=r);
 const f=await setup(t,{transport:async()=>{await gate;return Response.json({id:'11111111-1111-4111-8111-111111111111'});}});const r=await f.review(f.id);
 const pending=Array.from({length:5},()=>f.send(r));while(!f.wireCalls()) await new Promise(r=>setImmediate(r));release();
 assert.ok((await Promise.all(pending)).every(r=>r.status===200));assert.equal(f.wireCalls(),1);
});
test('customer lost provider response is terminal UNKNOWN and cannot retry',async t=>{
 const f=await setup(t,{transport:async()=>{throw Error('lost response');}});const r=await f.review(f.id);
 assert.equal((await (await f.send(r)).json()).status,'UNKNOWN');
 assert.equal((await (await f.send(r)).json()).status,'UNKNOWN');assert.equal(f.wireCalls(),1);
 await assert.rejects(f.review(f.id),/revision_or_delivery_conflict/);
});

test('worker atomic claim rejects receipt evidence changed after its preflight read',async t=>{
 const f=await setup(t);const r=await f.review(f.id);const prepare=f.DB.prepare.bind(f.DB);
 f.DB.prepare=sql=>{
  const statement=prepare(sql),bind=statement.bind;
  statement.bind=(...args)=>{
   const bound=bind(...args),run=bound.run;
   bound.run=async()=>{
    const result=await run();
    if(sql==='INSERT INTO audit_events VALUES (?,?,?,?,?)' && args[1]==='reply_config_approved')f.DB.sqlite.exec("UPDATE email_receipts SET forward_state='UNKNOWN'");
    return result;
   };
   return bound;
  };
  return statement;
 };
 assert.equal((await f.send(r)).status,409);assert.equal(f.wireCalls(),0);
 assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents').get().status,'reserved');
});
test('multiple forwarded incoming receipts from the same exact requester remain eligible',async t=>{
 const f=await setup(t);const other=await f.inbound(customer,'support@bigsoxstudios.com',{'message-id':'<second@example.test>'});
 f.DB.sqlite.prepare('UPDATE email_receipts SET case_id=? WHERE case_id=?').run(f.id,other);
 f.DB.sqlite.prepare('UPDATE messages SET case_id=? WHERE case_id=?').run(f.id,other);
 const r=await f.review(f.id);assert.equal((await (await f.send(r)).json()).status,'sent');assert.equal(f.wireCalls(),1);
});
test('customer mode cannot upgrade an existing immutable simulated review',async t=>{
 const f=await setup(t,{settings:{...env,SEND_MODE:'mock'}});const r=await f.review(f.id);assert.equal(r.mode,'mock');
 f.env.SEND_MODE='live';assert.equal((await f.send(r)).status,403);
 assert.equal((await f.request(`/api/cases/${f.id}/review`,{revision:r.revision})).status,409);
 assert.equal(f.DB.sqlite.prepare('SELECT mode FROM reply_review_modes').get().mode,'mock');assert.equal(f.wireCalls(),0);
});
test('repository customer defaults remain explicitly closed alongside the owner allowlist',async()=>{
 const config=await readFile(new URL('../wrangler.staging.toml',import.meta.url),'utf8');
 assert.match(config,/^MAILDESK_CUSTOMER_REPLIES = "off"$/m);
 assert.match(config,/^MAILDESK_CUSTOMER_RECIPIENT_POLICY = "off"$/m);
 assert.match(config,/^MAILDESK_REPLY_ACTIVATION = "off"$/m);
 assert.ok(config.includes(`MAILDESK_RECIPIENT_ALLOWLIST = '${JSON.stringify([owner])}'`));
});

const temporary = {...env, MAILDESK_REPLY_ACTIVATION:'owner-reviewed-customers-v1', MAILDESK_CUSTOMER_RECIPIENT_POLICY:'exact-forwarded-requester-v1', MAILDESK_CUSTOMER_TEST_RECIPIENT:'greg.fridman@outlook.com', MAILDESK_CUSTOMER_TEST_EXPIRES_AT:String(Math.floor(Date.now()/1000)+3600)};
for (const field of ['MAILDESK_CUSTOMER_TEST_RECIPIENT','MAILDESK_CUSTOMER_TEST_EXPIRES_AT']) for (const value of [undefined,' ','stale','0']) test(`permanent mode requires explicitly empty ${field}: ${String(value)}`,()=>{
 const changed={...env,[field]:value};assert.equal(replyPolicy(changed),'off');assert.throws(()=>prepareReply(snapshot(customer),changed));
});
for (const field of Object.keys(env)) test(`permanent configuration missing ${field} fails closed`,()=>{
 const changed={...env};delete changed[field];assert.equal(replyPolicy(changed),'off');assert.throws(()=>prepareReply(snapshot(customer),changed));
});
test('permanent multiple distinct cases and separately approved revisions to exact same recipient dispatch',async t=>{
 const f=await setup(t);
 const first=await f.review(f.id);assert.equal((await (await f.send(first)).json()).status,'sent');
 assert.equal((await (await f.send(first)).json()).status,'sent');assert.equal(f.wireCalls(),1);
 const second=await f.review(f.id,'Separately approved second reply');assert.equal((await (await f.send(second)).json()).status,'sent');
 const other=await f.inbound(customer,'support@bigsoxstudios.com',{'message-id':'<distinct-case@example.test>'});assert.notEqual(other,f.id);
 const third=await f.review(other,'Separately approved other case');
 const result=await f.request(`/api/cases/${other}/send`,{intentId:third.id,approval:third.approval,confirmed:true});assert.equal((await result.json()).status,'sent');
 assert.equal(f.wireCalls(),3);assert.equal(new Set(f.seen.map(x=>x.options.headers['Idempotency-Key'])).size,3);
 for(const call of f.seen)assert.deepEqual(JSON.parse(call.options.body).to,[customer]);
});
test('permanent UNKNOWN locks its case but does not impose a global recipient cap',async t=>{
 let count=0;const f=await setup(t,{transport:async()=>{if(++count===1)throw Error('offline lost');return Response.json({id:'11111111-1111-4111-8111-111111111111'});}});
 const r=await f.review(f.id);assert.equal((await (await f.send(r)).json()).status,'UNKNOWN');
 const other=await f.inbound(customer,'support@bigsoxstudios.com',{'message-id':'<after-unknown@example.test>'});assert.notEqual(other,f.id);const next=await f.review(other);
 assert.equal((await (await f.request(`/api/cases/${other}/send`,{intentId:next.id,approval:next.approval,confirmed:true})).json()).status,'sent');assert.equal(f.wireCalls(),2);
 assert.equal((await (await f.send(r)).json()).status,'UNKNOWN');assert.equal(f.wireCalls(),2);
});
for(const from of ['owner-self-v1','owner-reviewed-customers-v1','owner-reviewed-customers-v2']) for(const to of ['owner-self-v1','owner-reviewed-customers-v1','owner-reviewed-customers-v2']) if(from!==to) test(`approval namespace ${from} cannot send under ${to}`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:1792454400000});
 const settings=policy=>policy==='owner-self-v1'?ownerEnv:policy==='owner-reviewed-customers-v1'?{...temporary,MAILDESK_CUSTOMER_TEST_EXPIRES_AT:String(Math.floor(Date.now()/1000)+3600)}:env;
 const f=await setup(t,{settings:settings(from)});
 const recipient=from==='owner-self-v1'?owner:from==='owner-reviewed-customers-v1'?'greg.fridman@outlook.com':customer;
 f.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run(recipient);f.DB.sqlite.prepare('UPDATE email_receipts SET envelope_from=?').run(recipient);
 const r=await f.review(f.id);Object.assign(f.env,settings(to));assert.equal((await f.send(r)).status,403);assert.equal(f.wireCalls(),0);
});
for(const confirmed of [undefined,false,'true',1]) test(`v2 requires literal manual confirmation ${String(confirmed)}`,async t=>{
 const f=await setup(t);const r=await f.review(f.id);const response=await f.request(`/api/cases/${f.id}/send`,{intentId:r.id,approval:r.approval,confirmed});assert.equal(response.status,400);assert.equal(f.wireCalls(),0);
});
for(const field of ['to','recipient','from','sender','cc','bcc','html']) test(`v2 rejects arbitrary ${field} on every write`,async t=>{
 const f=await setup(t);const r=await f.review(f.id);
 for(const [action,payload] of [['draft',{revision:r.revision,body:'changed'}],['review',{revision:r.revision}],['send',{intentId:r.id,approval:r.approval,confirmed:true}]]) assert.equal((await f.request(`/api/cases/${f.id}/${action}`,{...payload,[field]:'attacker@example.test'})).status,400);
 assert.equal(f.wireCalls(),0);
});
test('v2 preserves ten minute expiration and rejects expired approval',async t=>{
 const f=await setup(t);const r=await f.review(f.id);const row=f.DB.sqlite.prepare('SELECT created_at,approval_expires FROM outbound_intents').get();assert.equal(row.approval_expires-row.created_at,600);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+601000});
 assert.equal((await f.send(r)).status,409);assert.equal(f.wireCalls(),0);
});
test('v2 preparation cannot cross into temporary policy',async()=>{
 const p=prepareReply(snapshot('greg.fridman@outlook.com'),env);
 await assert.rejects(sendReply(p,temporary,async()=>{},async()=>assert.fail('no network')),/reply_preflight_rejected/);
});
test('literal mixed-case requester is preserved and normalization is not accepted',async t=>{
 const f=await setup(t);const r=await f.review(f.id);assert.equal(r.to,customer);
 f.DB.sqlite.prepare('UPDATE email_receipts SET envelope_from=?').run(customer.toLowerCase());assert.equal((await f.send(r)).status,403);assert.equal(f.wireCalls(),0);
});

test('v2 stored body NUL rejects review and send without truncation',async t=>{
 const f=await setup(t);const r=await f.review(f.id);
 f.DB.sqlite.prepare('UPDATE cases SET draft=?').run(r.body+'\0hidden');
 assert.equal((await f.request(`/api/cases/${f.id}/review`,{revision:r.revision})).status,403);
 assert.equal((await f.send(r)).status,403);assert.equal(f.wireCalls(),0);
});
for(const recipient of ['', '*', 'person', 'a@localhost', 'a@@example.test', 'a@example.test,b@example.test', 'Name <a@example.test>', ' a@example.test', 'a@example.test ', 'a@example.test\n', '.a@example.test', 'a.@example.test', 'a@-example.test', 'a@bigsoxstudios.COM', 'no_reply@example.test', 'donotreply@example.test', `${'a'.repeat(65)}@example.test`]) test(`permanent recipient rejects ${JSON.stringify(recipient)}`,()=>assert.throws(()=>prepareReply(snapshot(recipient),env)));
test('v2 distinct customer destinations each require their own exact approval',async t=>{
 const f=await setup(t);const one=await f.review(f.id);const other=await f.inbound('Another.Customer@example.test');const two=await f.review(other);
 assert.equal((await f.request(`/api/cases/${other}/send`,{intentId:one.id,approval:one.approval,confirmed:true})).status,403);
 assert.equal((await (await f.send(one)).json()).status,'sent');
 assert.equal((await (await f.request(`/api/cases/${other}/send`,{intentId:two.id,approval:two.approval,confirmed:true})).json()).status,'sent');
 assert.deepEqual(f.seen.map(x=>JSON.parse(x.options.body).to),[[customer],['Another.Customer@example.test']]);
});
for(const [name,headers] of Object.entries({unauthenticated:{'Cf-Access-Jwt-Assertion':null},'no session':{Cookie:null},'no csrf':{'X-CSRF-Token':null},'cross origin':{Origin:'https://attacker.example.test'}})) test(`v2 review and send retain protection: ${name}`,async t=>{
 const f=await setup(t);const r=await f.review(f.id);
 for(const [action,data] of [['review',{revision:r.revision}],['send',{intentId:r.id,approval:r.approval,confirmed:true}]]) assert.ok([401,403].includes((await f.request(`/api/cases/${f.id}/${action}`,data,{headers})).status));
 assert.equal(f.wireCalls(),0);
});
for(const field of ['subject','body']) for(const value of ['bad\0hidden',field==='subject'?'bad\r\nBcc:attacker@example.test':'',field==='subject'?'x'.repeat(999):'x'.repeat(10001)]) test(`v2 ${field} payload validation ${value.length}`,()=>assert.throws(()=>prepareReply({...snapshot(customer),[field]:value},env)));
test('temporary Outlook v1 global single-send cap remains across distinct cases',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1792454400000});
 const settings={...temporary,MAILDESK_CUSTOMER_TEST_EXPIRES_AT:String(Math.floor(Date.now()/1000)+3600)};
 const f=await setup(t,{settings});const address='greg.fridman@outlook.com';
 const first=await f.inbound(address,'support@bigsoxstudios.com',{'message-id':'<outlook-one@example.test>'});
 const second=await f.inbound(address,'support@bigsoxstudios.com',{'message-id':'<outlook-two@example.test>'});
 const a=await f.review(first),b=await f.review(second);
 const send=r=>f.request(`/api/cases/${r.caseId}/send`,{intentId:r.id,approval:r.approval,confirmed:true});
 assert.equal((await (await send(a)).json()).status,'sent');assert.equal((await send(b)).status,409);assert.equal(f.wireCalls(),1);
});
for(const [field,value] of Object.entries({MAILDESK_CUSTOMER_REPLIES:'off',MAILDESK_CUSTOMER_RECIPIENT_POLICY:'exact-forwarded-requester-v1',MAILDESK_CUSTOMER_TEST_RECIPIENT:'greg.fridman@outlook.com',MAILDESK_CUSTOMER_TEST_EXPIRES_AT:'0',MAILDESK_RECIPIENT_ALLOWLIST:'[]',ALLOW_REAL_SEND:'false',SEND_MODE:'mock',DEPLOYMENT_STAGE:'production',RESEND_API_KEY:undefined,CSRF_SECRET:undefined})) test(`v2 config changed after review fails closed: ${field}`,async t=>{
 const f=await setup(t);const r=await f.review(f.id);f.env[field]=value;
 assert.ok([401,403,503].includes((await f.send(r)).status));assert.equal(f.wireCalls(),0);
 assert.equal(f.DB.sqlite.prepare('SELECT status FROM outbound_intents WHERE id=?').get(r.id).status,'reserved');
});
