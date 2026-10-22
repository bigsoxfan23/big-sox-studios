import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../membership/worker.mjs';
import {database,TIME} from './membership-fixtures.mjs';
const origin = 'https://bigsoxstudios.com';
const valid = {name:'Synthetic Visitor',email:'visitor@example.test',reason:'I know the studio through a synthetic example.',acknowledgement:true,token:'synthetic-token'};
function fixture({verdict={},fetcher,limit=true,config={},workerOptions={}}={}) {
 const storage=database(), calls=[], keys=[], failures=[];
 const env={MEMBERSHIP_DB:storage,EMAIL_HMAC_KEY:'e'.repeat(32),RATE_HMAC_KEY:'r'.repeat(32),TURNSTILE_SECRET_KEY:'s'.repeat(32),REQUEST_LIMITER:{async limit({key}) {keys.push(key); return {success:limit};}},ASSETS:{fetch:async()=>new Response('ASSET')},...config};
 const worker=createWorker({now:()=>TIME,logFailure:step=>failures.push(step),fetcher:async (...args)=>{calls.push(args); return fetcher ? fetcher(...args) : Response.json({success:true,hostname:'bigsoxstudios.com',action:'membership_request',challenge_ts:new Date(TIME).toISOString(),...verdict});},...workerOptions});
 return {env,storage,calls,keys,failures,worker,async request(data=valid,{headers={},method='POST',path='/api/membership/requests',raw,...options}={}) {
  return worker.fetch(new Request(new URL(path,origin),{method,headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',...headers},...(!['GET','HEAD'].includes(method) ? {body:raw ?? JSON.stringify(data)} : {}),...options}),env);
 }};
}
test('valid submission normalizes identity; HMAC dedupe, same generic response and no changes on duplicate',async()=>{
 const f=fixture(); const first=await f.request({...valid,email:'  VISITOR@Example.Test ',name:' Synthetic Visitor '});
 assert.equal(first.status,200); assert.equal(f.storage.rows().length,1);
 const before=f.storage.rows()[0]; assert.equal(before.email,'visitor@example.test'); assert.match(before.email_hash,/^[a-f0-9]{64}$/); assert.ok(!before.email_hash.includes('visitor'));
 f.storage.sqlite.prepare("UPDATE membership_requests SET status='rejected' WHERE id=?").run(before.id);
 const second=await f.request({...valid,name:'Different identity',reason:'Attempted replacement'});
 assert.equal(second.status,200); assert.equal(await first.text(),await second.text());
 assert.deepEqual({...f.storage.rows()[0]},{...before,status:'rejected'}); assert.equal(f.storage.audit().length,1); assert.equal(f.calls.length,2);
 const [url,options]=f.calls[0]; assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify'); assert.equal(options.body.get('remoteip'),null); assert.equal(options.redirect,'manual');
 assert.equal(f.keys[0].length,64); assert.equal(f.keys[0],f.keys[2]); assert.ok(!f.keys[0].includes('192.0.2.1'));
 assert.equal(second.headers.get('Cache-Control'),'no-store'); assert.equal(second.headers.get('Access-Control-Allow-Origin'),null);
});
test('concurrent duplicate inserts have one identity and one audit event',async()=>{
 const f=fixture(); const responses=await Promise.all(Array.from({length:20},(_,i)=>f.request({...valid,token:`token-${i}`})));
 assert.ok(responses.every(r=>r.status===200)); assert.equal(new Set(await Promise.all(responses.map(r=>r.text()))).size,1);
 assert.equal(f.storage.rows().length,1); assert.equal(f.storage.audit().length,1); assert.equal(f.calls.length,20);
});
for(const [name,verdict] of [
 ['false',{success:false}],['truthy',{success:'true'}],['wrong hostname',{hostname:'www.bigsoxstudios.com'}],['wrong action',{action:'other'}],
 ['expired',{challenge_ts:new Date(TIME-300000).toISOString()}],['future',{challenge_ts:new Date(TIME+1).toISOString()}],['missing timestamp',{challenge_ts:undefined}],['invalid timestamp',{challenge_ts:'bad'}],
 ['replayed',{success:false,'error-codes':['timeout-or-duplicate']}]
]) test(`Turnstile ${name} fails with no D1 writes`,async()=>{const f=fixture({verdict}); assert.equal((await f.request()).status,400); assert.equal(f.storage.writes,0);});
for(const [name,fetcher] of [['network',async()=>{throw Error('sensitive-error');}],['HTTP 500',async()=>new Response('',{status:500})],['bad JSON',async()=>new Response('{')],['oversized response',async()=>new Response('x'.repeat(16385))]])
 test(`Siteverify ${name} fails closed`,async()=>{const f=fixture({fetcher});const r=await f.request();assert.equal(r.status,503);assert.ok(!(await r.text()).includes('sensitive-error'));assert.equal(f.storage.writes,0);});
test('D1 failure never produces success',async()=>{const f=fixture({config:{MEMBERSHIP_DB:{prepare(){throw Error('private');}}}}); assert.equal((await f.request()).status,503);});
for(const field of ['MEMBERSHIP_DB','EMAIL_HMAC_KEY','RATE_HMAC_KEY','TURNSTILE_SECRET_KEY','REQUEST_LIMITER'])
 test(`missing ${field} fails closed before Siteverify`,async()=>{const f=fixture({config:{[field]:undefined}});assert.equal((await f.request()).status,503); assert.equal(f.calls.length,0);assert.equal(f.storage.writes,0);});
test('public test secret is explicitly rejected',async()=>{const f=fixture({config:{TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA'}}); assert.equal((await f.request()).status,503);assert.equal(f.calls.length,0);});
test('native rate limit failure/exception never calls Siteverify or D1; retry is truthful',async()=>{
 const f=fixture({limit:false}); const response=await f.request(); assert.equal(response.status,429); assert.equal(response.headers.get('Retry-After'),'60'); assert.equal(f.storage.writes,0); assert.equal(f.calls.length,0);
 f.env.REQUEST_LIMITER.limit=async()=>{throw Error('private');}; assert.equal((await f.request()).status,503);
});
for(const ip of ['', 'unknown','999.1.1.1','192.0.2.1, 192.0.2.2',':::', '1:2','01.2.3.4']) test(`invalid CF IP ${ip || 'missing'} cannot use spoofed forwarded IP`,async()=>{
 const f=fixture(); const r=await f.request(valid,{headers:{'CF-Connecting-IP':ip,'X-Forwarded-For':'192.0.2.1'}});assert.equal(r.status,403);assert.equal(f.keys.length,0);assert.equal(f.storage.writes,0);
});
test('IPv6 works and forwarded headers do not affect limiter key',async()=>{const f=fixture();assert.equal((await f.request(valid,{headers:{'CF-Connecting-IP':'2001:db8::1'}})).status,200);await f.request(valid,{headers:{'CF-Connecting-IP':'2001:db8::1','X-Forwarded-For':'192.0.2.99'}});assert.equal(f.keys[0],f.keys[2]);});
for(const headers of [{Origin:'https://evil.example.test'},{Origin:'null'},{Origin:''},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'},{'Content-Type':'text/plain'}])
 test(`origin/content policy ${JSON.stringify(headers)}`,async()=>{const f=fixture();assert.ok([403,415].includes((await f.request(valid,{headers})).status));assert.equal(f.calls.length,0);assert.equal(f.storage.writes,0);});
test('URL production origin is mandatory even with correct Origin header',async()=>{const f=fixture();assert.equal((await f.request(valid,{path:'https://www.bigsoxstudios.com/api/membership/requests'})).status,403);});
for(const data of [{...valid,name:'x\nY'},{...valid,name:'\u202eevil'},{...valid,name:''},{...valid,name:'x'.repeat(101)},{...valid,email:'a@bad'},{...valid,email:'a..b@example.test'},{...valid,email:'a@example.test\r'},{...valid,reason:'x'.repeat(501)},{...valid,acknowledgement:'true'},{...valid,token:''},{...valid,token:'<bad>'},{...valid,token:'x'.repeat(2049)},null,[]])
 test(`reject invalid input ${JSON.stringify(data).slice(0,90)}`,async()=>{const f=fixture();assert.equal((await f.request(data)).status,400);assert.equal(f.calls.length,0);assert.equal(f.storage.writes,0);});
test('body byte bounds enforce both header and actual stream',async()=>{const f=fixture();for(const options of [{raw:'x'.repeat(8193)},{headers:{'Content-Length':'8193'}},{headers:{'Content-Length':'0'},raw:'x'.repeat(8193)}]) assert.equal((await f.request(valid,options)).status,413);assert.equal(f.storage.writes,0);});
test('GET/HEAD and all other methods cannot expose status/list; unknown API routes do not fall through',async()=>{
 const f=fixture();for(const method of ['GET','HEAD','PUT','OPTIONS','DELETE','PATCH']) {const r=await f.request(undefined,{method});assert.equal(r.status,405);if(method==='HEAD') assert.equal(await r.text(),'');}
 for(const path of ['/api/membership/requests/id','/api/membership/requests?email=synthetic','/api/membership/private']) assert.equal((await f.request(valid,{path})).status,404);
 assert.equal(f.storage.writes,0);assert.equal(f.calls.length,0);
});
test('nonmembership requests use exact ASSETS fallback',async()=>{const f=fixture();for(const path of ['/','/admin/','/members/','/members/request/','/404','/api/other'])assert.equal(await (await f.request(undefined,{method:'GET',path})).text(),'ASSET');});
test('malformed JSON is a retryable client error without D1 writes',async()=>{const f=fixture();assert.equal((await f.request(valid,{raw:'{' })).status,400);assert.equal(f.calls.length,0);assert.equal(f.storage.writes,0);});
test('Siteverify single-use replay fails, including on a duplicate, then fresh token receives same generic confirmation',async()=>{
 const consumed=new Set();const f=fixture({fetcher:async(_url,options)=>{const token=options.body.get('response'),replay=consumed.has(token);consumed.add(token);return Response.json({success:!replay,hostname:'bigsoxstudios.com',action:'membership_request',challenge_ts:new Date(TIME).toISOString()});}});
 const first=await f.request();assert.equal(first.status,200);assert.equal((await f.request()).status,400);const duplicate=await f.request({...valid,token:'fresh-token'});assert.equal(duplicate.status,200);assert.equal(await duplicate.text(),await first.text());assert.equal(f.storage.rows().length,1);assert.equal(f.storage.audit().length,1);
});
test('supplemental email rate limiter protects Siteverify across different IPs with non-PII keys',async()=>{
 const f=fixture();let count=0;f.env.REQUEST_LIMITER.limit=async()=>({success:++count!==2});assert.equal((await f.request()).status,429);assert.equal(f.calls.length,0);assert.equal(f.storage.writes,0);
});
test('false D1 success and atomic audit failure cannot produce confirmation or un-audited row',async()=>{
 const f=fixture({config:{MEMBERSHIP_DB:{prepare(){return {bind(){return this;},async run(){return {success:false};}};}}}});assert.equal((await f.request()).status,503);
 const actual=fixture();actual.storage.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 assert.equal((await actual.request()).status,503);assert.equal(actual.storage.rows().length,0);
});

for (const [name,fetcher,step] of [
 ['network',async()=>{throw Object.assign(Error('PRIVATE_EXCEPTION'),{step:'PRIVATE_STEP',status:502});},'siteverify_fetch'],
 ['timeout',async()=>{throw new DOMException('PRIVATE_TIMEOUT','TimeoutError');},'siteverify_fetch'],
 ['HTTP failure',async()=>new Response('PRIVATE_BODY',{status:500,headers:{'X-Private':'PRIVATE_HEADER'}}),'siteverify_status'],
 ['redirect',async()=>new Response(null,{status:302,headers:{Location:'https://private.example.test'}}),'siteverify_status'],
 ['null body',async()=>new Response(null),'siteverify_body'],
 ['declared oversize',async()=>new Response('{}',{headers:{'Content-Length':'16385'}}),'siteverify_body'],
 ['actual oversize',async()=>new Response('x'.repeat(16385)),'siteverify_body'],
 ['stream failure',async()=>new Response(new ReadableStream({start(controller){controller.error(Error('PRIVATE_STREAM'));}})),'siteverify_body'],
 ['invalid UTF-8',async()=>new Response(new Uint8Array([0xff])),'siteverify_body'],
 ['invalid JSON',async()=>new Response('PRIVATE_RESPONSE'),'siteverify_json'],
 ['null JSON',async()=>Response.json(null),'siteverify_verdict']
]) test(`503 logging only records fixed stage for ${name}`,async t=>{
 const logs=[];
 t.mock.method(console,'error',(...args)=>logs.push(args));
 const f=fixture({fetcher,workerOptions:{logFailure:undefined}});
 const data={...valid,name:'PRIVATE_NAME',email:'private_email@example.test',reason:'PRIVATE_REASON',token:'PRIVATE_TOKEN'};
 f.env.TURNSTILE_SECRET_KEY='PRIVATE_TURNSTILE_SECRET'.repeat(2);
 f.env.EMAIL_HMAC_KEY='PRIVATE_EMAIL_SECRET'.repeat(2);
 f.env.RATE_HMAC_KEY='PRIVATE_RATE_SECRET'.repeat(2);
 const r=await f.request(data,{headers:{'CF-Connecting-IP':'192.0.2.234','X-Private':'PRIVATE_REQUEST_HEADER'}});
 assert.equal(r.status,503);
 assert.deepEqual(logs,[['membership_request_5xx',step]]);
 assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|private_email|192\.0\.2\.234|example\.test/);
 assert.doesNotMatch(await r.text(),/PRIVATE|siteverify|membership_request_5xx/);
 assert.equal(f.storage.writes,0);
});
test('configuration, supplemental limiter, and D1 exceptions have distinct fixed stages',async()=>{
 const missing=fixture({config:{TURNSTILE_SECRET_KEY:undefined}});
 assert.equal((await missing.request()).status,503);assert.deepEqual(missing.failures,['configuration']);
 const limited=fixture();let count=0;
 limited.env.REQUEST_LIMITER.limit=async()=>{if(++count===2)throw Error('PRIVATE');return {success:true};};
 assert.equal((await limited.request()).status,503);assert.deepEqual(limited.failures,['email_rate_limit']);
 assert.equal(limited.calls.length,0);
 const failed=fixture({config:{MEMBERSHIP_DB:{prepare(){throw Error('PRIVATE');}}}});
 assert.equal((await failed.request()).status,503);assert.deepEqual(failed.failures,['database_insert']);
});
test('ordinary validation failures, rate limits, success and duplicates do not log',async()=>{
 const f=fixture();assert.equal((await f.request({})).status,400);
 assert.equal((await f.request()).status,200);assert.equal((await f.request()).status,200);
 assert.deepEqual(f.failures,[]);
 const rejected=fixture({verdict:{success:false}});assert.equal((await rejected.request()).status,400);assert.deepEqual(rejected.failures,[]);
 const limited=fixture({limit:false});assert.equal((await limited.request()).status,429);assert.deepEqual(limited.failures,[]);
});
test('logging failure does not alter the generic 503 response',async()=>{
 const f=fixture({fetcher:async()=>{throw Error('PRIVATE');},workerOptions:{logFailure:()=>{throw Error('PRIVATE_LOGGER');}}});
 const ordinary=fixture({fetcher:async()=>new Response('',{status:500})});
 const r=await f.request();assert.equal(r.status,503);assert.equal(await r.text(),await (await ordinary.request()).text());
});
test('JSON parsing remains independent of response content-type; text/html errors fail closed',async()=>{
 for (const headers of [{},{'Content-Type':'text/plain'},{'Content-Type':'application/json; charset=utf-8'}]) {
  const f=fixture({fetcher:async()=>new Response('{"success":false}',{headers})});
  assert.equal((await f.request()).status,400);assert.deepEqual(f.failures,[]);assert.equal(f.storage.writes,0);
 }
 const f=fixture({fetcher:async()=>new Response('<html>PRIVATE_ERROR</html>',{headers:{'Content-Type':'text/html'}})});
 assert.equal((await f.request()).status,503);assert.deepEqual(f.failures,['siteverify_json']);assert.equal(f.storage.writes,0);
});
