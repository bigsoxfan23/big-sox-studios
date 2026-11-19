// Source-only OTP admission. Caller must authenticate with the existing runtime
// OTP authenticator on EVERY protected request, not only on the first login.
// A simulated welcome is never activation authority. No service grant is issued.
import {requireOtpIdentity} from './otp-identity.mjs';
import {normalizeEmail} from './identity.mjs';
const deny=()=>{throw Error('Approved Member sign-in unavailable.');};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
export function createApprovedMemberAdmission({memberDb,requestDb,sourceDatabase,now=()=>Math.floor(Date.now()/1000)}={}) {
 if(!memberDb?.prepare||!memberDb?.batch||!requestDb?.prepare||!id(sourceDatabase)||typeof now!=='function')deny();
 const q=(sql,...args)=>memberDb.prepare(sql).bind(...args);
 function clock(identity){const at=now();if(!Number.isSafeInteger(at)||at<0)deny();requireOtpIdentity(identity,at);if(identity.provider!=='otp')deny();return at;}
 const eligibility=`m.role='member' AND m.status IN ('pending','active') AND o.source_database=?
  AND o.jellyfin_ready_at IS NOT NULL AND w.mode='live' AND w.state='accepted'
  AND w.member_id=m.id AND w.recipient=m.recipient AND w.onboarding_revision=o.revision
  AND NOT EXISTS(SELECT 1 FROM member_approval_holds h
   WHERE h.source_database=o.source_database AND h.request_id=o.request_id)`;
 const joins=`members m JOIN member_onboarding o ON o.member_id=m.id
  JOIN welcome_intents w ON w.source_database=o.source_database AND w.request_id=o.request_id`;
 async function candidate(identity) {
  clock(identity);
  const row=await q(`SELECT m.id,m.recipient,m.role,m.status,o.request_id,o.request_revision,o.revision,w.id AS welcome_id
   FROM ${joins} WHERE ${eligibility} AND m.recipient=?`,sourceDatabase,identity.subject).first();
  clock(identity);if(!row||row.recipient!==identity.subject)deny();return row;
 }
 async function approved(row,identity) {
  clock(identity);
  const request=await requestDb.prepare('SELECT email,status,revision,pii_cleared_at FROM membership_requests WHERE id=?').bind(row.request_id).first();
  clock(identity);let email;try{email=normalizeEmail(request?.email);}catch{deny();}
  if(request.status!=='approved'||request.pii_cleared_at!==null||request.revision<row.request_revision||email!==row.recipient)deny();
 }
 async function bound(row,identity) {
  clock(identity);await approved(row,identity);
  const result=await q(`SELECT m.id,m.recipient,m.role,m.status FROM ${joins}
   JOIN identities i ON i.member_id=m.id WHERE ${eligibility} AND m.id=? AND m.status='active'
   AND i.provider='otp' AND i.subject=? AND m.recipient=? AND unixepoch('now')<?`,
   sourceDatabase,row.id,identity.subject,identity.subject,identity.expiresAt).first();
  clock(identity);if(!result)deny();return Object.freeze({...result});
 }
 return Object.freeze({async admit(identity) {
  clock(identity);const row=await candidate(identity);await approved(row,identity);
  if(row.status==='active')return bound(row,identity);
  // Existing identities are not silently linked by email; this is only a first
  // OTP binding for an already approved, manually prepared pending Member.
  const occupied=await q('SELECT member_id FROM identities WHERE member_id=? OR (provider=\'otp\' AND subject=?) LIMIT 1',row.id,identity.subject).first();
  clock(identity);if(occupied)deny();const at=clock(identity);
  const guard=`SELECT m.id FROM ${joins} WHERE ${eligibility} AND m.id=? AND m.recipient=?
   AND m.status=? AND o.request_id=? AND o.revision=? AND w.id=? AND unixepoch('now')<?`;
  const args=status=>[sourceDatabase,row.id,identity.subject,status,row.request_id,row.revision,row.welcome_id,identity.expiresAt];
  try {
   await memberDb.batch([
    q(`INSERT INTO identities(provider,subject,member_id,bound_at) VALUES('otp',?,(${guard}
     AND NOT EXISTS(SELECT 1 FROM identities WHERE member_id=m.id)),?)`,identity.subject,...args('pending'),at),
    q(`UPDATE members SET status='active' WHERE id=(${guard})
     AND EXISTS(SELECT 1 FROM identities WHERE member_id=members.id AND provider='otp' AND subject=?)`,...args('pending'),identity.subject),
    // Mandatory NOT NULL/FK audit forces the whole batch to roll back if the
    // session or eligibility changes between the binding and activation steps.
    q(`INSERT INTO audit_events(actor_id,member_id,artifact_id,action,at) VALUES(?,(${guard}
     AND EXISTS(SELECT 1 FROM identities WHERE member_id=m.id AND provider='otp' AND subject=?)),?,'first-approved-login',?)`,
     row.id,...args('active'),identity.subject,row.welcome_id,at)
   ]);
  }catch {
   // A concurrent successful first login may have won. Only a fresh complete
   // authorization read can turn that conflict into an idempotent success.
   return bound(row,identity);
  }
  return bound(row,identity);
 }});
}
