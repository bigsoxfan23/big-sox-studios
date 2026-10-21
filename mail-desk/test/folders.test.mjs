import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, D1, folderMigration, input } from './helpers.mjs';
import { syntheticIntake } from '../src/intake.synthetic.mjs';
import { claimSend } from '../src/store.mjs';
import { syncFolders } from '../src/folders.sync.mjs';
import { LiveNotion } from '../src/notion.live.mjs';
import { runNotionSync } from '../src/notion.sync.mjs';
const m4 = await readFile(new URL('../migrations/0004_outbound_approval.sql',import.meta.url),'utf8');
const m5 = await readFile(new URL('../migrations/0005_simple_replies.sql',import.meta.url),'utf8');
async function setup(t, options={}) {
 const f = await fixture(t,{notion:true,cleanup:false,...options});
 f.DB.sqlite.exec((options.legacyLock ? m4 : '')+m5+folderMigration);
 await f.session(); return f;
}
const detail = async(f,id) => (await f.request('/api/cases/'+id)).json();
const move = (f,id,action,version=0) => f.request('/api/cases/folder',{action,cases:[{id,version}]});
async function moved(f,id,action,version=0) { const r=await move(f,id,action,version);assert.equal(r.status,200);const v=await r.json();assert.equal(v.results[0].ok,true,JSON.stringify(v));return v.results[0]; }
async function inbound(f, name='parent', parent, reject=false) {
 const raw=new TextEncoder().encode('Content-Type: text/plain\r\n\r\nGenuine fixture'); let forwarded=0,rejected=0;
 await f.worker.email({from:'customer@example.test',to:'support@bigsoxstudios.com',headers:new Headers({'message-id':`<${name}@example.test>`,...(parent?{'in-reply-to':`<${parent}@example.test>`}:{})}),rawSize:raw.length,raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),setReject(){rejected++;},async forward(){forwarded++;}}, {...f.env,ENABLE_INBOUND_EMAIL:'true',INBOUND_FORWARD_TO:'owner@example.test'},{});
 assert.equal(rejected,reject?1:0);
 return {forwarded,id:f.DB.sqlite.prepare('SELECT case_id FROM email_receipts ORDER BY rowid DESC LIMIT 1').get()?.case_id};
}

for (const legacyLock of [false,true]) test(`full 0006 preserves populated 0001+0002+0003+${legacyLock?'0004+':''}0005 and existing triggers`,async t=>{
 const db=new D1({notion:true,cleanup:false});t.after(()=>db.close());db.sqlite.exec((legacyLock?m4:'')+m5);
 const id=await syntheticIntake(db,input());
 const names=db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
 const snapshot=()=>names.map(n=>db.sqlite.prepare('SELECT * FROM '+n).all());
 const before=snapshot();
 const triggers=db.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
 db.sqlite.exec(folderMigration);
 assert.deepEqual(snapshot(),before);
 for(const trigger of triggers) assert.deepEqual(db.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger.name),trigger);
 assert.equal(db.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='live_outbound_reviews'").get().n,legacyLock?1:0);
 db.sqlite.prepare("UPDATE cases SET draft='existing draft',revision=revision+1 WHERE id=?").run(id);
 for(const [folder,version] of [['archive',0],['inbox',1]]) db.sqlite.prepare('UPDATE case_folders SET folder=?,version=version+1,updated_at=updated_at+1,invalidated_revision=(SELECT revision+1 FROM cases WHERE id=?) WHERE case_id=? AND version=?').run(folder,id,id,version);
 assert.equal(db.sqlite.prepare('SELECT folder FROM case_folders WHERE case_id=?').get(id).folder,'inbox');
 const next=await syntheticIntake(db,input({key:'second'}));
 assert.equal(db.sqlite.prepare('SELECT folder FROM case_folders WHERE case_id=?').get(next).folder,'inbox');
 assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal(db.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.throws(()=>db.sqlite.exec("UPDATE case_folders SET folder='delete'"));
 assert.throws(()=>db.sqlite.exec("UPDATE case_folders SET version=version+1"));
});

test('folder counts, whole-case moves and restore preserve every immutable record',async t=>{
 const f=await setup(t);const id=await f.seed();const other=await f.seed({key:'other'});const r=await f.review(id);
 const tables=['messages','outbound_intents','reply_review_modes','inbound_dedupe','sync_jobs'];
 const snapshot=()=>tables.map(n=>f.DB.sqlite.prepare('SELECT * FROM '+n).all());const before=snapshot();
 await moved(f,id,'archive');let c=await detail(f,id);assert.equal(c.revision,r.revision+1);assert.equal(c.folder,'archive');
 let q=await (await f.request('/api/cases?folder=archive')).json();assert.equal(q.cases[0].id,id);assert.deepEqual(q.counts,{inbox:1,archive:1,trash:0});
 await moved(f,id,'trash',1);await moved(f,id,'restore',2);assert.deepEqual(snapshot(),before);
 assert.equal((await detail(f,id)).revision,r.revision+3);assert.equal((await detail(f,other)).folder,'inbox');
 assert.equal((await f.request('/api/cases?folder=bad')).status,400);
 assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE event LIKE 'folder_%'").get().n,3);
});

for (const data of [null,{}, {action:'delete',cases:[]},{action:'toString',cases:[]},{action:[],cases:[]},{action:'trash',cases:[]},{action:'trash',cases:[{id:'bad',version:0}]},{action:'trash',cases:[{id:crypto.randomUUID(),version:-1}]},{action:'trash',cases:[{id:crypto.randomUUID(),version:0,extra:true}]},{action:'trash',cases:Array.from({length:26},()=>({id:crypto.randomUUID(),version:0}))}]) test('malformed bulk request fails without mutations '+JSON.stringify(data),async t=>{
 const f=await setup(t);await f.seed();const r=await f.request('/api/cases/folder',data);assert.equal(r.status,400);assert.equal(f.DB.sqlite.prepare('SELECT version FROM case_folders').get().version,0);
});

test('bulk Access, session, CSRF and origin requirements',async t=>{
 const f=await setup(t),id=await f.seed(),data={action:'trash',cases:[{id,version:0}]};
 for (const headers of [{'Cf-Access-Jwt-Assertion':null},{Cookie:null},{'X-CSRF-Token':null},{Origin:'https://attacker.test'}]) {
  const r=await f.request('/api/cases/folder',data,{headers});assert.ok([401,403].includes(r.status));
 }
 assert.equal((await detail(f,id)).folder,'inbox');
});

test('bulk 25 limit, duplicate validation, stale versions, partial failures and concurrency',async t=>{
 const f=await setup(t);const ids=[];for(let i=0;i<25;i++) ids.push(await f.seed({key:'bulk'+i}));
 const cases=ids.map(id=>({id,version:0}));
 assert.equal((await f.request('/api/cases/folder',{action:'trash',cases:[cases[0],cases[0]]})).status,400);
 const r=await f.request('/api/cases/folder',{action:'archive',cases});assert.equal((await r.json()).results.filter(r=>r.ok).length,25);
 const responses=await Promise.all([move(f,ids[0],'trash',1),move(f,ids[0],'restore',1)]);
 assert.equal((await Promise.all(responses.map(r=>r.json()))).flatMap(r=>r.results).filter(r=>r.ok).length,1);
 const partial=await (await f.request('/api/cases/folder',{action:'trash',cases:[{id:ids[0],version:0},{id:ids[1],version:1},{id:crypto.randomUUID(),version:0}]})).json();
 assert.deepEqual(partial.results.map(r=>r.ok),[false,true,false]);assert.equal(partial.results[2].error,'case_not_found');
});

test('bulk storage rejection reports partial uncertainty without rolling back other successes',async t=>{
 const f=await setup(t),a=await f.seed(),b=await f.seed({key:'b'});
 f.DB.sqlite.exec(`CREATE TRIGGER fixture_folder_fail BEFORE UPDATE ON case_folders WHEN OLD.case_id='${a}' BEGIN SELECT RAISE(ABORT,'private'); END;`);
 const v=await (await f.request('/api/cases/folder',{action:'trash',cases:[{id:a,version:0},{id:b,version:0}]})).json();
 assert.deepEqual(v.results.map(r=>r.ok),[false,true]);assert.equal(v.results[0].error,'folder_outcome_unconfirmed');assert.equal((await detail(f,a)).folder,'inbox');
});

test('trash refuses draft/review/send; restore and archive invalidate old MAC approvals durably',async t=>{
 const f=await setup(t),id=await f.seed(),r=await f.review(id);
 const before=f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id);
 await moved(f,id,'trash');
 assert.equal((await f.request(`/api/cases/${id}/draft`,{body:'blocked',revision:r.revision+1})).status,409);
 assert.equal((await f.request(`/api/cases/${id}/review`,{revision:r.revision+1})).status,409);
 assert.equal((await f.send(id,r)).status,409);
 await moved(f,id,'restore',1);assert.equal((await f.send(id,r)).status,409);
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id),before);
 const fresh=await f.review(id);await moved(f,id,'archive',2);assert.equal((await f.send(id,fresh)).status,409);
 const archivedReview=await f.review(id);assert.equal((await (await f.send(id,archivedReview)).json()).status,'sent');assert.equal(f.calls(),1);
});

test('atomic claimSend independently refuses a matching snapshot while in Trash',async t=>{
 const f=await setup(t),id=await f.seed(),r=await f.review(id);await moved(f,id,'trash');
 f.DB.sqlite.prepare('UPDATE outbound_intents SET revision=? WHERE id=?').run(r.revision+1,r.id);
 const i=f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id);
 assert.equal(await claimSend(f.DB,i),null);assert.equal(f.calls(),0);
});

for (const folder of ['archive','trash']) test(`NEW receipt atomically reopens ${folder}, retries never reopen`,async t=>{
 const f=await setup(t);const {id}=await inbound(f);await moved(f,id,folder);const rev=(await detail(f,id)).revision;
 assert.equal((await inbound(f,'child','parent')).forwarded,1);let c=await detail(f,id);assert.equal(c.folder,'inbox');assert.equal(c.folderVersion,2);assert.equal(c.revision,rev+1);
 await moved(f,id,'trash',2);const snapshot=await detail(f,id);assert.equal((await inbound(f,'child','parent')).forwarded,0);c=await detail(f,id);assert.equal(c.folder,'trash');assert.equal(c.revision,snapshot.revision);assert.equal(c.messages.length,2);
});

test('receipt batch rollback and missing migration fail closed before forwarding',async t=>{
 const f=await setup(t),{id}=await inbound(f);await moved(f,id,'trash');
 f.DB.sqlite.exec("CREATE TRIGGER fixture_message_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'private'); END;");
 await inbound(f,'child','parent',true);assert.equal((await detail(f,id)).folder,'trash');assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM email_receipts').get().n,1);
 f.DB.sqlite.exec('DROP TRIGGER fixture_message_fail; DROP TRIGGER case_folder_initial; DROP TRIGGER case_folder_changed; DROP TRIGGER case_folder_transition; DROP TABLE case_folder_sync; DROP TABLE case_folders;');
 await inbound(f,'child','parent',true);
 assert.equal((await f.request('/api/cases')).status,503);assert.equal((await move(f,id,'restore',1)).status,503);assert.equal((await f.request(`/api/cases/${id}/draft`,{body:'blocked',revision:1})).status,503);
});

test('UNKNOWN remains durable across folder moves, reopen and new review attempts',async t=>{
 const f=await setup(t,{simulation:{status:'UNKNOWN'}}),{id}=await inbound(f);const r=await f.review(id);
 // Persist the uncertain outcome without invoking any transport.
 f.DB.sqlite.prepare("UPDATE outbound_intents SET status='dispatching' WHERE id=?").run(r.id);
 f.DB.sqlite.prepare("UPDATE outbound_intents SET status='UNKNOWN' WHERE id=?").run(r.id);
 const before=f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id);
 await moved(f,id,'trash');await inbound(f,'child','parent');
 const c=await detail(f,id);assert.equal((await f.request(`/api/cases/${id}/review`,{revision:c.revision})).status,409);
 assert.equal((await f.request(`/api/cases/${id}/draft`,{body:'blocked',revision:c.revision})).status,409);
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id),before);assert.equal(f.calls(),0);
});

const live={NOTION_SYNC_MODE:'live',NOTION_API_TOKEN:'offline-placeholder-only',NOTION_SYNC_START_UNIX:'0',NOTION_MAIL_DESK_FOLDER_READY:'true'};
async function notionSetup(t) {
 const f=await setup(t,{env:live});const {id}=await inbound(f);const page=crypto.randomUUID();
 f.DB.sqlite.prepare("INSERT INTO notion_links VALUES (?,?,'linked',0)").run(id,page);
 return {...f,id,page};
}
function notionServer(f,{patch=()=>Response.json({object:'page',id:f.page}),matches=[{object:'page',id:f.page}]}={}) {
 const calls=[];return {calls,fetcher:async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,method:init.method,body});return init.method==='PATCH'?patch(body):Response.json({results:matches,has_more:false});}};
}

test('dedicated Notion folder queue is idempotent, separate from Status/Notes and create',async t=>{
 const f=await notionSetup(t),s=notionServer(f);await moved(f,f.id,'archive');
 assert.equal((await syncFolders(f.env,s.fetcher)).processed,1);assert.equal((await syncFolders(f.env,s.fetcher)).processed,0);
 const patches=s.calls.filter(c=>c.method==='PATCH');assert.equal(patches.length,1);assert.deepEqual(patches[0].body,{properties:{'Mail Desk Folder':{select:{name:'Archive'}}}});
 assert.equal(patches[0].url,`https://api.notion.com/v1/pages/${f.page}`);assert.equal(s.calls.filter(c=>c.url.endsWith('/pages')).length,0);
});

for (const mode of ['http','lost','bad-id','oversize']) test('Notion PATCH retries safe assignment after '+mode,async t=>{
 const f=await notionSetup(t);let fail=true;
 const s=notionServer(f,{patch:()=>{if(!fail)return Response.json({object:'page',id:f.page});if(mode==='lost')throw Error('private token');if(mode==='http')return new Response('private',{status:503});if(mode==='oversize')return new Response('x'.repeat(262145));return Response.json({object:'page',id:crypto.randomUUID()});}});
 assert.equal((await syncFolders(f.env,s.fetcher)).unresolved,1);assert.equal(f.DB.sqlite.prepare('SELECT synced_version FROM case_folder_sync').get().synced_version,-1);
 assert.equal((await syncFolders(f.env,s.fetcher)).processed,0);fail=false;f.DB.sqlite.exec('UPDATE case_folder_sync SET next_attempt=0');
 assert.equal((await syncFolders(f.env,s.fetcher)).processed,1);assert.equal(s.calls.filter(c=>c.url.endsWith('/pages')).length,0);
});

for (const matches of [[],[{object:'page',id:crypto.randomUUID()}],[{object:'page',id:crypto.randomUUID()},{object:'page',id:crypto.randomUUID()}]]) test('Notion link uncertainty never PATCHes or creates '+matches.length,async t=>{
 const f=await notionSetup(t),s=notionServer(f,{matches});assert.equal((await syncFolders(f.env,s.fetcher)).unresolved,1);assert.equal(s.calls.length,1);assert.equal(s.calls[0].method,'POST');
});

test('Notion stale in-flight version stays queued; concurrent cron has a single lease',async t=>{
 const f=await notionSetup(t);let release,entered;const ready=new Promise(r=>entered=r);
 const s=notionServer(f,{patch:async()=>{entered();await new Promise(r=>release=r);return Response.json({object:'page',id:f.page});}});
 const first=syncFolders(f.env,s.fetcher);await ready;
 assert.equal((await syncFolders(f.env,s.fetcher)).processed,0);await moved(f,f.id,'trash');release();await first;
 assert.equal(f.DB.sqlite.prepare('SELECT synced_version FROM case_folder_sync').get().synced_version,-1);
 const next=notionServer(f);await syncFolders(f.env,next.fetcher);assert.equal(next.calls[1].body.properties['Mail Desk Folder'].select.name,'Trash');
});

test('Notion provisioning gate and UNKNOWN link suppress folder writes; cron drains folder-only work',async t=>{
 const f=await notionSetup(t),s=notionServer(f);assert.equal((await syncFolders({...f.env,NOTION_MAIL_DESK_FOLDER_READY:undefined},s.fetcher)).status,'off');assert.equal(s.calls.length,0);
 f.DB.sqlite.exec("UPDATE notion_links SET state='UNKNOWN'");assert.equal((await syncFolders(f.env,s.fetcher)).processed,0);
 f.DB.sqlite.exec("UPDATE notion_links SET state='linked'");
 // Remove activity-only work through durable links; folder queue must still run.
 const m=f.DB.sqlite.prepare('SELECT id FROM messages').get().id;f.DB.sqlite.prepare("INSERT INTO notion_activity_links VALUES (?,?,?,'linked',0)").run(m,f.id,crypto.randomUUID());
 const result=await runNotionSync(f.env,s.fetcher);assert.equal(result.folderSync.processed,1);
});

test('LiveNotion permits only validated exact page PATCH with the dedicated property',async()=>{
 let calls=0;const api=new LiveNotion({...live,DEPLOYMENT_STAGE:'staging'},async()=>{calls++;throw Error('unexpected');});
 for (const path of ['pages','pages/../users','pages/'+crypto.randomUUID()+'/properties','pages/'+crypto.randomUUID()+'?x=1','users']) await assert.rejects(api.request('support',path,{properties:{'Mail Desk Folder':{select:{name:'Inbox'}}}},'PATCH'),/invalid_patch/);
 for (const body of [{properties:{Status:{select:{name:'Inbox'}}}},{properties:{'Mail Desk Folder':{select:{name:'Evil'}}}},{properties:{'Mail Desk Folder':{select:{name:'Inbox'}},Notes:{rich_text:[]}}}]) await assert.rejects(api.request('support','pages/'+crypto.randomUUID(),body,'PATCH'),/invalid_patch/);
 assert.equal(calls,0);
});

test('live signed customer approval cannot survive trash/restore; fresh Archive reply remains manual',async t=>{
 let calls=0;
 const f=await setup(t,{env:{SEND_MODE:'live',ALLOW_REAL_SEND:'true',OWNER_EMAIL:'fridman.greg@gmail.com',MAILDESK_CUSTOMER_TEST_RECIPIENT:'',MAILDESK_CUSTOMER_TEST_EXPIRES_AT:'',MAILDESK_REPLY_ACTIVATION:'owner-reviewed-customers-v2',MAILDESK_CUSTOMER_REPLIES:'enabled',MAILDESK_CUSTOMER_RECIPIENT_POLICY:'exact-forwarded-requester-v2',MAILDESK_RECIPIENT_ALLOWLIST:'["fridman.greg@gmail.com"]',RESEND_API_KEY:'re_OFFLINE_SYNTHETIC_NOT_A_REAL_KEY_0000'},replyTransport:async()=>{calls++;return Response.json({id:'11111111-1111-4111-8111-111111111111'});}});
 const {id}=await inbound(f),r=await f.review(id);assert.equal(r.mode,'live');
 const send=r=>f.request(`/api/cases/${id}/send`,{intentId:r.id,approval:r.approval,confirmed:true});
 const immutable=f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id);
 await moved(f,id,'trash');assert.equal((await send(r)).status,409);await moved(f,id,'restore',1);assert.equal((await send(r)).status,409);assert.equal(calls,0);
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id),immutable);
 await moved(f,id,'archive',2);const fresh=await f.review(id);assert.equal(calls,0);
 assert.equal((await f.request(`/api/cases/${id}/send`,{intentId:fresh.id,approval:fresh.approval})).status,400);assert.equal(calls,0);
 assert.equal((await (await send(fresh)).json()).status,'sent');assert.equal(calls,1);
});

test('immutable 0004 UNKNOWN rejects folder invalidation and genuine reopen until reconciliation',async t=>{
 const f=await setup(t,{legacyLock:true}),{id}=await inbound(f);
 await moved(f,id,'archive');
 const receipt=f.DB.sqlite.prepare('SELECT * FROM email_receipts').get(),message=f.DB.sqlite.prepare('SELECT id FROM messages').get().id;
 f.DB.sqlite.prepare('INSERT INTO outbound_provenance VALUES (?,?,?,?,?,?)').run(receipt.receipt_key,message,'maildesk-ingress-v1','{}','fixture',1);
 const review=crypto.randomUUID(),time=Math.floor(Date.now()/1000);
 f.DB.sqlite.prepare("INSERT INTO live_outbound_reviews VALUES (?,?,?,?,?,'maildesk-live-review-v2',?,?,?,'reserved',NULL,?,?)").run(review,id,receipt.receipt_key,message,0,'{}','fixture',time+600,time,time);
 for (const status of ['approved','dispatching','UNKNOWN']) f.DB.sqlite.prepare('UPDATE live_outbound_reviews SET status=? WHERE id=?').run(status,review);
 const before=f.DB.sqlite.prepare('SELECT * FROM live_outbound_reviews').get();
 const folderBefore=f.DB.sqlite.prepare('SELECT * FROM case_folders WHERE case_id=?').get(id);
 const caseBefore=f.DB.sqlite.prepare('SELECT * FROM cases WHERE id=?').get(id);
 const auditBefore=f.DB.sqlite.prepare('SELECT * FROM audit_events').all();
 const result=await (await move(f,id,'trash',1)).json();assert.equal(result.results[0].ok,false);
 assert.equal(result.results[0].error,'folder_outcome_unconfirmed');
 await inbound(f,'new','parent',true);
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM case_folders WHERE case_id=?').get(id),folderBefore);
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM cases WHERE id=?').get(id),caseBefore);
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM audit_events').all(),auditBefore);
 assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM live_outbound_reviews').get(),before);
 assert.throws(()=>f.DB.sqlite.prepare("UPDATE cases SET draft='unsafe',revision=revision+1 WHERE id=?").run(id),/reconciliation/);
 assert.throws(()=>f.DB.sqlite.prepare('UPDATE cases SET revision=revision+1 WHERE id=?').run(id),/reconciliation/);
});

test('dispatch claims and manual folder transitions serialize without invalidating an active send',async t=>{
 const f=await setup(t),id=await f.seed(),r=await f.review(id),i=f.DB.sqlite.prepare('SELECT * FROM outbound_intents WHERE id=?').get(r.id);
 assert.ok(await claimSend(f.DB,i));const v=await (await move(f,id,'trash')).json();assert.equal(v.results[0].ok,false);assert.equal((await detail(f,id)).folder,'inbox');
});

test('server counts cover more than the 100 displayed cases',async t=>{
 const f=await setup(t);for(let i=0;i<103;i++)await f.seed({key:'many'+i});
 const result=await (await f.request('/api/cases?folder=inbox')).json();assert.equal(result.cases.length,100);assert.equal(result.counts.inbox,103);
});

test('cron read reconciliation repairs delayed stale remote writes without repeating matching PATCH',async t=>{
 const f=await notionSetup(t);let remote='Inbox',patches=0,reads=0;
 const fetcher=async(url,init)=>{
  if(init.method==='PATCH'){patches++;remote=JSON.parse(init.body).properties['Mail Desk Folder'].select.name;return Response.json({object:'page',id:f.page});}
  reads++;return Response.json({results:[{object:'page',id:f.page,properties:{'Mail Desk Folder':{select:{name:remote}}}}],has_more:false});
 };
 await moved(f,f.id,'archive');await syncFolders(f.env,fetcher);assert.equal(remote,'Archive');assert.equal(patches,1);
 f.DB.sqlite.exec('UPDATE case_folder_sync SET next_attempt=0');await syncFolders(f.env,fetcher);assert.equal(patches,1);assert.equal(reads,2);
 // Model an old external request finishing after a newer acknowledged assignment.
 remote='Inbox';f.DB.sqlite.exec('UPDATE case_folder_sync SET next_attempt=0');await syncFolders(f.env,fetcher);assert.equal(remote,'Archive');assert.equal(patches,2);
});

test('PATCH retains deadline, abort and credential shielding',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let started,signal;
 const entered=new Promise(r=>started=r);
 const api=new LiveNotion({...live,DEPLOYMENT_STAGE:'staging'},async(url,init)=>{signal=init.signal;started();return new Promise(()=>{});});
 const pending=api.updateFolder({channel:'support'},crypto.randomUUID(),'inbox');
 await entered;t.mock.timers.tick(9000);await assert.rejects(pending,/notion_deadline/);assert.equal(signal.aborted,true);
 const denied=new LiveNotion({...live,DEPLOYMENT_STAGE:'staging',NOTION_API_TOKEN:'private\ncredential'},async()=>assert.fail('credential reached transport'));
 await assert.rejects(denied.updateFolder({channel:'support'},crypto.randomUUID(),'inbox'),error=>error.message==='notion_credential_format');
});

test('concurrent new receipt and manual move always leave the genuine thread in Inbox',async t=>{
 const f=await setup(t),{id}=await inbound(f);await moved(f,id,'archive');
 const [r]=await Promise.all([move(f,id,'trash',1),inbound(f,'concurrent','parent')]);
 assert.equal(r.status,200);assert.equal((await detail(f,id)).folder,'inbox');assert.equal((await detail(f,id)).messages.length,2);
});
