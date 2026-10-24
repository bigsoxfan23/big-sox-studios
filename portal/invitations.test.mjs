import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,epoch} from './test-support.mjs';
import {digestSecret,equalDigest} from './repository.mjs';
import {normalizeEmail} from './identity.mjs';
import {createOfflineProjection,desiredProjection,projectAndReadback,reconciliationDiff} from './projection.mjs';

test('OFFLINE: careful email normalization and fixed length digest comparison',async()=>{
 assert.equal(normalizeEmail('First.Last+tag@EXAMPLE.TEST'),'First.Last+tag@example.test');
 for(const value of [' a@example.test','a@example.test ','a..b@example.test','a@localhost','ü@example.test','a@-example.test']) assert.throws(()=>normalizeEmail(value));
 const digest=await digestSecret('a'.repeat(43)); assert.equal(digest.length,64);
 assert.equal(equalDigest(digest,digest),true); assert.equal(equalDigest(digest,'f'.repeat(64)),false); assert.equal(equalDigest(null,null),false);
});
test('OFFLINE: D1 first, blocked until projection readback and owner delivery, digest-only single use',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.repo.issue('owner',id), identity=await f.identity();
 const row=await f.db.prepare('SELECT * FROM invitations WHERE id=?').bind(invite.id).first();
 assert.equal(row.status,'blocked'); assert.equal(row.expires_at-row.created_at,604800);
 assert.equal(row.digest,await digestSecret(invite.secret)); assert.ok(!JSON.stringify(row).includes(invite.secret));
 await assert.rejects(f.repo.claim(invite.id,invite.secret,identity));
 await assert.rejects(f.repo.confirmOwnerDelivery('owner',invite.id));
 const receipt=await projectAndReadback(f.db,f.adapter,invite.id,epoch);
 await f.repo.confirmProjection('owner',invite.id,receipt);
 await assert.rejects(f.repo.claim(invite.id,invite.secret,identity));
 await f.repo.confirmOwnerDelivery('owner',invite.id);
 await f.repo.claim(invite.id,invite.secret,identity);
 assert.equal(await f.repo.authorize(identity),true);
 await assert.rejects(f.repo.claim(invite.id,invite.secret,identity));
 assert.equal((await f.db.prepare('SELECT digest FROM invitations WHERE id=?').bind(invite.id).first()).digest,null);
});
for(const failure of ['failWrite','failRead']) test(`OFFLINE: projection ${failure} retains unclaimable D1 record; retry/reconciliation`,async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.repo.issue('owner',id);
 const adapter=createOfflineProjection({[failure]:true});
 await assert.rejects(projectAndReadback(f.db,adapter,invite.id,epoch));
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'blocked');
 await assert.rejects(f.repo.claim(invite.id,invite.secret,await f.identity()));
 const desired=await desiredProjection(f.db,epoch);
 const diff=reconciliationDiff(desired,await f.adapter.readback()); assert.equal(diff.differences[0].kind,'missing');
 await f.repo.confirmProjection('owner',invite.id,await projectAndReadback(f.db,f.adapter,invite.id,epoch));
 assert.deepEqual(reconciliationDiff(desired,await f.adapter.readback()).differences,[]);
});
test('OFFLINE: drift detects extras, missing, duplicates and mismatches without contact details',()=>{
 const desired=[{memberId:'one',recipient:'one@example.test',invitationId:'i1'},{memberId:'two',recipient:'two@example.test',invitationId:'i2'}];
 const diff=reconciliationDiff(desired,[{memberId:'one',recipient:'wrong@example.test'},{memberId:'one'},{memberId:'extra'}]);
 assert.deepEqual(new Set(diff.differences.map(x=>x.kind)),new Set(['mismatch','duplicate','extra','missing']));
 assert.ok(!JSON.stringify(diff).includes('@'));
});
test('OFFLINE PROXY P3: exact expiry boundary persists history and denies claim',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id);
 f.time(epoch+604800);
 await assert.rejects(f.repo.claim(invite.id,invite.secret,await f.identity()));
 const row=await f.db.prepare('SELECT status,digest FROM invitations WHERE id=?').bind(invite.id).first();
 assert.deepEqual(row,{status:'expired',digest:null});
 assert.equal((await f.db.prepare('SELECT status FROM members WHERE id=?').bind(id).first()).status,'pending');
 assert.equal(await f.repo.authorize(await f.identity()),false);
});
test('OFFLINE: simultaneous issue/reissue preserves one live invite; stale CAS fails',async t=>{
 const f=await fixture(t), id=await f.pending();
 for(let round=0;round<2;round++) {
  const results=await Promise.allSettled(Array.from({length:8},()=>f.repo.issue('owner',id)));
  assert.ok(results.some(x=>x.status==='fulfilled'));
  assert.equal((await f.db.prepare("SELECT count(*) n FROM invitations WHERE member_id=? AND status IN ('blocked','projected','delivered')").bind(id).first()).n,1);
 }
 const old=await f.repo.issue('owner',id), next=await f.repo.issue('owner',id);
 await assert.rejects(f.repo.claim(old.id,old.secret,await f.identity()));
 assert.notEqual(old.secret,next.secret);
 const current=await f.db.prepare('SELECT * FROM invitations WHERE id=?').bind(next.id).first();
 await assert.rejects(f.db.prepare("INSERT INTO invitations(id,member_id,recipient,issuer_id,revision,predecessor_id,digest,created_at,expires_at,changed_at,actor_id,status) VALUES(?,?,?,?,?,?,?,?,?,?,'owner','blocked')")
  .bind('stale',id,current.recipient,'owner',current.revision,current.predecessor_id,'a'.repeat(64),epoch,epoch+604800,epoch).run());
 const index=await f.db.prepare("SELECT sql FROM sqlite_master WHERE name='one_live_invite'").first(); assert.match(index.sql,/UNIQUE INDEX/);
});
test('OFFLINE: reissue rollback retains old live invite if new insert fails; terminal states cannot resurrect',async t=>{
 const f=await fixture(t), id=await f.pending(), old=await f.ready(id);
 // Force failure after supersession trigger via digest uniqueness on another row.
 const other=await f.pending('other@example.test'), otherInvite=await f.repo.issue('owner',other);
 const digest=await digestSecret(otherInvite.secret);
 await assert.rejects(f.db.prepare("INSERT INTO invitations(id,member_id,recipient,issuer_id,revision,predecessor_id,digest,created_at,expires_at,changed_at,actor_id,status) VALUES(?,?,'person@example.test','owner',2,?,?,?,?,?,'owner','blocked')")
  .bind('rollback',id,old.id,digest,epoch,epoch+604800,epoch).run());
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(old.id).first()).status,'delivered');
 await f.repo.revoke('owner',id);
 await assert.rejects(f.repo.issue('owner',id));
 await assert.rejects(f.db.prepare("UPDATE invitations SET status='blocked',digest=? WHERE id=?").bind('b'.repeat(64),old.id).run());
 await assert.rejects(f.db.prepare("UPDATE members SET status='pending' WHERE id=?").bind(id).run());
});
test('OFFLINE: concurrent claim is single-use and identity collision rolls back claim completely',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id), identity=await f.identity();
 const results=await Promise.allSettled(Array.from({length:8},()=>f.repo.claim(invite.id,invite.secret,identity)));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await f.db.prepare('SELECT count(*) n FROM identities').first()).n,1);
 const other=await f.pending('other@example.test'), second=await f.ready(other), collision=await f.identity('google','subject-one','other@example.test');
 await assert.rejects(f.repo.claim(second.id,second.secret,collision));
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(second.id).first()).status,'delivered');
 assert.equal((await f.db.prepare('SELECT status FROM members WHERE id=?').bind(other).first()).status,'pending');
});
test('OFFLINE: claim vs reissue never leaves active member with claimable invite',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id), identity=await f.identity();
 await Promise.allSettled([f.repo.claim(invite.id,invite.secret,identity),f.repo.issue('owner',id)]);
 const member=await f.db.prepare('SELECT status FROM members WHERE id=?').bind(id).first();
 const live=await f.db.prepare("SELECT count(*) n FROM invitations WHERE member_id=? AND status IN ('blocked','projected','delivered')").bind(id).first();
 if(member.status==='active') assert.equal(live.n,0); else assert.equal(live.n,1);
});
test('OFFLINE: shared contact cannot create a second membership; non-owner cannot issue',async t=>{
 const f=await fixture(t), id=await f.pending();
 await assert.rejects(f.pending());
 await assert.rejects(f.repo.issue(id,id));
 assert.equal((await f.db.prepare('SELECT count(*) n FROM members').first()).n,2);
});
test('OFFLINE: partial unique index independently forbids a second live invite',async t=>{
 const f=await fixture(t), id=await f.pending(); await f.repo.issue('owner',id);
 // Isolate the index from the stronger CAS trigger in this disposable DB.
 await f.db.prepare('DROP TRIGGER issue_guard').run();
 await assert.rejects(f.db.prepare(`INSERT INTO invitations(id,member_id,recipient,issuer_id,revision,digest,created_at,expires_at,changed_at,actor_id,status)
  VALUES('duplicate',?,'person@example.test','owner',2,?,?,?,?,'owner','blocked')`).bind(id,'f'.repeat(64),epoch,epoch+604800,epoch).run(),/UNIQUE constraint failed/);
});
test('OFFLINE: claim one second before expiry succeeds; expired reissue gets fresh TTL and keeps audit',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.ready(id);
 f.time(epoch+604799); await f.repo.claim(invite.id,invite.secret,await f.identity());
 const other=await f.pending('other@example.test'), old=await f.repo.issue('owner',other);
 f.time(epoch+1209599); const fresh=await f.repo.issue('owner',other);
 assert.equal(fresh.expiresAt,epoch+1814399);
 const row=await f.db.prepare('SELECT status,digest FROM invitations WHERE id=?').bind(old.id).first();
 assert.deepEqual(row,{status:'expired',digest:null});
 assert.equal((await f.db.prepare("SELECT count(*) n FROM audit_events WHERE artifact_id=? AND action='expired'").bind(old.id).first()).n,1);
});
test('OFFLINE: delayed owner delivery cannot rely on stale projection readback',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.repo.issue('owner',id);
 await f.repo.confirmProjection('owner',invite.id,await projectAndReadback(f.db,f.adapter,invite.id,epoch));
 f.time(epoch+61); await assert.rejects(f.repo.confirmOwnerDelivery('owner',invite.id));
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'projected');
});

// Each fixture is an ephemeral workerd D1 database; readback always occurs at T+0.
for (const deliveryAt of [60,61,118]) test(`OFFLINE: T+59 confirmation preserves T+0 readback for T+${deliveryAt} delivery`,async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.repo.issue('owner',id);
 const receipt=await projectAndReadback(f.db,f.adapter,invite.id,epoch);
 f.time(epoch+59); await f.repo.confirmProjection('owner',invite.id,receipt);
 const before=await f.db.prepare('SELECT * FROM invitations WHERE id=?').bind(invite.id).first();
 assert.equal(before.projected_at,receipt.verifiedAt); assert.equal(before.changed_at,epoch+59);
 const audit=await f.db.prepare('SELECT * FROM audit_events ORDER BY id').all();
 f.time(epoch+deliveryAt);
 if(deliveryAt===60) {
  await f.repo.confirmOwnerDelivery('owner',invite.id);
  const row=await f.db.prepare('SELECT status,projected_at,delivered_at FROM invitations WHERE id=?').bind(invite.id).first();
  assert.deepEqual(row,{status:'delivered',projected_at:epoch,delivered_at:epoch+60});
 } else {
  await assert.rejects(f.repo.confirmOwnerDelivery('owner',invite.id),/state conflict/);
  assert.deepEqual(await f.db.prepare('SELECT * FROM invitations WHERE id=?').bind(invite.id).first(),before);
  assert.deepEqual(await f.db.prepare('SELECT * FROM audit_events ORDER BY id').all(),audit);
 }
});

test('OFFLINE: late or future projection receipt cannot confirm; ordinary immediate delivery passes',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.repo.issue('owner',id);
 const receipt=await projectAndReadback(f.db,f.adapter,invite.id,epoch);
 const before=await f.db.prepare('SELECT * FROM invitations WHERE id=?').bind(invite.id).first();
 const audit=await f.db.prepare('SELECT * FROM audit_events ORDER BY id').all();
 for(const at of [epoch+61,epoch-1]) {
  f.time(at); await assert.rejects(f.repo.confirmProjection('owner',invite.id,receipt),/projection unconfirmed/);
  assert.deepEqual(await f.db.prepare('SELECT * FROM invitations WHERE id=?').bind(invite.id).first(),before);
  assert.deepEqual(await f.db.prepare('SELECT * FROM audit_events ORDER BY id').all(),audit);
 }
 f.time(epoch); await f.repo.confirmProjection('owner',invite.id,receipt);
 await f.repo.confirmOwnerDelivery('owner',invite.id);
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'delivered');
});

test('OFFLINE: SQL freshness guards atomically reject future/late confirmation and stale or retimed delivery',async t=>{
 const f=await fixture(t), id=await f.pending(), invite=await f.repo.issue('owner',id);
 const row=()=>f.db.prepare('SELECT * FROM invitations WHERE id=?').bind(invite.id).first();
 const audit=()=>f.db.prepare('SELECT * FROM audit_events ORDER BY id').all();
 async function rejected(sql,...args) {
  const before=await row(), events=await audit();
  await assert.rejects(f.db.prepare(sql).bind(...args,invite.id).run());
  assert.deepEqual(await row(),before); assert.deepEqual(await audit(),events);
 }
 const confirm="UPDATE invitations SET status='projected',projection_receipt='synthetic-receipt',projected_at=?,changed_at=? WHERE id=?";
 await rejected(confirm,epoch+1,epoch); // Future readback.
 await rejected(confirm,epoch,epoch+61); // Late confirmation bypassing JS.
 const receipt=await projectAndReadback(f.db,f.adapter,invite.id,epoch);
 f.time(epoch+59); await f.repo.confirmProjection('owner',invite.id,receipt);
 const deliver="UPDATE invitations SET status='delivered',delivery_channel='owner-private-channel',delivered_at=?,changed_at=? WHERE id=?";
 await rejected(deliver,epoch+61,epoch+61);
 await rejected(deliver,epoch+118,epoch+118);
 await rejected(deliver,epoch+60,epoch+118); // Cannot backdate delivery.
 await rejected("UPDATE invitations SET status='delivered',delivery_channel='owner-private-channel',projected_at=?,delivered_at=?,changed_at=? WHERE id=?",epoch+59,epoch+118,epoch+118);
 await rejected("UPDATE invitations SET status='delivered',delivery_channel='owner-private-channel',projection_receipt='replacement',delivered_at=?,changed_at=? WHERE id=?",epoch+60,epoch+60);
 // Clock rollback must not make a future readback eligible in repository SQL.
 f.time(epoch-1); await assert.rejects(f.repo.confirmOwnerDelivery('owner',invite.id),/state conflict/);
 f.time(epoch+60); await f.repo.confirmOwnerDelivery('owner',invite.id);
});

test('OFFLINE: replacement receipts and reissue cannot extend the original delivery window',async t=>{
 const f=await fixture(t), id=await f.pending(), old=await f.repo.issue('owner',id);
 const receipt=await projectAndReadback(f.db,f.adapter,old.id,epoch);
 f.time(epoch+59); await f.repo.confirmProjection('owner',old.id,receipt);
 f.time(epoch+61);
 const replacement=await projectAndReadback(f.db,f.adapter,old.id,f.now());
 await assert.rejects(f.repo.confirmProjection('owner',old.id,replacement),/state conflict/);
 await assert.rejects(f.repo.confirmOwnerDelivery('owner',old.id),/state conflict/);
 const fresh=await f.repo.issue('owner',id);
 for(const stale of [receipt,replacement]) await assert.rejects(f.repo.confirmProjection('owner',fresh.id,stale),/projection unconfirmed/);
 await assert.rejects(f.repo.confirmOwnerDelivery('owner',fresh.id));
 await assert.rejects(f.repo.confirmProjection('owner',old.id,replacement));
 const oldRow=await f.db.prepare('SELECT status,projected_at FROM invitations WHERE id=?').bind(old.id).first();
 assert.deepEqual(oldRow,{status:'superseded',projected_at:epoch});
 // A new invitation requires its own complete fresh reconciliation/readback.
 await f.repo.confirmProjection('owner',fresh.id,await projectAndReadback(f.db,f.adapter,fresh.id,f.now()));
 await f.repo.confirmOwnerDelivery('owner',fresh.id);
 assert.equal((await f.db.prepare('SELECT projected_at FROM invitations WHERE id=?').bind(fresh.id).first()).projected_at,epoch+61);
});
