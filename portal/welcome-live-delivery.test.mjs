import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createWelcomeLiveDelivery} from './welcome-live-delivery.mjs';
import {fixture,content,providerId,rows} from './test/welcome-live-fixture.mjs';

test('default off and nonboolean opt-ins refuse before touching any dependency',async()=>{
 for (const enabled of [undefined,false,'true',1]) {
  let touched=0;
  const api=createWelcomeLiveDelivery({enabled,memberDb:{prepare(){touched++;}},adapter:{send(){touched++;}}});
  await assert.rejects(api.send()); await assert.rejects(api.status()); assert.equal(touched,0);
 }
});
test('live acceptance uses exact signed ephemeral message and grants no access',async t=>{
 const f=await fixture(t),preview=await f.review.preview('request',1,content);
 const result=await f.send({review:preview.review,confirmed:true});
 assert.equal(result.state,'accepted'); assert.equal(result.mode,'live');
 for (const key of ['activated','activationAuthorized','delivered','mayRetry']) assert.equal(result[key],false);
 assert.deepEqual(f.calls.send,[{intentId:result.id,recipient:preview.recipient,subject:preview.subject,text:preview.text}]);
 assert.equal(f.count('welcome_intents'),1);
 assert.deepEqual(f.members.prepare("SELECT action FROM audit_events WHERE action LIKE 'welcome-%' ORDER BY id").all().map(x=>x.action),['welcome-live-dispatching','welcome-live-accepted']);
 assert.equal(f.members.prepare("SELECT status FROM members WHERE role='member'").get().status,'pending');
 for (const table of ['identities','invitations','service_grants']) assert.equal(f.count(table),0);
 const stored=JSON.stringify(rows(f.members));
 for (const value of [content.password,content.message,preview.review,preview.text]) assert.ok(!stored.includes(value));
 const status=await f.api.status('request',1);
 assert.deepEqual(Object.keys(status[0]).sort(),['created_at','id','mode','state','updated_at']);
 assert.equal(status[0].state,'accepted');
 await assert.rejects(f.send(await f.fresh())); assert.equal(f.calls.send.length,1);
});
test('concurrent same or distinct signed confirmations can claim only once',async t=>{
 for (const distinct of [false,true]) {
  const f=await fixture(t),other=distinct ? await f.fresh() : f.confirmation;
  const results=await Promise.allSettled([f.send(),f.send(other)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(f.calls.send.length,1); assert.equal(f.count('welcome_intents'),1);
 }
});
test('durable dispatching lock blocks concurrent submissions while adapter is still pending',async t=>{
 const f=await fixture(t); let release,started;
 const gate=new Promise(resolve=>{started=resolve;});
 f.adapter.send=()=>{started();return new Promise(resolve=>{release=resolve;});};
 const sending=f.send(); await gate;
 assert.equal(f.members.prepare('SELECT state FROM welcome_intents').get().state,'dispatching');
 await assert.rejects(f.send(await f.fresh()));
 release({state:'accepted',providerId}); assert.equal((await sending).state,'accepted');
});
test('provider refusal needs a new explicit signed review; never automatically retries',async t=>{
 const f=await fixture(t); let calls=0;
 f.adapter.send=async()=>{calls++;return {state:'failed'};};
 assert.equal((await f.send()).state,'failed'); assert.equal(calls,1);
 await assert.rejects(f.send()); assert.equal(calls,1);
 assert.equal((await f.send(await f.fresh())).state,'failed'); assert.equal(calls,2);
});
test('exceptions, abort errors and malformed responses classify UNKNOWN and lock fresh attempts',async t=>{
 for (const answer of [null,{}, {state:'accepted',providerId:'not-a-uuid'}, {state:'delivered'}, {state:'UNKNOWN'},'throw','abort']) {
  const f=await fixture(t); let calls=0;
  f.adapter.send=async()=>{calls++;if (answer==='throw') throw Error(content.password); if (answer==='abort') throw new DOMException('Aborted','AbortError'); return answer;};
  assert.equal((await f.send()).state,'UNKNOWN');
  await assert.rejects(f.send(await f.fresh())); assert.equal(calls,1);
  assert.equal(f.members.prepare('SELECT provider_id FROM welcome_intents').get().provider_id,null);
 }
});
test('timeout locks UNKNOWN even if adapter accepts later',async t=>{
 const f=await fixture(t,{timeoutMs:5}); let complete,calls=0;
 f.adapter.send=()=>{calls++;return new Promise(resolve=>{complete=resolve;});};
 assert.equal((await f.send()).state,'UNKNOWN'); complete({state:'accepted',providerId});
 await assert.rejects(f.send(await f.fresh())); assert.equal(calls,1);
 assert.equal(f.members.prepare('SELECT state FROM welcome_intents').get().state,'UNKNOWN');
});
test('abort before claim makes no intent; abort during dispatch locks UNKNOWN',async t=>{
 const f=await fixture(t),before=new AbortController(); before.abort();
 await assert.rejects(f.send(f.confirmation,{signal:before.signal})); assert.equal(f.count('welcome_intents'),0);
 const during=new AbortController();
 f.adapter.send=async()=>{during.abort();return {state:'accepted',providerId};};
 assert.equal((await f.send(f.confirmation,{signal:during.signal})).state,'UNKNOWN');
 await assert.rejects(f.send(await f.fresh()));
});
test('abort after durable claim never starts transport and stays locked',async t=>{
 const f=await fixture(t),controller=new AbortController();
 f.hooks.after=query=>{if (query.startsWith('INSERT INTO welcome_intents')) controller.abort();};
 assert.equal((await f.send(f.confirmation,{signal:controller.signal})).state,'UNKNOWN');
 assert.equal(f.calls.send.length,0); await assert.rejects(f.send(await f.fresh()));
});
test('lost completion or lost claim readback leaves dispatching locked',async t=>{
 for (const phase of ['finish','claim-readback']) {
  const f=await fixture(t);
  if (phase==='finish') f.members.exec("CREATE TRIGGER lose_finish BEFORE UPDATE ON welcome_intents BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  else f.hooks.after=query=>{if (query.startsWith('INSERT INTO welcome_intents')) throw Error('lost readback');};
  await assert.rejects(f.send(),{message:'Welcome live delivery unavailable. Check recorded status before retrying.'});
  assert.equal(f.members.prepare('SELECT state FROM welcome_intents').get().state,'dispatching');
  await assert.rejects(f.send(await f.fresh())); assert.equal(f.calls.send.length,phase==='finish' ? 1 : 0);
 }
});
test('bad proof, changed message, wrong Owner/session, withdrawal, role and status fail before claim',async t=>{
 for (const change of ['proof','body','actor','session','withdrawn','owner-revoked','owner-role','active','revoked','member-role','not-ready','revision']) {
  const f=await fixture(t);
  if (change==='proof') f.confirmation.confirmed=false;
  if (change==='actor' || change==='session') {
   const {createWelcomeReview}=await import('./welcome-review.mjs');
   f.options.review=createWelcomeReview({...f.reviewOptions,...(change==='actor'?{actorId:'wrong'}:{sessionBinding:'x'.repeat(64)})});
  }
  if (change==='withdrawn') f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");
  if (change==='owner-revoked') f.members.exec("UPDATE members SET status='revoked' WHERE id='owner'");
  if (change==='owner-role') f.members.exec("UPDATE members SET role='trusted' WHERE id='owner'");
  if (['active','revoked'].includes(change)) f.members.exec(`UPDATE members SET status='${change}' WHERE role='member'`);
  if (change==='member-role') f.members.exec("UPDATE members SET role='trusted' WHERE role='member'");
  if (change==='not-ready') f.members.exec('UPDATE member_onboarding SET jellyfin_ready_at=NULL,jellyfin_username=NULL,jellyfin_url=NULL');
  if (change==='revision') f.members.exec('UPDATE member_onboarding SET revision=revision+1');
  const api=createWelcomeLiveDelivery(f.options);
  await assert.rejects(api.send('request',1,change==='body'?{...content,message:'changed'}:content,f.confirmation));
  assert.equal(f.calls.send.length,0,change); assert.equal(f.count('welcome_intents'),0,change);
 }
});
test('SQL claim independently checks pending Member, Owner and session deadline',async t=>{
 for (const change of ['member','owner','session','review']) {
  const f=await fixture(t);
  f.hooks.before=query=>{
   if (!query.startsWith('INSERT INTO welcome_intents')) return;
   if (change==='member') f.members.exec("UPDATE members SET status='revoked' WHERE role='member'");
   if (change==='owner') f.members.exec("UPDATE members SET status='revoked' WHERE id='owner'");
   if (change==='session') f.members.function('unixepoch',{varargs:true},()=>f.base.expiresAt);
   if (change==='review') f.members.function('unixepoch',{varargs:true},()=>f.clock.at+300);
  };
  await assert.rejects(f.send()); assert.equal(f.count('welcome_intents'),0); assert.equal(f.calls.send.length,0);
 }
});
test('pre-provider recheck refuses withdrawal, deadline and local status changes after claim',async t=>{
 for (const change of ['request','member','owner','session','review','sql-deadline','revision']) {
  const f=await fixture(t);
  f.hooks.after=query=>{
   if (!query.startsWith('INSERT INTO welcome_intents')) return;
   if (change==='request') f.requests.exec("UPDATE membership_requests SET status='revoked',revision=2");
   if (change==='member') f.members.exec("UPDATE members SET status='revoked' WHERE role='member'");
   if (change==='owner') f.members.exec("UPDATE members SET status='revoked' WHERE id='owner'");
   if (change==='session') f.clock.at=f.base.expiresAt;
   if (change==='review') f.clock.at+=300;
   if (change==='sql-deadline') f.members.function('unixepoch',{varargs:true},()=>f.base.expiresAt);
   if (change==='revision') f.members.exec('UPDATE member_onboarding SET revision=revision+1');
  };
  assert.equal((await f.send()).state,'failed',change); assert.equal(f.calls.send.length,0,change);
 }
});
test('session expiry after dispatch persists result but never starts another call',async t=>{
 const f=await fixture(t);
 f.adapter.send=async()=>{f.clock.at=f.base.expiresAt;return {state:'accepted',providerId};};
 assert.equal((await f.send()).state,'accepted'); await assert.rejects(f.send());
});
test('new source modules are not imported by existing source or Worker routes',()=>{
 const walk=dir=>readdirSync(new URL(dir,import.meta.url),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+e.name+'/'):[dir+e.name]);
 const files=[...walk('./'),...walk('../owner-launchpad/src/')].filter(p=>/\.(mjs|js|ts)$/.test(p)
  && !p.includes('/test/') && !p.endsWith('.test.mjs') && !p.endsWith('/welcome-live-delivery.mjs') && !p.endsWith('/welcome-reconciliation.mjs'));
 for (const file of files) {
  const code=readFileSync(new URL(file,import.meta.url),'utf8');
  if (file.endsWith('/owner-launchpad/src/welcome-live-route.mjs')) {
   // Route integration is explicitly source-only and requires independent staging gates.
   assert.match(code,/PORTAL_WELCOME_LIVE_ROUTE==='review-only-12'/);
   assert.match(code,/PORTAL_WELCOME_LIVE_SEND==='enabled-12'/);
   continue;
  }
  assert.doesNotMatch(code,/\b(?:import|export)\b[^;]*welcome-(?:live-delivery|reconciliation)\.mjs/,file);
 }
});
