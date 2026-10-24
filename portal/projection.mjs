const receipts = new WeakSet();
export function requireProjectionReceipt(receipt,id,at) {
 if (!receipts.has(receipt) || receipt.invitationId!==id || receipt.verifiedAt>at || at-receipt.verifiedAt>60) throw Error('projection unconfirmed');
}
// Offline-only adapter. No network methods or Cloudflare credentials.
export function createOfflineProjection({failWrite=false,failRead=false}={}) {
 const entries=new Map();
 return {
  async project(entry) {
   if (failWrite) throw Error('offline projection write failure');
   entries.set(entry.memberId,{...entry});
  },
  async readback() {
   if (failRead) throw Error('offline projection read failure');
   return [...entries.values()].map(x=>({...x}));
  },
  async remove(memberId) { entries.delete(memberId); }
 };
}
export async function desiredProjection(db,at=Math.floor(Date.now()/1000)) {
 const {results}=await db.prepare(`SELECT m.id AS memberId,m.recipient,i.id AS invitationId
  FROM members m LEFT JOIN invitations i ON i.member_id=m.id AND i.status IN ('blocked','projected','delivered') AND i.expires_at>?
  WHERE m.status='active' OR (m.status='pending' AND i.id IS NOT NULL)`).bind(at).all();
 return results;
}
export function reconciliationDiff(desired,effective) {
 const differences=[], seen=new Set(), expected=new Map(desired.map(x=>[x.memberId,x]));
 for (const entry of effective) {
  const want=expected.get(entry.memberId);
  if (seen.has(entry.memberId)) differences.push({kind:'duplicate',memberId:entry.memberId});
  seen.add(entry.memberId);
  if (!want) differences.push({kind:'extra',memberId:entry.memberId});
  else if (entry.recipient!==want.recipient || entry.invitationId!==want.invitationId) differences.push({kind:'mismatch',memberId:entry.memberId});
 }
 for (const want of desired) if (!seen.has(want.memberId)) differences.push({kind:'missing',memberId:want.memberId});
 return {mode:'OFFLINE DRY RUN',desiredCount:desired.length,effectiveCount:effective.length,differences};
}
export async function projectAndReadback(db,adapter,invitationId,at=Math.floor(Date.now()/1000)) {
 const desired=(await desiredProjection(db,at)).sort((a,b)=>a.memberId.localeCompare(b.memberId)), entry=desired.find(x=>x.invitationId===invitationId);
 if (!entry) throw Error('live invitation required');
 await adapter.project(entry);
 const effective=await adapter.readback();
 // Full effective policy inventory is required; no partial/group-only snapshot.
 const diff=reconciliationDiff(desired,effective);
 const readAgain=(await desiredProjection(db,at)).sort((a,b)=>a.memberId.localeCompare(b.memberId));
 if (JSON.stringify(desired)!==JSON.stringify(readAgain) || diff.differences.length) throw Error('projection drift');
 const receipt=Object.freeze({id:crypto.randomUUID(),invitationId,confirmed:true,verifiedAt:at}); receipts.add(receipt); return receipt;
}

export async function reconcileInvitation(repo,db,adapter,actor,invitationId,at) {
 let receipt;
 try { receipt=await projectAndReadback(db,adapter,invitationId,at); }
 catch {
  await repo.recordProjectionAttempt(actor,invitationId,'failed-or-drift');
  throw Error('projection blocked');
 }
 await repo.confirmProjection(actor,invitationId,receipt);
 await repo.recordProjectionAttempt(actor,invitationId,'confirmed');
 return receipt;
}
