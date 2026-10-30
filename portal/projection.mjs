import {createAccessPolicyReader} from './access-policy-readback.mjs';
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

// Live readback never changes Access. This separate path cannot upgrade an
// offline preflight/caller-supplied receipt into live authorization.
export function createLiveProjection(options={}) {
 const now=options.now??(()=>Math.floor(Date.now()/1000));
 const reader=createAccessPolicyReader({...options,now});
 const sorted=rows=>rows.sort((a,b)=>a.memberId.localeCompare(b.memberId));
 const owners=async db=>{
  const rows=(await db.prepare("SELECT recipient FROM members WHERE role='owner' AND status='active'").all()).results;
  if(!Array.isArray(rows)||rows.length!==1)throw Error('Access policy readback unavailable');
  return rows[0].recipient;
 };
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 function contactsMatch(rows,contacts){
  const actual=rows.map(x=>x.recipient).sort();
  if(new Set(actual).size!==actual.length||!same(actual,contacts))throw Error('Access policy readback unavailable');
 }
 const result={
  // Safe to execute before the one approved invitation is issued. Does not
  // create a pending member, invitation, audit or usable projection receipt.
  async preflight(db){
   const at=now(),owner=await owners(db),before=sorted(await desiredProjection(db,at));
   const snapshot=await reader.read(owner);
   const expected=before.filter(x=>x.recipient!==options.recipient);
   expected.push({recipient:options.recipient});contactsMatch(expected,snapshot.contacts);
   const after=sorted(await desiredProjection(db,now()));
   if(!same(before,after)||await owners(db)!==owner)throw Error('Access policy readback unavailable');
   return Object.freeze({ready:true,verifiedAt:snapshot.verifiedAt});
  },
  async project(db,invitationId){
   const at=now(),owner=await owners(db),before=sorted(await desiredProjection(db,at));
   if(!before.some(x=>x.invitationId===invitationId&&x.recipient===options.recipient))throw Error('Access policy readback unavailable');
   const snapshot=await reader.read(owner);contactsMatch(before,snapshot.contacts);
   const after=sorted(await desiredProjection(db,now()));
   if(!same(before,after)||await owners(db)!==owner||now()-snapshot.verifiedAt>15||now()<snapshot.verifiedAt)throw Error('Access policy readback unavailable');
   const receipt=Object.freeze({id:crypto.randomUUID(),invitationId,confirmed:true,verifiedAt:snapshot.verifiedAt});
   receipts.add(receipt);return receipt;
  }
 };
 return Object.freeze(result);
}
