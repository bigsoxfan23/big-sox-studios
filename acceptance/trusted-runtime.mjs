// Staging-only trusted runtime reader. Never imported by production.
// The source cannot produce its own evidence or signature.
// A separately authorized operator must inspect current Access policy,
// physical D1 binding IDs, private Notion scope and sending-only scope.
// Operator signs the exact snapshot with a separate staging-only secret.
import {PINS,must} from './config.mjs';
const aud=role=>role==='owner'?PINS.ownerAudience:PINS.memberAudience;
export async function readSignedPreflight({runId,env,role}) {
 // NO STATIC ENV FALLBACK. This is a readonly select against the pre-existing
 // isolated TEST Requests D1; operator-only scoped D1 updates renew the lease.
 // Both staging entrypoints see the same signed role-specific generation.
 must(role==='owner'||role==='member');
 must(env?.ACCEPTANCE_REQUESTS_ID===PINS.requestsId &&
  typeof env.ACCEPTANCE_REQUESTS?.prepare==='function');
 const row=await env.ACCEPTANCE_REQUESTS.prepare(
  'SELECT role,run_id,nonce_digest,revision,generation,issued_at,expires_at,signed_token,snapshot_json,revoked FROM acceptance_preflight_lease WHERE role=? AND run_id=?'
 ).bind(role,runId).first();
 must(row?.role===role && row.run_id===runId && row.revoked===0 &&
  row.revision===PINS.revision && Number.isSafeInteger(row.generation) &&
  row.generation>0 && Number.isSafeInteger(row.issued_at) &&
  Number.isSafeInteger(row.expires_at) && row.expires_at-row.issued_at<=300 &&
  typeof row.signed_token==='string' && row.signed_token.length<4096 &&
  typeof row.snapshot_json==='string' && row.snapshot_json.length<12288);
 const snapshot=JSON.parse(row.snapshot_json);
 must(snapshot?.runId===runId && snapshot.nonceDigest===row.nonce_digest);
 return {signedToken:row.signed_token,snapshot,generation:row.generation,
  issuedAt:row.issued_at,expiresAt:row.expires_at};
}
export async function verifyTrustedStagingPolicy({claims,runtime,role,preflight,runId,bindings}) {
 must(role==='owner'||role==='member');
 const expected=role==='owner'?PINS.owner:PINS.tester;
 // Signed Access JWT and trusted Cloudflare Access runtime identity must already
 // pass createSecurity. This verifies the separately signed scope readbacks.
 must(claims?.email===expected && typeof claims.sub==='string' && claims.sub.length>0 &&
  runtime?.email===expected && preflight?.runId===runId && preflight.revoked===false);
 const a=preflight.access;
 must(a?.issuer===PINS.issuer && a.independentMfa===true &&
  a.twoIdentityOnly===true && a.memberOtp===true &&
  a.ownerHost===PINS.ownerHost && a.memberHost===PINS.memberHost &&
  a.ownerAudience===PINS.ownerAudience && a.memberAudience===PINS.memberAudience &&
  a.owner===PINS.owner && a.tester===PINS.tester);
 must(bindings?.requests && bindings?.members &&
  bindings.requests!==bindings.members &&
  bindings.requestsId===PINS.requestsId &&
  bindings.membersId===PINS.membersId);
 const bs=preflight.bindings;
 must(Array.isArray(bs) && bs.length===2 &&
  bs[0]?.name==='ACCEPTANCE_REQUESTS' && bs[0].physicalId===PINS.requestsId &&
  bs[1]?.name==='ACCEPTANCE_MEMBERS' && bs[1].physicalId===PINS.membersId &&
  bs.every(x=>x.isolated===true && x.zeroGrants===true &&
   x.ownerHost===PINS.ownerHost && x.memberHost===PINS.memberHost));
 // Independent MFA is an enforced Access app/policy property, not a claim
 // proved by JWT amr. Interactive browser factor remains an owner test gate.
 return {mfaVerified:true,policyVerified:true,allowlistVerified:true,
  bindingsVerified:true,requestsId:PINS.requestsId,membersId:PINS.membersId,
  ownerHost:PINS.ownerHost,memberHost:PINS.memberHost,
  subject:claims.sub,audience:aud(role),runId,expiresAt:claims.exp};
}
