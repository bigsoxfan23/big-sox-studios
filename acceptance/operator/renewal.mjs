// OFFLINE OPERATOR-ONLY utility. No network or Cloudflare Worker import.
// Caller must independently inspect current provider/Access/physical-D1 evidence.
import {createHmac,createHash} from 'node:crypto';
import {PINS} from '../config.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const must=x=>{if(!x)throw Error('operator preflight unavailable');};
const audience=role=>role==='owner'?PINS.ownerAudience:PINS.memberAudience;
// ONLY targets the isolated TEST preflight row. Provider attempts never reset.
export const LEASE_UPSERT_SQL=[
 'INSERT INTO acceptance_preflight_lease',
 '(role,run_id,nonce_digest,revision,generation,issued_at,expires_at,signed_token,snapshot_json,revoked)',
 'VALUES(?,?,?,?,?,?,?,?,?,0)',
 'ON CONFLICT(role) DO UPDATE SET',
 'generation=excluded.generation,issued_at=excluded.issued_at,',
 'expires_at=excluded.expires_at,signed_token=excluded.signed_token,',
 'snapshot_json=excluded.snapshot_json',
 'WHERE acceptance_preflight_lease.revoked=0',
 'AND acceptance_preflight_lease.run_id=excluded.run_id',
 'AND acceptance_preflight_lease.nonce_digest=excluded.nonce_digest',
 'AND acceptance_preflight_lease.revision=excluded.revision',
 'AND excluded.generation=acceptance_preflight_lease.generation+1',
 'AND excluded.issued_at>acceptance_preflight_lease.issued_at'
].join(' ');
export function leaseValues(row){return [row.role,row.run_id,row.nonce_digest,row.revision,
 row.generation,row.issued_at,row.expires_at,row.signed_token,row.snapshot_json];}
export function prepareOperatorLease({role,env,proof,at,generation}) {
 // These structural checks are NOT independent verification of truth.
 // An operator must verify every external readback before calling the signer.
 must((role==='owner'||role==='member') && Number.isSafeInteger(at) &&
  Number.isSafeInteger(generation) && generation>=1 && generation<=2147483647);
 must(typeof env?.ACCEPTANCE_ATTESTATION_KEY==='string' &&
  Buffer.from(env.ACCEPTANCE_ATTESTATION_KEY,'base64url').length===32 &&
  typeof env.ACCEPTANCE_RUN_NONCE==='string' &&
  Buffer.from(env.ACCEPTANCE_RUN_NONCE,'base64url').length===32);
 must(proof?.runId===env.ACCEPTANCE_RUN_ID && proof.revision===PINS.revision &&
  proof.nonceDigest===sha(env.ACCEPTANCE_RUN_NONCE) && proof.revoked===false &&
  Number.isSafeInteger(proof.observedAt) && proof.observedAt<=at &&
  proof.observedAt>=at-60 && Number.isSafeInteger(proof.expiresAt) &&
  proof.expiresAt>=at+300);
 must(proof.access?.issuer===PINS.issuer && proof.access.independentMfa===true &&
  proof.access.twoIdentityOnly===true && proof.access.memberOtp===true &&
  proof.access.ownerHost===PINS.ownerHost && proof.access.memberHost===PINS.memberHost &&
  proof.notion?.parent===PINS.parent && proof.notion.destinationOnly===true &&
  proof.resend?.sender===PINS.sender && proof.resend.sendingOnly===true &&
  proof.resend.domainLimited===true && proof.resend.zeroSpend===true &&
  proof.resend.paidFallback===false && Number.isSafeInteger(proof.resend.freeQuotaRemaining) && proof.resend.freeQuotaRemaining>=2 && proof.resend.plan==='free' &&
  proof.resend.overagesEnabled===false && proof.resend.sharedQuotaRiskAccepted===true &&
  Number.isSafeInteger(proof.resend.quotaEvidenceAt) && proof.resend.quotaEvidenceAt<=at &&
  Array.isArray(proof.bindings) && proof.bindings.length===2 &&
  proof.bindings[0].physicalId===PINS.requestsId &&
  proof.bindings[1].physicalId===PINS.membersId);
 const snapshot_json=JSON.stringify(proof);
 must(snapshot_json.length<12288);
 const signed={version:'task12-operator-v1',operator:PINS.owner,revision:PINS.revision,
  runId:env.ACCEPTANCE_RUN_ID,nonceDigest:proof.nonceDigest,
  audience:audience(role),generation,issuedAt:at,expiresAt:at+300,
  preflightDigest:sha(snapshot_json)};
 const data=Buffer.from(JSON.stringify(signed)).toString('base64url');
 const sig=createHmac('sha256',Buffer.from(env.ACCEPTANCE_ATTESTATION_KEY,'base64url'))
  .update(data).digest('base64url');
 return Object.freeze({role,run_id:env.ACCEPTANCE_RUN_ID,nonce_digest:proof.nonceDigest,
  revision:PINS.revision,generation,issued_at:at,expires_at:at+300,
  signed_token:data+'.'+sig,snapshot_json});
}
export async function applyOperatorLease({db,row}) {
 must(db && row && typeof db.prepare==='function');
 const result=await db.prepare(LEASE_UPSERT_SQL).bind(...leaseValues(row)).run();
 must(Number.isSafeInteger(result?.meta?.changes) && result.meta.changes>0);
 return {role:row.role,generation:row.generation,expiresAt:row.expires_at};
}

// One-time immutable baseline, from operator-confirmed actual Free/no-overage
// dashboard and TWO unused permitted sends. No account credentials in SQL.
// Operator must independently establish that the human owner has accepted the
// residual shared-quota risk BEFORE creating this row. No automatic retries.
export function prepareStartBudget({env,proof}) {
 const r=proof?.resend;
 must(proof?.runId===env?.ACCEPTANCE_RUN_ID &&
  proof.nonceDigest===sha(env.ACCEPTANCE_RUN_NONCE) &&
  r?.sender===PINS.sender && r?.domain===PINS.senderDomain &&
  r.domainLimited===true && r.sendingOnly===true && r.senderVerified===true &&
  r.plan==='free' && r.overagesEnabled===false && r.paidFallback===false &&
  r.zeroSpend===true && r.sharedQuotaRiskAccepted===true &&
  Number.isSafeInteger(r.quotaEvidenceAt) && Number.isSafeInteger(r.freeQuotaRemaining) &&
  r.freeQuotaRemaining>=2 && r.quotaEvidenceAt>0 &&
  r.credentialDigest===sha(env.ACCEPTANCE_SENDER_CREDENTIAL));
 const q={runId:proof.runId,nonceDigest:proof.nonceDigest,
  credentialDigest:r.credentialDigest,quotaEvidenceAt:r.quotaEvidenceAt,
  freeQuotaRemaining:r.freeQuotaRemaining,plan:r.plan,overagesEnabled:r.overagesEnabled,
  sharedQuotaRiskAccepted:r.sharedQuotaRiskAccepted,maxEmailAttempts:2};
 return Object.freeze({run_id:q.runId,nonce_digest:q.nonceDigest,credential_digest:q.credentialDigest,
  quota_evidence_digest:sha(JSON.stringify(q)),quota_observed_at:q.quotaEvidenceAt,
  free_quota_at_start:q.freeQuotaRemaining,plan:'free',overages_enabled:0,
  shared_quota_risk_accepted:1,max_email_attempts:2});
}
export async function applyStartBudget({db,row}) {
 must(db && typeof db.prepare==='function' && row);
 const result=await db.prepare(
 'INSERT INTO acceptance_send_budget VALUES(?,?,?,?,?,?,?,?,?,?)'
 ).bind(row.run_id,row.nonce_digest,row.credential_digest,row.quota_evidence_digest,
 row.quota_observed_at,row.free_quota_at_start,row.plan,row.overages_enabled,
 row.shared_quota_risk_accepted,row.max_email_attempts).run();
 must(Number.isSafeInteger(result?.meta?.changes) && result.meta.changes>0);
 return {runId:row.run_id,maxEmailAttempts:2};
}
