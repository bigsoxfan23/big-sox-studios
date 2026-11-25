// TEST GRAPH ONLY: synthetic operator/evidence. Never import from an entrypoint.
import {createHmac,createHash} from 'node:crypto';
import {PINS} from '../config.mjs';
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function preflightFixture(env,at) {
 return {runId:env.ACCEPTANCE_RUN_ID,nonceDigest:hash(env.ACCEPTANCE_RUN_NONCE),revision:PINS.revision,revoked:false,observedAt:at-1,expiresAt:at+300,
  access:{issuer:PINS.issuer,independentMfa:true,twoIdentityOnly:true,readbackDigest:hash('synthetic Access readback'),
   ownerHost:PINS.ownerHost,memberHost:PINS.memberHost,ownerAudience:PINS.ownerAudience,memberAudience:PINS.memberAudience,owner:PINS.owner,tester:PINS.tester,memberOtp:true},
  bindings:[['ACCEPTANCE_REQUESTS',PINS.requestsId],['ACCEPTANCE_MEMBERS',PINS.membersId]].map(([name,physicalId])=>({name,physicalId,isolated:true,zeroGrants:true,ownerHost:PINS.ownerHost,memberHost:PINS.memberHost,readbackDigest:hash(`synthetic physical binding ${name}`)})),
  notion:{parent:PINS.parent,privateParent:true,destinationOnly:true,stagingOnly:true,credentialDigest:hash(env.ACCEPTANCE_NOTION_CREDENTIAL),readbackDigest:hash('synthetic Notion scope')},
  resend:{sender:PINS.sender,domain:PINS.senderDomain,domainLimited:true,sendingOnly:true,senderVerified:true,stagingOnly:true,zeroSpend:true,paidFallback:false,freeQuotaRemaining:2,recipientPinsVerified:true,credentialDigest:hash(env.ACCEPTANCE_SENDER_CREDENTIAL),readbackDigest:hash('synthetic Resend scope')},
 };
}
export function signAttestation(env,preflight,token,at,changes={}) {
 const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
 const payload={version:'task12-operator-v1',operator:PINS.owner,revision:PINS.revision,runId:env.ACCEPTANCE_RUN_ID,nonceDigest:hash(env.ACCEPTANCE_RUN_NONCE),
  audience:Array.isArray(claims.aud)?claims.aud[0]:claims.aud,issuedAt:at,expiresAt:at+300,preflightDigest:hash(JSON.stringify(preflight)),...changes};
 const data=Buffer.from(JSON.stringify(payload)).toString('base64url');
 return `${data}.${createHmac('sha256',Buffer.from(env.ACCEPTANCE_ATTESTATION_KEY,'base64url')).update(data).digest('base64url')}`;
}
