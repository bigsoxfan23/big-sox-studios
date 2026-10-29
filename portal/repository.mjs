import {normalizeEmail, requireIdentity} from './identity.mjs';
import {requireProjectionReceipt} from './projection.mjs';
import {authorizeMember} from './authorization.mjs';
const encoder = new TextEncoder();
const clock = () => Math.floor(Date.now()/1000);
const checkTime = now => { if (!Number.isSafeInteger(now) || now < 0) throw Error('invalid server time'); return now; };
export async function digestSecret(secret) {
 if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw Error('invalid proof');
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(secret)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function equalDigest(a,b) {
 if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
 let diff=0; for (let i=0;i<64;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i); return diff===0;
}
export function createRepository(db, {now=clock}={}) {
 const stmt = (sql,...args) => db.prepare(sql).bind(...args);
 const time = () => checkTime(now());
 const owner = async actor => {
  if (!await stmt("SELECT id FROM members WHERE id=? AND role='owner' AND status='active'",actor).first()) throw Error('owner required');
 };
 const changed = result => { if (!result?.id) throw Error('state conflict'); };
 async function expire() {
  const at=time();
  await stmt("UPDATE invitations SET status='expired',digest=NULL,changed_at=?,actor_id='system-expiry' WHERE expires_at<=? AND status IN ('blocked','projected','delivered')",at,at).run();
 }
 async function lookup(identity) {
  requireIdentity(identity,time());
  // One statement/snapshot for live status, role, binding and service grants.
  const row = await stmt(`SELECT m.id,m.status,m.role,COALESCE(json_group_array(g.service) FILTER(WHERE g.service IS NOT NULL),'[]') AS grants
   FROM identities i JOIN members m ON m.id=i.member_id LEFT JOIN service_grants g ON g.member_id=m.id
   WHERE i.provider=? AND i.subject=? GROUP BY m.id`,identity.provider,identity.subject).first();
  return row ? {...row,grants:JSON.parse(row.grants)} : null;
 }
 return {
  lookup, expire,
  async authorize(identity,service) { return authorizeMember(await lookup(identity),service); },
  async createPending(actor,email) {
   await owner(actor); const at=time(), id=crypto.randomUUID(), recipient=normalizeEmail(email);
   await db.batch([
    stmt("INSERT INTO members(id,recipient,role,status,created_at) SELECT ?,?,'member','pending',? WHERE EXISTS(SELECT 1 FROM members WHERE id=? AND status='active' AND role='owner')",id,recipient,at,actor),
    stmt("INSERT INTO audit_events(actor_id,member_id,action,at) VALUES(?,?,'membership-approved',?)",actor,id,at)
   ]); return id;
  },
  async issue(actor,memberId) {
   await owner(actor); const at=time();
   const member=await stmt("SELECT recipient FROM members WHERE id=? AND status='pending'",memberId).first();
   if (!member) throw Error('pending member required');
   const last=await stmt('SELECT id,revision FROM invitations WHERE member_id=? ORDER BY revision DESC LIMIT 1',memberId).first();
   const bytes=crypto.getRandomValues(new Uint8Array(32));
   const secret=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
   const id=crypto.randomUUID(), digest=await digestSecret(secret);
   // Single SQL statement + triggers: CAS predecessor, supersede, insert and audit
   // roll back together. A concurrent stale writer must retry explicitly.
   await stmt(`INSERT INTO invitations(id,member_id,recipient,issuer_id,revision,predecessor_id,digest,created_at,expires_at,changed_at,actor_id,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'blocked')`,id,memberId,member.recipient,actor,(last?.revision??0)+1,last?.id??null,digest,at,at+604800,at,actor).run();
   // Sensitive result: ephemeral custody only; never log/serialize to tracking.
   return {id,secret,expiresAt:at+604800};
  },
  async recordProjectionAttempt(actor,id,outcome) {
   await owner(actor);
   if (!['failed-or-drift','confirmed'].includes(outcome)) throw Error('invalid outcome');
   await stmt(`INSERT INTO projection_attempts(invitation_id,actor_id,outcome,at)
    SELECT id,?,?,? FROM invitations WHERE id=? AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')`,actor,outcome,time(),id,actor).run();
  },
  async confirmProjection(actor,id,receipt) {
   await owner(actor); const at=time();
   // Keep the branded readback time; confirmation must not restart freshness.
   requireProjectionReceipt(receipt,id,at);
   changed(await stmt(`UPDATE invitations SET status='projected',projection_receipt=?,projected_at=?,changed_at=?,actor_id=? WHERE id=? AND status='blocked' AND expires_at>?
    AND EXISTS(SELECT 1 FROM members WHERE id=invitations.member_id AND status='pending')
    AND EXISTS(SELECT 1 FROM members WHERE id=? AND status='active' AND role='owner') RETURNING id`,receipt.id,receipt.verifiedAt,at,actor,id,at,actor).first());
  },
  async confirmOwnerDelivery(actor,id) {
   await owner(actor); const at=time();
   changed(await stmt(`UPDATE invitations SET status='delivered',delivered_at=?,delivery_channel='owner-private-channel',changed_at=?,actor_id=? WHERE id=? AND status='projected' AND expires_at>? AND projected_at BETWEEN ? AND ?
    AND EXISTS(SELECT 1 FROM members WHERE id=invitations.member_id AND status='pending')
    AND EXISTS(SELECT 1 FROM members WHERE id=? AND status='active' AND role='owner') RETURNING id`,at,at,actor,id,at,at-60,at,actor).first());
  },
  async claim(id,secret,identity) {
   const at=time(); requireIdentity(identity,at); await expire();
   const digest=await digestSecret(secret);
   const invite=await stmt("SELECT digest,recipient FROM invitations WHERE id=? AND status='delivered' AND expires_at>?",id,at).first();
   if (!invite || !equalDigest(invite.digest,digest) || invite.recipient!==identity.email) throw Error('claim denied');
   changed(await stmt(`UPDATE invitations SET status='claimed',digest=NULL,claim_provider=?,claim_subject=?,claimed_at=?,changed_at=?,actor_id=member_id
    WHERE id=? AND digest=? AND recipient=? AND status='delivered' AND expires_at>? RETURNING id`,identity.provider,identity.subject,at,at,id,digest,identity.email,at).first());
  },
  async requestLink(current,candidate) {
   const at=time(); requireIdentity(current,at); requireIdentity(candidate,at);
   const member=await lookup(current); if (!authorizeMember(member)) throw Error('active binding required');
   if (Math.min(current.expiresAt,candidate.expiresAt)<at+900) throw Error('fresh verification required');
   const id=crypto.randomUUID();
   await stmt(`INSERT INTO link_requests(id,member_id,current_provider,current_subject,candidate_provider,candidate_subject,verified_at,expires_at,status)
    VALUES(?,?,?,?,?,?,?,?,'requested')`,id,member.id,current.provider,current.subject,candidate.provider,candidate.subject,at,at+900).run(); return id;
  },
  async approveLink(actor,id) {
   await owner(actor); const at=time();
   changed(await stmt("UPDATE link_requests SET status='approved',approved_by=?,approved_at=? WHERE id=? AND status='requested' AND expires_at>? RETURNING id",actor,at,id,at).first());
  },
  async commitLink(actor,id) {
   await owner(actor); const at=time();
   changed(await stmt("UPDATE link_requests SET status='committed',committed_at=? WHERE id=? AND status='approved' AND approved_by=? AND expires_at>? RETURNING id",at,id,actor,at).first());
  },
  async cancelInvitation(actor,invitationId) {
   await owner(actor); const at=time();
   if(typeof invitationId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(invitationId)) throw Error('invalid invitation');
   // D1 transition trigger retains immutable history and clears the claim digest.
   const row=await stmt(`UPDATE invitations SET status='revoked',digest=NULL,changed_at=?,actor_id=?
    WHERE id=? AND status IN ('blocked','projected','delivered')
    AND EXISTS(SELECT 1 FROM members m WHERE m.id=invitations.member_id AND m.status='pending')
    AND EXISTS(SELECT 1 FROM members m WHERE m.id=? AND m.status='active' AND m.role='owner')
    RETURNING id`,at,actor,invitationId,actor).first();
   changed(row);
  },
  async revoke(actor,memberId) {
   await owner(actor); const at=time();
   await stmt('INSERT INTO revocations(id,member_id,actor_id,at) VALUES(?,?,?,?)',crypto.randomUUID(),memberId,actor,at).run();
  }
 };
}
