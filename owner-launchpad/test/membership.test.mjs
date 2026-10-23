import test from 'node:test';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
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
 return {storage,env,request,advance:ms=>{clock+=ms;},async form(view='pending') {
  const r=await request(`/membership/requests/?view=${view}`);const html=await r.text();
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
 assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/membership/requests/?view=invite-ready');assert.equal(f.storage.rows()[0].status,'approved');assert.equal(f.storage.rows()[0].revision,2);
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
  const f=fixture();const id=seed(f.storage,{status:from});const form=await f.form(from==='pending'?'pending':from==='approved'?'invite-ready':'history');const r=await f.post(id,fields(form,{status:to}),{headers:{Cookie:form.cookie}});
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
 const next=first.html.match(/href="([^"]+)"[^>]*>Older requests/)[1];const second=await (await f.request(next.replaceAll('&amp;','&'))).text();assert.equal((second.match(/<article>/g)||[]).length,3);assert.doesNotMatch(second,/Annual owner review due/);assert.match((await f.form('invite-ready')).html,/Annual owner review due/);
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
 const form=await f.form('invite-ready');
 assert.equal((form.html.match(/Annual owner review due/g)||[]).length,2);
 assert.match(form.html,/Keep for annual review/);
 assert.ok(f.storage.rows().every(row=>row.status==='approved' && row.revision===1));
 // Saving the annual review note retains approval and emits no status event.
 assert.equal((await f.post(id,fields(form,{status:'approved',note:'Annual review complete: retain'}),{headers:{Cookie:form.cookie}})).status,303);
 assert.equal(f.storage.sqlite.prepare("SELECT count(*) AS n FROM membership_notify_outbox WHERE kind='status'").get().n,0);
 const closeForm=await f.form('invite-ready');
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

const viewStatuses={pending:['pending'],'invite-ready':['approved'],history:['rejected','revoked','expired']};
const listPath=view=>`/membership/requests/?view=${view}`;
const older=html=>html.match(/href="([^"]+)">Older requests/)?.[1].replaceAll('&amp;','&');
const articles=html=>[...html.matchAll(/<article>.*?<\/article>/gs)].map(m=>m[0]);
test('views isolate exact statuses, private details and audit IDs; GET preserves every record and note',async()=>{
 const f=fixture(),ids={};
 for(const status of Object.values(viewStatuses).flat())ids[status]=seed(f.storage,{status,name:`Synthetic ${status}`,email:`${status}@example.test`,note:`Private ${status}`,reason:`Reason ${status}`});
 const before=JSON.stringify([f.storage.rows(),f.storage.audit()]);
 for(const view of Object.keys(viewStatuses)) {
  for(const path of [listPath(view),...(view==='pending'?['/membership/requests/']:[])]) {
   const r=await f.request(path),html=await r.text();assert.equal(r.status,200);
   assert.equal(r.headers.get('Referrer-Policy'),'same-origin');assert.equal(r.headers.get('Cache-Control'),'no-store');
   for(const status of Object.keys(ids))for(const detail of [ids[status],`${status}@example.test`,`Private ${status}`,`Reason ${status}`])assert.equal(html.includes(detail),viewStatuses[view].includes(status),`${view}: ${detail}`);
  }
 }
 assert.equal(JSON.stringify([f.storage.rows(),f.storage.audit()]),before);
});
test('strict view and cursor validation rejects empty, duplicate, unknown and injected query values',async()=>{
 const f=fixture();seed(f.storage);
 for(const query of ['view=','view=approved','view=Pending','view=__proto__','view=constructor',"view=pending%27%20OR%201=1--",'view=pending&view=pending','view=history&view=pending','view[]=pending','unexpected=x','view=pending&unexpected=x','before=','before=x','before=1&before=2','view=history&before=invalid']) {
  const r=await f.request(`/membership/requests/?${query}`);assert.equal(r.status,400,query);assert.doesNotMatch(await r.text(),/Synthetic|visitor@example.test|Private/);
 }
});
test('each empty view has mobile navigation, one current page link, keyboard focus and matching CSS CSP with no scripts',async()=>{
 const f=fixture();
 for(const [view,message] of [['pending','No pending applications.'],['invite-ready','No invite-ready applications.'],['history','No rejected, withdrawn, or expired applications.']]) {
  const r=await f.request(listPath(view)),html=await r.text();assert.ok(html.includes(message));
  const nav=html.match(/<nav aria-label="Membership request views">(.*?)<\/nav>/s)[1];
  assert.equal((nav.match(/<a /g)||[]).length,3);assert.equal((nav.match(/aria-current="page"/g)||[]).length,1);
  assert.match(nav,new RegExp(`href="${view==='pending'?'/membership/requests/':listPath(view).replace('?','\\?')}" aria-current="page"`));
  assert.doesNotMatch(html,/<script|\son\w+=|javascript:|role="tab"/i);
  assert.match(html,/name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html,/nav\{display:flex;flex-wrap:wrap;gap:8px/);assert.match(html,/nav a\{[^}]*min-height:44px/);assert.match(html,/a:focus-visible[^}]*outline:3px/);
  const css=html.match(/<style>(.*?)<\/style>/s)[1];const hash=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(css))).replaceAll('-','+').replaceAll('_','/');
  assert.ok(r.headers.get('Content-Security-Policy').includes(`style-src 'sha256-${hash}='`));assert.match(r.headers.get('Content-Security-Policy'),/script-src 'none'/);
 }
});
test('20 per page stable timestamp ties and newest-first order remain view scoped through all pages',async()=>{
 const f=fixture(),expected={};
 for(const [view,statuses] of Object.entries(viewStatuses)) {
  expected[view]=[];
  for(let i=0;i<45;i++)expected[view].push(seed(f.storage,{status:statuses[i%statuses.length],created:TIME-Math.floor(i/10)*DAY}));
  expected[view].sort((a,b)=>{const rows=f.storage.rows();return rows.find(r=>r.id===b).created_at-rows.find(r=>r.id===a).created_at || b.localeCompare(a);});
 }
 for(const view of Object.keys(viewStatuses)) {
  const seen=[];let path=listPath(view);
  for(const count of [20,20,5]) {
   const r=await f.request(path);assert.equal(r.status,200);const html=await r.text(),items=articles(html);assert.equal(items.length,count);
   seen.push(...items.map(item=>item.match(/Request ([a-f0-9-]{36})/)[1]));
   path=older(html);if(count===20){assert.ok(path.includes(`view=${view}&before=`));}else assert.equal(path,undefined);
  }
  assert.deepEqual(seen,expected[view]);
 }
});
for(const [from,to,view] of [['pending','pending','pending'],['pending','approved','invite-ready'],['pending','rejected','history'],['approved','approved','invite-ready'],['approved','revoked','history'],['rejected','rejected','history'],['revoked','revoked','history'],['expired','expired','history']])test(`save ${from} to ${to} redirects into ${view} and leaves other queues`,async()=>{
 const f=fixture(),id=seed(f.storage,{status:from}),form=await f.form(from==='pending'?'pending':from==='approved'?'invite-ready':'history');
 const r=await f.post(id,fields(form,{status:to}),{headers:{Cookie:form.cookie}});assert.equal(r.status,303);
 assert.equal(r.headers.get('Location'),view==='pending'?'/membership/requests/':listPath(view));
 for(const target of Object.keys(viewStatuses)) {
  const html=await (await f.request(listPath(target))).text();assert.equal(html.includes(id),target===view);assert.equal(html.includes('Synthetic owner note'),target===view);
 }
 assert.equal(f.storage.rows()[0].owner_note,'Synthetic owner note');
});

test('real local workerd/D1 executes filtered SQL, stable pagination and authenticated decision redirects without external services',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
  log:new NoOpLog(),name:'owner-queue-offline',compatibilityDate:'2026-09-29',d1Databases:['MEMBERSHIP_DB'],bindings:envBase,
  modules:[{type:'ESModule',path:'entry.mjs',contents:`
   import {createWorker} from './owner-launchpad/src/worker.mjs';
   export default createWorker({now:()=>${TIME},fetcher:async()=>Response.json({keys:[${JSON.stringify(jwk)}]})});
  `},...['owner-launchpad/src/worker.mjs','owner-launchpad/src/security.mjs','owner-launchpad/src/membership.mjs','membership/common.mjs'].map(path=>({type:'ESModule',path,contents:readFileSync(new URL('../../'+path,import.meta.url),'utf8')}))],
  outboundService:()=>{throw Error('External services forbidden');}
 }));
 try {
  const d=await mf.getD1Database('MEMBERSHIP_DB');
  // Preserve multi-statement triggers as single D1 prepared statements.
  const schema=readFileSync(new URL('../../membership/migrations/0001_membership.sql',import.meta.url),'utf8');
  const statements=schema.replace(/^--.*$/gm,'').trim().match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g).map(s=>s.trim()).filter(Boolean);
  await d.batch(statements.map(s=>d.prepare(s)));
  const expected={};
  for(const [view,statuses] of Object.entries(viewStatuses)) {
   expected[view]=[];
   for(let i=0;i<23;i++) {
    const id=crypto.randomUUID();expected[view].push(id);
    await d.prepare('INSERT INTO membership_requests(id,email_hash,name,email,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,id,'Synthetic runtime',`${view}@example.test`,'Offline only',statuses[i%statuses.length],TIME,TIME).run();
   }
   expected[view].sort().reverse();
  }
  const request=(path='/membership/requests/',options={})=>mf.dispatchFetch(new URL(path,envBase.APP_ORIGIN).href,{redirect:'manual',...options,headers:{'Cf-Access-Jwt-Assertion':owner,...options.headers}});
  for(const view of Object.keys(viewStatuses)) {
   const r=await request(listPath(view));assert.equal(r.status,200);assert.equal(r.headers.get('Referrer-Policy'),'same-origin');
   const html=await r.text(),second=await (await request(older(html))).text();
   assert.deepEqual([...articles(html),...articles(second)].map(item=>item.match(/Request ([a-f0-9-]{36})/)[1]),expected[view]);
   assert.equal(articles(html).length,20);assert.equal(articles(second).length,3);
  }
  for(const query of ['view=unknown','view=pending&view=history','extra=1'])assert.equal((await request(`/membership/requests/?${query}`)).status,400);
  const id=expected.pending[0],r=await request(),html=await r.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1],cookie=r.headers.get('Set-Cookie').split(';')[0];
  for(const [status,revision,view] of [['approved','1','invite-ready'],['revoked','2','history']]) {
   const saved=await request(`/membership/requests/${id}/decision`,{method:'POST',headers:{Origin:envBase.APP_ORIGIN,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded',Cookie:cookie},body:new URLSearchParams({csrf,revision,status,note:'Synthetic retained note'})});
   assert.equal(saved.status,303);assert.equal(saved.headers.get('Location'),listPath(view));
   assert.doesNotMatch(await (await request()).text(),new RegExp(id));
   assert.ok((await (await request(listPath(view))).text()).includes(id));
  }
  const row=await d.prepare('SELECT status,owner_note FROM membership_requests WHERE id=?').bind(id).first();assert.equal(row.status,'revoked');assert.equal(row.owner_note,'Synthetic retained note');
 } finally {await mf.dispose();}
});
