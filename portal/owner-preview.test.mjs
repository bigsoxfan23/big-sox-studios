import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {createOwnerPreview} from './owner-preview.mjs';
import {createOwnerProof} from './owner-proof.mjs';
import {createAuthenticator} from './access.mjs';
import inert from './worker.mjs';
import {fixture,envConfig,epoch,token,certFetch,request,applySchema,jwk} from './test-support.mjs';

const email='owner@example.test';
const evidence={provider:'google',subject:'synthetic-google-owner',email,emailVerified:true,stableSubjectVerified:true,
 mfaVerified:true,independentMfaVerified:true,amr:['mfa'],connection:'synthetic-google',accountId:'synthetic-account',
 accessSubject:'access-session',sessionNonce:'synthetic-session-nonce',issuedAt:epoch,expiresAt:epoch+60,proofId:'one-use-proof'};
const jwt=(changes={})=>token({type:'app',email,identity_nonce:evidence.sessionNonce,syntheticEvidence:evidence,...changes});
const identity=()=>({email,user_uuid:'access-session',account_id:'synthetic-account',identity_nonce:evidence.sessionNonce,
 iat:epoch,idp:{connection:'synthetic-google',syntheticEvidence:structuredClone(evidence)}});
// SYNTHETIC ONLY: Access-signed test envelope supplies invented upstream proof.
// This verifies fixture integrity, NOT real Google/Cloudflare subject provenance.
const verifySynthetic=async({claims,data,tokenDigest})=>{
 assert.deepEqual(data.idp.syntheticEvidence,claims.syntheticEvidence);
 assert.equal(data.idp.connection,'synthetic-google');
 return {...data.idp.syntheticEvidence,tokenDigest};
};
function harness(db,options={}) {
 let data=identity(),status=200,calls=0;
 const env={...envConfig,DB:db,OWNER_ACCOUNT_ID:'synthetic-account',OWNER_CONNECTION_ID:'synthetic-google',OWNER_MEMBER_ID:'owner'};
 const fetcher=async(url,init)=>{
  if(url.endsWith('/certs')) return certFetch();
  calls++;
  assert.equal(url,env.ACCESS_ISSUER+'/cdn-cgi/access/get-identity');
  assert.equal(init.redirect,'manual'); assert.equal(init.cache,'no-store');
  assert.deepEqual(Object.keys(init.headers).sort(),['Accept','Cookie']);
  assert.match(init.headers.Cookie,/^CF_Authorization=ey/);
  return Response.json(data,{status});
 };
 const worker=createOwnerPreview({mode:'offline-test',fetcher,now:()=>epoch*1000,verifyUpstreamEvidence:verifySynthetic,...options});
 const get=(signed=jwt(),path='/owner-preview',extra={})=>worker.fetch(request(signed,path,env.APP_ORIGIN,{Cookie:`other=discard; CF_Authorization=${signed}`,...extra}),env);
 return {env,get,worker,fetcher,setData:value=>{data=value;},setStatus:value=>{status=value;},calls:()=>calls};
}
async function bindOwner(db) {
 await db.prepare("INSERT INTO identities VALUES('google',?,'owner',?)").bind(evidence.subject,epoch).run();
}

test('OFFLINE owner greeting needs pre-provisioned provider binding, current D1 owner and private HTML',async t=>{
 const f=await fixture(t); const h=harness(f.db);
 assert.equal((await h.get()).status,403);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM identities').first()).n,0);
 await bindOwner(f.db);
 const h2=harness(f.db); const result=await h2.get();
 assert.equal(result.status,200); assert.match(await result.text(),/Welcome, Owner/);
 assert.match(result.headers.get('Cache-Control'),/no-store/);assert.match(result.headers.get('Content-Security-Policy'),/default-src 'none'/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM members').first()).n,1);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM service_grants').first()).n,0);
});

test('OFFLINE current D1 denies revoked owner with already live token and new proof',async t=>{
 const f=await fixture(t); await bindOwner(f.db); const signed=jwt();
 assert.equal((await harness(f.db).get(signed)).status,200);
 await f.db.prepare("UPDATE members SET status='revoked' WHERE id='owner'").run();
 assert.equal((await harness(f.db).get(signed)).status,403);
});

test('OFFLINE role and explicit owner ID are authoritative',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 const h=harness(f.db);h.env.OWNER_MEMBER_ID='someone-else'; assert.equal((await h.get()).status,403);
 await f.db.prepare("UPDATE members SET role='member' WHERE id='owner'").run();
 assert.equal((await harness(f.db).get()).status,403);
});

test('OFFLINE same one-use evidence replay and concurrent replay deny',async t=>{
 const f=await fixture(t);await bindOwner(f.db);const h=harness(f.db);
 const responses=await Promise.all([h.get(),h.get()]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,403]);assert.equal((await h.get()).status,403);
});

test('OFFLINE signed JWT, exclusive audience, freshness and session checks',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 for(const changes of [{aud:['owner-test']},{aud:['members-test','owner-test']},{iss:'https://wrong.cloudflareaccess.com'},
  {sub:'different-session'},{email:'different@example.test'},{identity_nonce:'different-nonce'},
  {identity_nonce:undefined},{type:'org'},{service_token_id:'service'},{exp:epoch},{iat:epoch-301}]) {
  const h=harness(f.db);assert.equal((await h.get(jwt(changes))).status,403,JSON.stringify(changes));
 }
 const signed=jwt();assert.equal((await harness(f.db).get(signed.slice(0,-3)+'aaa')).status,403);
 const ownerAuth=createAuthenticator({fetcher:certFetch,now:()=>epoch*1000});
 await assert.rejects(()=>ownerAuth(request(signed),{...envConfig,ACCESS_AUDIENCE:'owner-test',OWNER_ACCESS_AUDIENCE:'members-test'}));
});

test('OFFLINE get-identity mismatches, refusal and incomplete fields deny',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 for(const change of [{account_id:'wrong'},{user_uuid:'wrong'},{identity_nonce:'wrong'},{email:'wrong@example.test'},
  {iat:epoch-1},{idp:{connection:'otp'}},{service_token_status:true},{idp:undefined}]) {
  const h=harness(f.db);h.setData({...identity(),...change}); assert.equal((await h.get()).status,403);
 }
 for(const status of [302,401,403,500]) {const h=harness(f.db);h.setStatus(status);assert.equal((await h.get()).status,403);}
});

test('OFFLINE missing authoritative subject, verified email or independent MFA denies',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 for(const changes of [{provider:'otp'},{provider:'apple'},{subject:''},{subject:undefined},{subject:'access-session'},{subject:email},{amr:undefined},{amr:[]},
  {emailVerified:false},{stableSubjectVerified:false},{independentMfaVerified:false},{mfaVerified:false},
  {connection:'wrong'},{accountId:'wrong'},{sessionNonce:'wrong'},{accessSubject:'wrong'},{email:'wrong@example.test'},
  {expiresAt:epoch},{expiresAt:epoch+61},{issuedAt:epoch+1},{issuedAt:epoch-61}]) {
  const syntheticEvidence={...evidence,...changes};const h=harness(f.db);const data=identity();data.idp.syntheticEvidence=syntheticEvidence;h.setData(data);
  assert.equal((await h.get(jwt({syntheticEvidence}))).status,403,JSON.stringify(changes));
 }
 const h=harness(f.db,{verifyUpstreamEvidence:async({data})=>({...data.idp.syntheticEvidence,tokenDigest:'wrong'})});
 assert.equal((await h.get()).status,403);
});

test('OFFLINE cookie cannot select another session; unrelated cookies never forwarded',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 for(const Cookie of ['',`CF_Authorization=${jwt({sub:'other'})}`,`CF_Authorization=${jwt()}; CF_Authorization=${jwt()}`,'x'.repeat(32769)]) {
  const h=harness(f.db);assert.equal((await h.get(jwt(),'/owner-preview',{Cookie})).status,403);assert.equal(h.calls(),0);
 }
 assert.equal((await harness(f.db).get()).status,200);
});

test('OFFLINE direct routes, unknown hosts, Origin, query and service tokens denied before identity fetch',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 for(const path of ['/','/api/owner','/api/services/jellyfin','/owner-preview?subject=spoof']) {
  const h=harness(f.db);assert.equal((await h.get(jwt(),path)).status,403);assert.equal(h.calls(),0);
 }
 for(const extra of [{Host:'unknown.test'},{Origin:'https://wrong.test'},{'Sec-Fetch-Site':'cross-site'},{'CF-Access-Client-Id':'service'}]) {
  const h=harness(f.db);assert.equal((await h.get(jwt(),'/owner-preview',extra)).status,403);assert.equal(h.calls(),0);
 }
 const h=harness(f.db);
 assert.equal((await h.worker.fetch(request(jwt(),'/owner-preview','https://unknown.test'),h.env)).status,403);
 const post=new Request(envConfig.APP_ORIGIN+'/owner-preview',{method:'POST',body:JSON.stringify(evidence)});
 assert.equal((await h.worker.fetch(post,h.env)).status,403);assert.equal(h.calls(),0);
});

test('OFFLINE absent verifier and production mode stay inactive; default portal unchanged',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 assert.equal((await harness(f.db,{verifyUpstreamEvidence:undefined}).get()).status,403);
 const h=harness(f.db,{mode:'production'});assert.equal((await h.get()).status,503);assert.equal(h.calls(),0);
 assert.equal((await inert.fetch(request(jwt()),h.env)).status,503);
 await assert.rejects(()=>createOwnerProof() (request(jwt()),h.env));
});

test('OFFLINE network, body limits, malformed responses and D1 errors reveal no input',async t=>{
 const f=await fixture(t);await bindOwner(f.db);
 const responses=[()=>{throw Error(email+' secret-token');},()=>new Promise(()=>{}),()=>new Response('x'.repeat(32769),{headers:{'Content-Type':'application/json'}}),
  ()=>new Response('{'),()=>Response.json(null),()=>Response.json({}),()=>new Response('{}',{status:302,headers:{Location:'https://other.test'}})];
 for(const fail of responses) {
  const h=harness(f.db,{fetcher:async(url)=>url.endsWith('/certs')?certFetch():fail()});const r=await h.get();
  assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/owner@example|secret-token|eyJ|synthetic/);
 }
 const h=harness({prepare(){throw Error(email);}});const r=await h.get();assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/owner@example/);
});

test('OFFLINE preview runs actual WebCrypto, cookie transport and D1 in workerd, outbound disabled',async t=>{
 const modules=['owner-preview','owner-proof','access','identity','repository','authorization','projection'].map(name=>({
  type:'ESModule',path:`portal/${name}.mjs`,contents:readFileSync(new URL(`./${name}.mjs`,import.meta.url),'utf8')
 }));
 const config={...envConfig,OWNER_ACCOUNT_ID:'synthetic-account',OWNER_CONNECTION_ID:'synthetic-google',OWNER_MEMBER_ID:'owner'};
 const entry=`import {createOwnerPreview} from './portal/owner-preview.mjs';
 let serial=0;
 const preview=createOwnerPreview({mode:'offline-test',now:()=>${epoch}000,
 fetcher:async(url,init)=>{
  if(url.endsWith('/certs')) return Response.json({keys:[${JSON.stringify(jwk)}]});
  if(url!==${JSON.stringify(envConfig.ACCESS_ISSUER+'/cdn-cgi/access/get-identity')} || !init.headers.Cookie.startsWith('CF_Authorization=') || init.redirect!=='manual') throw Error('denied');
  return Response.json(${JSON.stringify(identity())});
 },verifyUpstreamEvidence:async({claims,data,tokenDigest})=>{
  if(JSON.stringify(claims.syntheticEvidence)!==JSON.stringify(data.idp.syntheticEvidence)) throw Error('denied');
  return {...data.idp.syntheticEvidence,tokenDigest,proofId:'runtime-proof-'+(++serial)};
 }});
 export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);
 return preview.fetch(new Request(request,{headers}),{...env,...${JSON.stringify(config)}});}};`;
 const mf=new Miniflare(convertV4MiniflareOptions({name:'owner-preview-offline',log:new NoOpLog(),compatibilityDate:'2026-10-24',
  d1Databases:{DB:'owner-preview-synthetic'},modules:[{type:'ESModule',path:'entry.mjs',contents:entry},...modules],
  outboundService:()=>{throw Error('outbound prohibited');}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await applySchema(db);
 await db.prepare("INSERT INTO members VALUES('owner',?,'owner','active',?)").bind(email,epoch).run();await bindOwner(db);
 const signed=jwt();const headers={'Cf-Access-Jwt-Assertion':signed,Cookie:`CF_Authorization=${signed}`};
 const get=path=>mf.dispatchFetch(envConfig.APP_ORIGIN+path,{headers});
 assert.equal((await get('/owner-preview')).status,200);
 await db.prepare("UPDATE members SET status='revoked' WHERE id='owner'").run();
 assert.equal((await get('/owner-preview')).status,403);
 assert.equal((await get('/api/services/jellyfin')).status,403);
 assert.equal((await mf.dispatchFetch('https://unknown.test/owner-preview',{headers})).status,403);
});
