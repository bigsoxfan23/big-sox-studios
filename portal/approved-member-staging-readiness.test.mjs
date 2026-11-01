import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateApprovedMemberStagingReadiness as evaluate} from './approved-member-staging-readiness.mjs';
import {stagingAccessTarget as target} from './access-policy-readback.mjs';
import {requireOtpIdentity} from './otp-identity.mjs';
import {requireIdentity} from './identity.mjs';
import {requireProjectionReceipt} from './projection.mjs';
import {authorizeMember,mayManageMembers,SERVICES} from './authorization.mjs';
import {createApprovedMemberAdmission} from './approved-member-admission.mjs';
import {loadSimplifiedMember} from './simplified-member-dashboard.mjs';

const now=1800000000;
const id=n=>String(n).repeat(8)+'-'+String(n).repeat(4)+'-'+String(n).repeat(4)+'-'+String(n).repeat(4)+'-'+String(n).repeat(12);
const memberDb='43a8a15b-e195-4712-9198-1dcc9f0152af',requestDb='48b0a0cc-40ad-4495-8883-a42b4a938b71';
const snapshot=(evidenceRef,fields)=>({capturedAt:now,complete:true,evidenceRef,...fields});
const rule=subjectRef=>({kind:'exact-email',subjectRef});
const policy=(id,precedence,subjectRef)=>({id,decision:'allow',precedence,include:[rule(subjectRef)],require:[],exclude:[],mfa:null});
const scopes=['member-access-policy','staging-runtime','member-activation','staging-acceptance'];
// Entirely synthetic future consistency example. No real identity or delivery.
function fixture() {
 const owner=policy(target.ownerPolicyId,1,'owner-01');
 const mfa={disabled:false,authenticators:['totp','biometrics','security_key'],sessionSeconds:86400};
 const access=snapshot('access-readback',{
  applicationId:target.applicationId,host:target.host,audience:target.audience,issuer:'https://'+target.launcherHost,digest:'a'.repeat(64),
  matchingApplicationIds:[target.applicationId],memberPolicyApplicationIds:[target.applicationId],
  idps:[{id:id(1),type:'onetimepin'},{id:id(2),type:'google'}],allowedIdpIds:[id(1),id(2)],runtimeProvider:'onetimepin',
  baselineEvidenceRef:'retained-owner-audit',ownerBaseline:{policy:structuredClone(owner),applicationMfa:structuredClone(mfa)},
  applicationMfa:mfa,policies:[owner,policy(id(3),2,'test-01'),{
   ...policy(id(4),3,'member-01'),
   require:[{kind:'login-method',subjectRef:id(1)}],
   mfa:{disabled:true,authenticators:[],sessionSeconds:0}
  }]
 });
 const source=snapshot('source-review',{revision:'b'.repeat(40),artifactDigest:'c'.repeat(64),
  modules:['otp-identity','approved-member-admission','simplified-member-dashboard','access-policy-readback','member-dashboard'].map(x=>'portal/'+x+'.mjs')});
 const deployment=snapshot('deployment-readback',{id:id(5),sourceRevision:source.revision,artifactDigest:source.artifactDigest,
  worker:'big-sox-studios-members-staging',bindings:{DB:memberDb,APPROVED_REQUESTS_DB:requestDb},
  vars:{APP_ORIGIN:'https://'+target.host,ACCESS_ISSUER:access.issuer,ACCESS_AUDIENCE:target.audience,
   OWNER_ACCESS_AUDIENCE:'synthetic-distinct-owner-audience',OTP_CUSTOM_HOSTS:[target.host],
   APPROVED_MEMBER_DB_ID:memberDb,APPROVED_REQUESTS_ID:requestDb,
   PORTAL_APPROVED_MEMBERS:'enabled-12-approved',PORTAL_SIMPLIFIED_MEMBER_UI:'enabled-12'}});
 const requests=snapshot('request-readback',{digest:'d'.repeat(64),memberDatabase:memberDb,sourceDatabase:requestDb,
  rows:[{memberRef:'member-01',requestRef:'request-01',role:'member',status:'pending',requestStatus:'approved',piiCleared:false,
   requestRevision:2,onboardingRequestRevision:1,onboardingRevision:3,jellyfinReady:true,
   welcomeRef:'welcome-01',welcomeReceiptRef:'receipt-01',welcomeMode:'live',welcomeState:'accepted',welcomeRevision:3,welcomeAcceptedAt:now-10}]});
 const approvals=snapshot('approval-audit',{records:scopes.map((scope,i)=>({scope,decision:'approve',actorRef:'owner-01',auditRef:'audit-'+i,
  applicationId:target.applicationId,accessDigest:access.digest,sourceRevision:source.revision,artifactDigest:source.artifactDigest,
  deploymentId:deployment.id,requestsDigest:requests.digest,memberRefs:['member-01'],recordedAt:now-20,expiresAt:now+120}))});
 return {schemaVersion:1,now,principals:{ownerRef:'owner-01',controlledTestRef:'test-01',memberRefs:['member-01']},access,source,deployment,requests,approvals};
}
function currentBaseline() {
 const f=fixture();
 f.access.policies.pop();f.access.memberPolicyApplicationIds=[];
 f.deployment.bindings.APPROVED_REQUESTS_DB=null;
 f.deployment.vars.PORTAL_APPROVED_MEMBERS=null;
 f.approvals.records=[];
 return f;
}
function blocked(input,code) {
 const r=evaluate(input);
 assert.equal(r.status,'BLOCKED');assert.equal(r.authorize,false);
 assert.equal(r.snapshotAnalysis,'UNSAFE_OR_UNKNOWN');
 if(code)assert.ok(r.findings.includes(code),JSON.stringify(r));
 return r;
}
function freeze(value) {
 if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
 return value;
}

test('reported baseline remains BLOCKED: two exact policies, no request binding or approved-Member flag, no new approvals',()=>{
 const r=blocked(currentBaseline(),'REQUIRED_MEMBER_FLAGS_ABSENT');
 for(const code of ['POLICY_INVENTORY_UNSUPPORTED','SEPARATE_MEMBER_ALLOWLIST_POLICY_REQUIRED','ISOLATED_D1_BINDINGS_REQUIRED','OWNER_APPROVALS_MISSING'])assert.ok(r.findings.includes(code));
});

test('even fully consistent synthetic snapshots remain BLOCKED, deterministic, immutable and unverified',t=>{
 const f=freeze(fixture()),before=JSON.stringify(f);
 const fetcher=t.mock.method(globalThis,'fetch',()=>{throw Error('external I/O forbidden');});
 const one=evaluate(f),two=evaluate(f);
 assert.deepEqual(one,two);assert.deepEqual(one.findings,[]);assert.equal(one.snapshotAnalysis,'CONSISTENT_ONLY');
 assert.equal(one.status,'BLOCKED');assert.equal(one.authorize,false);
 assert.deepEqual(one.blockers,['LIVE_EVIDENCE_UNVERIFIED','SEPARATE_EXECUTION_APPROVAL_REQUIRED']);
 assert.equal(JSON.stringify(f),before);assert.equal(fetcher.mock.callCount(),0);
 assert.ok(Object.isFrozen(one)&&Object.isFrozen(one.findings)&&Object.isFrozen(one.blockers));
});

const memberPolicy=f=>f.access.policies[2];
const cases=[
 ['wrong app',f=>{f.access.applicationId=id(9);},'STAGING_TARGET_OR_ROUTING_MISMATCH'],
 ['wrong host',f=>{f.access.host='other.example.test';},'STAGING_TARGET_OR_ROUTING_MISMATCH'],
 ['wrong audience',f=>{f.access.audience='synthetic-other';},'STAGING_TARGET_OR_ROUTING_MISMATCH'],
 ['overlapping app',f=>{f.access.matchingApplicationIds.push(id(9));},'STAGING_TARGET_OR_ROUTING_MISMATCH'],
 ['Google only',f=>{f.access.idps.shift();f.access.allowedIdpIds.shift();},'OTP_PROVIDER_UNPROVEN'],
 ['Google runtime',f=>{f.access.runtimeProvider='google';},'OTP_PROVIDER_UNPROVEN'],
 ['unmapped IdP',f=>{f.access.allowedIdpIds.push(id(9));},'OTP_PROVIDER_UNPROVEN'],
 ['wrong Owner id',f=>{f.access.policies[0].id=id(9);},'EXACT_OWNER_POLICY_NOT_RETAINED'],
 ['wrong Owner subject',f=>{f.access.policies[0].include[0].subjectRef='other-owner';},'EXACT_OWNER_POLICY_NOT_RETAINED'],
 ['disabled app MFA',f=>{f.access.applicationMfa.disabled=true;},'OWNER_MFA_NOT_RETAINED'],
 ['changed Owner precedence',f=>{f.access.policies[0].precedence=4;},'EXACT_OWNER_POLICY_NOT_RETAINED'],
 ['long MFA',f=>{f.access.applicationMfa.sessionSeconds=172800;},'OWNER_MFA_NOT_RETAINED'],
 ['Owner-test policy disables MFA',f=>{f.access.policies[1].mfa={disabled:true,authenticators:[],sessionSeconds:0};},'BROAD_OR_UNSUPPORTED_POLICY'],
 ['Member OTP login-method missing',f=>{memberPolicy(f).require=[];},'BROAD_OR_UNSUPPORTED_POLICY'],
 ['Member uses Google login method',f=>{memberPolicy(f).require[0].subjectRef=id(2);},'BROAD_OR_UNSUPPORTED_POLICY'],
 ['Member adds different login method',f=>{memberPolicy(f).require.push({kind:'login-method',subjectRef:id(2)});},'BROAD_OR_UNSUPPORTED_POLICY'],
 ['Member MFA inherits Owner enrollment',f=>{memberPolicy(f).mfa=null;},'BROAD_OR_UNSUPPORTED_POLICY'],
 ['Member MFA waiver has unexpected methods',f=>{memberPolicy(f).mfa.authenticators=['totp'];},'BROAD_OR_UNSUPPORTED_POLICY'],
 ['unknown MFA',f=>{f.access.applicationMfa.authenticators.push('email');},'OWNER_MFA_NOT_RETAINED'],
 ['Owner in Member list',f=>{f.principals.memberRefs.push('owner-01');},'INVALID_PRINCIPAL_ALLOWLIST'],
 ['extra Member',f=>{memberPolicy(f).include.push(rule('unapproved-01'));},'SEPARATE_MEMBER_ALLOWLIST_POLICY_REQUIRED'],
 ['Member policy reused',f=>{f.access.memberPolicyApplicationIds.push(id(9));},'SEPARATE_MEMBER_ALLOWLIST_POLICY_REQUIRED'],
 ['bypass policy',f=>{memberPolicy(f).decision='bypass';},'BROAD_OR_UNSUPPORTED_POLICY'],
 ['duplicate policy',f=>{f.access.policies.push(structuredClone(memberPolicy(f)));},'POLICY_INVENTORY_UNSUPPORTED'],
 ['request binding missing',f=>{f.deployment.bindings.APPROVED_REQUESTS_DB=null;},'ISOLATED_D1_BINDINGS_REQUIRED'],
 ['DBs aliased',f=>{f.deployment.bindings.DB=requestDb;},'ISOLATED_D1_BINDINGS_REQUIRED'],
 ['wrong request ID',f=>{f.deployment.vars.APPROVED_REQUESTS_ID=memberDb;},'ISOLATED_D1_BINDINGS_REQUIRED'],
 ['OTP host missing',f=>{f.deployment.vars.OTP_CUSTOM_HOSTS=[];},'OTP_CUSTOM_HOST_CONFIG_REQUIRED'],
 ['workers host',f=>{f.deployment.vars.OTP_CUSTOM_HOSTS=['synthetic.workers.dev'];},'OTP_CUSTOM_HOST_CONFIG_REQUIRED'],
 ['Owner audience collision',f=>{f.deployment.vars.OWNER_ACCESS_AUDIENCE=target.audience;},'OTP_CUSTOM_HOST_CONFIG_REQUIRED'],
 ['simplified UI off',f=>{f.deployment.vars.PORTAL_SIMPLIFIED_MEMBER_UI=null;},'REQUIRED_MEMBER_FLAGS_ABSENT'],
 ['wrong Worker',f=>{f.deployment.worker='synthetic-other';},'WRONG_STAGING_WORKER'],
 ['old deployed source',f=>{f.deployment.sourceRevision='e'.repeat(40);},'SOURCE_DEPLOYMENT_UNCORROBORATED'],
 ['different deployed artifact',f=>{f.deployment.artifactDigest='e'.repeat(64);},'SOURCE_DEPLOYMENT_UNCORROBORATED'],
 ['unreviewed source module',f=>{f.source.modules.pop();},'SOURCE_DEPLOYMENT_UNCORROBORATED'],
 ['same source/deployment evidence',f=>{f.deployment.evidenceRef=f.source.evidenceRef;},'SOURCE_DEPLOYMENT_UNCORROBORATED'],
 ['empty request rows',f=>{f.requests.rows=[];},'MEMBER_REQUEST_COVERAGE_MISMATCH'],
 ['revoked Member',f=>{f.requests.rows[0].status='revoked';},'APPROVED_REQUEST_OR_ONBOARDING_UNPROVEN'],
 ['Owner row',f=>{f.requests.rows[0].role='owner';},'APPROVED_REQUEST_OR_ONBOARDING_UNPROVEN'],
 ['withdrawn request',f=>{f.requests.rows[0].requestStatus='revoked';},'APPROVED_REQUEST_OR_ONBOARDING_UNPROVEN'],
 ['cleared request',f=>{f.requests.rows[0].piiCleared=true;},'APPROVED_REQUEST_OR_ONBOARDING_UNPROVEN'],
 ['stale request revision',f=>{f.requests.rows[0].requestRevision=0;},'APPROVED_REQUEST_OR_ONBOARDING_UNPROVEN'],
 ['Jellyfin not prepared',f=>{f.requests.rows[0].jellyfinReady=false;},'APPROVED_REQUEST_OR_ONBOARDING_UNPROVEN'],
 ['simulated welcome',f=>{f.requests.rows[0].welcomeMode='simulated';},'LIVE_ACCEPTED_WELCOME_REQUIRED'],
 ['stale welcome revision',f=>{f.requests.rows[0].welcomeRevision=2;},'LIVE_ACCEPTED_WELCOME_REQUIRED'],
 ['no acceptance receipt',f=>{f.requests.rows[0].welcomeReceiptRef=null;},'LIVE_ACCEPTED_WELCOME_REQUIRED'],
 ['future acceptance',f=>{f.requests.rows[0].welcomeAcceptedAt=now+1;},'LIVE_ACCEPTED_WELCOME_REQUIRED'],
 ['one approval missing',f=>{f.approvals.records.pop();},'OWNER_APPROVALS_MISSING'],
 ['duplicate approvals',f=>{f.approvals.records[1]=structuredClone(f.approvals.records[0]);},'OWNER_APPROVALS_MISSING'],
 ['wrong approval actor',f=>{f.approvals.records[0].actorRef='test-01';},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['expired approval',f=>{f.approvals.records[0].expiresAt=now;},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['future approval',f=>{f.approvals.records[0].recordedAt=now+1;},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['approval postdates its own snapshot',f=>{f.approvals.capturedAt=now-60;},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['unbounded approval',f=>{f.approvals.records[0].expiresAt=now+301;},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['old policy approval',f=>{f.approvals.records[0].accessDigest='e'.repeat(64);},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['old request approval',f=>{f.approvals.records[0].requestsDigest='e'.repeat(64);},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['old deployment approval',f=>{f.approvals.records[0].deploymentId=id(9);},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT'],
 ['wrong approval allowlist',f=>{f.approvals.records[0].memberRefs=['other-member'];},'OWNER_APPROVAL_NOT_BOUND_OR_CURRENT']
];
for(const [label,mutate,code] of cases)test('snapshot gate blocks '+label,()=>{
 const f=fixture();mutate(f);blocked(f,code);
});
for(const kind of ['everyone','country','ip','email-domain','group','login-method'])test('broad or unsupported '+kind+' rule blocks in every policy lane',()=>{
 for(const lane of ['include','require','exclude']) {
  const f=fixture();memberPolicy(f)[lane].push({kind,subjectRef:'synthetic-selector'});
  blocked(f,'BROAD_OR_UNSUPPORTED_POLICY');
 }
});
for(const state of ['failed','unknown','dispatching','simulated'])test('welcome '+state+' cannot establish accepted delivery',()=>{
 const f=fixture();f.requests.rows[0].welcomeState=state;blocked(f,'LIVE_ACCEPTED_WELCOME_REQUIRED');
});
for(const name of ['access','source','deployment','requests','approvals'])test(name+' snapshot freshness, completeness and exact time boundary',()=>{
 for(const delta of [-61,1]){const f=fixture();f[name].capturedAt=now+delta;blocked(f,name.toUpperCase()+'_STALE_OR_FUTURE');}
 const f=fixture();f[name].complete=false;blocked(f,name.toUpperCase()+'_INCOMPLETE');
 const boundary=fixture();boundary[name].capturedAt=now-60;
 // Acceptance cannot postdate its request readback.
 if(name==='requests')boundary.requests.rows[0].welcomeAcceptedAt=now-60;
 if(name==='approvals')boundary.approvals.records.forEach(record=>{record.recordedAt=now-60;});
 assert.equal(evaluate(boundary).snapshotAnalysis,'CONSISTENT_ONLY');
});

// Walk the known fixture to challenge every required field and nested object.
function paths(value,path=[],out=[]) {
 if(value&&typeof value==='object')for(const key of Object.keys(value)) {
  const next=[...path,key];out.push(next);paths(value[key],next,out);
 }
 return out;
}
const at=(root,path)=>path.reduce((value,key)=>value[key],root);
test('every truncation, unknown nested property and unsupported scalar fails closed',()=>{
 const base=fixture();
 for(const path of paths(base)) {
  const missing=fixture();delete at(missing,path.slice(0,-1))[path.at(-1)];blocked(missing);
  const original=at(base,path);
  if(original&&typeof original==='object') {
   const unknown=fixture();at(unknown,path).unexpected=true;blocked(unknown);
  } else {
   const malformed=fixture();at(malformed,path.slice(0,-1))[path.at(-1)]={};blocked(malformed);
  }
 }
 const unknown=fixture();unknown.approved=true;blocked(unknown,'MALFORMED_OR_UNKNOWN_SNAPSHOT');
});

test('malformed data, accessors, oversized or executable inputs never echo private data or invoke getters',()=>{
 const secret='synthetic-private-canary',bad=fixture();let invoked=0;
 Object.defineProperty(bad,'extra',{enumerable:true,get(){invoked++;throw Error(secret);}});
 const cycle={};cycle.self=cycle;
 for(const input of [undefined,null,[],{},'{truncated',bad,cycle,()=>{},new Date(),{toJSON(){invoked++;return fixture();}},
  {apiKey:secret},{email:'synthetic-private-canary@example.test'}, {...fixture(),now:NaN},{...fixture(),now:-1},
  {...fixture(),extra:'x'.repeat(513)}, {...fixture(),[Symbol('unknown')]:secret},Object.assign(Object.create({}),fixture())]) {
  const result=blocked(input,'MALFORMED_OR_UNKNOWN_SNAPSHOT');
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-canary|@|apiKey|email/);
 }
 assert.equal(invoked,0);
});

test('forged approval/enablement flags cannot replace evidence or repair the reported baseline',()=>{
 for(const key of ['approved','ownerApproved','authorize','ready']) {
  const f=currentBaseline();f[key]=true;blocked(f,'MALFORMED_OR_UNKNOWN_SNAPSHOT');
 }
 const f=currentBaseline();f.deployment.vars.PORTAL_APPROVED_MEMBERS='enabled-12-approved';
 f.approvals=fixture().approvals;
 blocked(f,'ISOLATED_D1_BINDINGS_REQUIRED');
});

test('permission invariant: every result, including copied results, is neither a Member grant, OTP identity, admission nor receipt',async()=>{
 let dbCalls=0;
 const db={prepare(){dbCalls++;throw Error('database forbidden');},batch(){dbCalls++;throw Error('database forbidden');}};
 const admission=createApprovedMemberAdmission({memberDb:db,requestDb:db,sourceDatabase:'synthetic-source',now:()=>now});
 const inputs=[fixture(),currentBaseline(),null,{}];
 for(const [,mutate] of cases){const f=fixture();mutate(f);inputs.push(f);}
 for(const path of paths(fixture())){const f=fixture();delete at(f,path.slice(0,-1))[path.at(-1)];inputs.push(f);}
 for(const input of inputs) {
  const result=evaluate(input);
  for(const candidate of [result,{...result},JSON.parse(JSON.stringify(result))]) {
   assert.equal(candidate.authorize,false);assert.equal(candidate.status,'BLOCKED');
   assert.equal(authorizeMember(candidate),false);assert.equal(mayManageMembers(candidate),false);
   for(const service of SERVICES)assert.equal(authorizeMember(candidate,service),false);
   assert.throws(()=>requireOtpIdentity(candidate,now));assert.throws(()=>requireIdentity(candidate,now));
   assert.throws(()=>requireProjectionReceipt(candidate,'synthetic-invite',now));
   await assert.rejects(()=>admission.admit(candidate));
   await assert.rejects(()=>loadSimplifiedMember(db,candidate,{now:()=>now}));
  }
 }
 assert.equal(dbCalls,0);
});
