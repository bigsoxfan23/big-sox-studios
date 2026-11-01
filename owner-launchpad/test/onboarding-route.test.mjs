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
 portal.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?)").run(Math.floor(Date.now()/1000));
 const env={ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUDIENCE:'preview-aud',OWNER_EMAIL:'owner@example.test',APP_ORIGIN:origin,MAIL_DESK_URL:'https://mail.example.test/',MEMBERSHIP_DB:storage,MEMBERSHIP_CSRF_KEY:'synthetic-csrf-key-12345678901234567890',PORTAL_DB:memberDb(portal),PORTAL_ONBOARDING:'staging-12',ONBOARDING_SOURCE_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71',ONBOARDING_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af',JELLYFIN_ORIGIN:'https://jellyfin.example.test'};
 const worker=createWorker({fetcher:async()=>Response.json({keys:[jwk]})});
 async function token(email=env.OWNER_EMAIL){const at=Math.floor(Date.now()/1000),data=encode({alg:'RS256',kid:'setup'})+'.'+encode({iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUDIENCE],email,iat:at-1,nbf:at-1,exp:at+600});return data+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(data)));}
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
