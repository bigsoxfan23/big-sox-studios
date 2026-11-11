import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createWorker} from '../src/worker.mjs';
import {b64} from '../src/security.mjs';
import {database,seed} from '../../tests/membership-fixtures.mjs';
const origin='https://bss-owner-launchpad-staging.fridman-greg.workers.dev';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'setup',use:'sig',alg:'RS256'};
const encode=value=>b64(new TextEncoder().encode(JSON.stringify(value)));
function memberDb(sqlite){const stmt=(sql,args=[])=>({bind(...a){return stmt(sql,a);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return{results:sqlite.prepare(sql).all(...args)};},async run(){return {success:true,meta:{changes:sqlite.prepare(sql).run(...args).changes}};}});return {prepare:sql=>stmt(sql),async batch(statements){sqlite.exec('BEGIN');try{for(const s of statements)await s.run();sqlite.exec('COMMIT');return [];}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}
async function fixture(){
 const storage=database(),portal=new DatabaseSync(':memory:');
 portal.exec(readFileSync(new URL('../../portal/schema.sql',import.meta.url),'utf8'));
 portal.exec(readFileSync(new URL('../../portal/migrations/0004-request-onboarding.sql',import.meta.url),'utf8'));
 portal.exec(readFileSync(new URL('../../portal/migrations/0007-owner-admission-withdrawal-holds.sql',import.meta.url),'utf8'));
 portal.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").run(Math.floor(Date.now()/1000));
 const env={ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUDIENCE:'preview-aud',OWNER_EMAIL:'owner@example.test',APP_ORIGIN:origin,MAIL_DESK_URL:'https://mail.example.test/',MEMBERSHIP_DB:storage,MEMBERSHIP_CSRF_KEY:'synthetic-csrf-key-12345678901234567890',PORTAL_DB:memberDb(portal),PORTAL_ONBOARDING:'staging-12',ONBOARDING_SOURCE_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71',ONBOARDING_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af',JELLYFIN_ORIGIN:'https://jellyfin.example.test'};
 const worker=createWorker({fetcher:async()=>Response.json({keys:[jwk]})});
 async function token(email=env.OWNER_EMAIL,expiresOffset=600){const at=Math.floor(Date.now()/1000),data=encode({alg:'RS256',kid:'setup'})+'.'+encode({iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUDIENCE],email,iat:at-1,nbf:at-1,exp:at+expiresOffset});return data+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(data)));}
 const jwt=await token();const request=(path,options={})=>worker.fetch(new Request(origin+path,{...options,headers:{'Cf-Access-Jwt-Assertion':jwt,...options.headers}}),env);
 const form=async path=>{const r=await request(path),html=await r.text();return {r,html,csrf:html.match(/name="csrf" value="([^"]+)"/)?.[1],cookie:r.headers.get('Set-Cookie')?.split(';')[0]};};
 const post=(path,form,fields,headers={})=>request(path,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded',Cookie:form.cookie,...headers},body:new URLSearchParams({csrf:form.csrf,...fields})});
 return {storage,portal,env,request,form,post,token};
}
test('approval links one pending Member; setup and manual readiness remain separate from activation',async()=>{
 const f=await fixture(),id=seed(f.storage),queue='/membership/requests/';const form=await f.form(queue);
 const approved=await f.post(`${queue}${id}/decision`,form,{revision:'1',status:'approved',note:'Approved synthetic'});assert.equal(approved.status,303);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,1);
 const setup=`${queue}${id}/setup`,page=await f.form(setup);assert.equal(page.r.status,200);assert.match(page.html,/Pending Member linked/);assert.doesNotMatch(page.html,/type="password"/);
 const ready=await f.post(setup,page,{request_revision:'2',revision:'1',action:'jellyfin-ready',confirm:'yes',username:'synthetic',url:'https://jellyfin.example.test/'});assert.equal(ready.status,303);
 const member=f.portal.prepare("SELECT role,status FROM members WHERE id!='owner'").get();assert.deepEqual({...member},{role:'member',status:'pending'});
 for(const table of ['identities','service_grants','invitations'])assert.equal(f.portal.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 assert.equal((await f.request('/membership/members/')).status,200);
});
test('setup missing confirmation, missing/mismatched CSRF, stale revisions and cross-origin all deny writes',async()=>{
 for(const kind of ['confirm','csrf','cookie','stale','origin','extra']){
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),path=`/membership/requests/${id}/setup`,form=await f.form(path);
 const fields={request_revision:'1',action:'start',confirm:'yes'};const headers={};
 if(kind==='confirm')fields.confirm='no';if(kind==='csrf')fields.csrf='wrong';if(kind==='cookie')headers.Cookie='';if(kind==='stale')fields.request_revision='2';if(kind==='origin')headers.Origin='https://evil.example.test';if(kind==='extra')fields.actor='owner';
 const r=await f.post(path,form,fields,headers);assert.ok([400,403,409].includes(r.status),kind);assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,0);
 }
});
test('unapproved, withdrawn, wrong Owner, disabled feature and wrong database pin cannot access setup',async()=>{
 for(const kind of ['pending','revoked','wrong-owner','disabled','wrong-db']){
 const f=await fixture(),id=seed(f.storage,{status:['pending','revoked'].includes(kind)?kind:'approved'}),path=`/membership/requests/${id}/setup`;
 if(kind==='disabled')f.env.PORTAL_ONBOARDING='off';if(kind==='wrong-db')f.env.ONBOARDING_MEMBER_DB_ID='other';
 const r=kind==='wrong-owner'?await f.request(path,{headers:{'Cf-Access-Jwt-Assertion':await f.token('member@example.test')}}):await f.request(path);
 assert.ok([401,403,404,409,503].includes(r.status),kind);assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,0);
 }
});

test('saving a note on an existing approval does not create a pending Member',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),form=await f.form('/membership/requests/?view=invite-ready');
 const saved=await f.post(`/membership/requests/${id}/decision`,form,{revision:'1',status:'approved',note:'Private note only'});assert.equal(saved.status,303);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,0);
 const page=await f.form(`/membership/requests/${id}/setup`);const linked=await f.post(`/membership/requests/${id}/setup`,page,{request_revision:'2',action:'start',confirm:'yes'});assert.equal(linked.status,303);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,1);
});
test('bridge failure reports saved approval and safe setup retry instead of implying approval failed',async()=>{
 const f=await fixture(),id=seed(f.storage),form=await f.form('/membership/requests/');delete f.env.PORTAL_DB;
 const r=await f.post(`/membership/requests/${id}/decision`,form,{revision:'1',status:'approved',note:''});assert.equal(r.status,503);
 const body=await r.text();assert.match(body,/Your approval was saved/);assert.match(body,/Continue member setup/);
 assert.equal(f.storage.rows()[0].status,'approved');assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,0);
});

test('authenticated Owner withdrawal installs durable hold BEFORE revoking the approved request',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),setup=`/membership/requests/${id}/setup`;
 const page=await f.form(setup);assert.equal(page.r.status,200);
 assert.equal((await f.post(setup,page,{request_revision:'1',action:'start',confirm:'yes'})).status,303);
 const form=await f.form('/membership/requests/?view=invite-ready');
 const result=await f.post(`/membership/requests/${id}/decision`,form,{revision:'1',status:'revoked',note:'Synthetic withdrawal'});
 assert.equal(result.status,303);
 assert.equal(f.storage.rows()[0].status,'revoked');
 assert.equal(f.storage.rows()[0].revision,2);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
 assert.equal(f.portal.prepare("SELECT status FROM members WHERE role='member'").get().status,'pending');
 assert.equal(f.portal.prepare('SELECT count(*) n FROM identities').get().n,0);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM service_grants').get().n,0);
});
test('Owner withdrawal seals admission even if approved request has no Member linkage yet',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),form=await f.form('/membership/requests/?view=invite-ready');
 const result=await f.post(`/membership/requests/${id}/decision`,form,{revision:'1',status:'revoked',note:''});
 assert.equal(result.status,303);
 assert.equal(f.storage.rows()[0].status,'revoked');
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold' AND member_id='owner'").get().n,1);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_onboarding').get().n,0);
});
test('missing hold table fails closed: Owner cannot silently withdraw approval without the admission barrier',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),form=await f.form('/membership/requests/?view=invite-ready');
 f.portal.exec('DROP TABLE member_approval_holds');
 const result=await f.post(`/membership/requests/${id}/decision`,form,{revision:'1',status:'revoked',note:''});
 assert.equal(result.status,503);
 assert.equal(f.storage.rows()[0].status,'approved');
 assert.equal(f.storage.rows()[0].revision,1);
});
test('forged or stale Owner withdrawal never creates an admission hold',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),form=await f.form('/membership/requests/?view=invite-ready');
 const bad=await f.post(`/membership/requests/${id}/decision`,form,{revision:'1',status:'revoked',note:'',csrf:'fake'});
 assert.equal(bad.status,403);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,0);
 const stale=await f.post(`/membership/requests/${id}/decision`,form,{revision:'2',status:'revoked',note:''});
 assert.equal(stale.status,409);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,0);
 assert.equal(f.storage.rows()[0].status,'approved');
});

test('staging withdrawal fails closed on absent, disabled or mismatched onboarding configuration',async()=>{
 for(const kind of ['flag-missing','flag-off','source-mismatch','member-mismatch','member-db-missing']){
  const f=await fixture(),requestId=seed(f.storage,{status:'approved'});
  const page=await f.form('/membership/requests/?view=invite-ready');
  if(kind==='flag-missing')delete f.env.PORTAL_ONBOARDING;
  if(kind==='flag-off')f.env.PORTAL_ONBOARDING='disabled';
  if(kind==='source-mismatch')f.env.ONBOARDING_SOURCE_ID='other';
  if(kind==='member-mismatch')f.env.ONBOARDING_MEMBER_DB_ID='other';
  if(kind==='member-db-missing')delete f.env.PORTAL_DB;
  const r=await f.post(`/membership/requests/${requestId}/decision`,page,{revision:'1',status:'revoked',note:'not saved'});
  assert.equal(r.status,503,kind);
  assert.equal(f.storage.rows()[0].status,'approved',kind);
  assert.equal(f.storage.rows()[0].revision,1,kind);
  assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,0,kind);
  assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,0,kind);
 }
});
test('failed Requests D1 write retains immutable hold and exposes private recovery on reload',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),path=`/membership/requests/${id}/decision`;
 const page=await f.form('/membership/requests/?view=invite-ready');
 f.storage.sqlite.exec("CREATE TRIGGER synthetic_request_failure BEFORE UPDATE ON membership_requests WHEN NEW.status='revoked' BEGIN SELECT RAISE(ABORT,'simulated Requests D1 outage'); END;");
 const r=await f.post(path,page,{revision:'1',status:'revoked',note:'attempted withdrawal'});
 assert.equal(r.status,503);assert.match(await r.text(),/Member admission remains held/);
 assert.equal(f.storage.rows()[0].status,'approved');assert.equal(f.storage.rows()[0].revision,1);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
 const refreshed=await f.form('/membership/requests/?view=invite-ready');
 assert.equal(refreshed.r.status,200);assert.match(refreshed.html,/Admission held after an interrupted withdrawal/);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM identities').get().n,0);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM service_grants').get().n,0);
 f.storage.sqlite.exec('DROP TRIGGER synthetic_request_failure');
 const result=await f.post(path,refreshed,{revision:'1',status:'revoked',note:'retry after outage'});
 assert.equal(result.status,303);
 assert.equal(f.storage.rows()[0].status,'revoked');assert.equal(f.storage.rows()[0].revision,2);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM service_grants').get().n,0);
});
test('concurrent Requests revision change leaves hold, fresh reviewed revision retries without clearing hold',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),path=`/membership/requests/${id}/decision`,first=await f.form('/membership/requests/?view=invite-ready');
 f.storage.sqlite.exec("CREATE TRIGGER synthetic_revision_race BEFORE UPDATE ON membership_requests WHEN NEW.status='revoked' BEGIN SELECT RAISE(IGNORE); END;");
 const race=await f.post(path,first,{revision:'1',status:'revoked',note:'raced'});
 assert.equal(race.status,409);assert.match(await race.text(),/Member admission remains held/);
 assert.equal(f.storage.rows()[0].status,'approved');
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 f.storage.sqlite.exec('DROP TRIGGER synthetic_revision_race');
 const page=await f.form('/membership/requests/?view=invite-ready');
 // A private note is a legitimate concurrent revision, not permission to erase the original hold.
 assert.equal((await f.post(path,page,{revision:'1',status:'approved',note:'Revised synthetic note'})).status,303);
 assert.equal(f.storage.rows()[0].revision,2);
 const stale=await f.post(path,first,{revision:'1',status:'revoked',note:'stale'});
 assert.equal(stale.status,409);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 const refreshed=await f.form('/membership/requests/?view=invite-ready');
 assert.match(refreshed.html,/Admission held after an interrupted withdrawal/);
 const valid=await f.post(path,refreshed,{revision:'2',status:'revoked',note:'Owner reviewed and confirmed'});
 assert.equal(valid.status,303);
 assert.equal(f.storage.rows()[0].status,'revoked');
 assert.equal(f.storage.rows()[0].revision,3);
 assert.deepEqual({...f.portal.prepare('SELECT request_revision,actor_id FROM member_approval_holds').get()},{request_revision:1,actor_id:'owner'});
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM identities').get().n,0);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM service_grants').get().n,0);
});
test('stale or forged Owner session cannot reconcile a committed hold',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),path=`/membership/requests/${id}/decision`,page=await f.form('/membership/requests/?view=invite-ready');
 f.storage.sqlite.exec("CREATE TRIGGER synthetic_request_failure BEFORE UPDATE ON membership_requests WHEN NEW.status='revoked' BEGIN SELECT RAISE(ABORT,'offline'); END;");
 assert.equal((await f.post(path,page,{revision:'1',status:'revoked',note:''})).status,503);
 f.storage.sqlite.exec('DROP TRIGGER synthetic_request_failure');
 const expired=await f.post(path,page,{revision:'1',status:'revoked',note:'expired'},{'Cf-Access-Jwt-Assertion':await f.token(f.env.OWNER_EMAIL,-5)});
 assert.equal(expired.status,401);
 const rejected=await f.post(path,page,{revision:'1',status:'revoked',note:'forged'},{'Cf-Access-Jwt-Assertion':'forged'});
 assert.equal(rejected.status,401);
 const forgedCsrf=await f.post(path,page,{revision:'1',status:'revoked',note:'forged',csrf:'bad'});
 assert.equal(forgedCsrf.status,403);
 assert.equal(f.storage.rows()[0].status,'approved');
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
});

test('Owner approved queue checks at most the visible 20 holds during pagination',async()=>{
 const f=await fixture();
 for(let i=0;i<22;i++)seed(f.storage,{status:'approved'});
 const page=await f.form('/membership/requests/?view=invite-ready');
 assert.equal(page.r.status,200);
 assert.equal((page.html.match(/<article>/g)||[]).length,20);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,0);
});

test('failed hold audit rolls back the Members-D1 hold and leaves Requests approved',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),form=await f.form('/membership/requests/?view=invite-ready');
 f.portal.exec("CREATE TRIGGER synthetic_hold_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='owner-approval-withdrawal-hold' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
 const r=await f.post(`/membership/requests/${id}/decision`,form,{revision:'1',status:'revoked',note:''});
 assert.equal(r.status,503);
 assert.equal(f.storage.rows()[0].status,'approved');
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,0);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,0);
});
test('actual competing note revision between Member hold and Request CAS is never overwritten',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),path=`/membership/requests/${id}/decision`,form=await f.form('/membership/requests/?view=invite-ready');
 const original=f.env.MEMBERSHIP_DB.prepare.bind(f.env.MEMBERSHIP_DB);
 let injected=0;
 f.env.MEMBERSHIP_DB.prepare=sql=>{
  const stmt=original(sql);
  if(!sql.startsWith('UPDATE membership_requests SET status='))return stmt;
  return {bind(...args){
   const bound=stmt.bind(...args);
   return {async first(){
    if(!injected++){f.storage.sqlite.prepare("UPDATE membership_requests SET owner_note='Concurrent synthetic note',revision=revision+1 WHERE id=?").run(id);}
    return bound.first();
   }};
  }};
 };
 const conflict=await f.post(path,form,{revision:'1',status:'revoked',note:'should not overwrite'});
 assert.equal(conflict.status,409);
 assert.equal(f.storage.rows()[0].status,'approved');
 assert.equal(f.storage.rows()[0].revision,2);
 assert.equal(f.storage.rows()[0].owner_note,'Concurrent synthetic note');
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 f.env.MEMBERSHIP_DB.prepare=original;
 const fresh=await f.form('/membership/requests/?view=invite-ready');
 assert.match(fresh.html,/Admission held after an interrupted withdrawal/);
 const retry=await f.post(path,fresh,{revision:'2',status:'revoked',note:'Owner-confirmed withdrawal'});
 assert.equal(retry.status,303);
 assert.equal(f.storage.rows()[0].status,'revoked');
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
 assert.equal(f.storage.rows()[0].owner_note,'Owner-confirmed withdrawal');
});
test('concurrent repeat withdrawals converge on one hold and one Requests status transition',async()=>{
 const f=await fixture(),id=seed(f.storage,{status:'approved'}),form=await f.form('/membership/requests/?view=invite-ready'),path=`/membership/requests/${id}/decision`;
 const results=await Promise.all([f.post(path,form,{revision:'1',status:'revoked',note:'one'}),f.post(path,form,{revision:'1',status:'revoked',note:'two'})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[303,409]);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
 assert.equal(f.portal.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
 assert.equal(f.storage.rows()[0].status,'revoked');
 assert.equal(f.storage.audit().filter(r=>r.to_status==='revoked').length,1);
 assert.equal((await f.post(path,form,{revision:'1',status:'revoked',note:'old replay'})).status,409);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM member_approval_holds').get().n,1);
});
