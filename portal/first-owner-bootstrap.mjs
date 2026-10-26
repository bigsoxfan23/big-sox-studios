// Source-only factory: no live verifier or deployed entrypoint.
import {createOtpAuthenticator} from './otp-identity.mjs';

const need=value=>{if(!value) throw Error('bootstrap denied');};
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const hex=value=>typeof value==='string' && value.length===64 && /^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function createFirstOwnerBootstrap({mode,target,verifyAccess,verifyPolicy,verifyOwnerApproval,now=()=>Date.now()}={}) {
 const authenticate=createOtpAuthenticator({verifyAccess,now});
 // Snapshot configuration so a callback cannot change the approved target.
 const intended=Object.freeze({...target});
 return async function bootstrap(request,env,ctx,{commit=false,expectedConfirmationDigest,confirmationExpiresAt}={}) {
  need(['offline-test','staging-enrollment-source'].includes(mode) && env?.PORTAL_MODE===mode && env.DB);
  need(typeof verifyPolicy==='function' && typeof verifyOwnerApproval==='function' && verifyPolicy!==verifyOwnerApproval);
  need(intended.role==='owner' && typeof intended.recipient==='string' && id(intended.databaseId) &&
   id(intended.revision) && typeof intended.nonce==='string' && /^[A-Za-z0-9_-]{32,128}$/.test(intended.nonce));
  need(env.BOOTSTRAP_DATABASE_ID===intended.databaseId && typeof commit==='boolean');
  const url=new URL(request.url);
  need(request.method==='POST' && url.pathname==='/' && !url.search);
  const jwt=request.headers.get('Cf-Access-Jwt-Assertion');
  need(typeof jwt==='string' && jwt.length>0 && jwt.length<16384);
  const identity=await authenticate(request,env,ctx);
  need(identity.subject===intended.recipient); // exact OTP namespace, never normalize/link/promote
  const sessionDigest=await digest(jwt);
  const context=Object.freeze({provider:'otp',subject:identity.subject,runtimeType:'onetimepin',role:'owner',
   issuer:env.ACCESS_ISSUER,audience:env.ACCESS_AUDIENCE,origin:env.APP_ORIGIN,
   databaseId:intended.databaseId,revision:intended.revision,nonce:intended.nonce,sessionDigest});
  const contextDigest=await digest(JSON.stringify(context));
  const challenge=Object.freeze({...context,contextDigest});
  // Separate trusted server adapters must independently verify external evidence.
  // Neither callback may accept browser/env booleans or sign the challenge on demand.
  const policy=Object.freeze({...await verifyPolicy(challenge)});
  const approval=Object.freeze({...await verifyOwnerApproval(Object.freeze({...challenge,policyDigest:policy.policyDigest}))});
  const confirmationDigest=await digest(JSON.stringify([contextDigest,policy.policyDigest,approval.approvalDigest,approval.auditId]));
  const time=()=>{const at=Math.floor(now()/1000);need(Number.isSafeInteger(at) && at>=0);return at;};
  const fresh=(proof,at)=>Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt>=0 && proof.verifiedAt<=at &&
   Number.isSafeInteger(proof.expiresAt) && proof.expiresAt>at && proof.expiresAt<=proof.verifiedAt+300;
  const valid=()=>{
   const at=time();
   if (expectedConfirmationDigest!==undefined) need(hex(expectedConfirmationDigest) && expectedConfirmationDigest===confirmationDigest);
   if (confirmationExpiresAt!==undefined) need(Number.isSafeInteger(confirmationExpiresAt) && confirmationExpiresAt>at);
   need(identity.expiresAt>at && fresh(policy,at) && fresh(approval,at));
   need(policy.source==='cloudflare-effective-policy-readback' && policy.independentMfaRequired===true &&
    policy.enforcementVerified===true && policy.otpIdentityShapeVerified===true && policy.contextDigest===contextDigest && hex(policy.policyDigest));
   need(approval.source==='independent-explicit-owner-approval' && approval.decision==='approve-first-owner' &&
    approval.approvalCount===1 && approval.contextDigest===contextDigest && approval.policyDigest===policy.policyDigest &&
    hex(approval.approvalDigest) && id(approval.auditId));
   return at;
  };
  valid();
  // Read-only default; SQL repeats pristine-state checks under the write lock.
  const state=await env.DB.prepare(`SELECT
   (SELECT count(*) FROM members)+(SELECT count(*) FROM identities)+(SELECT count(*) FROM audit_events)+
   (SELECT count(*) FROM invitations)+(SELECT count(*) FROM link_requests)+(SELECT count(*) FROM revocations)+
   (SELECT count(*) FROM service_grants)+(SELECT count(*) FROM revocation_tasks)+(SELECT count(*) FROM projection_attempts)+
   (SELECT count(*) FROM first_owner_bootstrap) AS records`).first();
  need(state?.records===0);
  const at=valid(); // recheck both attestations and the same JWT after the D1 await
  if (!commit) return Object.freeze({ready:true,committed:false,contextDigest,confirmationDigest});
  const memberId=crypto.randomUUID();
  // One statement + triggers: receipt, exact binding, active Owner and audit all
  // commit or roll back together. No pre-existing person can be promoted.
  await env.DB.prepare(`INSERT INTO first_owner_bootstrap
   (slot,nonce,member_id,subject,database_id,revision,session_digest,context_digest,policy_digest,approval_digest,approval_audit_id,at,expires_at)
   VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(intended.nonce,memberId,identity.subject,intended.databaseId,intended.revision,
   sessionDigest,contextDigest,policy.policyDigest,approval.approvalDigest,approval.auditId,at,
   Math.min(identity.expiresAt,policy.expiresAt,approval.expiresAt)).run();
  // A readback failure can follow a successful commit: inspect, never retry blindly.
  const verified=await env.DB.prepare(`SELECT m.id FROM first_owner_bootstrap b
   JOIN members m ON m.id=b.member_id JOIN identities i ON i.member_id=m.id
   JOIN audit_events a ON a.member_id=m.id AND a.artifact_id=b.nonce
   WHERE b.slot=1 AND b.context_digest=? AND b.approval_digest=? AND m.id=?
   AND m.role='owner' AND m.status='active' AND m.recipient=?
   AND i.provider='otp' AND i.subject=? AND a.action='first-owner-bootstrap'`).bind(
   contextDigest,approval.approvalDigest,memberId,identity.subject,identity.subject).first();
  if (verified?.id!==memberId) throw Error('bootstrap commit requires inspection; do not retry');
  return Object.freeze({ready:true,committed:true,contextDigest,memberId});
 };
}
