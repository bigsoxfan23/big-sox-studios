import test from 'node:test';
import assert from 'node:assert/strict';
import {welcomeFixture,seed} from './welcome-fixture.mjs';
async function ready(){const f=await welcomeFixture(),id=seed(f.storage,{status:'approved'}),setup=`/membership/requests/${id}/setup`,path=`/membership/requests/${id}/welcome`;
 const initial=await f.form(setup);assert.equal((await f.post(setup,initial,{request_revision:'1',action:'start',confirm:'yes'})).status,303);
 const linked=await f.form(setup);assert.equal((await f.post(setup,linked,{request_revision:'1',revision:'1',action:'jellyfin-ready',confirm:'yes',username:'synthetic',url:'https://jellyfin.example.test/'})).status,303);
 return {...f,id,setup,path};}
const fields={action:'preview',request_revision:'1',message:'Hello synthetic friend!',password:'transient-synthetic-secret'};
function extract(html,name){return html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];}
test('protected welcome preview→explicit simulation→durable state, with no body/password persistence or activation',async()=>{
 const f=await ready(),compose=await f.form(f.path);assert.equal(compose.r.status,200);assert.match(compose.html,/Preview welcome/);
 const preview=await f.post(f.path,compose,fields),html=await preview.text();assert.equal(preview.status,200);assert.match(html,/transient-synthetic-secret/);assert.match(preview.headers.get('Cache-Control'),/no-store/);assert.match(preview.headers.get('Content-Security-Policy'),/script-src 'none'/);
 const confirmed={cookie:preview.headers.get('Set-Cookie').split(';')[0],csrf:extract(html,'csrf')},send={...fields,action:'send',review:extract(html,'review'),confirm:'yes'};
 const result=await f.post(f.path,confirmed,send);assert.equal(result.status,200);const body=await result.text();assert.match(body,/Simulation recorded/);assert.doesNotMatch(body,/transient-synthetic-secret|Hello synthetic friend/);
 assert.equal(f.portal.prepare('SELECT state FROM welcome_intents').get().state,'accepted');assert.equal((await f.post(f.path,confirmed,send)).status,409);
 const stored=JSON.stringify(f.portal.prepare('SELECT * FROM welcome_intents').all())+JSON.stringify(f.portal.prepare('SELECT * FROM audit_events').all());assert.doesNotMatch(stored,/transient-synthetic-secret|Hello synthetic friend/);
 assert.equal(f.portal.prepare("SELECT status FROM members WHERE role='member'").get().status,'pending');for(const t of ['identities','service_grants'])assert.equal(f.portal.prepare(`SELECT count(*) n FROM ${t}`).get().n,0);
 assert.match((await f.form(f.path)).html,/already|accepted/);
});
test('missing or changed proof/content/confirmation, CSRF, Origin and unknown fields cannot dispatch',async()=>{
 for(const kind of ['confirm','proof','password','csrf','origin','extra','stale']){
  const f=await ready(),compose=await f.form(f.path),preview=await f.post(f.path,compose,fields),html=await preview.text(),form={cookie:preview.headers.get('Set-Cookie').split(';')[0],csrf:extract(html,'csrf')};
  const send={...fields,action:'send',review:extract(html,'review'),confirm:'yes'},headers={};
  if(kind==='confirm')send.confirm='no';if(kind==='proof')send.review='wrong';if(kind==='password')send.password='different';if(kind==='csrf')form.csrf='wrong';if(kind==='origin')headers.Origin='https://evil.example.test';if(kind==='extra')send.mode='live';if(kind==='stale')send.request_revision='2';
  assert.equal((await f.post(f.path,form,send,headers)).status,kind==='origin'?403:409,kind);assert.equal(f.portal.prepare('SELECT count(*) n FROM welcome_intents').get().n,0);
 }
});
test('welcome needs manual readiness; disabled flag and wrong Owner deny without side effects',async()=>{
 const f=await welcomeFixture(),id=seed(f.storage,{status:'approved'}),setup=`/membership/requests/${id}/setup`,path=`/membership/requests/${id}/welcome`,page=await f.form(setup);
 await f.post(setup,page,{request_revision:'1',action:'start',confirm:'yes'});const r=await f.request(path);assert.equal(r.status,200);assert.match(await r.text(),/Complete manual Jellyfin setup/);
 f.env.PORTAL_WELCOME='off';assert.equal((await f.request(path)).status,404);f.env.PORTAL_WELCOME='simulation-12';assert.equal((await f.request(path,{headers:{'Cf-Access-Jwt-Assertion':await f.token('other@example.test')}})).status,401);
 assert.equal(f.portal.prepare('SELECT count(*) n FROM welcome_intents').get().n,0);
});
test('welcome preview escapes supplied markup and rejects withdrawal before confirm',async()=>{
 const f=await ready(),compose=await f.form(f.path),input={...fields,message:'<img src=x onerror=alert(1)> & hello'},preview=await f.post(f.path,compose,input),html=await preview.text();
 assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));
 await f.storage.prepare("UPDATE membership_requests SET status='revoked',revision=2 WHERE id=?").bind(f.id).run();
 const result=await f.post(f.path,{cookie:preview.headers.get('Set-Cookie').split(';')[0],csrf:extract(html,'csrf')},{...input,action:'send',review:extract(html,'review'),confirm:'yes'});assert.equal(result.status,409);assert.equal(f.portal.prepare('SELECT count(*) n FROM welcome_intents').get().n,0);
});
