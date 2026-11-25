// Staging-only trusted runtime reader. Never imported by production.
// The source cannot produce its own evidence or signature.
// A separately authorized operator must inspect current Access policy,
// physical D1 binding IDs, private Notion scope and sending-only scope.
// Operator signs the exact snapshot with a separate staging-only secret.
import {PINS,must} from './config.mjs';
const aud=role=>role==='owner'?PINS.ownerAudience:PINS.memberAudience;
export async function readSignedPreflight({runId,env}) {
 const raw=env?.ACCEPTANCE_TRUSTED_PREFLIGHT;
 must(typeof raw==='string' && raw.length>100 && raw.length<12288);
 const proof=JSON.parse(raw);
 must(proof && proof.runId===runId && proof.revoked===false);
 return proof;
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
