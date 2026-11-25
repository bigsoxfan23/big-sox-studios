// Staging-only. No signer or evidence collector is shipped in the runtime graph.
// The operator signs only AFTER independent review; a signature cannot establish
// policy, physical wiring or credential scope by itself.
import {PINS,must,sha256} from './config.mjs';
import {unb64} from '../portal/access.mjs';
const encoder=new TextEncoder();
const verified=new WeakSet();
export function requireAttestation(value,now) {must(verified.has(value) && value.expiresAt>Math.floor(now()/1000));return value;}
const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
export async function verifyOperatorAttestation({env,role,now,readTrustedPreflight}) {
 must(typeof readTrustedPreflight==='function');
 must(typeof env.ACCEPTANCE_ATTESTATION_KEY==='string' && /^[A-Za-z0-9_-]{43}$/.test(env.ACCEPTANCE_ATTESTATION_KEY) &&
  ![env.ACCEPTANCE_CSRF_KEY,env.ACCEPTANCE_RUN_NONCE,env.ACCEPTANCE_NOTION_CREDENTIAL,env.ACCEPTANCE_SENDER_CREDENTIAL].includes(env.ACCEPTANCE_ATTESTATION_KEY));
 const raw=unb64(env.ACCEPTANCE_ATTESTATION_KEY);must(raw.length===32);
 // The deployed default reader obtains an operator-signed, renewable lease
 // from isolated Requests D1. Older static env tokens are accepted ONLY via
 // an explicitly injected synthetic reader in local tests, never by default.
 const observation=await readTrustedPreflight({runId:env.ACCEPTANCE_RUN_ID,env,role});
 const fromLease=typeof observation?.signedToken==='string';
 const token=fromLease?observation.signedToken:env.ACCEPTANCE_OPERATOR_ATTESTATION;
 must(typeof token==='string' && token.length<=4096);
 const parts=token.split('.');must(parts.length===2);
 const key=await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['verify']);
 must(await crypto.subtle.verify('HMAC',key,unb64(parts[1]),encoder.encode(parts[0])));
 const signed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unb64(parts[0])));
 const at=Math.floor(now()/1000);
 must(signed.version==='task12-operator-v1' && signed.operator===PINS.owner && signed.revision===PINS.revision &&
  signed.runId===env.ACCEPTANCE_RUN_ID && signed.nonceDigest===await sha256(env.ACCEPTANCE_RUN_NONCE) &&
  signed.audience===(role==='owner'?PINS.ownerAudience:PINS.memberAudience) &&
  Number.isSafeInteger(signed.issuedAt) && Number.isSafeInteger(signed.expiresAt) && signed.issuedAt<=at && signed.issuedAt>=at-300 &&
  signed.expiresAt>at && signed.expiresAt>signed.issuedAt && signed.expiresAt-signed.issuedAt<=300 && digest(signed.preflightDigest));
 // Server-owned independent evidence store, never request headers/env booleans.
 // Obtain a fresh read each request, including revocation. No positive cache.
 const proof=fromLease?observation.snapshot:observation;
 if(fromLease) must(Number.isSafeInteger(signed.generation) && signed.generation===observation.generation &&
  signed.issuedAt===observation.issuedAt && signed.expiresAt===observation.expiresAt);
 must(proof && signed.preflightDigest===await sha256(JSON.stringify(proof)) && proof.runId===signed.runId &&
  proof.nonceDigest===signed.nonceDigest && proof.revision===PINS.revision && proof.revoked===false &&
  Number.isSafeInteger(proof.observedAt) && proof.observedAt<=signed.issuedAt && proof.observedAt>=at-300 &&
  Number.isSafeInteger(proof.expiresAt) && proof.expiresAt>=signed.expiresAt);
 const access=proof.access;
 must(access?.issuer===PINS.issuer && access.independentMfa===true && access.twoIdentityOnly===true && digest(access.readbackDigest) &&
  access.ownerHost===PINS.ownerHost && access.memberHost===PINS.memberHost && access.ownerAudience===PINS.ownerAudience && access.memberAudience===PINS.memberAudience &&
  access.owner===PINS.owner && access.tester===PINS.tester && access.memberOtp===true);
 must(Array.isArray(proof.bindings) && proof.bindings.length===2);
 for(const [index,name,id] of [[0,'ACCEPTANCE_REQUESTS',PINS.requestsId],[1,'ACCEPTANCE_MEMBERS',PINS.membersId]]) {
  const binding=proof.bindings[index];
  must(binding?.name===name && binding.physicalId===id && binding.isolated===true && binding.zeroGrants===true &&
   binding.ownerHost===PINS.ownerHost && binding.memberHost===PINS.memberHost && digest(binding.readbackDigest));
 }
 must(proof.bindings[0].readbackDigest!==proof.bindings[1].readbackDigest);
 const notion=proof.notion,resend=proof.resend;
 must(notion?.parent===PINS.parent && notion.privateParent===true && notion.destinationOnly===true && notion.stagingOnly===true &&
  notion.credentialDigest===await sha256(env.ACCEPTANCE_NOTION_CREDENTIAL) && digest(notion.readbackDigest));
 must(resend?.sender===PINS.sender && resend.domain===PINS.senderDomain && resend.domainLimited===true && resend.sendingOnly===true &&
  resend.senderVerified===true && resend.stagingOnly===true && resend.zeroSpend===true && resend.paidFallback===false &&
  Number.isSafeInteger(resend.freeQuotaRemaining) && resend.freeQuotaRemaining>=2 &&
  Number.isSafeInteger(resend.quotaEvidenceAt) && resend.quotaEvidenceAt<=signed.issuedAt &&
  resend.plan==='free' && resend.overagesEnabled===false && resend.sharedQuotaRiskAccepted===true &&
  resend.recipientPinsVerified===true &&
  resend.credentialDigest===await sha256(env.ACCEPTANCE_SENDER_CREDENTIAL) && digest(resend.readbackDigest));
 must(env.ACCEPTANCE_VERIFIED_SENDER===PINS.sender && typeof env.ACCEPTANCE_NOTION_CREDENTIAL==='string' && env.ACCEPTANCE_NOTION_CREDENTIAL.length>=32 &&
  typeof env.ACCEPTANCE_SENDER_CREDENTIAL==='string' && env.ACCEPTANCE_SENDER_CREDENTIAL.length>=32 && env.ACCEPTANCE_NOTION_CREDENTIAL!==env.ACCEPTANCE_SENDER_CREDENTIAL);
 const result=Object.freeze({expiresAt:signed.expiresAt,preflight:proof,preflightDigest:signed.preflightDigest});
 verified.add(result);return result;
}
