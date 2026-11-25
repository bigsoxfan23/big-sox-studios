import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessPolicyReader,stagingAccessTarget as target} from './access-policy-readback.mjs';
import {createLiveProjection,requireProjectionReceipt} from './projection.mjs';
import {fixture} from './test-support.mjs';
const idp='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',invitePolicy='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',otherId='cccccccc-cccc-cccc-cccc-cccccccccccc';
const mfa={mfa_disabled:false,allowed_authenticators:['totp','biometrics','security_key'],session_duration:'24h'};
const policy=(id,email,precedence)=>({id,decision:'allow',precedence,include:[{email:{email}}],require:[],exclude:[],mfa_config:null});
function apiFixture(change=()=>{}){
 const owner=policy(target.ownerPolicyId,'owner@example.test',1),recipient=policy(invitePolicy,'person@example.test',2);
 const app={id:target.applicationId,type:'self_hosted',domain:target.host,aud:target.audience,session_duration:'24h',allowed_idps:[idp],mfa_config:structuredClone(mfa),policies:[{id:owner.id},{id:recipient.id}]};
 const other={id:otherId,type:'self_hosted',domain:'other.example.test',policies:[{id:owner.id}]};
 const data={app,other,policies:[owner,recipient],otherPolicies:[owner]};change(data);
 const calls=[];
 const envelope=rows=>({success:true,errors:[],result:rows,result_info:{page:1,per_page:50,count:rows.length,total_count:rows.length,total_pages:1}});
 const fetcher=async(url,options)=>{
  calls.push({url,options});assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(new URL(url).origin,'https://api.cloudflare.com');
  const p=new URL(url).pathname;
  if(p.endsWith('/apps'))return Response.json(envelope([{id:app.id},{id:other.id}]));
  if(p.endsWith('/'+app.id+'/policies'))return Response.json(envelope(data.policies));
  if(p.endsWith('/'+other.id+'/policies'))return Response.json(envelope(data.otherPolicies));
  if(p.endsWith('/'+app.id))return Response.json({success:true,errors:[],result:app});
  if(p.endsWith('/'+other.id))return Response.json({success:true,errors:[],result:other});
  throw Error('unexpected API target');
 };
 return {...data,calls,fetcher};
}
const options=fetcher=>({fetcher,token:'synthetic-read-token-only-123456789',expectedIdps:[idp],recipient:'person@example.test',now:()=>1800000000});

test('live read-only inventory validates exact recipient, inherited MFA and exclusive app policy',async()=>{
 const f=apiFixture(),snapshot=await createAccessPolicyReader(options(f.fetcher)).read('owner@example.test');
 assert.deepEqual(snapshot.contacts,['owner@example.test','person@example.test']);assert.equal(snapshot.verifiedAt,1800000000);
 assert.equal(f.calls.length,10);assert.ok(f.calls.every(c=>c.url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+target.accountId+'/access/')));
});

for(const [name,mutate] of [
 ['wrong audience',f=>{f.app.aud='other';}],
 ['different hostname',f=>{f.app.domain='other.example.test';}],
 ['wrong IdP',f=>{f.app.allowed_idps=[];}],
 ['missing MFA',f=>{delete f.app.mfa_config;}],
 ['disabled MFA',f=>{f.app.mfa_config.mfa_disabled=true;}],
 ['long app session',f=>{f.app.session_duration='48h';}],
 ['policy MFA disabled',f=>{f.policies[1].mfa_config={...mfa,mfa_disabled:true};}],
 ['long policy MFA',f=>{f.policies[1].mfa_config={...mfa,session_duration:'48h'};}],
 ['unknown MFA method',f=>{f.app.mfa_config.allowed_authenticators.push('email');}],
 ['everyone rule',f=>{f.policies[1].include=[{everyone:{}}];}],
 ['group rule',f=>{f.policies[1].include=[{group:{id:idp}}];}],
 ['bypass policy',f=>{f.policies[1].decision='bypass';}],
 ['wrong recipient',f=>{f.policies[1].include[0].email.email='wrong@example.test';}],
 ['unverified require constraint',f=>{f.policies[1].require=[{login_method:{id:idp}}];}],
 ['case-insensitive overlapping app',f=>{f.other.domain=target.host.toUpperCase()+'/app';}],
 ['wildcard overlapping app',f=>{f.other.domain='*.bigsoxstudios.com';}],
 ['overlapping destination',f=>{f.other.destinations=[{type:'public',uri:target.host}];}],
 ['unknown public destination shape',f=>{f.other.destinations=[{type:'public',hostname:target.host}];}],
 ['conflicting public destination keys',f=>{f.other.destinations=[{type:'public',hostname:'other.example.test',uri:target.host}];}],
 ['public bypass override',f=>{f.app.destinations=[{type:'public',uri:target.host,overrides:[{behavior:'public',path_pattern:'/app/*'}]}];}],
 ['missing other app routing',f=>{delete f.other.domain;}],
 ['trailing-dot overlapping app',f=>{f.other.domain=target.host+'.';}],
 ['legacy domain conflicts with Worker destination',f=>{f.other.domain=target.host;f.other.destinations=[{type:'worker',worker_id:'some-worker'}];}],
 ['legacy aliases conflict with public destination',f=>{f.other.self_hosted_domains=[target.host];f.other.destinations=[{type:'public',uri:'other.example.test'}];}],
 ['reused recipient policy',f=>{f.otherPolicies.push(f.policies[1]);f.other.policies.push({id:invitePolicy});}],
 ['incomplete app policy linkage',f=>{f.app.policies.pop();}]
])test('live readback denies '+name,async()=>{
 const f=apiFixture(mutate);await assert.rejects(()=>createAccessPolicyReader(options(f.fetcher)).read('owner@example.test'));
});

test('live readback denies partial pagination, redirects, API failures, drift and stale reads without credential errors',async()=>{
 for(const kind of ['partial','redirect','failure','drift','slow','oversized']){
  const f=apiFixture();let n=0,at=1800000000;
  const fetcher=async(url,opts)=>{
   if(kind==='failure')throw Error('synthetic-read-token-only-123456789');
   const res=await f.fetcher(url,opts);const call=++n;
   if(kind==='slow')at+=3;
   if(kind==='redirect')return new Response(null,{status:302,headers:{Location:'https://external.example/'}});
   if(kind==='oversized')return new Response(' '.repeat(1048577));
   const body=await res.json();
   if(kind==='partial'&&body.result_info)body.result_info.total_count++;
   if(kind==='drift'&&call===7)body.result.session_duration='12h';
   return Response.json(body);
  };
  await assert.rejects(()=>createAccessPolicyReader({...options(fetcher),now:()=>at}).read('owner@example.test'),{message:'Access policy readback unavailable'});
 }
});

test('nonmutating preflight precedes one issue; only live repeated readback mints repository receipt',async t=>{
 const f=await fixture(t),api=apiFixture(),live=createLiveProjection({...options(api.fetcher),now:f.now});
 const before=(await f.db.prepare('SELECT * FROM audit_events').all()).results;
 assert.deepEqual(await live.preflight(f.db),{ready:true,verifiedAt:f.now()});
 assert.deepEqual((await f.db.prepare('SELECT * FROM audit_events').all()).results,before);
 assert.equal((await f.db.prepare('SELECT count(*) AS n FROM invitations').first()).n,0);
 const member=await f.pending(),invite=await f.repo.issue('owner',member),receipt=await live.project(f.db,invite.id);
 requireProjectionReceipt(receipt,invite.id,f.now());await f.repo.confirmProjection('owner',invite.id,receipt);
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'projected');
 await assert.rejects(()=>f.repo.confirmProjection('owner',invite.id,{...receipt}));
});

test('live receipt rejects changed D1 and missing credential; helper never changes membership',async t=>{
 const f=await fixture(t),member=await f.pending(),invite=await f.repo.issue('owner',member),api=apiFixture();let first=true;
 const fetcher=async(url,opts)=>{
  if(first){first=false;await f.db.prepare("INSERT INTO members VALUES('unexpected','unexpected@example.test','member','active',?)").bind(f.now()).run();}
  return api.fetcher(url,opts);
 };
 await assert.rejects(()=>createLiveProjection({...options(fetcher),now:f.now}).project(f.db,invite.id));
 await assert.rejects(()=>createLiveProjection({...options(api.fetcher),token:undefined,now:f.now}).preflight(f.db));
 assert.equal((await f.db.prepare('SELECT status FROM members WHERE id=?').bind(member).first()).status,'pending');
 assert.equal((await f.db.prepare('SELECT status FROM invitations WHERE id=?').bind(invite.id).first()).status,'blocked');
});


test('documented public URI and Worker destination shapes are supported without bypass overrides',async()=>{
 const f=apiFixture(x=>{x.app.destinations=[{type:'public',uri:target.host}];delete x.other.domain;x.other.destinations=[{type:'worker',worker_id:'big-sox-studios-members-staging'}];});
 assert.deepEqual((await createAccessPolicyReader(options(f.fetcher)).read('owner@example.test')).contacts,['owner@example.test','person@example.test']);
});

const launcherFixture=change=>apiFixture(f=>{
 f.other.id=target.launcherApplicationId;f.other.type='app_launcher';
 f.other.domain=target.launcherHost;change?.(f);
});
test('known built-in launcher remains in both inventories and policy reuse checks',async()=>{
 const f=launcherFixture();
 assert.equal((await createAccessPolicyReader(options(f.fetcher)).read('owner@example.test')).contacts.length,2);
 assert.equal(f.calls.filter(c=>c.url.includes('/'+target.launcherApplicationId)).length,4);
 const reused=launcherFixture(x=>{x.otherPolicies.push(x.policies[1]);x.other.policies.push({id:invitePolicy});});
 await assert.rejects(()=>createAccessPolicyReader(options(reused.fetcher)).read('owner@example.test'));
});
for(const [name,change] of [
 ['unrecognized launcher ID',f=>{f.other.id=otherId;}],
 ['different launcher host',f=>{f.other.domain='other.cloudflareaccess.com';}],
 ['launcher overlapping target host',f=>{f.other.domain=target.host;}],
 ['launcher destination',f=>{f.other.destinations=[{type:'public',uri:target.host}];}],
 ['launcher alias',f=>{f.other.self_hosted_domains=[target.host];}],
 ['unsupported application type',f=>{f.other.type='saas';}]
])test('live readback denies '+name,async()=>{
 const f=launcherFixture(change);
 await assert.rejects(()=>createAccessPolicyReader(options(f.fetcher)).read('owner@example.test'));
});

test('actual workerd accepts the collector redirect mode while redirects still fail shut',async t=>{
 const f=apiFixture();await createAccessPolicyReader(options(f.fetcher)).read('owner@example.test');
 const {Miniflare,convertV4MiniflareOptions,NoOpLog}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({log:new NoOpLog(),modules:true,compatibilityDate:'2026-10-09',
  script:`export default {fetch(request){try{const checked=new Request('https://api.cloudflare.com/client/v4/',{redirect:request.headers.get('x-test-redirect-mode')});return new Response(checked.redirect);}catch{return new Response('unsupported',{status:400});}}}`}));
 t.after(()=>mf.dispose());
 const response=await mf.dispatchFetch('https://fixture.example/',{headers:{'x-test-redirect-mode':f.calls[0].options.redirect}});
 assert.equal(response.status,200);assert.equal(await response.text(),'manual');
 const redirected=async(url,init)=>{assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://outside.example/'}});};
 await assert.rejects(()=>createAccessPolicyReader(options(redirected)).read('owner@example.test'),{message:'Access policy readback unavailable'});
});
