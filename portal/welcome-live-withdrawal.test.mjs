import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fixture,providerId,d1,baseline,content,sql as sourceSql} from './test/welcome-live-fixture.mjs';
import {createRequestOnboarding} from './request-onboarding.mjs';
import {createWelcomeLiveDelivery} from './welcome-live-delivery.mjs';
import {createWelcomeReview} from './welcome-review.mjs';

const claim=sql=>sql.startsWith('INSERT INTO welcome_intents');
const dispatch=sql=>sql.startsWith('SELECT i.id FROM welcome_intents');
// Mirror the Owner path: Requests D1 must NEVER be changed unless the hold
// succeeds. The fixture forbids fetch; every adapter is synthetic.
async function withdraw(f,onboarding=f.onboarding) {
 await onboarding.holdAdmission('request',1);
 f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");
}
function stillApproved(f) {
 assert.deepEqual({...f.requests.prepare('SELECT status,revision FROM membership_requests').get()},
  {status:'approved',revision:1});
 assert.equal(f.count('member_approval_holds'),0);
 assert.equal(f.members.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,0);
}
function held(f) {
 assert.equal(f.count('member_approval_holds'),1);
 assert.equal(f.members.prepare("SELECT count(*) n FROM audit_events WHERE action='owner-approval-withdrawal-hold'").get().n,1);
 assert.throws(()=>f.members.exec('DELETE FROM member_approval_holds'),/retain Owner approval hold/);
 assert.throws(()=>f.members.exec('UPDATE member_approval_holds SET held_at=held_at+1'),/immutable Owner approval hold/);
}

test('withdrawal after review and preflight but before durable claim excludes the claim atomically',async t=>{
 const f=await fixture(t);
 f.hooks.before=async sql=>{if(claim(sql))await withdraw(f);};
 await assert.rejects(f.send());
 held(f); assert.equal(f.count('welcome_intents'),0); assert.equal(f.calls.send.length,0);
 assert.equal(f.requests.prepare('SELECT status FROM membership_requests').get().status,'revoked');
});

test('final SQL independently rejects a hold committed after the post-claim preflight',async t=>{
 for(const revoke of [false,true]) {
  const f=await fixture(t); let checked=0;
  f.hooks.before=sql=>{
   if(!dispatch(sql))return;
   checked++;
   // Model a legacy/out-of-band writer to reproduce the reported final-SQL
   // race independently of the new cooperating holdAdmission exclusion.
   f.members.prepare(`INSERT INTO member_approval_holds VALUES('source','request','owner',1,?)`).run(f.clock.at);
   if(revoke)f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");
  };
  assert.equal((await f.send()).state,'failed');
  assert.equal(checked,1); assert.equal(f.calls.send.length,0); held(f);
  assert.deepEqual(f.members.prepare("SELECT action FROM audit_events WHERE action LIKE 'welcome-%' ORDER BY id").all().map(x=>x.action),
   ['welcome-live-dispatching','welcome-live-failed']);
 }
});

test('claim excludes withdrawal after claim and on either side of final dispatch SQL, including a different Owner',async t=>{
 for(const boundary of ['after-claim','before-final','after-final']) {
  const f=await fixture(t); let attempts=0;
  f.members.prepare("INSERT INTO members VALUES('other-owner','other@example.test','owner','active',?)").run(f.clock.at);
  const other=createRequestOnboarding({...f.base,actorId:'other-owner',requestDb:d1(f.requests)});
  const attempt=async sql=>{
   if(!(boundary==='after-claim'?claim(sql):dispatch(sql)))return;
   attempts++; await assert.rejects(withdraw(f,other)); stillApproved(f);
  };
  f.hooks[boundary==='before-final'?'before':'after']=attempt;
  assert.equal((await f.send()).state,'accepted');
  assert.equal(attempts,1); assert.equal(f.calls.send.length,1); stillApproved(f);
  await withdraw(f,other); held(f);
 }
});

test('in-flight adapter blocks withdrawal, then definite acceptance or refusal permits it',async t=>{
 for(const state of ['accepted','failed']) {
  const f=await fixture(t); let complete,started;
  const gate=new Promise(resolve=>{started=resolve;});
  f.adapter.send=()=>{started();return new Promise(resolve=>{complete=resolve;});};
  const sending=f.send(); await gate;
  await assert.rejects(withdraw(f)); stillApproved(f);
  complete(state==='accepted'?{state,providerId}:{state});
  assert.equal((await sending).state,state);
  await withdraw(f); held(f);
  await assert.rejects(f.send());
 }
});

test('timeout UNKNOWN blocks withdrawal even when transport accepts late; receipt and lock stay immutable',async t=>{
 const f=await fixture(t,{timeoutMs:5}); let complete;
 f.adapter.send=()=>new Promise(resolve=>{complete=resolve;});
 const result=await f.send(); assert.equal(result.state,'UNKNOWN');
 await assert.rejects(withdraw(f)); stillApproved(f);
 complete({state:'accepted',providerId}); await Promise.resolve();
 await assert.rejects(withdraw(f)); stillApproved(f);
 assert.equal(f.members.prepare('SELECT state FROM welcome_intents').get().state,'UNKNOWN');
 await assert.rejects(f.send(await f.fresh()));
 assert.throws(()=>f.members.exec("UPDATE welcome_intents SET state='failed'"),/welcome reconciliation required/);
 assert.throws(()=>f.members.exec('DELETE FROM welcome_intents'),/retain welcome history/);
});

test('lost claim/completion readback and abort after claim retain the withdrawal exclusion',async t=>{
 for(const phase of ['claim-readback','completion','abort']) {
  const f=await fixture(t),controller=new AbortController();
  if(phase==='completion')f.members.exec("CREATE TRIGGER lose_finish BEFORE UPDATE ON welcome_intents BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  else f.hooks.after=sql=>{
   if(!claim(sql))return;
   if(phase==='abort')controller.abort(); else throw Error('lost readback');
  };
  if(phase==='abort')assert.equal((await f.send(f.confirmation,{signal:controller.signal})).state,'UNKNOWN');
  else await assert.rejects(f.send());
  await assert.rejects(withdraw(f)); stillApproved(f);
  assert.equal(f.members.prepare('SELECT state FROM welcome_intents').get().state,phase==='abort'?'UNKNOWN':'dispatching');
  assert.equal(f.calls.send.length,phase==='completion'?1:0);
 }
});

test('known pre-dispatch failure permits withdrawal and a simulated uncertain intent does not block it',async t=>{
 const f=await fixture(t);
 f.hooks.after=sql=>{if(claim(sql))f.members.exec('UPDATE member_onboarding SET revision=revision+1');};
 assert.equal((await f.send()).state,'failed'); assert.equal(f.calls.send.length,0);
 await withdraw(f); held(f);
 for(const state of ['dispatching','UNKNOWN']) {
  const g=await fixture(t);
  g.members.prepare(`INSERT INTO welcome_intents
   SELECT 'simulated',source_database,request_id,member_id,'owner',revision,'friend@example.test',?,'simulated','dispatching',?,?,NULL
   FROM member_onboarding`).run('f'.repeat(64),g.clock.at,g.clock.at);
  if(state==='UNKNOWN')g.members.exec("UPDATE welcome_intents SET state='UNKNOWN'");
  await withdraw(g); held(g);
 }
});

test('missing hold table fails closed at claim and final SQL; missing welcome table fails closed at withdrawal',async t=>{
 for(const boundary of ['claim','final']) {
  const f=await fixture(t);
  f.hooks.before=sql=>{if((boundary==='claim'?claim:dispatch)(sql))f.members.exec('DROP TABLE member_approval_holds');};
  if(boundary==='claim'){await assert.rejects(f.send());assert.equal(f.count('welcome_intents'),0);}
  else assert.equal((await f.send()).state,'failed');
  assert.equal(f.calls.send.length,0);
 }
 const g=await fixture(t); g.members.exec('DROP TABLE welcome_reconciliation_events; DROP TABLE welcome_intents');
 await assert.rejects(withdraw(g)); stillApproved(g);
});

test('legacy overlap of a retained hold and dispatching intent cannot bypass withdrawal exclusion through hold retry',async t=>{
 const f=await fixture(t);
 f.hooks.after=sql=>{
  if(!claim(sql))return;
  f.members.prepare("INSERT INTO member_approval_holds VALUES('source','request','owner',1,?)").run(f.clock.at);
  throw Error('lost claim readback');
 };
 await assert.rejects(f.send());
 const before=f.members.prepare('SELECT * FROM member_approval_holds').get(),audit=f.count('audit_events');
 await assert.rejects(withdraw(f)); held(f);
 assert.equal(f.requests.prepare('SELECT status FROM membership_requests').get().status,'approved');
 assert.deepEqual(f.members.prepare('SELECT * FROM member_approval_holds').get(),before);
 assert.equal(f.count('audit_events'),audit); assert.equal(f.calls.send.length,0);
 assert.equal(f.members.prepare('SELECT state FROM welcome_intents').get().state,'dispatching');
});

test('local workerd/D1 serializes withdrawal with claim and the final-read-to-adapter gap',async t=>{
 const {Miniflare,NoOpLog,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),name:'welcome-hold-offline',
  compatibilityDate:'2026-10-14',modules:true,script:'export default {fetch(){return new Response("offline")}}',
  d1Databases:['BEFORE','AFTER'],outboundService:()=>{throw Error('External services forbidden');}}));
 try {
  for(const boundary of ['before-claim','after-final']) {
   const memberDb=await mf.getD1Database(boundary==='before-claim'?'BEFORE':'AFTER'),probe=new DatabaseSync(':memory:');
   try {
    for(const path of baseline)probe.exec(sourceSql(path));
    await memberDb.batch(probe.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map(x=>memberDb.prepare(x.sql)));
   } finally {probe.close();}
   const f=await fixture(t),sourceDatabase=boundary;
   // Each ordering uses isolated local D1 with the exact baseline triggers.
   const memberId='member-'+boundary;
   await memberDb.prepare("INSERT INTO members VALUES(?,?,'member','pending',?)").bind(memberId,'friend@example.test',f.clock.at).run();
   await memberDb.prepare("INSERT INTO members VALUES('owner','owner@example.test','owner','active',?) ON CONFLICT DO NOTHING").bind(f.clock.at).run();
   await memberDb.prepare(`INSERT INTO member_onboarding(source_database,request_id,request_revision,member_id,actor_id,approved_at,jellyfin_ready_at,jellyfin_username,jellyfin_url,revision)
    VALUES(?,'request',1,?,'owner',?,?,'friend','https://jellyfin.example.test/',2)`).bind(sourceDatabase,memberId,f.clock.at,f.clock.at).run();
   const base={...f.base,sourceDatabase,memberDb},onboarding=createRequestOnboarding({...base,requestDb:d1(f.requests)});
   let attempts=0;
   const wrapped={prepare(sql) {
    const bind=(args=[])=>({bind:(...values)=>bind(values),async first() {
     if(boundary==='before-claim'&&claim(sql)){attempts++;await withdraw(f,onboarding);}
     const row=await memberDb.prepare(sql).bind(...args).first();
     if(boundary==='after-final'&&dispatch(sql)){attempts++;await assert.rejects(withdraw(f,onboarding));}
     return row;
    }});
    return bind();
   }};
   const review=createWelcomeReview({...f.reviewOptions,onboarding});
   const confirmation={review:(await review.preview('request',1,content)).review,confirmed:true};
   const api=createWelcomeLiveDelivery({...f.options,...base,memberDb:wrapped,onboarding,review});
   if(boundary==='before-claim')await assert.rejects(api.send('request',1,content,confirmation));
   else assert.equal((await api.send('request',1,content,confirmation)).state,'accepted');
   assert.equal(attempts,1); assert.equal(f.calls.send.length,boundary==='after-final'?1:0);
   assert.equal((await memberDb.prepare('SELECT count(*) n FROM member_approval_holds WHERE source_database=?').bind(sourceDatabase).first()).n,boundary==='before-claim'?1:0);
   assert.equal(f.requests.prepare('SELECT status FROM membership_requests').get().status,boundary==='before-claim'?'revoked':'approved');
   assert.deepEqual((await memberDb.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }
 } finally {await mf.dispose();}
});
