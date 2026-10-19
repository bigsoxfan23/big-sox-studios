import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { customerReplies, replyPolicy, prepareReply, sendReply } from '../src/reply.resend.mjs';
import { claimSend } from '../src/store.mjs';
const migration = await readFile(new URL('../migrations/0005_simple_replies.sql', import.meta.url), 'utf8');
const owner = 'fridman.greg@gmail.com', customer = 'Customer@example.test';
const ownerEnv = { DEPLOYMENT_STAGE:'staging', SEND_MODE:'live', ALLOW_REAL_SEND:'true', MAILDESK_REPLY_ACTIVATION:'owner-self-v1', MAILDESK_RECIPIENT_ALLOWLIST:JSON.stringify([owner]), OWNER_EMAIL:owner, RESEND_API_KEY:'re_OFFLINE_SYNTHETIC_NOT_A_REAL_KEY_0000' };
const env = { ...ownerEnv, MAILDESK_REPLY_ACTIVATION:'owner-reviewed-customers-v1', MAILDESK_CUSTOMER_REPLIES:'enabled', MAILDESK_CUSTOMER_RECIPIENT_POLICY:'exact-forwarded-requester-v1' };
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
 assert.equal(r.to,customer);assert.equal(r.policy,'owner-reviewed-customers-v1');assert.equal(r.mode,'live');assert.equal(f.wireCalls(),0);
 const response = await f.send(r);assert.equal(response.status,200);assert.equal((await response.json()).status,'sent');
 assert.equal(f.wireCalls(),1);assert.equal(f.seen[0].url,'https://api.resend.com/emails');
 assert.deepEqual(JSON.parse(f.seen[0].options.body),{from:'support@bigsoxstudios.com',to:[customer],subject:r.subject,text:r.body});
 // Evidence establishes a route only: the envelope itself could also be spoofed.
 assert.equal((await f.session()).v.replyPolicy,'owner-reviewed-customers-v1');
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
 const f=await setup(t);const c=await f.seed({channel:'support',requester_email:customer});
 await assert.rejects(f.review(c),/reply_inbound_required/);assert.equal(f.wireCalls(),0);
});
test('atomic customer claim rechecks evidence after preflight',async t=>{
 const f=await setup(t);const r=await f.review(f.id);const i=f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id);
 f.DB.sqlite.exec("UPDATE email_receipts SET forward_state='UNKNOWN'");
 assert.equal(await claimSend(f.DB,i,true),null);assert.equal(f.wireCalls(),0);
});
test('owner and customer review signatures cannot cross policies, including owner destination',async t=>{
 const f=await setup(t,{settings:ownerEnv});f.DB.sqlite.prepare('UPDATE cases SET requester_email=?').run(owner);f.DB.sqlite.prepare('UPDATE email_receipts SET envelope_from=?').run(owner);
 const r=await f.review(f.id);Object.assign(f.env,env);
 assert.equal((await f.send(r)).status,403);assert.equal(f.wireCalls(),0);
 const customerReview=await (await f.request(`/api/cases/${f.id}/review`,{revision:r.revision})).json();
 Object.assign(f.env,ownerEnv);assert.equal((await f.send(customerReview)).status,403);assert.equal(f.wireCalls(),0);
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
