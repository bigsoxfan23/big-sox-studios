import test from 'node:test';
import assert from 'node:assert/strict';
import {preflightAccessProjection} from './access-preflight.mjs';
import {requireProjectionReceipt} from './projection.mjs';

const now = 1800000000;
const email = value => ({email:{email:value}});
const login = {login_method:{id:'synthetic-idp'}};
const api = result => ({success:true,errors:[],messages:[],result,result_info:{page:1,per_page:100,count:result.length,total_count:result.length,total_pages:1}});
function fixture() {
 const member = {id:'synthetic-member',recipient:'synthetic@example.test',status:'active',invitationId:null,invitationStatus:null,expiresAt:null};
 const d1 = {capturedAt:now,complete:true,members:[member]};
 return {now,expectedHosts:['members.example.test'],expectedIdps:['synthetic-idp'],
  hosts:{capturedAt:now,complete:true,workersDev:false,previewUrls:false,hosts:['members.example.test']},
  access:{capturedAt:now,complete:true,applications:api([{id:'synthetic-app',type:'self_hosted',domain:'members.example.test',allowed_idps:['synthetic-idp']}]),groups:api([]),
   policies:[{applicationId:'synthetic-app',response:api([{id:'synthetic-policy',decision:'allow',precedence:1,include:[email(member.recipient)],require:[login],exclude:[]}])}]},
  d1Before:structuredClone(d1),d1After:structuredClone(d1)};
}
const policy = f => f.access.policies[0].response.result[0];
const codes = result => result.findings.map(x => x.code);
function blocked(f, code) {
 const r = preflightAccessProjection(f);
 assert.equal(r.status,'BLOCKED');
 assert.equal(r.reconciliation,'INCONCLUSIVE');
 assert.ok(codes(r).includes(code),JSON.stringify(r));
 return r;
}

test('OFFLINE preflight: matching contacts never proves users, provider identity, or projection receipt',()=>{
 const f = fixture(), before = structuredClone(f), r = preflightAccessProjection(f);
 assert.deepEqual(f,before);
 assert.equal(r.policyAnalysis,'SUPPORTED_CONTACT_SUBSET');
 assert.equal(r.reconciliation,'CONTACTS_MATCH_ONLY');
 assert.equal(r.status,'BLOCKED');
 assert.deepEqual(r.differences,[]);
 assert.ok(r.blockers.includes('PROVIDER_STABLE_SUBJECT_UNPROVEN'));
 assert.throws(()=>requireProjectionReceipt(r,'synthetic-invite',now));
});

test('OFFLINE preflight: flat email group is parsed as rules, including manual app entries',()=>{
 const f = fixture();
 f.access.groups = api([{id:'synthetic-group',include:[email('synthetic@example.test')],require:[],exclude:[]}]);
 policy(f).include = [{group:{id:'synthetic-group'}},email('manual@example.test')];
 const r = preflightAccessProjection(f);
 assert.equal(r.reconciliation,'DRIFT');
 assert.equal(r.differences[0].kind,'extra-or-ineligible');
 assert.ok(r.inventory.some(x=>x.selector === 'group'));
 assert.ok(r.inventory.some(x=>x.selector === 'email' && x.ref.startsWith('group-')));
 assert.ok(!JSON.stringify(r).includes('@'));
});

for (const [label,selector] of Object.entries({everyone:{everyone:{}},domain:{email_domain:{domain:'example.test'}},wildcard:email('*@example.test'),service:{service_token:{token_id:'synthetic-token'}},anyService:{any_valid_service_token:{}},nested:{email:{email:'synthetic@example.test',unexpected:{everyone:{}}}},multiple:{email:{email:'synthetic@example.test'},everyone:{}},idpGroup:{gsuite:{email:'group@example.test',identity_provider_id:'synthetic-idp'}},external:{external_evaluation:{evaluate_url:'https://unused.example.test'}}})) {
 test(`OFFLINE preflight: ${label} selector blocks in every lane`,()=>{
  for (const lane of ['include','require','exclude']) {
   const f = fixture(); policy(f)[lane].push(selector);
   assert.equal(preflightAccessProjection(f).reconciliation,'INCONCLUSIVE');
  }
 });
}
for (const decision of ['deny','bypass','non_identity','unexpected',null]) test(`OFFLINE preflight: decision ${decision} cannot disappear behind matching allow`,()=>{
 const f = fixture(); f.access.policies[0].response = api([policy(f),{...structuredClone(policy(f)),id:'second-policy',precedence:2,decision}]);
 const r = blocked(f,'NON_ALLOW_DECISION_UNSUPPORTED');
 assert.equal(r.inventory.filter(x=>'decision' in x).length,2);
});

test('OFFLINE preflight: malformed policy does not hide later policies',()=>{
 const f = fixture(); f.access.policies[0].response = api([null,policy(f)]);
 const r = blocked(f,'MALFORMED_RULE_CONTAINER');
 assert.equal(r.inventory.filter(x=>'decision' in x).length,2);
});

for (const [label,mutate,code] of [
 ['missing group',f=>{policy(f).include=[{group:{id:'missing'}}];},'MISSING_GROUP_REFERENCE'],
 ['unscoped app IdP',f=>{f.access.applications.result[0].allowed_idps=[];},'UNSCOPED_APPLICATION_IDPS'],
 ['unscoped login',f=>{policy(f).require=[];},'LOGIN_METHOD_SCOPE_REQUIRED'],
 ['foreign login',f=>{policy(f).require=[{login_method:{id:'unknown'}}];},'UNSCOPED_LOGIN_METHOD'],
 ['two AND logins',f=>{policy(f).require.push(login);},'LOGIN_METHOD_SCOPE_REQUIRED'],
 ['include login',f=>{policy(f).include.push(login);},'UNSCOPED_LOGIN_METHOD'],
 ['email require',f=>{policy(f).require.push(email('synthetic@example.test'));},'CONSTRAINED_CONTACT_SET_UNSUPPORTED'],
 ['exclusion',f=>{policy(f).exclude=[email('synthetic@example.test')];},'EXCLUSION_SEMANTICS_UNSUPPORTED'],
 ['wildcard host',f=>{f.access.applications.result[0].domain='*.example.test';},'HOST_OR_APPLICATION_VARIANT_UNSUPPORTED'],
 ['path host',f=>{f.access.applications.result[0].domain='members.example.test/private';},'HOST_OR_APPLICATION_VARIANT_UNSUPPORTED'],
 ['destination variant',f=>{f.access.applications.result[0].destinations=[{type:'public',uri:'direct.example.test'}];},'UNKNOWN_APPLICATION_FIELDS'],
 ['direct worker',f=>{f.hosts.workersDev=true;},'DIRECT_WORKER_HOST_EXPOSURE'],
 ['preview',f=>{f.hosts.previewUrls=true;},'DIRECT_WORKER_HOST_EXPOSURE'],
 ['extra host',f=>{f.hosts.hosts.push('direct.example.test');},'HOST_INVENTORY_MISMATCH'],
 ['missing host',f=>{f.expectedHosts.push('alias.example.test');},'MISSING_HOST_APPLICATION'],
 ['partial policy pages',f=>{f.access.policies[0].response.result_info.total_pages=2;},'PARTIAL_OR_INVALID_API_ENVELOPE'],
 ['API error',f=>{f.access.applications.success=false;},'PARTIAL_OR_INVALID_API_ENVELOPE'],
 ['API count mismatch',f=>{f.access.groups.result_info.total_count=1;},'PARTIAL_OR_INVALID_API_ENVELOPE'],
 ['missing policy list',f=>{f.access.policies=[];},'MISSING_APPLICATION_POLICIES'],
 ['duplicate list',f=>{f.access.policies.push(f.access.policies[0]);},'INVALID_OR_DUPLICATE_POLICY_INVENTORY'],
 ['orphan list',f=>{f.access.policies.push({applicationId:'orphan',response:api([])});},'ORPHAN_POLICY_INVENTORY'],
 ['duplicate app',f=>{f.access.applications=api([f.access.applications.result[0],f.access.applications.result[0]]);},'INVALID_OR_DUPLICATE_APPLICATION'],
 ['unknown policy option',f=>{policy(f).approval_required=true;},'UNKNOWN_POLICY_FIELDS'],
 ['duplicate policy',f=>{f.access.policies[0].response=api([policy(f),policy(f)]);},'INVALID_OR_DUPLICATE_POLICY'],
 ['duplicate precedence',f=>{f.access.policies[0].response=api([policy(f),{...policy(f),id:'other'}]);},'AMBIGUOUS_PRECEDENCE'],
 ['bad D1 status',f=>{f.d1Before.members[0].status='unknown';},'INVALID_OR_DUPLICATE_D1_ROW'],
 ['bad invite',f=>{f.d1Before.members[0].invitationId='partial';},'INVALID_D1_INVITATION'],
 ['D1 duplicate',f=>{f.d1Before.members.push(f.d1Before.members[0]);},'INVALID_OR_DUPLICATE_D1_ROW'],
 ['D1 changed',f=>{f.d1After.members[0].status='revoked';},'D1_READBACK_DRIFT']
]) test(`OFFLINE preflight: ${label}`,()=>{ const f=fixture(); mutate(f); blocked(f,code); });

test('OFFLINE preflight: cyclic/nested and unreferenced unsupported groups cannot hide',()=>{
 const f = fixture();
 f.access.groups=api([{id:'g1',include:[{group:{id:'g2'}}],require:[],exclude:[]},{id:'g2',include:[{group:{id:'g1'}}],require:[],exclude:[]}]);
 policy(f).include=[{group:{id:'g1'}}];
 const r=blocked(f,'CYCLIC_OR_DEEP_GROUP');
 assert.ok(codes(r).includes('NESTED_OR_CONSTRAINED_GROUP_UNSUPPORTED'));
 f.access.groups=api([{id:'unused',include:[{everyone:{}}],require:[],exclude:[]}]);
 blocked(f,'UNSAFE_SELECTOR');
});

test('OFFLINE preflight: every snapshot requires explicit completeness and 60-second freshness',()=>{
 for (const field of ['access','hosts','d1Before','d1After']) {
  for (const delta of [-61,1]) {const f=fixture();f[field].capturedAt=now+delta;blocked(f,'STALE_OR_FUTURE_SNAPSHOT');}
  const f=fixture(); delete f[field].complete; blocked(f,'INCOMPLETE_SNAPSHOT');
 }
 const f=fixture(); for(const field of ['access','hosts','d1Before','d1After']) f[field].capturedAt=now-60;
 assert.equal(preflightAccessProjection(f).reconciliation,'CONTACTS_MATCH_ONLY');
});

test('OFFLINE preflight: missing, duplicate, expired, revoked and stale projection contacts',()=>{
 for (const status of ['revoked','expired','superseded','claimed']) {
  const f=fixture(); Object.assign(f.d1Before.members[0],{status:status==='revoked'?'revoked':'pending',invitationId:'synthetic-invite',invitationStatus:status,expiresAt:now+1});
  f.d1After=structuredClone(f.d1Before);
  assert.equal(preflightAccessProjection(f).differences[0].kind,'extra-or-ineligible');
 }
 for(const delta of [-1,0,1]) {
  const f=fixture(); Object.assign(f.d1Before.members[0],{status:'pending',invitationId:'synthetic-invite',invitationStatus:'delivered',expiresAt:now+delta}); f.d1After=structuredClone(f.d1Before);
  assert.equal(preflightAccessProjection(f).reconciliation,delta>0?'CONTACTS_MATCH_ONLY':'DRIFT');
 }
 const f=fixture(); policy(f).include=[email('other@example.test'),email('other@example.test')];
 assert.deepEqual(preflightAccessProjection(f).differences.map(x=>x.kind),['extra-or-ineligible','duplicate','extra-or-ineligible','missing']);
});

test('OFFLINE preflight: all configured host and IdP variants are inventoried',()=>{
 const f=fixture(); f.expectedHosts.push('alias.example.test'); f.hosts.hosts=[...f.expectedHosts];
 f.access.applications=api([...f.access.applications.result,{...f.access.applications.result[0],id:'alias-app',domain:'alias.example.test'}]);
 f.access.policies.push({applicationId:'alias-app',response:api([{...policy(f),id:'alias-policy'}])});
 assert.equal(preflightAccessProjection(f).reconciliation,'CONTACTS_MATCH_ONLY');
 policy(f).include.push(email('extra@example.test'));
 assert.equal(preflightAccessProjection(f).differences[0].app,'app-1');
});

test('OFFLINE preflight: opaque diagnostics never echo input contacts, IDs, labels or malicious strings',()=>{
 const f=fixture(), marker='private-marker@example.test';
 policy(f).name=marker; policy(f).id=marker; f.access.applications.result[0].id=marker;
 f.access.policies[0].applicationId=marker; policy(f).include=[email(marker),{[marker]:{value:marker}}];
 f.d1Before.members[0].id=marker; f.d1After.members[0].id=marker;
 const output=JSON.stringify(preflightAccessProjection(f));
 assert.ok(!output.includes(marker)); assert.ok(!output.includes('@')); assert.ok(!output.includes('example.test'));
 for(const input of [null,{},[],{now:'bad'},'bad',undefined]) assert.equal(preflightAccessProjection(input).status,'BLOCKED');
 const cycle={}; cycle.self=cycle;
 blocked(cycle,'INVALID_OR_OVERSIZED_JSON');
 blocked({padding:'x'.repeat(1000001)},'INVALID_OR_OVERSIZED_JSON');
});

test('OFFLINE preflight: opaque IdP inventory distinguishes variants without treating labels as subjects',()=>{
 const f=fixture(); f.expectedIdps.push('synthetic-alternate-idp'); f.access.applications.result[0].allowed_idps=[...f.expectedIdps];
 policy(f).require=[{login_method:{id:'synthetic-alternate-idp'}}];
 const r=preflightAccessProjection(f);
 assert.equal(r.reconciliation,'CONTACTS_MATCH_ONLY');
 assert.deepEqual(r.inventory.find(x=>x.kind==='application').identityProviderRefs,['idp-1','idp-2']);
 assert.equal(r.inventory.find(x=>x.selector==='login_method').identityProviderRef,'idp-2');
 assert.ok(!JSON.stringify(r).includes('synthetic-alternate-idp'));
 assert.equal(r.status,'BLOCKED');
});

test('OFFLINE preflight: case-variant duplicate D1 contacts block; reissued invitation drift blocks',()=>{
 const f=fixture(); f.d1Before.members.push({...f.d1Before.members[0],id:'different',recipient:'Synthetic@example.test'}); f.d1After=structuredClone(f.d1Before);
 blocked(f,'DUPLICATE_D1_CONTACT');
 const g=fixture(); Object.assign(g.d1Before.members[0],{status:'pending',invitationId:'old',invitationStatus:'delivered',expiresAt:now+10});
 g.d1After=structuredClone(g.d1Before); g.d1After.members[0].invitationId='new';
 blocked(g,'D1_READBACK_DRIFT');
});

test('OFFLINE preflight: bounded rule expansion and missing arrays are inconclusive',()=>{
 const f=fixture(); policy(f).include=Array.from({length:10001},()=>email('synthetic@example.test'));
 blocked(f,'RULE_BUDGET_EXCEEDED');
 const g=fixture(); delete policy(g).exclude; blocked(g,'MISSING_RULE_ARRAY');
});

test('OFFLINE preflight: caller identity/MFA/completeness assertions cannot remove production blockers',()=>{
 const f=fixture(); f.providerSubjectVerified=true; f.mfaVerified=true; f.liveInventoryVerified=true;
 const r=preflightAccessProjection(f);
 assert.equal(r.status,'BLOCKED'); assert.equal(r.blockers.length,3);
});
