import test from 'node:test';
import assert from 'node:assert/strict';
import {createWelcomeReview} from '../../portal/welcome-review.mjs';
import {createRequestOnboarding} from '../../portal/request-onboarding.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
const form={message:'Hi friend!\nGlad you are joining us.',password:'synthetic-password-only'};
function fixture(change={}) {
 let at=1000;
 const row={source_database:'synthetic-source',member_id:'synthetic-member',revision:2,jellyfin_ready_at:900,jellyfin_username:'friend',jellyfin_url:'https://jellyfin.example.test/',recipient:'friend@example.test',role:'member',status:'pending'};
 const options={onboarding:{async read(id,revision){if(id!=='request'||revision!==3)throw Error('stale request');return {...row};}},actorId:'owner',sessionBinding:'s'.repeat(64),signingKey:'k'.repeat(64),expiresAt:2000,jellyfinOrigin:'https://jellyfin.example.test',memberLoginUrl:'https://members.example.test/app',now:()=>at,...change};
 return {row,options,api:createWelcomeReview(options),clock:t=>{at=t;}};
}
test('welcome preview and explicit confirmation preserve exact transient plain-text message and credentials',async()=>{
 const f=fixture(),p=await f.api.preview('request',3,form);
 assert.equal(p.recipient,'friend@example.test');assert.ok(p.text.startsWith(form.message));assert.ok(p.text.includes('Temporary password: '+form.password));
 assert.ok(p.text.includes('separate account'));assert.ok(p.text.includes('https://members.example.test/app'));
 assert.ok(p.text.includes('one-time code sent to your approved email'));assert.ok(!p.text.includes('Google'));
 const c=await f.api.confirm('request',3,form,{review:p.review,confirmed:true});assert.equal(c.text,p.text);assert.equal(c.memberId,f.row.member_id);
 assert.ok(!p.review.includes(form.password));assert.ok(!p.review.includes(form.message));assert.ok(!p.review.includes(p.recipient));
});
test('confirmation requires explicit confirmation and rejects every changed form field',async()=>{
 const f=fixture(),p=await f.api.preview('request',3,form);
 for(const input of [undefined,{review:p.review,confirmed:false},{review:p.review,confirmed:'yes'},{review:p.review+'0',confirmed:true}])await assert.rejects(f.api.confirm('request',3,form,input));
 for(const change of [{password:'another-password'},{message:'different message'},{recipient:'attacker@example.test'}])await assert.rejects(f.api.confirm('request',3,{...form,...change},{review:p.review,confirmed:true}));
});
test('review binds Owner session, actor, signing key, login URL and trusted service origin',async()=>{
 const f=fixture(),p=await f.api.preview('request',3,form);
 for(const change of [{actorId:'other'},{sessionBinding:'t'.repeat(64)},{signingKey:'z'.repeat(64)},{memberLoginUrl:'https://other.example.test/app'},{jellyfinOrigin:'https://other.example.test'}]){
  const other=createWelcomeReview({...f.options,...change});await assert.rejects(other.confirm('request',3,form,{review:p.review,confirmed:true}));
 }
});
test('fresh readiness, Member eligibility, recipient and onboarding revision required after preview',async()=>{
 for(const change of [{status:'active'},{status:'revoked'},{role:'owner'},{jellyfin_ready_at:null},{jellyfin_username:'other'},{jellyfin_url:'https://jellyfin.example.test/other'},{recipient:'other@example.test'},{revision:3},{member_id:'other'}]){
  const f=fixture(),p=await f.api.preview('request',3,form);Object.assign(f.row,change);await assert.rejects(f.api.confirm('request',3,form,{review:p.review,confirmed:true}));
 }
 const f=fixture(),p=await f.api.preview('request',3,form);await assert.rejects(f.api.confirm('request',4,form,{review:p.review,confirmed:true}));
});
test('review expires at five minutes or earlier Owner session deadline; clock reversal denied',async()=>{
 for(const options of [{},{expiresAt:1100}]){
  const f=fixture(options),p=await f.api.preview('request',3,form);assert.equal(p.expiresAt,Math.min(1300,f.options.expiresAt));f.clock(p.expiresAt);
  await assert.rejects(f.api.confirm('request',3,form,{review:p.review,confirmed:true}));
 }
 const f=fixture(),p=await f.api.preview('request',3,form);f.clock(999);await assert.rejects(f.api.confirm('request',3,form,{review:p.review,confirmed:true}));
});
test('review rejects noncanonical timestamps so alternate encodings cannot bypass durable one-use fingerprints',async()=>{
 const f=fixture(),p=await f.api.preview('request',3,form),parts=p.review.split('.');
 for(const index of [0,1]){const altered=[...parts];altered[index]='0'+altered[index];await assert.rejects(f.api.confirm('request',3,form,{review:altered.join('.'),confirmed:true}));}
});
test('rejects malformed fields and header/body credential injection without leaking values in errors',async()=>{
 const f=fixture();
 for(const change of [{password:'x\ny'},{password:' secret '},{password:'\u202eunsafe'},{password:''},{password:'p'.repeat(129)},{message:'\0secret'},{message:''},{message:'m'.repeat(4001)},{extra:'unapproved'}]){
  await assert.rejects(f.api.preview('request',3,{...form,...change}),e=>e.message==='Welcome preview unavailable. Reload member setup.');
 }
});
test('trusted URL configuration rejects HTTP, credentials, query secrets, fragments and uncanonical URLs',async()=>{
 for(const key of ['jellyfinOrigin','memberLoginUrl'])for(const value of ['http://example.test/','https://user:secret@example.test/','https://example.test/?secret=value','https://example.test/#secret'])assert.throws(()=>fixture({[key]:value}));
 for(const change of [{jellyfin_url:'https://evil.example.test/'},{jellyfin_url:'https://jellyfin.example.test/?password=secret'},{jellyfin_username:'friend\nInjected'},{recipient:'friend@example.test\r\nBcc: attacker@example.test'}]){const f=fixture();Object.assign(f.row,change);await assert.rejects(f.api.preview('request',3,form));}
});
test('multiple previews have different nonces; helper intentionally has no dispatch or persistence authority',async()=>{
 const f=fixture(),a=await f.api.preview('request',3,form),b=await f.api.preview('request',3,form);assert.notEqual(a.review,b.review);
 assert.deepEqual(Object.keys(f.api).sort(),['confirm','preview']);assert.equal(f.row.status,'pending');assert.equal(f.row.revision,2);
});
test('actual onboarding SQL is re-read and preview/confirmation leave every database row unchanged',async()=>{
 const requests=new DatabaseSync(':memory:'),members=new DatabaseSync(':memory:'),at=Math.floor(Date.now()/1000);
 requests.exec(readFileSync(new URL('../../membership/migrations/0001_membership.sql',import.meta.url),'utf8'));
 members.exec(readFileSync(new URL('../../portal/schema.sql',import.meta.url),'utf8'));
 members.exec(readFileSync(new URL('../../portal/migrations/0004-request-onboarding.sql',import.meta.url),'utf8'));
 members.exec(readFileSync(new URL('../../portal/migrations/0007-owner-admission-withdrawal-holds.sql',import.meta.url),'utf8'));
 members.prepare("INSERT INTO members VALUES('owner','greg@example.test','owner','active',?)").run(at);
 requests.prepare("INSERT INTO membership_requests(id,email_hash,email,status,created_at,updated_at) VALUES('request','hash','friend@example.test','approved',?,?)").run(at*1000,at*1000);
 const adapter=sqlite=>{const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){return sqlite.prepare(sql).run(...args);}});return {prepare:sql=>wrap(sql),async batch(statements){sqlite.exec('BEGIN');try{for(const s of statements)await s.run();sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}}};};
 const onboarding=createRequestOnboarding({requestDb:adapter(requests),memberDb:adapter(members),sourceDatabase:'synthetic-source',actorId:'owner',expiresAt:at+600,jellyfinOrigin:'https://jellyfin.example.test'});
 await onboarding.link('request',1);await onboarding.markJellyfinReady('request',1,{expectedRevision:1,confirmed:true,username:'friend',url:'https://jellyfin.example.test/'});
 const api=createWelcomeReview({...fixture().options,onboarding,expiresAt:at+600,now:()=>at});
 const rows=database=>database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,database.prepare(`SELECT * FROM "${name}"`).all()]);
 const before=JSON.stringify([rows(requests),rows(members)]),p=await api.preview('request',1,form);
 await api.confirm('request',1,form,{review:p.review,confirmed:true});assert.equal(JSON.stringify([rows(requests),rows(members)]),before);
 requests.exec("UPDATE membership_requests SET status='revoked',revision=2");await assert.rejects(api.confirm('request',1,form,{review:p.review,confirmed:true}));
 assert.equal(members.prepare("SELECT count(*) n FROM members WHERE status='active'").get().n,1);
 for(const table of ['identities','invitations','service_grants'])assert.equal(members.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 requests.close();members.close();
});
