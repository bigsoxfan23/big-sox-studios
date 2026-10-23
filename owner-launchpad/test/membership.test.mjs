import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../src/worker.mjs';
import {b64} from '../src/security.mjs';
import {sweep} from '../../membership/common.mjs';
import {database,seed,TIME,DAY} from '../../tests/membership-fixtures.mjs';
const envBase={ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUDIENCE:'synthetic-audience',OWNER_EMAIL:'owner@example.test',APP_ORIGIN:'https://owner.example.test',MAIL_DESK_URL:'https://mail.example.test/',MEMBERSHIP_CSRF_KEY:'c'.repeat(32)};
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test-key',alg:'RS256'};
const encode=value=>b64(new TextEncoder().encode(JSON.stringify(value)));
async function token(changes={},signer=pair.privateKey) {
 const data=`${encode({alg:'RS256',kid:'test-key'})}.${encode({iss:envBase.ACCESS_ISSUER,aud:envBase.ACCESS_AUDIENCE,email:envBase.OWNER_EMAIL,iat:TIME/1000-1,nbf:TIME/1000-1,exp:TIME/1000+3600,...changes})}`;
 return `${data}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',signer,new TextEncoder().encode(data)))}`;
}
const owner=await token();
function fixture() {
 const storage=database(),env={...envBase,MEMBERSHIP_DB:storage}; let clock=TIME;
 const worker=createWorker({now:()=>clock,fetcher:async()=>Response.json({keys:[jwk]})});
 const request=(path='/membership/requests/',{jwt=owner,headers={},...options}={})=>worker.fetch(new Request(new URL(path,env.APP_ORIGIN),{...options,headers:{...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),...headers}}),env);
 return {storage,env,request,advance:ms=>{clock+=ms;},async form() {
  const r=await request();const html=await r.text();
  return {csrf:html.match(/name="csrf" value="([^"]+)"/)?.[1],cookie:r.headers.get('Set-Cookie')?.split(';')[0],html};
 },async post(id,fields,options={}) {
  return request(`/membership/requests/${id}/decision`,{method:'POST',...options,headers:{Origin:env.APP_ORIGIN,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded',...options.headers},body:new URLSearchParams(fields)});
 }};
}
const fields=(form,extras={})=>({csrf:form.csrf,revision:'1',status:'approved',note:'Synthetic owner note',...extras});
test('only authenticated queue GET uses same-origin referrer policy for Safari form navigation',async()=>{
 const f=fixture();seed(f.storage);
 const queue=await f.request();assert.equal(queue.status,200);assert.equal(queue.headers.get('Referrer-Policy'),'same-origin');
 assert.match(await queue.text(),/<form method="post" action="\/membership\/requests\/[a-f0-9-]{36}\/decision">/);
 for(const [path,options,status] of [
  ['/',{},200],
  ['/membership/requests/',{method:'HEAD'},200],
  ['/membership/requests/',{jwt:null},401],
  ['/membership/requests/',{headers:{Origin:'null'}},403],
  ['/membership/requests/',{method:'POST'},405],
  ['/membership/requests/?before=invalid',{},400],
  ['/membership/debug',{},404],
 ]) {
  const response=await f.request(path,options);assert.equal(response.status,status);assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
 }
 delete f.env.MEMBERSHIP_CSRF_KEY;
 const unavailable=await f.request();assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('Referrer-Policy'),'no-referrer');
});
for(const [name,origin,site] of [
 ['null Origin','null','same-origin'],
 ['absent Origin',undefined,'same-origin'],
 ['cross-site Origin','https://evil.example.test','same-origin'],
 ['cross-site Fetch-Site',envBase.APP_ORIGIN,'cross-site'],
]) test(`authenticated decision with valid CSRF rejects ${name} without mutation`,async()=>{
 const f=fixture(),id=seed(f.storage),form=await f.form();
 const headers={Cookie:form.cookie,'Sec-Fetch-Site':site,'Content-Type':'application/x-www-form-urlencoded'};
 if(origin!==undefined)headers.Origin=origin;
 const response=await f.request(`/membership/requests/${id}/decision`,{method:'POST',headers,body:new URLSearchParams(fields(form))});
 assert.equal(response.status,403);assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
 if(origin!==undefined && origin!==envBase.APP_ORIGIN)assert.equal(await response.text(),'Forbidden');
 const row=f.storage.rows()[0];assert.equal(row.status,'pending');assert.equal(row.revision,1);assert.equal(row.owner_note,'');assert.equal(f.storage.audit().length,1);assert.equal(f.storage.writes,0);
});
test('owner queue requires exact authenticated owner and rejects anonymous, forged, wrong audience/nonowner',async()=>{
 const f=fixture();const forgedPair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 for(const jwt of [null,'bad',await token({aud:'other'}),await token({email:'other@example.test'}),await token({},forgedPair.privateKey)]) {
  for(const path of ['/membership/requests/','/membership/requests/'+crypto.randomUUID()+'/decision']) assert.equal((await f.request(path,{jwt})).status,401);
 }
 assert.equal(f.storage.writes,0);
});
test('queue escapes applicant fields and owner notes; signed HttpOnly host cookie and narrow CSP',async()=>{
 const f=fixture();seed(f.storage,{name:'<img src=x onerror=alert(1)>',reason:'</p><script>evil</script>',note:'</textarea><script>note</script>'});
 const r=await f.request();const html=await r.text();assert.equal(r.status,200);
 assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('</textarea><script>'));
 assert.match(html,/&lt;script&gt;evil/);assert.match(html,/&lt;\/textarea&gt;/);
 const cookie=r.headers.get('Set-Cookie');assert.match(cookie,/^__Host-/);for(const value of ['Secure','HttpOnly','SameSite=Strict','Path=/','Max-Age=900'])assert.ok(cookie.includes(value));
 assert.match(r.headers.get('Content-Security-Policy'),/form-action 'self'/);assert.match(r.headers.get('Content-Security-Policy'),/script-src 'none'/);
 const css=html.match(/<style>(.*?)<\/style>/s)[1]; const hash=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(css))).replaceAll('-','+').replaceAll('_','/');
 assert.ok(r.headers.get('Content-Security-Policy').includes(hash));
 for(const secret of [owner,envBase.OWNER_EMAIL,envBase.MEMBERSHIP_CSRF_KEY])assert.ok(!html.includes(secret));
});
test('valid double-submit owner/session CSRF changes status and note with atomic audit',async()=>{
 const f=fixture();const id=seed(f.storage);const form=await f.form();const response=await f.post(id,fields(form),{headers:{Cookie:form.cookie}});
 assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/membership/requests/');assert.equal(f.storage.rows()[0].status,'approved');assert.equal(f.storage.rows()[0].revision,2);
 const audit=f.storage.audit();assert.equal(audit.length,2);assert.equal(audit[1].from_status,'pending');assert.equal(audit[1].to_status,'approved');assert.ok(!JSON.stringify(audit).includes('Synthetic owner note'));
});
for(const mode of ['missing cookie','missing token','cookie mismatch','tampered signature','forged cookie token','expired','other session','wrong origin','cross-site','same-site','duplicate cookie'])
 test(`CSRF ${mode} rejects without mutation`,async()=>{
  const f=fixture();const id=seed(f.storage);const form=await f.form();let data=fields(form),headers={Cookie:form.cookie},jwt=owner;
  if(mode==='missing cookie')delete headers.Cookie;
  if(mode==='missing token')delete data.csrf;
  if(mode==='cookie mismatch')headers.Cookie='__Host-bss-membership-csrf=other';
  if(mode==='tampered signature')data.csrf=data.csrf.slice(0,-2)+'00';
  if(mode==='forged cookie token'){data.csrf=`${TIME+900000}.${crypto.randomUUID()}.${'0'.repeat(64)}`;headers.Cookie=`__Host-bss-membership-csrf=${data.csrf}`;}
  if(mode==='expired')f.advance(900000);
  if(mode==='other session')jwt=await token({iat:TIME/1000-2});
  if(mode==='wrong origin')headers.Origin='https://evil.example.test';
  if(mode==='cross-site')headers['Sec-Fetch-Site']='cross-site';
  if(mode==='same-site')headers['Sec-Fetch-Site']='same-site';
  if(mode==='duplicate cookie')headers.Cookie+='; '+headers.Cookie;
  assert.ok([400,403].includes((await f.post(id,data,{headers,jwt})).status));assert.equal(f.storage.rows()[0].revision,1);assert.equal(f.storage.audit().length,1);
 });
test('stale revision and nonexistent random ID share conflict; concurrent decisions only mutate once',async()=>{
 const f=fixture();const id=seed(f.storage);const form=await f.form(),options={headers:{Cookie:form.cookie}};
 const responses=await Promise.all([f.post(id,fields(form),options),f.post(id,fields(form,{status:'rejected'}),options)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[303,409]);assert.equal(f.storage.audit().length,2);
 const stale=await f.post(id,fields(form),options),unknown=await f.post(crypto.randomUUID(),fields(form),options);
 assert.equal(stale.status,409);assert.equal(unknown.status,409);assert.equal(await stale.text(),await unknown.text());
});
for(const [from,to,allowed] of [['pending','approved',true],['pending','rejected',true],['pending','revoked',false],['approved','revoked',true],['approved','rejected',false],['rejected','approved',false],['revoked','pending',false],['expired','approved',false]])
 test(`transition ${from} → ${to}`,async()=>{
  const f=fixture();const id=seed(f.storage,{status:from});const form=await f.form();const r=await f.post(id,fields(form,{status:to}),{headers:{Cookie:form.cookie}});
  assert.equal(r.status,allowed?303:409);const row=f.storage.rows()[0];assert.equal(row.status,allowed?to:from);if(allowed && ['rejected','revoked'].includes(to))assert.equal(row.closed_at,TIME);
 });
test('safe note-only save, strict max/control validation and no edits after PII cleared',async()=>{
 const f=fixture();const id=seed(f.storage);const form=await f.form(),options={headers:{Cookie:form.cookie}};
 for(const note of ['x'.repeat(501),'line\ncontrol','\u202econtrol'])assert.equal((await f.post(id,fields(form,{note}),options)).status,400);
 assert.equal((await f.post(id,fields(form,{status:'pending',note:'<safe text>'}),options)).status,303);
 const row=f.storage.rows()[0];assert.equal(row.owner_note,'<safe text>');assert.equal(row.status,'pending');assert.equal(f.storage.audit().at(-1).event,'note_updated');
 f.storage.sqlite.prepare('UPDATE membership_requests SET pii_cleared_at=? WHERE id=?').run(TIME,id);
 assert.equal((await f.post(id,fields(form,{revision:'2'}),options)).status,409);
});
test('bounded stable pagination newest-first with equal timestamp tie breaks; annual invite-ready flag',async()=>{
 const f=fixture();for(let i=0;i<23;i++)seed(f.storage,{name:`Synthetic ${i}`,created:TIME-i*DAY});
 seed(f.storage,{status:'approved',created:TIME-365*DAY});
 const first=await f.form();assert.equal((first.html.match(/<article>/g)||[]).length,20);assert.ok(first.html.indexOf('Synthetic 0')<first.html.indexOf('Synthetic 1'));
 const next=first.html.match(/href="([^"]+)"[^>]*>Older requests/)[1];const second=await (await f.request(next)).text();assert.equal((second.match(/<article>/g)||[]).length,4);assert.match(second,/Annual owner review due/);
 for(const query of ['?limit=9999','?before=invalid','?before=1&before=2'])assert.equal((await f.request('/membership/requests/'+query)).status,400);
});
test('third home card includes pending count and existing shortcuts',async()=>{const f=fixture();seed(f.storage);seed(f.storage,{status:'rejected'});const html=await (await f.request('/')).text();assert.match(html,/Pending: 1/);assert.ok(html.includes(envBase.MAIL_DESK_URL));assert.match(html,/https:\/\/bigsoxstudios.com\/admin\//);});
test('method denials, HEAD semantics, unknown paths and missing membership config fail closed',async()=>{
 const f=fixture();for(const method of ['POST','PUT','DELETE','OPTIONS'])assert.equal((await f.request('/membership/requests/',{method})).status,405);
 const id=seed(f.storage);assert.equal((await f.request(`/membership/requests/${id}/decision`)).status,405);
 const head=await f.request('/membership/requests/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 assert.equal((await f.request('/membership/debug')).status,404);
 delete f.env.MEMBERSHIP_CSRF_KEY;assert.equal((await f.request()).status,503);assert.equal((await f.request('/')).status,200);
});
test('audit failure rolls back owner decision and note atomically',async()=>{
 const f=fixture(),id=seed(f.storage),form=await f.form();
 f.storage.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 const r=await f.post(id,fields(form),{headers:{Cookie:form.cookie}});assert.equal(r.status,503);assert.equal(f.storage.rows()[0].status,'pending');assert.equal(f.storage.rows()[0].revision,1);assert.equal(f.storage.rows()[0].owner_note,'');
});

test('annual review boundary retains invite-ready details; only explicit owner withdrawal starts clearing',async()=>{
 const f=fixture();
 seed(f.storage,{status:'approved',created:TIME-365*DAY+1});
 seed(f.storage,{status:'approved',created:TIME-365*DAY});
 const id=seed(f.storage,{status:'approved',created:TIME-800*DAY,note:'Keep for annual review'});
 await sweep(f.env,TIME);
 const form=await f.form();
 assert.equal((form.html.match(/Annual owner review due/g)||[]).length,2);
 assert.match(form.html,/Keep for annual review/);
 assert.ok(f.storage.rows().every(row=>row.status==='approved' && row.revision===1));
 // Saving the annual review note retains approval and emits no status event.
 assert.equal((await f.post(id,fields(form,{status:'approved',note:'Annual review complete: retain'}),{headers:{Cookie:form.cookie}})).status,303);
 assert.equal(f.storage.sqlite.prepare("SELECT count(*) AS n FROM membership_notify_outbox WHERE kind='status'").get().n,0);
 const closeForm=await f.form();
 assert.equal((await f.post(id,fields(closeForm,{revision:'2',status:'revoked'}),{headers:{Cookie:closeForm.cookie}})).status,303);
 const events=f.storage.sqlite.prepare("SELECT * FROM membership_notify_outbox WHERE kind='status'").all();
 assert.equal(events.length,1);assert.equal(events[0].application_id,id);
 await sweep(f.env,TIME+30*DAY-1);
 assert.equal(f.storage.rows().find(row=>row.id===id).email,'visitor@example.test');
 await sweep(f.env,TIME+30*DAY);
 const closed=f.storage.rows().find(row=>row.id===id);
 assert.equal(closed.status,'revoked');assert.equal(closed.closed_at,TIME);
 for(const key of ['name','email','reason','owner_note'])assert.equal(closed[key],null);
});
