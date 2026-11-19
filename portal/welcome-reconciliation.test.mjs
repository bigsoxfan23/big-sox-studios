import test from 'node:test';
import assert from 'node:assert/strict';
import {createWelcomeReconciliation,welcomeReconciliationProofValue} from './welcome-reconciliation.mjs';
import {fixture,providerId} from './test/welcome-live-fixture.mjs';

const evidenceFor = async f => {
 const sent=await f.send();
 assert.equal(sent.state,'accepted');
 const receipt=await f.reconciliation.verifyReceipt(sent.id,providerId);
 assert.equal(receipt.state,'provider-observed');
 assert.equal(receipt.activationAuthorized,false);
 assert.equal(receipt.mayRetry,false);
 return {sent,evidence:receipt.evidence};
};
const reject = async work => assert.rejects(work,/Welcome reconciliation unavailable|unavailable|locked/);

test('default OFF rejects inspection and mutations without touching D1 or provider',async t=>{
 const f=await fixture(t),disabled=createWelcomeReconciliation();
 await reject(disabled.verifyReceipt('missing',providerId));
 await reject(disabled.recordEvidence({},{}));
 assert.equal(f.count('welcome_reconciliation_events'),0);
 assert.equal(f.calls.inspect.length,0);
});
test('independent provider receipt + signed Owner confirmation append immutable, auditable, secret-free evidence',async t=>{
 const f=await fixture(t),{sent,evidence}=await evidenceFor(f);
 const auditBefore=f.count('audit_events');
 const proof=await f.sign(evidence);
 const result=await f.reconciliation.recordEvidence(evidence,proof);
 assert.equal(result.state,'evidence-recorded');
 assert.equal(result.activationAuthorized,false);
 assert.equal(result.mayRetry,false);
 assert.equal(f.count('welcome_reconciliation_events'),1);
 assert.equal(f.count('audit_events'),auditBefore+1);
 const row=f.members.prepare('SELECT * FROM welcome_reconciliation_events').get();
 assert.equal(row.intent_id,sent.id);
 assert.equal(row.provider_id,providerId);
 assert.equal(row.provider_status,'delivered');
 assert.equal(row.intent_state,'accepted');
 assert.equal(f.members.prepare('SELECT state FROM welcome_intents WHERE id=?').get(sent.id).state,'accepted');
 assert.equal(f.members.prepare("SELECT status FROM members WHERE role='member'").get().status,'pending');
 assert.equal(f.count('service_grants'),0);
 for(const s of [JSON.stringify(row),JSON.stringify(result)])assert.doesNotMatch(s,/synthetic-only-password|Welcome, synthetic friend!/);
 assert.deepEqual(f.members.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal(f.members.prepare('PRAGMA quick_check').get().quick_check,'ok');
});
test('same proof cannot be recorded twice; replay and concurrent duplicates record only one event',async t=>{
 const f=await fixture(t),{evidence}=await evidenceFor(f),proof=await f.sign(evidence);
 const results=await Promise.allSettled([f.reconciliation.recordEvidence(evidence,proof),f.reconciliation.recordEvidence(evidence,proof)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(f.count('welcome_reconciliation_events'),1);
 assert.equal(f.members.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='welcome-live-reconciliation-delivered'").get().n,1);
 await reject(f.reconciliation.recordEvidence(evidence,proof));
});
test('unsigned or tampered Owner evidence and extra fields cannot persist',async t=>{
 const f=await fixture(t),{evidence}=await evidenceFor(f),proof=await f.sign(evidence);
 for(const e of [{...evidence,providerStatus:'failed'},{...evidence,providerId:'550e8400-e29b-41d4-a716-446655440012'},{...evidence,privateMessage:'password'},{...evidence,intentState:'UNKNOWN'}]){
  await reject(f.reconciliation.recordEvidence(e,proof));
 }
 for(const p of [{...proof,confirmed:false},{...proof,signature:'0'.repeat(64)},{...proof,unexpected:'x'},{...proof,nonce:'b'.repeat(32)}]){
  await reject(f.reconciliation.recordEvidence(evidence,p));
 }
 assert.equal(f.count('welcome_reconciliation_events'),0);
});
test('unverified receipt ID, provider error, wrong status and wrong Owner are denied',async t=>{
 const f=await fixture(t),{sent,evidence}=await evidenceFor(f);
 const badId='550e8400-e29b-41d4-a716-446655440099';
 await reject(f.reconciliation.verifyReceipt(sent.id,badId));
 const another=createWelcomeReconciliation({...f.reconcileOptions,actorId:'not-an-owner'});
 await reject(another.verifyReceipt(sent.id,providerId));
 const broken=createWelcomeReconciliation({...f.reconcileOptions,adapter:{inspect:async()=>({state:'provider-observed',providerId,providerStatus:'surprise'})}});
 const unknown=await broken.verifyReceipt(sent.id,providerId);
 assert.equal(unknown.state,'UNKNOWN');
 assert.equal(unknown.mayRetry,false);
 const proof=await f.sign(evidence);
 await reject(broken.recordEvidence(evidence,proof));
 assert.equal(f.count('welcome_reconciliation_events'),0);
});
test('expired session or proof, future proof, and revoked Owner cannot record evidence',async t=>{
 for(const scenario of ['expired-session','future-proof','expired-proof','revoked-owner']){
  const f=await fixture(t),{evidence}=await evidenceFor(f),proof=await f.sign(evidence);
  if(scenario==='expired-session')f.clock.at=f.base.expiresAt;
  if(scenario==='future-proof')proof.issuedAt=f.clock.at+20;
  if(scenario==='expired-proof')f.clock.at=proof.expiresAt;
  if(scenario==='revoked-owner')f.members.prepare("UPDATE members SET status='revoked' WHERE role='owner'").run();
  await reject(f.reconciliation.recordEvidence(evidence,proof));
  assert.equal(f.count('welcome_reconciliation_events'),0,scenario);
 }
});
test('original UNKNOWN lock survives receipt evidence, including a provider-delivered observation',async t=>{
 const f=await fixture(t,{adapter:{
  send:async()=>({state:'UNKNOWN'}),
  inspect:async({providerId:id})=>({state:'provider-observed',providerId:id,providerStatus:'delivered'})
 }}),out=await f.send();
 assert.equal(out.state,'UNKNOWN');
 const observed=await f.reconciliation.verifyReceipt(out.id,providerId);
 assert.equal(observed.state,'provider-observed');
 const proof=await f.sign(observed.evidence);
 const recorded=await f.reconciliation.recordEvidence(observed.evidence,proof);
 assert.equal(recorded.state,'evidence-recorded');
 assert.equal(recorded.mayRetry,false);
 assert.equal(f.members.prepare('SELECT state FROM welcome_intents WHERE id=?').get(out.id).state,'UNKNOWN');
 await assert.rejects(f.send(await f.fresh()));
 assert.equal(f.count('welcome_intents'),1);
 assert.equal(f.count('welcome_reconciliation_events'),1);
 assert.equal(f.count('service_grants'),0);
});
test('evidence and audit are append-only, including REPLACE attempts',async t=>{
 const f=await fixture(t),{evidence}=await evidenceFor(f),proof=await f.sign(evidence);
 await f.reconciliation.recordEvidence(evidence,proof);
 const row=f.members.prepare('SELECT id,proof_digest FROM welcome_reconciliation_events').get();
 assert.throws(()=>f.members.prepare('UPDATE welcome_reconciliation_events SET provider_status=? WHERE id=?').run('bounced',row.id));
 assert.throws(()=>f.members.prepare('DELETE FROM welcome_reconciliation_events WHERE id=?').run(row.id));
 assert.throws(()=>f.members.prepare("INSERT OR REPLACE INTO welcome_reconciliation_events SELECT * FROM welcome_reconciliation_events WHERE id=?").run(row.id));
 assert.equal(f.count('welcome_reconciliation_events'),1);
});
test('proof canonicalization fails closed on malformed evidence or session binding',async()=>{
 assert.throws(()=>welcomeReconciliationProofValue());
 const evidence={intentId:'550e8400-e29b-41d4-a716-446655440000',intentState:'UNKNOWN',
  providerId,providerStatus:'delivered',observedAt:1000};
 assert.throws(()=>welcomeReconciliationProofValue({actorId:'owner',sourceDatabase:'source',sessionBinding:'x',evidence,issuedAt:1000,expiresAt:1050,nonce:'a'.repeat(32)}));
 assert.throws(()=>welcomeReconciliationProofValue({actorId:'owner',sourceDatabase:'source',sessionBinding:'x'.repeat(64),evidence:{...evidence,body:'secret'},issuedAt:1000,expiresAt:1050,nonce:'a'.repeat(32)}));
});
