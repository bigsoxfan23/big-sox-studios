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
  ...changes};
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
// Low-level atomicity tests only. Browser validation is exercised in enrollment tests.
async function confirmation(app,env) {
 const plan=await app(req(),env,context());
 return {commit:true,expectedConfirmationDigest:plan.confirmationDigest,confirmationExpiresAt:epoch+300,browserTicketDigest:'a'.repeat(64)};
}
async function commit(app,env) {return app(req(),env,context(),await confirmation(app,env));}
test('bootstrap defaults to read-only, creates exact OTP Owner atomically, retains audit and never replays',async t=>{
 const {db,env}=await setup(t),app=createFirstOwnerBootstrap(options());
 const before=await snapshot(db);
 const plan=await app(req(),env,context()); assert.equal(plan.committed,false); assert.deepEqual(await snapshot(db),before);
 assert.doesNotMatch(JSON.stringify(plan),/person@|eyJ|approval-audit/);
 const result=await app(req(),env,context(),await confirmation(app,env)); assert.equal(result.committed,true);
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
 await assert.rejects(commit(app,env));
 await assert.rejects(commit(createFirstOwnerBootstrap(options({target:{...target,nonce:'z'.repeat(32)}})),env));
 assert.equal((await snapshot(db))[0].length,1);
});

test('bootstrap denies absent target, wrong exact recipient/DB and missing browser confirmation',async t=>{
 const {db,env}=await setup(t),before=await snapshot(db);
 for(const change of [{mode:undefined},{target:undefined},{target:{...target,role:'member'}},
  {target:{...target,recipient:'Person@example.test'}},{target:{...target,databaseId:'wrong-db'}}])
  await assert.rejects(createFirstOwnerBootstrap(options(change))(req(),env,context()));
 await assert.rejects(createFirstOwnerBootstrap(options())(req(),env,context(),{commit:true}));
 assert.deepEqual(await snapshot(db),before);
});

test('bootstrap requires exact OTP runtime and unexpired signed JWT, rejects invalid sessions',async t=>{
 const {db,env}=await setup(t),before=await snapshot(db),app=createFirstOwnerBootstrap(options());
 for(const [jwt,ctx] of [[token(),{}],[token(),context(target.recipient,'google')],[token(),context(target.recipient,'apple')],
  [token(),context('other@example.test')],[token({aud:['members-test','owner-test']}),context()],
  [token({iss:'https://wrong.cloudflareaccess.com'}),context()],[token({exp:epoch}),context()],
  [token({iat:epoch+1}),context()],[token().replace(/.$/,'!'),context()]])
  await assert.rejects(app(req(jwt),env,ctx));
 for(const request of [new Request(req(),{method:'GET'}),new Request('https://evil.example.test/',req()),
  new Request(config.APP_ORIGIN+'/?nonce=browser',req())]) await assert.rejects(app(request,env,context()));
 assert.deepEqual(await snapshot(db),before);
});

test('valid Cloudflare session older than five minutes starts a fresh five-minute confirmation',async t=>{
 const {db,env}=await setup(t),app=createFirstOwnerBootstrap(options());
 const oldButUnexpired=token({iat:epoch-3600,nbf:epoch-3600,exp:epoch+3600});
 const plan=await app(req(oldButUnexpired),env,context());
 assert.equal(plan.ready,true);assert.equal(plan.committed,false);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM members').first()).n,0);
 await assert.rejects(app(req(token({iat:epoch-3600,nbf:epoch-3600,exp:epoch-1})),env,context()));
});

test('bootstrap handles concurrent writers with exactly one winner and rolls back every row on downstream failure',async t=>{
 const {db,env}=await setup(t);
 await db.prepare("CREATE TRIGGER synthetic_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").run();
 await assert.rejects(commit(createFirstOwnerBootstrap(options()),env));
 assert.deepEqual(await snapshot(db),[[],[],[],[]]);
 await db.prepare('DROP TRIGGER synthetic_failure').run();
 let readers=0,release;
 const barrier=new Promise(resolve=>{release=resolve;});
 const concurrent={prepare(sql){const statement=db.prepare(sql);if(!sql.includes(' AS records')) return statement;
  return {async first(){const row=await statement.first();if(++readers===8) release();await barrier;return row;}};}};
 const attempts=await Promise.allSettled(Array.from({length:8},(_,i)=>commit(createFirstOwnerBootstrap(options({target:{...target,nonce:String(i).repeat(32)}})),{...env,DB:concurrent})));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 for (const rows of await snapshot(db)) assert.equal(rows.length,1);
});

test('bootstrap SQL guard rejects state changed after preflight; failed readback does not permit retry',async t=>{
 const {db,env}=await setup(t);
 const changed={prepare(sql){const statement=db.prepare(sql);if(!sql.includes(' AS records')) return statement;
  return {async first(){const row=await statement.first();await db.prepare("INSERT INTO members VALUES('interloper','other@example.test','member','pending',?)").bind(epoch).run();return row;}};}};
 await assert.rejects(commit(createFirstOwnerBootstrap(options()),{...env,DB:changed}));
 let rows=await snapshot(db);assert.equal(rows[0].length,1);assert.deepEqual(rows.slice(1),[[],[],[]]);
 await db.prepare('DELETE FROM members').run();
 const brokenReadback={prepare(sql){if(sql.includes('SELECT m.id FROM first_owner_bootstrap')) return {bind(){return {first:async()=>null};}};return db.prepare(sql);}};
 await assert.rejects(commit(createFirstOwnerBootstrap(options()),{...env,DB:brokenReadback}),/requires inspection/);
 rows=await snapshot(db);for(const entries of rows) assert.equal(entries.length,1);
 await assert.rejects(commit(createFirstOwnerBootstrap(options()),env));
});

test('bootstrap refuses every existing person, including revoked Owners, pending members and Google-only same email',async t=>{
 const {db,env}=await setup(t);
 for (const [role,status] of [['owner','active'],['owner','revoked'],['member','pending'],['member','active']]) {
  await db.prepare('INSERT INTO members VALUES(?,?,?,?,?)').bind('existing',target.recipient,role,status,epoch).run();
  const before=await snapshot(db);
  await assert.rejects(commit(createFirstOwnerBootstrap(options()),env));
  assert.deepEqual(await snapshot(db),before);
  await db.prepare('DELETE FROM members').run();
 }
 await db.prepare("INSERT INTO members VALUES('existing',?,'owner','active',?)").bind(target.recipient,epoch).run();
 await db.prepare("INSERT INTO identities VALUES('google',?,'existing',?)").bind(target.recipient,epoch).run();
 const before=await snapshot(db);
 await assert.rejects(commit(createFirstOwnerBootstrap(options()),env));
 assert.deepEqual(await snapshot(db),before);
});

test('bootstrap rechecks JWT freshness after asynchronous D1 reads',async t=>{
 const {db,env}=await setup(t);
 for(const expiry of [epoch+10,epoch+200]) {
  let at=epoch;const now=()=>at*1000;
  const app=createFirstOwnerBootstrap(options({now,verifyAccess:createAuthenticator({fetcher:certFetch,now})}));
  const delayed={prepare(sql){const statement=db.prepare(sql);return {async first(){
   const row=await statement.first();at=epoch+(expiry===epoch+10?10:300);return row;
  }};}};
  await assert.rejects(app(req(token({exp:expiry})),{...env,DB:delayed},context()));
 }
 assert.deepEqual(await snapshot(db),[[],[],[],[]]);
});
