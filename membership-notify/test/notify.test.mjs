import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {database,seed,TIME,DAY} from '../../tests/membership-fixtures.mjs';
import {createWorker,emailReady} from '../worker.mjs';
import {SOURCE,MANUAL,OWNER,SENDER,QUEUE,payload,decisions,statuses,createProviders} from '../providers.mjs';
import {schema} from './schema.mjs';
const PAGE='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const RESPONSE='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const json=value=>new Response(JSON.stringify(value),{status:200});
function page(id,pageId=PAGE) {
 return {object:'page',id:pageId,parent:{data_source_id:SOURCE},archived:false,in_trash:false,properties:payload(id).properties};
}
function setup() {
 const d=database();
 // Most tests isolate a fresh application; manual adoption is tested separately.
 d.sqlite.exec('DELETE FROM membership_notify_outbox');
 let time=TIME;
 const env={MEMBERSHIP_DB:d,NOTIFY_ENABLED:'true',NOTION_ENABLED:'true',EMAIL_ENABLED:'true',PROVIDER_DAILY_LIMIT:'10',
  OWNER_EMAIL:OWNER,SENDER_EMAIL:SENDER,NOTIFY_START_MS:String(TIME-1),PROVIDER_VERIFIED_UNTIL_MS:String(TIME+DAY),
  NOTION_API_TOKEN:'synthetic_notion_token',RESEND_API_KEY:'synthetic_resend_token'};
 const calls=[],pages=new Map(),logs=[];
 const control={};
 const fetcher=async(url,init)=>{
  const body=init.body?JSON.parse(init.body):undefined;
  calls.push({url,init,body});
  if(control.before) await control.before(url,init,body);
  if(url.endsWith(`/data_sources/${SOURCE}`)) return control.schemaResponse?control.schemaResponse():json(control.schema || schema());
  if(url.endsWith('/query')) {
   if(control.query) return control.query(body);
   const id=body.filter.rich_text.equals;
   return json({results:pages.has(id)?[pages.get(id)]:[],has_more:false});
  }
  if(url.endsWith('/pages')) {
   const id=body.properties['External Case ID'].rich_text[0].text.content;
   const p=page(id,crypto.randomUUID());pages.set(id,p);
   if(control.create) return control.create(p);
   return json(p);
  }
  if(url.includes('/pages/')) {
   if(control.patch) return control.patch(body);
   const p=[...pages.values()].find(p=>p.id===url.split('/').at(-1));Object.assign(p.properties,body.properties);return json(p);
  }
  if(url==='https://api.resend.com/emails') {
   if(control.send) return control.send(body);
   return json({id:RESPONSE});
  }
  throw Error('unexpected URL');
 };
 const options={fetcher,now:()=>time,logFailure:c=>logs.push(c),timeout:30};
 const worker=createWorker(options);
 const run=()=>worker.run(env);
 const tick=()=>{time+=3600000;env.PROVIDER_VERIFIED_UNTIL_MS=String(time+DAY);};
 const effects=()=>calls.filter(c=>c.url.endsWith('/pages') || c.url.endsWith('/emails'));
 const row=id=>d.sqlite.prepare('SELECT * FROM membership_notify_cases WHERE application_id=?').get(id);
 const jobs=()=>d.sqlite.prepare('SELECT * FROM membership_notify_outbox').all();
 return {d,env,calls,pages,control,worker,run,tick,effects,row,jobs,logs,
  setTime:value=>{time=value;},
  advance:ms=>{time+=ms;env.PROVIDER_VERIFIED_UNTIL_MS=String(time+DAY);},
  restart:()=>createWorker(options).run(env)};
}
test('additive migration leaves legacy records intact and creates only one no-email adoption',()=>{
 const d=new DatabaseSync(':memory:');
 d.exec(readFileSync(new URL('../../membership/migrations/0001_membership.sql',import.meta.url),'utf8'));
 d.prepare('INSERT INTO membership_requests(id,email_hash,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(MANUAL,'legacy','Synthetic',TIME,TIME);
 d.exec(readFileSync(new URL('../../membership/migrations/0002_notifications.sql',import.meta.url),'utf8'));
 assert.equal(d.prepare('SELECT name FROM membership_requests').get().name,'Synthetic');
 assert.equal(d.prepare('SELECT count(*) AS n FROM membership_notify_outbox').get().n,1);
 assert.equal(d.prepare('SELECT email_state FROM membership_notify_cases').get().email_state,'SUPPRESSED');
 const cases=d.prepare('SELECT * FROM membership_notify_cases').all(),jobs=d.prepare('SELECT * FROM membership_notify_outbox').all();
 d.exec(readFileSync(new URL('../../membership/migrations/0003_notification_provider_check.sql',import.meta.url),'utf8'));
 assert.deepEqual(d.prepare('SELECT * FROM membership_notify_cases').all(),cases);
 assert.deepEqual(d.prepare('SELECT * FROM membership_notify_outbox').all(),jobs);
 assert.equal(d.prepare('SELECT attempts FROM membership_notify_provider_check').get().attempts,0);
});
test('new application and outbox rollback atomically; duplicate intake creates no extra work; immutable strict uniqueness',()=>{
 const s=setup();const id=seed(s.d,{hash:'same'});
 s.d.sqlite.prepare('INSERT INTO membership_requests(id,email_hash,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(email_hash) DO NOTHING').run(crypto.randomUUID(),'same',TIME,TIME);
 assert.equal(s.jobs().length,1);
 assert.throws(()=>s.d.sqlite.prepare("INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at) VALUES(?,'submitted',2,?)").run(id,TIME),/UNIQUE/);
 assert.throws(()=>s.d.sqlite.prepare("UPDATE membership_notify_outbox SET revision=2").run(),/immutable/);
 s.d.sqlite.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON membership_notify_outbox BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.throws(()=>seed(s.d,{hash:'rollback'}),/injected/);
 assert.equal(s.d.rows().length,1);assert.equal(s.d.audit().length,1);
 assert.throws(()=>s.d.sqlite.prepare('UPDATE membership_notify_cases SET suppress_email=1 WHERE application_id=?').run(id),/immutable/);
});
test('default OFF and HTTP route denial have zero network effects',async()=>{
 const s=setup();seed(s.d);await s.worker.run({MEMBERSHIP_DB:s.d});
 for(const method of ['GET','POST','PUT'])assert.equal((await s.worker.fetch(new Request('https://example.test/',{method}))).status,404);
 assert.equal(s.calls.length,0);
});
test('fresh intake reconciles then creates minimal ticket and sends fixed owner-only message once',async()=>{
 const s=setup();const id=seed(s.d);await s.run();await s.run();
 assert.equal(s.row(id).notion_state,'LINKED');assert.equal(s.row(id).email_state,'SENT');assert.equal(s.effects().length,2);
 const create=s.effects()[0],send=s.effects()[1];
 assert.deepEqual(create.body,payload(id));assert.equal(send.init.headers['Idempotency-Key'],`membership-notify-v1-${id}`);
 assert.deepEqual(send.body.to,[OWNER]);assert.equal(send.body.from,SENDER);assert.ok(send.body.text.includes(QUEUE));
 const serialized=JSON.stringify(s.calls);
 for(const text of ['visitor@example.test','Synthetic Visitor','Synthetic request','owner_note','Requester Email'])assert.ok(!serialized.includes(text));
 assert.ok(s.calls.every(c=>c.init.redirect==='manual' && c.init.signal));
});
test('overlapping cron invocations claim one application and never duplicate effects',async()=>{
 const s=setup();const id=seed(s.d);await Promise.all([s.run(),s.run(),s.run()]);
 assert.equal(s.effects().length,2);assert.equal(s.row(id).email_state,'SENT');
});
test('manual External Case ID adopts matching page without create or retroactive email',async()=>{
 const s=setup();s.d.sqlite.prepare("INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at) VALUES(?,'adopt',1,0)").run(MANUAL);
 s.pages.set(MANUAL,page(MANUAL));await s.run();
 assert.equal(s.row(MANUAL).notion_page_id,PAGE);assert.equal(s.row(MANUAL).email_state,'SUPPRESSED');assert.equal(s.effects().length,0);
});
test('manual adoption missing from Notion never creates',async()=>{
 const s=setup();s.d.sqlite.prepare("INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at) VALUES(?,'adopt',1,0)").run(MANUAL);
 await s.run();s.tick();await s.run();assert.equal(s.effects().length,0);assert.equal(s.jobs()[0].failure,'notion_unknown');
});
for(const mode of ['throw','malformed','oversize','redirect','stall'])test(`ambiguous Notion creation ${mode} reconciles without recreating`,async()=>{
 const s=setup();const id=seed(s.d);
 s.control.create=()=>{
  if(mode==='throw')throw Error('secret must not log');
  if(mode==='malformed')return new Response('{');
  if(mode==='oversize')return new Response('x'.repeat(65537));
  if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://evil.test/'}});
  return new Promise(()=>{});
 };
 await s.run();assert.equal(s.row(id).notion_state,'UNKNOWN');
 s.pages.clear();s.tick();await s.run();assert.equal(s.effects().length,1);
 s.pages.set(id,page(id));s.tick();await s.run();
 assert.equal(s.row(id).notion_state,'LINKED');assert.equal(s.effects().filter(c=>c.url.endsWith('/pages')).length,1);
 assert.ok(s.logs.every(c=>!c.includes('secret')));
});
for(const mode of ['throw','malformed','oversize','redirect','stall','500','refused'])test(`Resend ${mode} never retries ambiguous or refused sends`,async()=>{
 const s=setup();const id=seed(s.d);
 s.control.send=()=>{
  if(mode==='throw')throw Error('sensitive');
  if(mode==='malformed')return json({});
  if(mode==='oversize')return new Response('x'.repeat(65537));
  if(mode==='redirect')return new Response(null,{status:307});
  if(mode==='500')return new Response(null,{status:500});
  if(mode==='refused')return new Response(null,{status:429});
  return new Promise(()=>{});
 };
 await s.run();s.tick();await s.run();
 assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,1);
 assert.equal(s.row(id).email_state,mode==='refused'?'REFUSED':'UNKNOWN');
});
test('create link persistence failure leaves UNKNOWN and later lookup adopts',async()=>{
 const s=setup();const id=seed(s.d);
 s.d.sqlite.exec("CREATE TRIGGER fail_link BEFORE UPDATE OF notion_page_id ON membership_notify_cases BEGIN SELECT RAISE(ABORT,'storage fault'); END;");
 await s.run();assert.equal(s.row(id).notion_state,'UNKNOWN');
 s.d.sqlite.exec('DROP TRIGGER fail_link');s.tick();await s.run();
 assert.equal(s.row(id).notion_state,'LINKED');assert.equal(s.effects().filter(c=>c.url.endsWith('/pages')).length,1);
});
test('send acknowledgement persistence failure never resends even after provider window expires',async()=>{
 const s=setup();const id=seed(s.d);
 s.d.sqlite.exec("CREATE TRIGGER fail_sent BEFORE UPDATE OF email_state ON membership_notify_cases WHEN NEW.email_state='SENT' BEGIN SELECT RAISE(ABORT,'storage fault'); END;");
 await s.run();assert.equal(s.row(id).email_state,'UNKNOWN');
 s.d.sqlite.exec('DROP TRIGGER fail_sent');for(let n=0;n<26;n++)s.tick();await s.run();
 assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,1);
});
for(const field of ['OWNER_EMAIL','SENDER_EMAIL','PROVIDER_VERIFIED_UNTIL_MS','NOTIFY_START_MS','RESEND_API_KEY','EMAIL_ENABLED','PROVIDER_DAILY_LIMIT'])test(`email fails closed for invalid ${field}`,async()=>{
 const s=setup();s.env[field]='invalid';seed(s.d);assert.equal(emailReady(s.env,TIME),false);await s.run();
 assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,0);
});
test('expired or excessive attestation TTL fails closed; cutover suppresses historical mail',async()=>{
 const s=setup();for(const until of [TIME,TIME-1,TIME+DAY+1])assert.equal(emailReady({...s.env,PROVIDER_VERIFIED_UNTIL_MS:String(until)},TIME),false);
 const id=seed(s.d,{created:TIME-10});await s.run();assert.equal(s.row(id).email_state,'SUPPRESSED');
 assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,0);
});
for(const mode of ['duplicates','incomplete','wrongKind','wrongChannel','wrongExternal','wrongParent','archived','staleLink'])test(`Notion reconciliation ${mode} fails closed`,async()=>{
 const s=setup();const id=seed(s.d);const p=page(id);
 if(mode==='wrongKind')p.properties['Ticket Kind'].select.name='Incident / Support';
 if(mode==='wrongChannel')p.properties['Request Channel'].select.name='support@';
 if(mode==='wrongExternal')p.properties['External Case ID'].rich_text[0].text.content=MANUAL;
 if(mode==='wrongParent')p.parent.data_source_id=PAGE;
 if(mode==='archived')p.archived=true;
 if(mode==='staleLink')s.d.sqlite.prepare("UPDATE membership_notify_cases SET notion_state='LINKED',notion_page_id=? WHERE application_id=?").run(RESPONSE,id);
 s.control.query=()=>json({results:mode==='duplicates'?[p,p]:[p],has_more:mode==='incomplete',next_cursor:'same'});
 await s.run();assert.equal(s.effects().length,0);
});
test('schema mismatch prevents all ticket and email effects',async()=>{
 const s=setup();seed(s.d);const contract=schema();contract.properties.Link.type='rich_text';s.control.schema=contract;
 await s.run();assert.equal(s.effects().length,0);assert.deepEqual(s.logs,['configuration']);
});
test('status events are distinct/deduped, notes do not enqueue, latest decision PATCHes status and decision and sends no mail',async()=>{
 const s=setup();const id=seed(s.d);await s.run();s.calls.length=0;
 s.d.sqlite.prepare('UPDATE membership_requests SET owner_note=?,revision=revision+1 WHERE id=?').run('private',id);
 assert.equal(s.jobs().length,1);
 s.d.sqlite.prepare("UPDATE membership_requests SET status='approved',revision=revision+1,updated_at=? WHERE id=? AND status='pending'").run(TIME,id);
 s.d.sqlite.prepare("UPDATE membership_requests SET status='revoked',revision=revision+1,updated_at=? WHERE id=? AND status='approved'").run(TIME,id);
 await Promise.all([s.run(),s.run()]);
 assert.equal(s.effects().length,0);
 for(const call of s.calls.filter(c=>c.init.method==='PATCH'))assert.deepEqual(call.body,{properties:{Status:{select:{name:'Closed'}},'Membership Decision':{select:{name:'Declined'}}}});
 assert.equal(s.jobs().length,3);
});
test('bounded single-job batches, persisted crash lease, bounded retries and 365-day deidentified event retention',async()=>{
 const s=setup();for(let i=0;i<12;i++)seed(s.d,{created:TIME-10});
 // Frozen lease excludes one case while another invocation can process the rest.
 const id=s.d.rows()[0].id;s.d.sqlite.prepare('UPDATE membership_notify_cases SET lease_until=? WHERE application_id=?').run(TIME+120000,id);
 await s.run();assert.equal(s.jobs().filter(j=>j.state==='done').length,0);
 s.tick();for(let i=0;i<12;i++)await s.run();assert.equal(s.jobs().filter(j=>j.state==='done').length,12);
 const allCases=s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_cases').get().n;
 // Complete event aging never erases suppression tombstones.
 const old=createWorker({now:()=>TIME+366*DAY,fetcher:async(url)=>url.endsWith(SOURCE)?json(schema()):json({results:[],has_more:false}),logFailure:()=>{}});
 await old.run(s.env);assert.equal(s.jobs().length,0);
 assert.equal(s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_cases').get().n,allCases);
});
test('safe read errors use bounded backoff then block; no blind effect',async()=>{
 const s=setup();seed(s.d);s.control.query=()=>{throw Error('query fault');};
 for(let n=0;n<9;n++){await s.run();s.tick();}
 assert.equal(s.jobs()[0].attempts,8);assert.equal(s.jobs()[0].state,'blocked');assert.equal(s.effects().length,0);
});
test('provider deadline covers stalled response body and does not expose logs',async()=>{
 const provider=createProviders({NOTION_API_TOKEN:'synthetic_token'},async()=>new Response(new ReadableStream({start(){},cancel(){}})),10);
 await assert.rejects(provider.schema());
});
test('daily send budget is atomic across applications and reserves only approved allotment',async()=>{
 const s=setup();s.env.PROVIDER_DAILY_LIMIT='1';seed(s.d);seed(s.d);seed(s.d);
 for(let i=0;i<3;i++)await s.run();
 assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,1);
 assert.equal(s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').get().n,1);
 s.tick();await s.run();assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,1);
});
test('intent write failure rolls back reservation and safely resumes after repair',async()=>{
 const s=setup();const id=seed(s.d);
 s.d.sqlite.exec("CREATE TRIGGER fail_intent BEFORE UPDATE OF email_state ON membership_notify_cases WHEN NEW.email_state='UNKNOWN' BEGIN SELECT RAISE(ABORT,'storage fault'); END;");
 await s.run();s.d.sqlite.exec('DROP TRIGGER fail_intent');s.tick();await s.run();
 assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,1);
 assert.equal(s.row(id).email_state,'SENT');
 assert.equal(s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').get().n,1);
});
test('lost or expired durable effect claim cannot dispatch',async()=>{
 const s=setup();seed(s.d);
 s.control.query=()=>{
  s.d.sqlite.exec('UPDATE membership_notify_cases SET lease_until=0,lease_token=NULL');
  return json({results:[],has_more:false});
 };
 await s.run();assert.equal(s.effects().length,0);
});
test('completed event expiry preserves case tombstones and cannot re-notify after event pruning',async()=>{
 const s=setup();const id=seed(s.d);await s.run();
 s.d.sqlite.exec("DELETE FROM membership_notify_outbox WHERE state='done'");
 s.d.sqlite.prepare("INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at) VALUES(?,'submitted',1,?)").run(id,TIME);
 s.tick();await s.run();assert.equal(s.effects().filter(c=>c.url.endsWith('/emails')).length,1);
 assert.equal(s.effects().filter(c=>c.url.endsWith('/pages')).length,1);
});
test('scheduled handler drains via waitUntil; provider failure does not affect applicant retention',async()=>{
 const {sweep}=await import('../../membership/common.mjs');
 const s=setup();const id=seed(s.d,{created:TIME-90*DAY});s.control.query=()=>{throw Error('offline');};
 let job;s.worker.scheduled({},s.env,{waitUntil(p){job=p;}});await job;
 await sweep(s.env,TIME);assert.equal(s.d.rows().find(r=>r.id===id).status,'expired');
 await sweep(s.env,TIME+30*DAY);assert.equal(s.d.rows().find(r=>r.id===id).email,null);
});

for(const status of Object.keys(decisions))test(`verified schema and exact mapping for ${status}; no applicant email`,async()=>{
 const s=setup();seed(s.d,{status});await s.run();
 const patch=s.calls.find(c=>c.init.method==='PATCH');
 assert.deepEqual(patch.body.properties,{Status:{select:{name:statuses[status]}},'Membership Decision':{select:{name:decisions[status]}}});
 const create=s.calls.find(c=>c.url.endsWith('/pages'));
 assert.equal(create.body.properties.Status.select.name,'Inbox');assert.deepEqual(create.body.properties.Link,{url:QUEUE});
 assert.ok(!Object.hasOwn(create.body.properties,'Owner Queue'));
 assert.ok(s.calls.filter(c=>c.url.endsWith('/emails')).every(c=>JSON.stringify(c.body.to)===JSON.stringify([OWNER])));
});
for(const field of ['EMAIL_ENABLED','PROVIDER_VERIFIED_UNTIL_MS','PROVIDER_DAILY_LIMIT','NOTIFY_START_MS'])test(`temporary ${field} wait survives retry limit then resumes`,async()=>{
 const s=setup();const id=seed(s.d);const value=s.env[field];s.env[field]='0';
 for(let i=0;i<12;i++){s.env[field]='0';await s.run();s.tick();}
 assert.equal(s.row(id).email_state,'NEW');assert.equal(s.jobs()[0].state,'pending');assert.equal(s.jobs()[0].attempts,0);
 assert.equal(s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').get().n,0);
 s.env[field]=field==='PROVIDER_VERIFIED_UNTIL_MS'?String(TIME+12*3600000+DAY):value;
 await s.run();assert.equal(s.row(id).email_state,'SENT');
});
test('quota wait resumes next day without consuming retries or UNKNOWN; status work is not starved',async()=>{
 const s=setup();s.env.PROVIDER_DAILY_LIMIT='1';const first=seed(s.d),second=seed(s.d);
 await s.run();await s.run();
 assert.equal(s.row(second).email_state,'NEW');
 s.d.sqlite.prepare("UPDATE membership_requests SET status='expired',revision=revision+1,updated_at=? WHERE id=?").run(TIME,first);
 await s.run();assert.equal(s.pages.get(first).properties.Status.select.name,'Closed');
 for(let i=0;i<24;i++)s.tick();await s.run();
 assert.equal(s.row(second).email_state,'SENT');assert.equal(s.jobs().find(j=>j.application_id===second).attempts,0);
});
test('expiration survives failed PATCH and PII clearing, then closes the existing ticket without another email',async()=>{
 const {sweep}=await import('../../membership/common.mjs');
 const s=setup();const id=seed(s.d,{created:TIME-90*DAY});await s.run();
 await sweep(s.env,TIME);s.control.patch=()=>{throw Error('offline');};await s.run();
 assert.equal(s.jobs().filter(j=>j.state==='pending').length,1);
 await sweep(s.env,TIME+30*DAY);assert.equal(s.d.rows()[0].email,null);
 delete s.control.patch;s.tick();await s.run();
 assert.equal(s.pages.get(id).properties.Status.select.name,'Closed');
 assert.equal(s.pages.get(id).properties['Membership Decision'].select.name,'Not applicable');
 assert.equal(s.calls.filter(c=>c.url.endsWith('/emails')).length,0);
});
test('schema missing an allowed status blocks before effects and does not provision options',async()=>{
 const s=setup();seed(s.d);s.control.schema=schema();s.control.schema.properties.Status.select.options.pop();
 await s.run();assert.equal(s.effects().length,0);assert.ok(s.calls.every(c=>c.init.method==='GET'));
});

test('uncertain reservation transaction acknowledgement preserves UNKNOWN and cannot dispatch on restart',async()=>{
 const s=setup();const id=seed(s.d);const batch=s.d.batch;
 s.d.batch=async statements=>{const result=await batch(statements);throw Object.assign(Error('lost acknowledgement'),{result});};
 await s.run();assert.equal(s.row(id).email_state,'UNKNOWN');
 s.d.batch=batch;s.tick();await s.run();assert.equal(s.calls.filter(c=>c.url.endsWith('/emails')).length,0);
});
test('pending expiry is bounded, atomic with its outbox, and preserves old approved requests',async()=>{
 const {sweep}=await import('../../membership/common.mjs');const s=setup();
 for(let i=0;i<102;i++)seed(s.d,{created:TIME-90*DAY});
 const approved=seed(s.d,{status:'approved',created:TIME-800*DAY,note:'Retain until owner closure'});
 const original=s.d.rows().find(row=>row.id===approved);
 s.d.sqlite.exec("CREATE TRIGGER fail_expiry BEFORE INSERT ON membership_notify_outbox WHEN NEW.kind='status' BEGIN SELECT RAISE(ABORT,'offline failure'); END;");
 await assert.rejects(sweep(s.env,TIME));assert.equal(s.d.rows().filter(r=>r.status==='expired').length,0);
 s.d.sqlite.exec('DROP TRIGGER fail_expiry');await sweep(s.env,TIME);
 assert.equal(s.d.rows().filter(r=>r.status==='expired').length,100);
 assert.equal(s.jobs().filter(j=>j.kind==='status').length,100);
 await sweep(s.env,TIME);assert.equal(s.d.rows().filter(r=>r.status==='expired').length,102);
 await sweep(s.env,TIME+30*DAY);assert.equal(s.d.rows().filter(r=>r.email===null).length,100);
 await sweep(s.env,TIME+30*DAY);assert.equal(s.d.rows().filter(r=>r.email===null).length,102);
 assert.ok(s.jobs().filter(j=>j.kind==='status').every(j=>j.state==='pending'));
 assert.deepEqual(s.d.rows().find(row=>row.id===approved),original);
 assert.equal(s.jobs().filter(j=>j.application_id===approved && j.kind==='status').length,0);
});
test('unexpected decision option fails schema validation before provider mutations',async()=>{
 const s=setup();seed(s.d);s.control.schema=schema();
 s.control.schema.properties['Membership Decision'].select.options.push({name:'Expired'});
 await s.run();assert.equal(s.effects().length,0);assert.deepEqual(s.logs,['configuration']);
});

for(const mode of ['credentials','schema','outage'])test(`persistent schema budget: ${mode}, 12 five-minute cron cycles, restart and eventual recovery`,async()=>{
 const s=setup();const id=seed(s.d);
 const invalid=schema();invalid.properties.Link.type='rich_text';
 s.control.before=url=>{
  if(!url.endsWith(SOURCE))return;
  if(mode==='credentials')return;
  if(mode==='outage')throw Error('sensitive provider outage');
 };
 if(mode==='schema')s.control.schema=invalid;
 if(mode==='credentials')s.control.schemaResponse=()=>new Response('secret credential fault',{status:401});
 for(let n=0;n<12;n++) {
  // Reconstruct the Worker every tick: no in-memory retry state.
  let promise;s.worker.scheduled({},s.env,{waitUntil(p){promise=p;}});
  await promise;await s.restart();s.advance(300000);
 }
 assert.equal(s.calls.length,4); // minutes 0, 5, 15, 35 (not every tick)
 assert.equal(s.effects().length,0);
 assert.equal(s.jobs()[0].state,'pending');assert.equal(s.jobs()[0].attempts,0);
 let check=s.d.sqlite.prepare('SELECT * FROM membership_notify_provider_check').get();
 assert.equal(check.attempts,4);assert.equal(check.next_attempt,TIME+75*60000);
 // Prolonged failure saturates the counter and permits at most one probe/day.
 for(let n=0;n<12;n++){s.advance(DAY);await s.restart();await s.restart();}
 check=s.d.sqlite.prepare('SELECT * FROM membership_notify_provider_check').get();
 assert.equal(check.attempts,8);assert.equal(s.calls.length,16);
 delete s.control.before;delete s.control.schema;delete s.control.schemaResponse;
 await s.restart();assert.equal(s.row(id).notion_state,'NEW');
 s.advance(DAY);await s.restart();await s.restart();
 assert.equal(s.row(id).email_state,'SENT');assert.equal(s.jobs()[0].state,'done');
 assert.equal(s.effects().length,2);
 check=s.d.sqlite.prepare('SELECT * FROM membership_notify_provider_check').get();
 assert.equal(check.attempts,0);assert.equal(check.next_attempt,0);
 assert.ok(s.logs.every(c=>c==='configuration'));
});
test('no schema/provider calls without due pending work, including blocked-only queue',async()=>{
 const s=setup();await s.run();const id=seed(s.d);
 s.d.sqlite.prepare('UPDATE membership_notify_outbox SET next_attempt=?').run(TIME+DAY);
 await s.run();s.d.sqlite.exec("UPDATE membership_notify_outbox SET state='blocked',next_attempt=0");await s.run();
 assert.equal(s.calls.length,0);assert.equal(s.row(id).notion_state,'NEW');
 assert.equal(s.d.sqlite.prepare('SELECT attempts FROM membership_notify_provider_check').get().attempts,0);
});
test('schema probe concurrency and uncertain reservation acknowledgement cannot bypass persistent cooldown',async()=>{
 const s=setup();seed(s.d);s.control.before=()=>{throw Error('offline');};
 await Promise.all(Array.from({length:12},()=>s.restart()));assert.equal(s.calls.length,1);
 s.advance(300000);
 const prepare=s.d.prepare;
 s.d.prepare=query=>{
  const statement=prepare(query);
  if(!query.includes('RETURNING id') || !query.includes('SET attempts=MIN'))return statement;
  return {bind(...values){const bound=statement.bind(...values);return {async first(){await bound.first();throw Error('lost DB ack');}};}};
 };
 await assert.rejects(s.restart(),/lost DB ack/);s.d.prepare=prepare;
 await s.restart();assert.equal(s.calls.length,1);
 s.advance(600000);await s.restart();assert.equal(s.calls.length,2);
});
for(const gate of ['NOTIFY_ENABLED','NOTION_ENABLED','unconfigured','invalid schema'])test(`bounded completed-event cleanup with ${gate}, independent of dispatch and applicant retention`,async()=>{
 const {sweep}=await import('../../membership/common.mjs');const s=setup();
 const approved=seed(s.d,{status:'approved',created:TIME-800*DAY,note:'Retain until manual closure'});
 for(let n=0;n<204;n++)seed(s.d,{created:TIME-365*DAY});
 s.d.sqlite.exec("UPDATE membership_notify_outbox SET state='done'");
 const fresh=seed(s.d,{created:TIME-365*DAY+1});
 s.d.sqlite.prepare("UPDATE membership_notify_outbox SET state='done' WHERE application_id=?").run(fresh);
 const pending=seed(s.d,{created:TIME-400*DAY}),blocked=seed(s.d,{created:TIME-400*DAY});
 s.d.sqlite.prepare("UPDATE membership_notify_outbox SET state='blocked' WHERE application_id=?").run(blocked);
 const original=s.d.rows().find(r=>r.id===approved);
 if(gate==='unconfigured'){delete s.env.NOTIFY_ENABLED;delete s.env.NOTION_ENABLED;}
 else if(gate==='invalid schema'){s.control.schema=schema();s.control.schema.properties.Link.type='rich_text';}
 else s.env[gate]='false';
 for(const remaining of [105,5,0]) {
  await s.restart();
  assert.equal(s.jobs().filter(j=>j.state==='done' && j.occurred_at<=TIME-365*DAY).length,remaining);
 }
 assert.equal(s.jobs().length,3);assert.ok(s.jobs().some(j=>j.application_id===fresh && j.state==='done'));
 assert.ok(s.jobs().some(j=>j.application_id===pending && j.state==='pending'));
 assert.ok(s.jobs().some(j=>j.application_id===blocked && j.state==='blocked'));
 assert.equal(s.effects().length,0);assert.equal(s.calls.length,gate==='invalid schema'?1:0);
 assert.equal(s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_cases').get().n,209);
 for(const year of [0,1,10])await sweep(s.env,TIME+year*365*DAY);
 assert.deepEqual(s.d.rows().find(r=>r.id===approved),original);
 const plan=s.d.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM membership_notify_outbox WHERE state='done' AND occurred_at<=? ORDER BY occurred_at,id LIMIT 100").all(TIME);
 assert.ok(plan.some(row=>row.detail.includes('membership_notify_completed_age')));
 assert.ok(plan.every(row=>!row.detail.includes('TEMP B-TREE')));
});

// Synthetic assertions only. Scope/plan are release attestations, not key introspection.
function permanentSetup(time=TIME) {
 const s=setup();s.setTime(time);
 Object.assign(s.env,{PERMANENT_OWNER_FREE_MODE:'true',PROVIDER_VERIFIED_UNTIL_MS:'0',PROVIDER_DAILY_LIMIT:'0',
  PERMANENT_OWNER_FREE_DAILY_LIMIT:'1',PERMANENT_OWNER_FREE_MONTHLY_LIMIT:'15',
  PERMANENT_OWNER_FREE_ATTESTATION:'resend-free-sending-only-no-overages-v1',
  PERMANENT_OWNER_FREE_ATTESTED_AT_MS:String(time-1),NOTIFY_START_MS:String(time-2)});
 return s;
}
const emails=s=>s.calls.filter(c=>c.url.endsWith('/emails'));
function reserveFixture(s,day) {
 // Historical durable attempts, with no pending jobs; include any outcome in budgets.
 const id=crypto.randomUUID();
 s.d.sqlite.prepare("INSERT INTO membership_notify_cases(application_id,created_at,email_state) VALUES(?,?,'REFUSED')").run(id,day*DAY);
 s.d.sqlite.prepare('INSERT INTO membership_notify_send_attempts(application_id,utc_day) VALUES(?,?)').run(id,day);
 return id;
}
test('permanent eligibility after original expiry; no usage API, fixed owner payload, durable idempotency',async()=>{
 const s=permanentSetup();const id=seed(s.d);
 assert.equal(emailReady({...s.env,PERMANENT_OWNER_FREE_MODE:'false',PROVIDER_VERIFIED_UNTIL_MS:String(TIME-1)},TIME),false);
 assert.equal(emailReady(s.env,TIME),true);await s.run();await s.restart();
 assert.equal(s.row(id).email_state,'SENT');assert.equal(emails(s).length,1);
 assert.equal(emails(s)[0].init.headers['Idempotency-Key'],`membership-notify-v1-${id}`);
 assert.deepEqual(emails(s)[0].body.to,[OWNER]);assert.equal(emails(s)[0].body.from,SENDER);
 assert.ok(s.calls.every(c=>!c.url.includes('/usage')));
 s.d.sqlite.exec("DELETE FROM membership_notify_outbox WHERE state='done'");
 s.d.sqlite.prepare("INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at) VALUES(?,'submitted',1,?)").run(id,TIME);
 await s.restart();assert.equal(emails(s).length,1);
});
const badPermanentConfigs=[
 ['PERMANENT_OWNER_FREE_MODE',undefined],['PERMANENT_OWNER_FREE_MODE','false'],['PERMANENT_OWNER_FREE_MODE','TRUE'],
 ['PERMANENT_OWNER_FREE_MODE','1'],['PERMANENT_OWNER_FREE_MODE',''],
 ['PERMANENT_OWNER_FREE_DAILY_LIMIT',undefined],['PERMANENT_OWNER_FREE_DAILY_LIMIT','0'],['PERMANENT_OWNER_FREE_DAILY_LIMIT','2'],
 ['PERMANENT_OWNER_FREE_DAILY_LIMIT','01'],['PERMANENT_OWNER_FREE_DAILY_LIMIT',1],
 ['PERMANENT_OWNER_FREE_MONTHLY_LIMIT',undefined],['PERMANENT_OWNER_FREE_MONTHLY_LIMIT','0'],['PERMANENT_OWNER_FREE_MONTHLY_LIMIT','16'],
 ['PERMANENT_OWNER_FREE_MONTHLY_LIMIT','015'],['PERMANENT_OWNER_FREE_MONTHLY_LIMIT',15],
 ['PERMANENT_OWNER_FREE_ATTESTATION',''],['PERMANENT_OWNER_FREE_ATTESTATION','full-access'],
 ['PERMANENT_OWNER_FREE_ATTESTED_AT_MS','0'],['PERMANENT_OWNER_FREE_ATTESTED_AT_MS',String(TIME+1)],
 ['PERMANENT_OWNER_FREE_ATTESTED_AT_MS',String(TIME-3)],
 ['PROVIDER_DAILY_LIMIT','1'],['PROVIDER_VERIFIED_UNTIL_MS',String(TIME+3600000)],
 ['RESEND_API_KEY',undefined],['RESEND_API_KEY','bad key'],['RESEND_API_KEY',''],
 ['OWNER_EMAIL','synthetic@example.test'],['SENDER_EMAIL','synthetic@example.test'],
 ['NOTIFY_START_MS','0'],['NOTIFY_START_MS',String(TIME+1)],['EMAIL_ENABLED','false']
];
for(const [field,value] of badPermanentConfigs)test(`permanent rejects ${field}=${String(value)} while Notion/status remains independent`,async()=>{
 const s=permanentSetup();s.env[field]=value;const id=seed(s.d,{created:field==='NOTIFY_START_MS' && value===String(TIME+1)?TIME+1:TIME});await s.run();
 assert.equal(emailReady(s.env,TIME),false);assert.equal(emails(s).length,0);assert.equal(s.row(id).email_state,'NEW');
 assert.equal(s.row(id).notion_state,'LINKED');assert.equal(s.jobs()[0].attempts,0);
 s.d.sqlite.prepare("UPDATE membership_requests SET status='expired',revision=revision+1,updated_at=? WHERE id=?").run(TIME,id);
 await s.run();assert.equal(s.pages.get(id).properties.Status.select.name,'Closed');
 assert.equal(s.jobs().find(j=>j.kind==='status').state,'done');
 assert.equal(s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').get().n,0);
});
test('permanent daily limit across distinct applications, overlap and restart; waits do not consume retries',async()=>{
 const s=permanentSetup();const ids=Array.from({length:4},()=>seed(s.d));
 await Promise.all(Array.from({length:8},()=>s.restart()));
 for(let i=0;i<4;i++)await s.run();
 assert.equal(emails(s).length,1);assert.equal(ids.filter(id=>s.row(id).email_state==='NEW').length,3);
 assert.ok(s.jobs().every(j=>j.attempts===0));
 s.setTime(TIME+DAY);await s.restart();assert.equal(emails(s).length,2);
});
for(const boundary of ['2026-12-31T23:59:59.999Z','2027-01-31T23:59:59.999Z','2028-02-29T23:59:59.999Z','2028-02-28T23:59:59.999Z'])test(`permanent UTC budget edges ${boundary}`,async()=>{
 const time=Date.parse(boundary),s=permanentSetup(time),day=Math.floor(time/DAY);
 const date=new Date(time),start=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/DAY;
 // Prior month never counts; 14 current-month attempts allow exactly one more.
 for(let i=1;i<=20;i++)reserveFixture(s,start-i);
 for(let i=0;i<14;i++)reserveFixture(s,start+i);
 const first=seed(s.d,{created:time});await s.run();assert.equal(s.row(first).email_state,'SENT');
 const nextTime=time+1;s.setTime(nextTime);
 const second=seed(s.d,{created:nextTime});await s.run();
 const rollover=new Date(nextTime).getUTCMonth()!==date.getUTCMonth();
 assert.equal(s.row(second).email_state,rollover?'SENT':'NEW');
 assert.equal(emails(s).length,rollover?2:1);
 // All timestamps were partitioned by UTC, including year and leap-day rollover.
 assert.equal(s.d.sqlite.prepare('SELECT utc_day FROM membership_notify_send_attempts WHERE application_id=?').get(first).utc_day,day);
});
test('permanent exhausted month waits, still closes status, resumes at next UTC month without new attestation',async()=>{
 const time=Date.parse('2028-01-30T12:00:00Z'),s=permanentSetup(time),start=Date.parse('2028-01-01T00:00:00Z')/DAY;
 for(let i=0;i<15;i++)reserveFixture(s,start+i);
 const id=seed(s.d,{created:time});await s.run();assert.equal(emails(s).length,0);
 s.setTime(time+DAY);await s.run();assert.equal(s.row(id).email_state,'NEW');
 s.d.sqlite.prepare("UPDATE membership_requests SET status='rejected',revision=revision+1,updated_at=? WHERE id=?").run(time,id);
 await s.run();assert.equal(s.pages.get(id).properties.Status.select.name,'Closed');
 s.setTime(Date.parse('2028-02-01T00:00:00Z'));await s.restart();assert.equal(s.row(id).email_state,'SENT');
 assert.equal(s.jobs()[0].attempts,0);
});
for(const status of [400,401,403,422,429,500,'timeout','malformed'])test(`permanent provider exhaustion/refusal/UNKNOWN ${status} never retries`,async()=>{
 const s=permanentSetup();const id=seed(s.d);
 s.control.send=()=>status==='timeout'?new Promise(()=>{}):status==='malformed'?json({}):new Response(null,{status});
 await s.run();s.setTime(TIME+32*DAY);await s.restart();
 assert.equal(s.row(id).email_state,[400,401,403,422,429].includes(status)?'REFUSED':'UNKNOWN');
 assert.equal(emails(s).length,1);assert.equal(s.d.sqlite.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').get().n,1);
});
test('permanent historical/manual suppression remains irreversible',async()=>{
 const s=permanentSetup();const id=seed(s.d,{created:TIME-3});await s.run();
 assert.equal(s.row(id).email_state,'SUPPRESSED');assert.equal(emails(s).length,0);
 s.d.sqlite.prepare("INSERT INTO membership_notify_outbox(application_id,kind,revision,occurred_at) VALUES(?,'adopt',1,0)").run(MANUAL);
 s.pages.set(MANUAL,page(MANUAL));await s.run();assert.equal(s.row(MANUAL).email_state,'SUPPRESSED');
 assert.equal(emails(s).length,0);
});
for(const mode of ['rollback','lost-ack','midnight','config-change'])test(`permanent transaction safety ${mode}`,async()=>{
 const time=Date.parse('2028-12-31T23:59:59.999Z'),s=permanentSetup(time),id=seed(s.d,{created:time});
 const batch=s.d.batch;
 if(mode==='rollback')s.d.sqlite.exec("CREATE TRIGGER fail_free_intent BEFORE UPDATE OF email_state ON membership_notify_cases WHEN NEW.email_state='UNKNOWN' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 else s.d.batch=async statements=>{
  const result=await batch(statements);
  if(mode==='lost-ack')throw Error('synthetic lost ack');
  if(mode==='midnight')s.setTime(time+1);
  if(mode==='config-change')s.env.PERMANENT_OWNER_FREE_MODE='false';
  return result;
 };
 await s.run();assert.equal(emails(s).length,0);
 assert.equal(s.row(id).email_state,mode==='rollback'?'NEW':'UNKNOWN');
 s.d.batch=batch;
 if(mode==='rollback')s.d.sqlite.exec('DROP TRIGGER fail_free_intent');
 s.env.PERMANENT_OWNER_FREE_MODE='true';s.setTime(time+2*DAY);await s.restart();
 assert.equal(emails(s).length,mode==='rollback'?1:0);
});
test('permanent never treats an existing reservation as fresh dispatch authority',async()=>{
 const s=permanentSetup();const id=seed(s.d);
 s.d.sqlite.prepare('INSERT INTO membership_notify_send_attempts(application_id,utc_day) VALUES(?,?)').run(id,Math.floor(TIME/DAY)-1);
 await s.run();assert.equal(emails(s).length,0);assert.equal(s.row(id).email_state,'NEW');
});
test('temporary six-hour attestation remains separately supported and expires; invalid mode fails closed',async()=>{
 const s=setup();s.env.PROVIDER_VERIFIED_UNTIL_MS=String(TIME+6*3600000);
 for(const flag of [undefined,'false'])assert.equal(emailReady({...s.env,PERMANENT_OWNER_FREE_MODE:flag},TIME),true);
 assert.equal(emailReady({...s.env,PERMANENT_OWNER_FREE_MODE:'TRUE'},TIME),false);
 const first=seed(s.d);await s.run();assert.equal(s.row(first).email_state,'SENT');
 s.setTime(TIME+6*3600000);const second=seed(s.d,{created:TIME+6*3600000});await s.run();
 assert.equal(s.row(second).email_state,'NEW');assert.equal(emails(s).length,1);
});
test('permanent range/equality queries use existing covering day index without temporary sorting',()=>{
 const s=permanentSetup();
 for(const [query,values] of [
  ['SELECT 1 FROM membership_notify_send_attempts WHERE utc_day=?',[1]],
  ['SELECT COUNT(*) FROM (SELECT 1 FROM membership_notify_send_attempts WHERE utc_day>=? AND utc_day<? LIMIT 15)',[1,32]]
 ]) {
  const plan=s.d.sqlite.prepare('EXPLAIN QUERY PLAN '+query).all(...values);
  assert.ok(plan.some(row=>row.detail.includes('membership_notify_send_day')));
  assert.ok(plan.every(row=>!row.detail.includes('TEMP B-TREE')));
 }
});
