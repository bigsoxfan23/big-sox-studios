import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {fixture} from './fixture.mjs';
import {PINS} from '../config.mjs';
async function schema(db,kind){
 const sql=[`${kind}.sql`,`migration-0002-${kind}.sql`].map(file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8')).join('\n').replace(/^--.*$/gm,'').trim();
 // Preserve complete trigger bodies; only split before top-level statements.
 const statements=sql.split(/;(?=\s*(?:CREATE|INSERT|PRAGMA|$))/).map(s=>s.trim()).filter(Boolean);
 await db.batch(statements.map(sql=>db.prepare(sql)));
}
test('local workerd/D1 full synthetic flow, concurrent one-shot dispatch, SQL triggers, same JWT revocation',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'task12-private-acceptance-offline',modules:true,
  script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-24',
  d1Databases:{REQUESTS:'task12-LOCAL-requests-only',MEMBERS:'task12-LOCAL-members-only'}}));
 t.after(()=>mf.dispose());
 const requests=await mf.getD1Database('REQUESTS'),members=await mf.getD1Database('MEMBERS');
 await schema(requests,'requests');await schema(members,'members');
 const f=fixture(t,{entries:true});f.env.ACCEPTANCE_REQUESTS=requests;f.env.ACCEPTANCE_MEMBERS=members;
 const form=await f.form('member','/acceptance/request');assert.equal(form.res.status,200);assert.equal(typeof form.csrf,'string');
 const submissions=await Promise.all([1,2].map(()=>f.post('member','/acceptance/request',form)));
 assert.deepEqual(submissions.map(r=>r.status).sort(),[201,409]);
 const {id}=await requests.prepare('SELECT id FROM acceptance_requests').first();
 const ownerForm=await f.form('owner','/acceptance/requests/');
 const concurrent=await Promise.all([1,2].map(()=>f.post('owner',`/acceptance/requests/${id}/dispatch`,ownerForm,{confirm:PINS.owner})));
 assert.deepEqual(concurrent.map(r=>r.status).sort(),[410,410]);assert.equal(f.calls.length,2);
 assert.equal((await f.approve(id)).status,200);assert.equal((await f.welcome(id)).status,200);
 assert.equal((await f.get('member','/acceptance/app')).status,200);
 assert.equal((await f.get('member','/acceptance/app')).status,200);
 assert.equal((await members.prepare('SELECT count(*) AS n FROM service_grants').first()).n,0);
 await assert.rejects(members.prepare("INSERT INTO service_grants VALUES('x','x','jellyfin')").run(),/NEVER/);
 const {id:memberId}=await members.prepare('SELECT id FROM acceptance_members').first();
 const revoke=await f.form('owner','/acceptance/members/');
 assert.equal((await f.post('owner',`/acceptance/members/${memberId}/remove`,revoke,{revision:'2'})).status,200);
 assert.equal((await f.get('member','/acceptance/app')).status,403);
 const ledger=(await requests.prepare('SELECT * FROM acceptance_effects').all()).results;
 assert.equal(ledger.length,3);assert.ok(ledger.every(e=>e.state==='accepted' && e.attempt_count===1));
 assert.equal((await members.prepare('SELECT count(*) AS n FROM acceptance_identities').first()).n,1);
 await assert.rejects(requests.prepare('DELETE FROM acceptance_audit').run(),/immutable/);
 await assert.rejects(requests.prepare("UPDATE acceptance_effects SET state='reserved',provider_id=NULL").run(),/immutable/);
 assert.equal(f.calls.length,3);
});

test('offline Miniflare D1 with actual adapters and mocked HTTPS: atomic submit, UNKNOWN and retired Owner dispatch',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'task12-wire-adapters-offline',modules:true,
  script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-24',
  d1Databases:{REQUESTS:'task12-LOCAL-wire-requests-only',MEMBERS:'task12-LOCAL-wire-members-only'}}));
 t.after(()=>mf.dispose());
 const requests=await mf.getD1Database('REQUESTS'),members=await mf.getD1Database('MEMBERS');
 await schema(requests,'requests');await schema(members,'members');
 const wire=[],childId='11111111-1111-4111-8111-111111111111';
 const child={object:'page',id:childId,archived:false,in_trash:false,public_url:null,parent:{type:'page_id',page_id:PINS.parent},properties:{title:{title:[{plain_text:'Task12 Acceptance — TEST Ticket'}]}}};
 const f=fixture(t,{entries:true,realAdapters:true,wireFetcher:async(url,init)=>{
  wire.push({url,init});
  const ledger=(await requests.prepare('SELECT * FROM acceptance_effects').all()).results;
  assert.equal(ledger.length,2);assert.equal((await requests.prepare('SELECT state FROM acceptance_outbox').first()).state,'locked');
  if(url===`https://api.notion.com/v1/pages/${PINS.parent}`)return Response.json({...child,id:PINS.parent});
  if(url==='https://api.notion.com/v1/pages')return Response.json(child);
  if(url===`https://api.notion.com/v1/pages/${childId}`)return Response.json(child);
  assert.equal(url,'https://api.resend.com/emails');assert.equal(ledger.find(e=>e.kind==='notion_ticket').state,'accepted');
  const mail=JSON.parse(init.body);assert.equal(mail.from,PINS.sender);assert.deepEqual(mail.to,[PINS.owner]);assert.equal(mail.subject,'TEST request awaiting review');
  throw Error('synthetic timeout after POST may have been accepted');
 }});
 f.env.ACCEPTANCE_REQUESTS=requests;f.env.ACCEPTANCE_MEMBERS=members;
 const form=await f.form('member','/acceptance/request');
 const submissions=await Promise.all([1,2].map(()=>f.post('member','/acceptance/request',form)));
 assert.deepEqual(submissions.map(r=>r.status),[409,409]);
 const {id}=await requests.prepare('SELECT id FROM acceptance_requests').first();
 assert.deepEqual((await requests.prepare('SELECT state FROM acceptance_effects ORDER BY kind').all()).results.map(e=>e.state),['accepted','unknown']);
 assert.equal(wire.length,4);
 assert.equal((await f.dispatch(id)).status,410);assert.equal((await f.approve(id)).status,409);
 assert.equal((await f.post('member','/acceptance/request',form)).status,409);assert.equal(wire.length,4);
 assert.equal((await members.prepare('SELECT count(*) AS n FROM service_grants').first()).n,0);
 await assert.rejects(requests.prepare("UPDATE acceptance_effects SET state='reserved' WHERE kind='owner_notice'").run(),/immutable/);
});
