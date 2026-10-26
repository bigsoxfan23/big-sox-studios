import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {createFirstOwnerBootstrap} from './first-owner-bootstrap.mjs';
import {createAuthenticator} from './access.mjs';
import {applySchema,epoch,envConfig,certFetch,token,request} from './test-support.mjs';

const target={recipient:'person@example.test',role:'owner',databaseId:'synthetic-only',revision:'reviewed-revision',nonce:'n'.repeat(32)};
const config={...envConfig,BOOTSTRAP_DATABASE_ID:target.databaseId,OTP_CUSTOM_HOSTS:['members.example.test']};
const context=(email=target.recipient,type='onetimepin')=>({access:{aud:config.ACCESS_AUDIENCE,getIdentity:async()=>({email,idp:{type}})}});
const req=(jwt=token())=>new Request(request(jwt),{method:'POST'});
function options(changes={}) {
 return {mode:'offline-test',target,now:()=>epoch*1000,
  verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>epoch*1000}),
  verifyPolicy:async c=>({source:'cloudflare-effective-policy-readback',contextDigest:c.contextDigest,policyDigest:'a'.repeat(64),
   independentMfaRequired:true,enforcementVerified:true,otpIdentityShapeVerified:true,verifiedAt:epoch,expiresAt:epoch+300}),
  verifyOwnerApproval:async c=>({source:'independent-explicit-owner-approval',decision:'approve-first-owner',approvalCount:1,
   contextDigest:c.contextDigest,policyDigest:c.policyDigest,approvalDigest:'b'.repeat(64),auditId:'approval-audit',verifiedAt:epoch,expiresAt:epoch+300}),...changes};
}
async function setup(t) {
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'bootstrap-offline',modules:true,
  script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-24',d1Databases:{DB:'bootstrap-synthetic'},
  outboundService:()=>{throw Error('no network');}}));
 t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB');
 await applySchema(db); await applySchema(db,'./migrations/0001-first-owner-bootstrap.sql');
 return {db,env:{...config,DB:db}};
}
async function snapshot(db) {
 return Promise.all(['members','identities','audit_events','first_owner_bootstrap'].map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results));
}
test('bootstrap defaults to read-only, creates exact OTP Owner atomically, retains audit and never replays',async t=>{
 const {db,env}=await setup(t),app=createFirstOwnerBootstrap(options());
 const before=await snapshot(db);
 const plan=await app(req(),env,context()); assert.equal(plan.committed,false); assert.deepEqual(await snapshot(db),before);
 assert.doesNotMatch(JSON.stringify(plan),/person@|eyJ|approval-audit/);
 const result=await app(req(),env,context(),{commit:true}); assert.equal(result.committed,true);
 const [members,identities,audit,receipt]=await snapshot(db);
 assert.deepEqual(members,[{id:result.memberId,recipient:target.recipient,role:'owner',status:'active',created_at:epoch}]);
 assert.deepEqual(identities,[{provider:'otp',subject:target.recipient,member_id:result.memberId,bound_at:epoch}]);
 assert.equal(audit.length,1); assert.equal(audit[0].action,'first-owner-bootstrap'); assert.equal(audit[0].artifact_id,target.nonce);
 assert.equal(receipt.length,1); assert.equal(receipt[0].context_digest,plan.contextDigest);
 for (const table of ['audit_events','first_owner_bootstrap']) {
  await assert.rejects(db.prepare(`DELETE FROM ${table}`).run());
  await assert.rejects(db.prepare(`UPDATE ${table} SET at=at+1`).run());
 }
 await assert.rejects(db.prepare('INSERT OR REPLACE INTO first_owner_bootstrap SELECT * FROM first_owner_bootstrap').run());
 await db.prepare("UPDATE members SET status='revoked' WHERE id=?").bind(result.memberId).run();
 await assert.rejects(app(req(),env,context(),{commit:true}));
 await assert.rejects(createFirstOwnerBootstrap(options({target:{...target,nonce:'z'.repeat(32)}}))(req(),env,context(),{commit:true}));
 assert.equal((await snapshot(db))[0].length,1);
});

test('bootstrap rejects missing, inferred, stale, mismatched or non-independent approval and MFA evidence without writes',async t=>{
 const {db,env}=await setup(t),before=await snapshot(db),base=options();
 const changes=[{mode:undefined},{verifyPolicy:undefined},{verifyOwnerApproval:undefined},{verifyOwnerApproval:base.verifyPolicy},
  {target:{...target,role:'member'}},{target:{...target,recipient:'Person@example.test'}},{target:{...target,databaseId:'wrong-db'}},
  ...[{source:'config-inference'},{independentMfaRequired:false},{enforcementVerified:false},{otpIdentityShapeVerified:false},
   {contextDigest:'c'.repeat(64)},{policyDigest:'a'.repeat(64)+'\n'},{verifiedAt:epoch+1},{expiresAt:epoch},{expiresAt:epoch+301}]
   .map(p=>({verifyPolicy:async c=>({...await base.verifyPolicy(c),...p})})),
  ...[{source:'browser'},{decision:'approve'},{approvalCount:0},{approvalCount:2},{auditId:''},
   {contextDigest:'c'.repeat(64)},{policyDigest:'c'.repeat(64)},{approvalDigest:''},{verifiedAt:epoch+1},{expiresAt:epoch},{expiresAt:epoch+301}]
   .map(p=>({verifyOwnerApproval:async c=>({...await base.verifyOwnerApproval(c),...p})}))];
 for (const change of changes) await assert.rejects(createFirstOwnerBootstrap(options(change))(req(),env,context(),{commit:true}));
 assert.deepEqual(await snapshot(db),before);
});

test('bootstrap requires verified OTP runtime on the same exact signed session; saved proofs cannot cross session/nonce/revision/target',async t=>{
 const {db,env}=await setup(t),before=await snapshot(db),base=options();
 const app=createFirstOwnerBootstrap(base);
 for (const [jwt,ctx] of [[token(),{}],[token(),context(target.recipient,'google')],[token(),context(target.recipient,'apple')],
  [token(),context('other@example.test')],[token({aud:['members-test','owner-test']}),context()],
  [token({iss:'https://wrong.cloudflareaccess.com'}),context()],[token({exp:epoch}),context()],
  [token().replace(/.$/,'!'),context()]]) await assert.rejects(app(req(jwt),env,ctx,{commit:true}));
 for (const request of [new Request(req(),{method:'GET'}),new Request('https://evil.example.test/',req()),
  new Request(config.APP_ORIGIN+'/?nonce=browser',req())]) await assert.rejects(app(request,env,context(),{commit:true}));
 let policy,approval;
 await createFirstOwnerBootstrap(options({verifyPolicy:async c=>(policy=await base.verifyPolicy(c)),
  verifyOwnerApproval:async c=>(approval=await base.verifyOwnerApproval(c))}))(req(),env,context());
 const saved={verifyPolicy:async()=>policy,verifyOwnerApproval:async()=>approval};
 await assert.rejects(createFirstOwnerBootstrap(options(saved))(req(token({sub:'another-session'})),env,context(),{commit:true}));
 for (const change of [{nonce:'z'.repeat(32)},{revision:'different'},{recipient:'other@example.test'}]) {
  const changed={...target,...change},jwt=token({email:changed.recipient});
  await assert.rejects(createFirstOwnerBootstrap(options({...saved,target:changed}))(req(jwt),env,context(changed.recipient),{commit:true}));
 }
 assert.deepEqual(await snapshot(db),before);
});

test('bootstrap handles concurrent writers with exactly one winner and rolls back every row on downstream failure',async t=>{
 const {db,env}=await setup(t);
 await db.prepare("CREATE TRIGGER synthetic_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").run();
 await assert.rejects(createFirstOwnerBootstrap(options())(req(),env,context(),{commit:true}));
 assert.deepEqual(await snapshot(db),[[],[],[],[]]);
 await db.prepare('DROP TRIGGER synthetic_failure').run();
 let readers=0,release;
 const barrier=new Promise(resolve=>{release=resolve;});
 const concurrent={prepare(sql){const statement=db.prepare(sql);if(!sql.includes(' AS records')) return statement;
  return {async first(){const row=await statement.first();if(++readers===8) release();await barrier;return row;}};}};
 const attempts=await Promise.allSettled(Array.from({length:8},(_,i)=>createFirstOwnerBootstrap(options({target:{...target,nonce:String(i).repeat(32)}}))(req(),{...env,DB:concurrent},context(),{commit:true})));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 for (const rows of await snapshot(db)) assert.equal(rows.length,1);
});

test('bootstrap SQL guard rejects state changed after preflight; failed readback does not permit retry',async t=>{
 const {db,env}=await setup(t);
 const changed={prepare(sql){const statement=db.prepare(sql);if(!sql.includes(' AS records')) return statement;
  return {async first(){const row=await statement.first();await db.prepare("INSERT INTO members VALUES('interloper','other@example.test','member','pending',?)").bind(epoch).run();return row;}};}};
 await assert.rejects(createFirstOwnerBootstrap(options())(req(),{...env,DB:changed},context(),{commit:true}));
 let rows=await snapshot(db);assert.equal(rows[0].length,1);assert.deepEqual(rows.slice(1),[[],[],[]]);
 await db.prepare('DELETE FROM members').run();
 const brokenReadback={prepare(sql){if(sql.includes('SELECT m.id FROM first_owner_bootstrap')) return {bind(){return {first:async()=>null};}};return db.prepare(sql);}};
 await assert.rejects(createFirstOwnerBootstrap(options())(req(),{...env,DB:brokenReadback},context(),{commit:true}),/requires inspection/);
 rows=await snapshot(db);for(const entries of rows) assert.equal(entries.length,1);
 await assert.rejects(createFirstOwnerBootstrap(options())(req(),env,context(),{commit:true}));
});

test('bootstrap refuses every existing person, including revoked Owners, pending members and Google-only same email',async t=>{
 const {db,env}=await setup(t);
 for (const [role,status] of [['owner','active'],['owner','revoked'],['member','pending'],['member','active']]) {
  await db.prepare('INSERT INTO members VALUES(?,?,?,?,?)').bind('existing',target.recipient,role,status,epoch).run();
  const before=await snapshot(db);
  await assert.rejects(createFirstOwnerBootstrap(options())(req(),env,context(),{commit:true}));
  assert.deepEqual(await snapshot(db),before);
  await db.prepare('DELETE FROM members').run();
 }
 await db.prepare("INSERT INTO members VALUES('existing',?,'owner','active',?)").bind(target.recipient,epoch).run();
 await db.prepare("INSERT INTO identities VALUES('google',?,'existing',?)").bind(target.recipient,epoch).run();
 const before=await snapshot(db);
 await assert.rejects(createFirstOwnerBootstrap(options())(req(),env,context(),{commit:true}));
 assert.deepEqual(await snapshot(db),before);
});

test('bootstrap rechecks retained evidence/JWT after asynchronous D1 reads and callback waits',async t=>{
 const {db,env}=await setup(t);
 for (const stage of ['policy','approval','database','jwt']) {
  let at=epoch; const base=options();
  const app=createFirstOwnerBootstrap(options({now:()=>at*1000,
   verifyAccess:createAuthenticator({fetcher:certFetch,now:()=>at*1000}),
   verifyPolicy:async c=>{const p=await base.verifyPolicy(c);if(stage==='policy') at=epoch+300;return p;},
   verifyOwnerApproval:async c=>{const p=await base.verifyOwnerApproval(c);if(stage==='approval') at=epoch+300;return p;}}));
  const delayed={prepare(sql){const statement=db.prepare(sql);return {async first(){const row=await statement.first();at=epoch+(stage==='jwt'?10:300);return row;}};}};
  await assert.rejects(app(req(token({exp:stage==='jwt'?epoch+10:epoch+700})),{...env,DB:stage==='database'||stage==='jwt'?delayed:db},context(),{commit:true}));
 }
 assert.deepEqual(await snapshot(db),[[],[],[],[]]);
});
