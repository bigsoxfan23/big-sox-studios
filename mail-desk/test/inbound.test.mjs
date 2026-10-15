import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { syntheticIntake } from '../src/intake.synthetic.mjs';
import { fixture, D1, input, token } from './helpers.mjs';
import { MAX_RAW, MAX_PREVIEW_RAW } from '../src/inbound.mjs';
const FIXTURE_FORWARD_TO = 'owner@example.test';
const rawDefault = 'Content-Type: text/plain; charset=utf-8\r\n\r\nHello original.';
function incoming(options = {}) {
 const raw = new TextEncoder().encode(options.raw ?? rawDefault);
 let forwarded = 0, rejected = 0;
 const message = { from: 'person@example.test', to: 'support@bigsoxstudios.com', rawSize: raw.length,
  headers: new Headers({ 'Message-ID': '<first@example.test>', Subject: 'Fixture', ...options.headers }),
  raw: new ReadableStream({start(c) {c.enqueue(raw);c.close();}}),
  setReject(reason) {rejected++; assert.equal(reason,'Mail Desk intake unavailable');},
  async forward(...args) {forwarded++; assert.deepEqual(args,[FIXTURE_FORWARD_TO]); await options.forward?.();},
  ...options.envelope
 };
 return { message, counts:()=>({forwarded,rejected}) };
}
const rows = (f, table) => f.DB.sqlite.prepare(`SELECT * FROM ${table}`).all();
async function deliver(f, i, env={}) {await f.worker.email(i.message,{...f.env,INBOUND_FORWARD_TO:FIXTURE_FORWARD_TO,ENABLE_INBOUND_EMAIL:'true',...env},{});}
test('forwarding destination is explicit, valid and never embedded in public Worker source', async t=>{
 const f=await fixture(t);
 for(const address of [undefined, '', 'bogus', 'owner@example.test\r\nBcc:evil@example.test']) {
  const i=incoming();await deliver(f,i,{INBOUND_FORWARD_TO:address});
  assert.deepEqual(i.counts(),{forwarded:0,rejected:1});
 }
 assert.equal(rows(f,'email_receipts').length,0);
 const source=await readFile(new URL('../src/inbound.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source, /[A-Z0-9._%+-]+@gmail\.com/i);
});
test('email event is disabled unless independent exact string flag is true; no D1 access', async t=>{
 const f=await fixture(t);
 for (const flag of [undefined,false,true,'false','TRUE']) {
  const i=incoming(); await f.worker.email(i.message,{ENABLE_INBOUND_EMAIL:flag},{}); assert.deepEqual(i.counts(),{forwarded:0,rejected:1});
 }
 const config=await readFile(new URL('../wrangler.staging.toml',import.meta.url),'utf8');assert.doesNotMatch(config,/(?:ENABLE_INBOUND_EMAIL|INBOUND_FORWARD_TO)\s*=/);
 assert.equal(rows(f,'cases').length,0);
});
for (const to of ['catchall@bigsoxstudios.com','support@bigsoxstudios.com.evil.test','support+tag@bigsoxstudios.com','support@evil.test',' support@bigsoxstudios.com','support@bigsoxstudios.com,hello@bigsoxstudios.com']) test(`reject exact envelope recipient ${to}`,async t=>{
 const f=await fixture(t),i=incoming({envelope:{to},headers:{To:'support@bigsoxstudios.com','X-Original-To':'support@bigsoxstudios.com'}});await deliver(f,i);assert.equal(i.counts().rejected,1);assert.equal(rows(f,'cases').length,0);
});
for (const to of ['SUPPORT@BIGSOXSTUDIOS.COM','members@bigsoxstudios.com','hello@bigsoxstudios.com']) test(`accept exact mailbox ${to} and forward original`,async t=>{
 const f=await fixture(t),i=incoming({envelope:{to},headers:{From:'evil@example.test',To:'evil@example.test','Reply-To':'evil@example.test','Cf-Access-Authenticated-User-Email':'owner@example.test'}});await deliver(f,i);
 assert.deepEqual(i.counts(),{forwarded:1,rejected:0});assert.equal(rows(f,'cases')[0].requester_email,'person@example.test');assert.equal(rows(f,'cases')[0].channel,to.split('@')[0].toLowerCase());assert.equal(rows(f,'messages')[0].body.trimEnd(),'Hello original.');assert.equal(rows(f,'email_receipts')[0].forward_state,'forwarded');assert.equal(f.calls(),0);
});
for(const from of ['', '<>', 'A <a@example.test>', 'a@example.test\r\nBCC: x@example.test', 'a@example.test,b@example.test','a..b@example.test']) test('reject invalid envelope sender '+JSON.stringify(from),async t=>{const f=await fixture(t),i=incoming({envelope:{from}});await deliver(f,i);assert.equal(i.counts().rejected,1);});
test('same Message-ID concurrent deliveries produce one case/message/job and one forward',async t=>{
 const f=await fixture(t);const messages=Array.from({length:10},()=>incoming());await Promise.all(messages.map(i=>deliver(f,i)));
 for(const table of ['cases','messages','sync_jobs','email_receipts']) assert.equal(rows(f,table).length,1);
 assert.equal(messages.reduce((n,i)=>n+i.counts().forwarded,0),1);
 const replay=incoming({raw:rawDefault+'changed'});await deliver(f,replay);assert.equal(replay.counts().forwarded,0);
});
test('reply chain uses same case, records thread metadata, isolates sender and channel',async t=>{
 const f=await fixture(t);await deliver(f,incoming());
 await deliver(f,incoming({headers:{'Message-ID':'<reply@example.test>','In-Reply-To':'<first@example.test>',References:'<first@example.test>'}}));
 assert.equal(rows(f,'cases').length,1);assert.equal(rows(f,'messages').length,2);assert.equal(rows(f,'sync_jobs').length,1);assert.equal(rows(f,'email_receipts')[1].in_reply_to,'<first@example.test>');
 await deliver(f,incoming({headers:{'Message-ID':'<other@example.test>','In-Reply-To':'<first@example.test>'},envelope:{from:'stranger@example.test'}}));
 await deliver(f,incoming({headers:{'Message-ID':'<channel@example.test>','In-Reply-To':'<first@example.test>'},envelope:{to:'hello@bigsoxstudios.com'}}));
 assert.equal(rows(f,'cases').length,3);assert.equal(rows(f,'email_receipts').length,4);
});
for(const id of ['', 'malformed', '<first@example.test>, <second@example.test>', '<bad@..>', '<a..b@example.test>']) test('missing/malformed ID uses bounded content hash '+id,async t=>{
 const f=await fixture(t);const a=incoming({headers:{'Message-ID':id}}),b=incoming({headers:{'Message-ID':id}});await deliver(f,a);await deliver(f,b);assert.equal(rows(f,'cases').length,1);assert.equal(a.counts().forwarded+b.counts().forwarded,1);assert.equal(rows(f,'email_receipts')[0].message_id,null);
});
for(const raw of [
 'Content-Type: text/html\r\n\r\n<script>bad()</script>',
 'Content-Type: text/plain\r\nContent-Disposition: attachment\r\n\r\nsecret',
 'Content-Type: text/plain\r\nContent-Type: text/html\r\n\r\nsecret',
 'malformed MIME without header boundary',
 'X'.repeat(MAX_PREVIEW_RAW+1)
]) test('unsupported MIME safely degrades and original still forwards '+raw.slice(0,40),async t=>{
 const f=await fixture(t),i=incoming({raw});await deliver(f,i);assert.match(rows(f,'messages')[0].body,/Preview unavailable/);assert.equal(i.counts().forwarded,1);
});
test('bounded plain text truncates, raw size mismatches reject, 25 MiB boundary',async t=>{
 const f=await fixture(t);await deliver(f,incoming({raw:rawDefault+'x'.repeat(20000)}));assert.equal(rows(f,'messages')[0].body.length,10000);
 for(const rawSize of [0,-1,1.2,MAX_RAW+1,rawDefault.length+1]) {const i=incoming({envelope:{rawSize}});await deliver(f,i);assert.equal(i.counts().rejected,1);}
 // Chunked 25 MiB stream: retain only the 256 KiB app preview, never a 25 MiB buffer.
 const i=incoming({envelope:{rawSize:MAX_RAW},headers:{'Message-ID':'<large@example.test>'}});let remaining=MAX_RAW;
 i.message.raw=new ReadableStream({pull(c){if(!remaining){c.close();return;}const n=Math.min(65536,remaining);c.enqueue(new Uint8Array(n));remaining-=n;}});
 await deliver(f,i);assert.equal(i.counts().forwarded,1);assert.match(rows(f,'messages')[1].body,/Preview unavailable/);
 const noId=incoming({raw:'x'.repeat(MAX_PREVIEW_RAW+1),headers:{'Message-ID':''}});await deliver(f,noId);assert.equal(noId.counts().rejected,1);
});
test('preclaim D1 failure rejects without forward; forward failure persists UNKNOWN and suppresses replay',async t=>{
 const f=await fixture(t);f.DB.sqlite.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'private failure'); END");
 const a=incoming();await deliver(f,a);assert.deepEqual(a.counts(),{forwarded:0,rejected:1});assert.equal(rows(f,'email_receipts').length,0);
 f.DB.sqlite.exec('DROP TRIGGER fixture_fail');const b=incoming({forward:()=>{throw Error('private provider detail');}});await deliver(f,b);assert.deepEqual(b.counts(),{forwarded:1,rejected:0});assert.equal(rows(f,'email_receipts')[0].forward_state,'UNKNOWN');
 const c=incoming();await deliver(f,c);assert.deepEqual(c.counts(),{forwarded:0,rejected:0});
});
test('post-forward D1 failure and crashed claim suppress all future forwarding',async t=>{
 const f=await fixture(t);const a=incoming({forward:()=>{f.DB.sqlite.exec("CREATE TRIGGER fixture_fail BEFORE UPDATE ON email_receipts BEGIN SELECT RAISE(ABORT,'private failure'); END");}});await deliver(f,a);assert.equal(rows(f,'email_receipts')[0].forward_state,'UNKNOWN');assert.equal(a.counts().forwarded,1);
 f.DB.sqlite.exec('DROP TRIGGER fixture_fail');f.DB.sqlite.exec("UPDATE email_receipts SET forward_state='claimed'");const b=incoming();await deliver(f,b);assert.equal(b.counts().forwarded,0);
});
test('conflicting parent threads create a new unlinked case and forward',async t=>{
 const f=await fixture(t);await deliver(f,incoming());await deliver(f,incoming({headers:{'Message-ID':'<second@example.test>'}}));
 const i=incoming({headers:{'Message-ID':'<third@example.test>',References:'<first@example.test> <second@example.test>'}});await deliver(f,i);assert.deepEqual(i.counts(),{forwarded:1,rejected:0});assert.equal(rows(f,'cases').length,3);assert.equal(new Set(rows(f,'email_receipts').map(r=>r.case_id)).size,3);
});
test('in-flight forward is durably UNKNOWN; duplicate never invokes forward',async t=>{
 const f=await fixture(t);let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
 const first=incoming({forward:async()=>{entered=true;await gate;}}),pending=deliver(f,first);
 while(!entered) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rows(f,'email_receipts')[0].forward_state,'UNKNOWN');const duplicate=incoming();await deliver(f,duplicate);assert.equal(duplicate.counts().forwarded,0);release();await pending;assert.equal(rows(f,'email_receipts')[0].forward_state,'forwarded');
});
test('canBeForwarded false, raw overflow and stream errors fail closed',async t=>{
 const f=await fixture(t);
 const noForward=incoming({envelope:{canBeForwarded:false}});await deliver(f,noForward);assert.equal(noForward.counts().forwarded,0);assert.equal(noForward.counts().rejected,1);
 const overflow=incoming({envelope:{rawSize:1}});await deliver(f,overflow);assert.equal(overflow.counts().rejected,1);
 const broken=incoming();broken.message.raw=new ReadableStream({start(c){c.error(Error('private MIME'));}});await deliver(f,broken);assert.equal(broken.counts().rejected,1);assert.equal(rows(f,'email_receipts').length,0);
});
test('new migration upgrades populated Task9 schema without altering accepted records',async t=>{
 const DB=new D1({initialOnly:true});t.after(()=>DB.close());
 const id=await syntheticIntake(DB,input());
 const tables=['cases','messages','sync_jobs','inbound_dedupe'];
 const snapshot=()=>tables.map(table=>DB.sqlite.prepare(`SELECT * FROM ${table}`).all());
 const before=snapshot();
 DB.sqlite.exec(await readFile(new URL('../migrations/0002_inbound_and_notion.sql',import.meta.url),'utf8'));
 assert.deepEqual(snapshot(),before);assert.equal(DB.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 assert.equal(DB.sqlite.prepare('SELECT id FROM cases').get().id,id);
});
test('failure before forward invocation preserves claimed state and does not retry',async t=>{
 const f=await fixture(t);f.DB.sqlite.exec("CREATE TRIGGER fixture_fail BEFORE UPDATE ON email_receipts BEGIN SELECT RAISE(ABORT,'private storage error'); END");
 const a=incoming();await deliver(f,a);assert.deepEqual(a.counts(),{forwarded:0,rejected:0});assert.equal(rows(f,'email_receipts')[0].forward_state,'claimed');
 f.DB.sqlite.exec('DROP TRIGGER fixture_fail');const b=incoming();await deliver(f,b);assert.equal(b.counts().forwarded,0);
});

for (const [file, expected] of [['gmail-alternative.eml','Hello studio,\nIs the café open?\nThanks!'],['outlook-mixed.eml','Hello studio, please help.']]) test(`realistic ${file} stores only decoded plain text and forwards original`,async t=>{
 const f=await fixture(t),raw=await readFile(new URL(`./fixtures/${file}`,import.meta.url),'utf8');
 const i=incoming({raw});const original=i.message;
 await deliver(f,i);
 assert.deepEqual(i.counts(),{forwarded:1,rejected:0});assert.equal(i.message,original);
 assert.equal(rows(f,'messages')[0].body.trim(),expected);
 assert.doesNotMatch(JSON.stringify(rows(f,'messages')),/HTML_SECRET|HTML_ONLY|ATTACHMENT_SECRET|ENCAPSULATED_SECRET|<html>/);
});
for (const [label, raw] of [
 ['base64','Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nYWJj'],
 ['quoted printable','Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nabc=0Acaf=C3=A9'],
 ['legacy charset','Content-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9']
]) test(`normal ${label} is readable`,async t=>{
 const f=await fixture(t),i=incoming({raw});await deliver(f,i);
 assert.equal(rows(f,'messages')[0].body.trimEnd(), label==='base64'?'abc':label==='quoted printable'?'abc\ncafé':'café');
});
const part = (type, body, extra='') => `Content-Type: ${type}\r\n${extra}\r\n${body}`;
for(const [label,raw] of [
 ['missing boundary',part('multipart/alternative','<script>secret</script>')],
 ['unknown encoding',part('text/plain','secret','Content-Transfer-Encoding: rot13\r\n')],
 ['html only alternative',part('multipart/alternative; boundary=x','--x\r\n'+part('text/html','<script>secret</script>')+'\r\n--x--')],
 ['attached multipart subtree',part('multipart/mixed; boundary=x','--x\r\n'+part('text/plain','ATTACHED_SECRET')+'\r\n--x--','Content-Disposition: attachment; filename="mail.mime"\r\n')],
 ['too many parts',part('multipart/mixed; boundary=x',Array.from({length:101},()=> '--x\r\n'+part('text/plain','secret')).join('\r\n')+'\r\n--x--')],
 ['too deep',Array.from({length:20},(_,i)=>part(`multipart/mixed; boundary=b${i}`,`--b${i}\r\n`)).join('')+part('text/plain','secret')],
 ['header budget',part('text/plain','secret','X-Large: '+'x'.repeat(33000)+'\r\n')],
 ['duplicate inner MIME headers',part('multipart/mixed; boundary=x','--x\r\n'+part('text/plain','secret','Content-Type: text/html\r\n')+'\r\n--x--')]
]) test(`hostile MIME ${label} uses fixed fallback and forwards original`,async t=>{
 const f=await fixture(t),i=incoming({raw});await deliver(f,i);
 assert.match(rows(f,'messages')[0].body,/Preview unavailable/);assert.deepEqual(i.counts(),{forwarded:1,rejected:0});
});
test('orphan and partly missing parent hints create new cases, preserve metadata and suppress replay',async t=>{
 const f=await fixture(t);await deliver(f,incoming());
 for(const [id,refs] of [['orphan','<unknown@example.test>'],['partial','<first@example.test> <unknown@example.test>']]) {
  const options={headers:{'Message-ID':`<${id}@example.test>`,'In-Reply-To':'<unknown@example.test>',References:refs}};
  const i=incoming(options);await deliver(f,i);assert.deepEqual(i.counts(),{forwarded:1,rejected:0});
  const receipt=rows(f,'email_receipts').at(-1);assert.equal(receipt.in_reply_to,'<unknown@example.test>');assert.deepEqual(JSON.parse(receipt.references_json),refs.split(' '));
  const replay=incoming(options);await deliver(f,replay);assert.deepEqual(replay.counts(),{forwarded:0,rejected:0});
 }
 assert.equal(rows(f,'cases').length,3);assert.equal(rows(f,'sync_jobs').length,3);
});
test('wrong-envelope-sender thread hint cannot merge even with forged From header',async t=>{
 const f=await fixture(t);await deliver(f,incoming());
 const i=incoming({envelope:{from:'stranger@example.test'},headers:{From:'person@example.test','Message-ID':'<wrong@example.test>','In-Reply-To':'<first@example.test>',References:'<first@example.test>'}});
 await deliver(f,i);assert.deepEqual(i.counts(),{forwarded:1,rejected:0});
 assert.equal(rows(f,'cases').length,2);assert.notEqual(rows(f,'email_receipts')[0].case_id,rows(f,'email_receipts')[1].case_id);
 assert.equal(rows(f,'cases')[1].requester_email,'stranger@example.test');
});
test('unresolved forward status is owner-only, read-only, aggregate and Task9 compatible',async t=>{
 const f=await fixture(t);
 let r=await f.request('/api/inbound-status',undefined,{headers:{'Cf-Access-Jwt-Assertion':null}});assert.equal(r.status,401);
 r=await f.request('/api/inbound-status',undefined,{headers:{'Cf-Access-Jwt-Assertion':await token({email:'stranger@example.test'})}});assert.equal(r.status,401);
 await deliver(f,incoming({forward:()=>{throw Error('private');}}));
 await deliver(f,incoming({headers:{'Message-ID':'<ok@example.test>'}}));
 f.DB.sqlite.exec("UPDATE email_receipts SET forward_state='claimed' WHERE message_id='<ok@example.test>'");
 const before=rows(f,'email_receipts');r=await f.request('/api/inbound-status');assert.equal(r.status,200);assert.deepEqual(await r.json(),{available:true,unresolved:2});assert.equal(r.headers.get('Cache-Control'),'no-store');assert.deepEqual(rows(f,'email_receipts'),before);
 f.DB.sqlite.exec('DROP TABLE email_receipts');r=await f.request('/api/inbound-status');assert.equal(r.status,200);assert.deepEqual(await r.json(),{available:false,unresolved:null});
});
test('exact 256 KiB MIME parses; one byte larger remains a placeholder',async t=>{
 const f=await fixture(t),prefix='Content-Type: text/plain\r\n\r\n';
 for(const extra of [0,1]) {
  const i=incoming({raw:prefix+'x'.repeat(MAX_PREVIEW_RAW-prefix.length+extra),headers:{'Message-ID':`<bound${extra}@example.test>`}});
  await deliver(f,i);assert.deepEqual(i.counts(),{forwarded:1,rejected:0});
 }
 assert.equal(rows(f,'messages')[0].body,'x'.repeat(10000));assert.match(rows(f,'messages')[1].body,/Preview unavailable/);
});
test('zero-row UNKNOWN transition cannot invoke forwarding',async t=>{
 const f=await fixture(t);f.DB.sqlite.exec("CREATE TRIGGER fixture_skip BEFORE UPDATE ON email_receipts BEGIN SELECT RAISE(IGNORE); END");
 const i=incoming();await deliver(f,i);assert.deepEqual(i.counts(),{forwarded:0,rejected:0});assert.equal(rows(f,'email_receipts')[0].forward_state,'claimed');
});
test('status storage failure returns fixed service error without private details',async t=>{
 const f=await fixture(t);f.env.DB={prepare(){throw Error('private storage detail person@example.test');}};
 const r=await f.request('/api/inbound-status');assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'service_unavailable'});
});
