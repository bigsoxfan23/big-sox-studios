// Pure source-only planning. Supplied evidence is untrusted, never live proof.
// No authenticator, admission writer, policy reader or deployment is invoked.
import {stagingAccessTarget as target} from './access-policy-readback.mjs';

const memberDb='43a8a15b-e195-4712-9198-1dcc9f0152af';
const requestDb='48b0a0cc-40ad-4495-8883-a42b4a938b71';
const modules=['otp-identity','approved-member-admission','simplified-member-dashboard','access-policy-readback','member-dashboard'].map(x=>'portal/'+x+'.mjs');
const scopes=['member-access-policy','staging-runtime','member-activation','staging-acceptance'];
const time=x=>Number.isSafeInteger(x)&&x>=0;
const bool=x=>typeof x==='boolean';
const ref=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const revision=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const string=x=>typeof x==='string';
const nullable=check=>x=>x===null||check(x);
const same=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const rule={kind:string,subjectRef:x=>ref(x)||uuid(x)};
const mfa={disabled:bool,authenticators:[string],sessionSeconds:time};
const policy={id:uuid,decision:string,precedence:time,include:[rule],require:[rule],exclude:[rule],mfa:nullable(x=>shape(x,mfa))};
const snapshot=fields=>({capturedAt:time,complete:bool,evidenceRef:ref,...fields});
const schema={
 schemaVersion:x=>x===1,now:time,
 principals:{ownerRef:ref,controlledTestRef:ref,memberRefs:[ref]},
 access:snapshot({applicationId:uuid,host:string,audience:string,issuer:string,digest,
  matchingApplicationIds:[uuid],memberPolicyApplicationIds:[uuid],
  idps:[{id:uuid,type:string}],allowedIdpIds:[uuid],runtimeProvider:string,
  baselineEvidenceRef:ref,ownerBaseline:{policy,applicationMfa:mfa},applicationMfa:mfa,policies:[policy]}),
 source:snapshot({revision,artifactDigest:digest,modules:[string]}),
 deployment:snapshot({id:uuid,sourceRevision:revision,artifactDigest:digest,worker:string,
  bindings:{DB:nullable(uuid),APPROVED_REQUESTS_DB:nullable(uuid)},
  vars:{APP_ORIGIN:nullable(string),ACCESS_ISSUER:nullable(string),ACCESS_AUDIENCE:nullable(string),
   OWNER_ACCESS_AUDIENCE:nullable(string),OTP_CUSTOM_HOSTS:[string],
   APPROVED_MEMBER_DB_ID:nullable(uuid),APPROVED_REQUESTS_ID:nullable(uuid),
   PORTAL_APPROVED_MEMBERS:nullable(string),PORTAL_SIMPLIFIED_MEMBER_UI:nullable(string)}}),
 requests:snapshot({digest,memberDatabase:uuid,sourceDatabase:uuid,rows:[{
  memberRef:ref,requestRef:ref,role:string,status:string,requestStatus:string,piiCleared:bool,
  requestRevision:time,onboardingRequestRevision:time,onboardingRevision:time,
  jellyfinReady:bool,welcomeRef:ref,welcomeReceiptRef:nullable(ref),welcomeMode:string,welcomeState:string,
  welcomeRevision:time,welcomeAcceptedAt:nullable(time)}]}),
 approvals:snapshot({records:[{scope:string,decision:string,actorRef:ref,auditRef:ref,
  applicationId:uuid,accessDigest:digest,sourceRevision:revision,artifactDigest:digest,
  deploymentId:uuid,requestsDigest:digest,memberRefs:[ref],recordedAt:time,expiresAt:time}]})
};

function shape(value,spec) {
 if(typeof spec==='function')return spec(value);
 if(Array.isArray(spec))return Array.isArray(value)&&value.length<=100&&value.every(x=>shape(x,spec[0]));
 return value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===Object.keys(spec).length&&Object.keys(spec).every(k=>Object.hasOwn(value,k)&&shape(value[k],spec[k]));
}

// Copy bounded plain data without invoking getters/toJSON or freezing input.
// Callers supply sanitized JSON data, never executable objects or raw API dumps.
function plainData(input) {
 let budget=5000;
 function copy(x,depth=0) {
  if(--budget<0||depth>16)throw Error();
  if(x===null||typeof x==='boolean'||time(x))return x;
  if(typeof x==='string'&&x.length<=512)return x;
  if(typeof x!=='object'||x===null)throw Error();
  const array=Array.isArray(x),proto=Object.getPrototypeOf(x);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)throw Error();
  const descriptors=Object.getOwnPropertyDescriptors(x),keys=Reflect.ownKeys(descriptors);
  if(keys.length>200)throw Error();
  const out=array?[]:Object.create(null);
  if(array&&(x.length>100||keys.length!==x.length+1))throw Error();
  for(const key of keys) {
   const d=descriptors[key];
   if(array&&key==='length')continue;
   if(typeof key!=='string'||!Object.hasOwn(d,'value')||!d.enumerable||
    (array&&!/^(?:0|[1-9][0-9]*)$/.test(key)))throw Error();
   out[key]=copy(d.value,depth+1);
  }
  return out;
 }
 return copy(input);
}

export function evaluateApprovedMemberStagingReadiness(input) {
 const findings=[];
 const add=code=>{if(!findings.includes(code))findings.push(code);};
 const result=()=>Object.freeze({mode:'SOURCE_ONLY_SNAPSHOT',status:'BLOCKED',authorize:false,
  snapshotAnalysis:findings.length?'UNSAFE_OR_UNKNOWN':'CONSISTENT_ONLY',
  blockers:Object.freeze(['LIVE_EVIDENCE_UNVERIFIED','SEPARATE_EXECUTION_APPROVAL_REQUIRED']),
  findings:Object.freeze(findings)});
 let data;
 try{data=plainData(input);if(!shape(data,schema))throw Error();}
 catch{add('MALFORMED_OR_UNKNOWN_SNAPSHOT');return result();}
 const {now,principals:p,access:a,source:s,deployment:d,requests:r,approvals}=data;
 for(const [name,snap] of Object.entries({ACCESS:a,SOURCE:s,DEPLOYMENT:d,REQUESTS:r,APPROVALS:approvals})) {
  if(!snap.complete)add(name+'_INCOMPLETE');
  if(snap.capturedAt>now||now-snap.capturedAt>60)add(name+'_STALE_OR_FUTURE');
 }
 if(p.memberRefs.length===0||!same(p.memberRefs,p.memberRefs)||p.ownerRef===p.controlledTestRef||
  p.memberRefs.some(x=>[p.ownerRef,p.controlledTestRef].includes(x)))add('INVALID_PRINCIPAL_ALLOWLIST');
 if(a.applicationId!==target.applicationId||a.host!==target.host||a.audience!==target.audience||
  a.issuer!=='https://'+target.launcherHost||!same(a.matchingApplicationIds,[target.applicationId]))add('STAGING_TARGET_OR_ROUTING_MISMATCH');
 const otp=a.idps.filter(x=>x.type==='onetimepin');
 if(otp.length!==1||!a.idps.every(x=>['onetimepin','google'].includes(x.type))||
  !same(a.allowedIdpIds,a.idps.map(x=>x.id))||a.runtimeProvider!=='onetimepin')add('OTP_PROVIDER_UNPROVEN');
 const validMfa=x=>!x.disabled&&x.sessionSeconds>0&&x.sessionSeconds<=86400&&x.authenticators.length>0&&
  same(x.authenticators,x.authenticators)&&x.authenticators.every(v=>['totp','biometrics','security_key'].includes(v));
 if(!validMfa(a.applicationMfa)||!validMfa(a.ownerBaseline.applicationMfa)||
  !equal(a.applicationMfa,a.ownerBaseline.applicationMfa))add('OWNER_MFA_NOT_RETAINED');
 const owners=a.policies.filter(x=>x.id===target.ownerPolicyId),baseline=a.ownerBaseline.policy;
 if(owners.length!==1||baseline.id!==target.ownerPolicyId||baseline.include.length!==1||
  baseline.include[0].subjectRef!==p.ownerRef||!equal(owners[0],baseline))add('EXACT_OWNER_POLICY_NOT_RETAINED');
 if(a.policies.length!==3||!same(a.policies.map(x=>x.id),a.policies.map(x=>x.id))||
  !same(a.policies.map(x=>x.precedence),a.policies.map(x=>x.precedence)))add('POLICY_INVENTORY_UNSUPPORTED');
 const extra=a.policies.filter(x=>x.id!==target.ownerPolicyId);
 const testPolicy=extra.filter(x=>x.include.length===1&&x.include[0].subjectRef===p.controlledTestRef);
 const memberPolicy=extra.filter(x=>same(x.include.map(v=>v.subjectRef),p.memberRefs));
 if(testPolicy.length!==1||memberPolicy.length!==1||testPolicy[0]===memberPolicy[0]||
  !same(a.memberPolicyApplicationIds,[target.applicationId]))add('SEPARATE_MEMBER_ALLOWLIST_POLICY_REQUIRED');
 // Only a separately scoped exact-Member policy may require OTP without
 // an additional independent-MFA enrollment. Owner and existing test policies
 // must retain their unchanged MFA inheritance and cannot use this exemption.
 // The Member allowance remains nonauthorizing until actual readback and Owner approval.
 for(const candidate of a.policies) {
  const member=memberPolicy.includes(candidate);
  const exact=candidate.decision==='allow'&&candidate.include.length>0&&candidate.exclude.length===0&&
   candidate.include.every(x=>x.kind==='exact-email'&&ref(x.subjectRef));
  const login=member
   ?candidate.require.length===1&&candidate.require[0].kind==='login-method'&&candidate.require[0].subjectRef===otp[0]?.id
   :candidate.require.length===0;
  const policyMfa=member
   ?candidate.mfa?.disabled===true&&candidate.mfa.authenticators.length===0&&candidate.mfa.sessionSeconds===0
   :candidate.mfa===null||(validMfa(candidate.mfa)&&equal(candidate.mfa,a.applicationMfa));
  if(!exact||!login||!policyMfa)add('BROAD_OR_UNSUPPORTED_POLICY');
 }
 if(!same(s.modules,modules)||d.sourceRevision!==s.revision||d.artifactDigest!==s.artifactDigest||
  d.evidenceRef===s.evidenceRef)add('SOURCE_DEPLOYMENT_UNCORROBORATED');
 if(d.worker!=='big-sox-studios-members-staging')add('WRONG_STAGING_WORKER');
 if(d.bindings.DB!==memberDb||d.bindings.APPROVED_REQUESTS_DB!==requestDb||
  d.vars.APPROVED_MEMBER_DB_ID!==memberDb||d.vars.APPROVED_REQUESTS_ID!==requestDb||
  r.memberDatabase!==memberDb||r.sourceDatabase!==requestDb)add('ISOLATED_D1_BINDINGS_REQUIRED');
 const v=d.vars;
 if(v.APP_ORIGIN!=='https://'+target.host||v.ACCESS_ISSUER!==a.issuer||v.ACCESS_AUDIENCE!==target.audience||
  !v.OWNER_ACCESS_AUDIENCE||v.OWNER_ACCESS_AUDIENCE===target.audience||!same(v.OTP_CUSTOM_HOSTS,[target.host]))add('OTP_CUSTOM_HOST_CONFIG_REQUIRED');
 if(v.PORTAL_APPROVED_MEMBERS!=='enabled-12-approved'||v.PORTAL_SIMPLIFIED_MEMBER_UI!=='enabled-12')add('REQUIRED_MEMBER_FLAGS_ABSENT');
 if(!same(r.rows.map(x=>x.memberRef),p.memberRefs)||!same(r.rows.map(x=>x.requestRef),r.rows.map(x=>x.requestRef))||
  !same(r.rows.map(x=>x.welcomeRef),r.rows.map(x=>x.welcomeRef)))add('MEMBER_REQUEST_COVERAGE_MISMATCH');
 for(const row of r.rows) {
  if(row.role!=='member'||!['pending','active'].includes(row.status)||row.requestStatus!=='approved'||row.piiCleared||
   row.onboardingRequestRevision<1||row.requestRevision<row.onboardingRequestRevision||row.onboardingRevision<1||
   !row.jellyfinReady)add('APPROVED_REQUEST_OR_ONBOARDING_UNPROVEN');
  if(row.welcomeMode!=='live'||row.welcomeState!=='accepted'||row.welcomeRevision!==row.onboardingRevision||
   !row.welcomeReceiptRef||!row.welcomeAcceptedAt||row.welcomeAcceptedAt>r.capturedAt)add('LIVE_ACCEPTED_WELCOME_REQUIRED');
 }
 if(approvals.records.length!==scopes.length||!same(approvals.records.map(x=>x.scope),scopes)||
  !same(approvals.records.map(x=>x.auditRef),approvals.records.map(x=>x.auditRef)))add('OWNER_APPROVALS_MISSING');
 for(const approval of approvals.records) {
  if(approval.decision!=='approve'||approval.actorRef!==p.ownerRef||approval.applicationId!==target.applicationId||
   approval.accessDigest!==a.digest||approval.sourceRevision!==s.revision||approval.artifactDigest!==s.artifactDigest||
   approval.deploymentId!==d.id||approval.requestsDigest!==r.digest||!same(approval.memberRefs,p.memberRefs)||
   approval.recordedAt>now||approval.expiresAt<=now||approval.expiresAt<=approval.recordedAt||
   approval.expiresAt-approval.recordedAt>300)add('OWNER_APPROVAL_NOT_BOUND_OR_CURRENT');
 }
 return result();
}
