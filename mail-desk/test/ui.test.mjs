import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture } from './helpers.mjs';
const script = await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const css = await readFile(new URL('../public/styles.css',import.meta.url),'utf8');
const html = await readFile(new URL('../public/index.html',import.meta.url),'utf8');
function dom() {
 const elements = new Map(), created = [];
 class Element {
  constructor(tag) {this.tag=tag;this.children=[];this.attributes={};this.hidden=false;this.value='';this.disabled=false;this.textContent='';created.push(this);}
  set innerHTML(_) {throw new Error('HTML injection sink used');}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=children;}
  setAttribute(k,v) {this.attributes[k]=v;}
  removeAttribute(k) {delete this.attributes[k];}
 }
 const get = id => { if(!elements.has(id)) elements.set(id,new Element('div')); return elements.get(id); };
 get('case-template').content={cloneNode:()=>{for(const id of ['subject','identity','thread','deliveries','draft','review','approval','envelope','preview','send','cancel']) elements.set(id,new Element('div'));return new Element('fragment');}};
 return { get, created, document:{ getElementById:get,createElement:tag=>new Element(tag),body:new Element('body') } };
}
test('untrusted subject, name, message and preview remain inert through full UI review/send',async t=>{
 const f=await fixture(t);await f.session();
 const attack='<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script>';
 await f.seed({subject:attack,requester_name:attack,body:attack});
 const d=dom();const context={window:{confirm:()=>true},document:d.document,fetch:async(path,options={})=>f.request(path,options.body,{headers:options.headers}),pwned:false};
 await vm.runInNewContext(`(async()=>{${script}\n})()`,context);
 assert.equal(f.calls(),0);assert.equal(d.get('queue').children[0].textContent,attack);
 await d.get('queue').children[0].onclick();assert.equal(d.get('subject').textContent,attack);assert.equal(d.get('thread').children[0].children[1].textContent,attack);assert.equal(f.calls(),0);
 d.get('draft').value=attack;await d.get('review').onclick();assert.equal(d.get('preview').textContent,attack);assert.equal(d.get('approval').hidden,false);assert.equal(f.calls(),0);
 await d.get('send').onclick();assert.equal(f.calls(),1);assert.equal(context.pwned,false);assert.ok(d.created.every(el=>!['img','script','iframe'].includes(el.tag)));
});
test('UI edit invalidates review and cancel requires another review',async t=>{
 const f=await fixture(t);await f.session();await f.seed();const d=dom();await vm.runInNewContext(`(async()=>{${script}\n})()`,{document:d.document,fetch:async(path,o={})=>f.request(path,o.body,{headers:o.headers})});
 await d.get('queue').children[0].onclick();d.get('draft').value='draft';await d.get('review').onclick();d.get('cancel').onclick();await d.get('send').onclick();assert.equal(f.calls(),0);assert.equal(d.get('approval').hidden,true);
 d.get('draft').oninput();await d.get('send').onclick();assert.equal(f.calls(),0);
});
test('390px responsive style contract and accessible controls',()=>{
 assert.match(html,/name="viewport" content="width=device-width,initial-scale=1"/);
 assert.match(css,/main\s*\{[^}]*grid-template-columns:1fr/);assert.match(css,/@media \(min-width:800px\)/);
 assert.match(css,/@media \(max-width:420px\)/);assert.match(css,/min-width:0/);assert.match(css,/width:100%/);assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/min-height:44px/);
 for(const color of ['#fbf6ea','#17202b','#d97706']) assert.ok(css.includes(color));
 assert.match(html,/aria-live="polite"/);assert.match(html,/label for="draft"/);assert.match(html,/app-icon-512.png/);
 assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(script));
});
test('Worker serves only authenticated static allowlist with CSP and no-store',async t=>{
 const f=await fixture(t);
 for(const path of ['/','/app.js','/styles.css']) {const r=await f.request(path);assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.match(r.headers.get('Content-Security-Policy'),/default-src 'none'/);}
 assert.equal((await f.request('/index.html')).status,404);assert.equal((await f.request('/secret.env')).status,404);
});
test('staging entry dependency graph cannot import future live adapter',async()=>{
 const visited=new Set();async function walk(path){if(visited.has(path))return;visited.add(path);const source=await readFile(new URL(`../src/${path}`,import.meta.url),'utf8');assert.ok(!/import\s*\(/.test(source));for(const match of source.matchAll(/from ['"]\.\/(.*?)['"]/g)) await walk(match[1]);}
 await walk('worker.mjs');for (const name of ['worker.outbound.mjs','outbound.candidate.mjs','resend.future.mjs']) assert.ok(!visited.has(name));
 assert.ok(visited.has('reply.resend.mjs'));
});
test('standalone staging config has closed defaults and protects all static assets',async()=>{
 const config=await readFile(new URL('../wrangler.staging.toml',import.meta.url),'utf8');
 for(const key of ['ACCESS_ISSUER','ACCESS_AUDIENCE','OWNER_EMAIL','APP_ORIGIN']) assert.match(config,new RegExp(`^${key} = ""$`,'m'));
 assert.match(config,/^name = "bss-mail-desk-staging"$/m);assert.match(config,/^run_worker_first = true$/m);assert.match(config,/^workers_dev = false$/m);assert.match(config,/^preview_urls = false$/m);assert.match(config,/^NOTION_SYNC_MODE = "off"$/m);assert.match(config,/^SEND_MODE = "mock"$/m);assert.match(config,/^ALLOW_REAL_SEND = "false"$/m);assert.match(config,/database_id = "[0-9a-f-]{36}"/);assert.doesNotMatch(config,/database_id = "00000000-0000-0000-0000-000000000000"/);assert.ok(!/^\s*(routes?|custom_domain|crons)\s*=/m.test(config));assert.ok(!/RESEND_API_KEY\s*=|NOTION_TOKEN\s*=|CSRF_SECRET\s*=/.test(config));
});
test('ordinary confirmation cancellation does not POST a send',async t=>{
 const f=await fixture(t);await f.session();await f.seed();const d=dom();let confirms=0;
 await vm.runInNewContext(`(async()=>{${script}\n})()`,{window:{confirm:()=>{confirms++;return false;}},document:d.document,fetch:async(path,o={})=>f.request(path,o.body,{headers:o.headers})});
 await d.get('queue').children[0].onclick();d.get('draft').value='Reply';await d.get('review').onclick();await d.get('send').onclick();assert.equal(confirms,1);assert.equal(f.calls(),0);
});
for(const outcome of ['UNKNOWN','dispatching','failed','sent','lost-response']) test(`live UI displays ${outcome} accurately and never retries a lost response`,async()=>{
 const d=dom();let sends=0;const c={id:crypto.randomUUID(),subject:'Owner test',requester_name:'Owner',requester_email:'owner@example.test',channel:'support',revision:0,draft:'Reply',messages:[],deliveries:[]};
 const fetcher=async(path,o={})=>{
  if(path==='/api/session') return Response.json({csrf:'offline',sendMode:'live'});
  if(path==='/api/cases') return Response.json([c]);
  if(path.endsWith('/draft')) return Response.json({...c,revision:1});
  if(path.endsWith('/review')) return Response.json({id:'review',mode:'live',from:'support@bigsoxstudios.com',to:c.requester_email,subject:c.subject,body:c.draft,approval:'offline'});
  if(path.endsWith('/send')) {sends++;assert.equal(JSON.parse(o.body).confirmed,true);if(outcome==='lost-response') throw Error('offline interrupted');return Response.json({status:outcome,mode:'live',stage:'provider_accepted'});}
  return Response.json(c);
 };
 await vm.runInNewContext(`(async()=>{${script}\n})()`,{window:{confirm:()=>true},document:d.document,fetch:fetcher});
 await d.get('queue').children[0].onclick();await d.get('review').onclick();assert.match(d.get('envelope').textContent,/From: support@bigsoxstudios.com/);assert.equal(d.get('send').textContent,'Send reply');
 await d.get('send').onclick();const status=d.get('status').textContent;
 if(outcome==='sent') assert.match(status,/accepted by provider \(not delivery confirmation\)/);
 else {assert.doesNotMatch(status,/^accepted by provider/);assert.match(status,outcome==='failed'?/refused\/no send/:/never retry/);}
 if(outcome==='lost-response') {await d.get('send').onclick();assert.equal(sends,1);}
});


test('a fresh review restores Send after a definitely refused preflight and cancellation',async()=>{
 const d=dom();let reviews=0,sends=0;
 const c={id:crypto.randomUUID(),subject:'Owner test',requester_name:'Owner',requester_email:'owner@example.test',
  channel:'support',revision:1,draft:'Reply',messages:[],deliveries:[]};
 const fetcher=async(path)=>{
  if(path==='/api/session') return Response.json({csrf:'offline',sendMode:'live'});
  if(path==='/api/cases') return Response.json([c]);
  if(path.endsWith('/draft')) return Response.json({...c,revision:c.revision+1});
  if(path.endsWith('/review')) { reviews++; return Response.json({
   id:'review'+reviews,mode:'live',from:'support@bigsoxstudios.com',to:c.requester_email,
   subject:c.subject,body:c.draft,approval:'offline'
  });}
  if(path.endsWith('/send')) { sends++; return Response.json({error:'reply_preflight_rejected'},{status:503}); }
  return Response.json(c);
 };
 await vm.runInNewContext(`(async()=>{${script}\n})()`,{window:{confirm:()=>true},document:d.document,fetch:fetcher});
 await d.get('queue').children[0].onclick();
 await d.get('review').onclick();
 assert.equal(d.get('send').disabled,false);
 await d.get('send').onclick();assert.equal(sends,1);
 assert.equal(d.get('send').disabled,true);
 d.get('cancel').onclick();
 await d.get('review').onclick();
 assert.equal(reviews,2);
 assert.equal(d.get('send').disabled,false,'new review must restore actionable Send after definite refusal');
});


test('small-screen inbox switches to selected case and Back without losing draft or sending',async t=>{
 const f=await fixture(t);await f.session();await f.seed({subject:'Phone test',body:'Inbound'});
 const d=dom();let scrolling=0;const w={matchMedia:()=>({matches:true}),scrollTo:()=>{scrolling++;}};
 await vm.runInNewContext('(async()=>{'+script+'\n})()',{document:d.document,window:w,fetch:async(path,o={})=>f.request(path,o.body,{headers:o.headers})});
 assert.equal(d.get('maildesk-layout').attributes['data-view'],undefined);
 await d.get('queue').children[0].onclick();
 assert.equal(d.get('maildesk-layout').attributes['data-view'],'case');
 d.get('draft').value='Unsent owner draft';
 d.get('back-inbox').onclick();
 assert.equal(d.get('maildesk-layout').attributes['data-view'],'inbox');
 assert.equal(d.get('draft').value,'Unsent owner draft');
 assert.equal(f.calls(),0);
 assert.equal(scrolling,2);
});

test('legacy RFC 2047 encoded subjects display decoded but exact raw storage and review stay unchanged',async t=>{
 const f=await fixture(t);await f.session();
 const raw='=?UTF-8?Q?BSS_Task_10_=E2=80=94_caf=C3=A9?=';
 await f.seed({subject:raw,requester_name:'Owner'});
 const listed=await (await f.request('/api/cases')).json();
 assert.equal(listed[0].subject,raw);
 assert.equal(listed[0].displaySubject,'BSS Task 10 — café');
 const detail=await (await f.request('/api/cases/'+listed[0].id)).json();
 assert.equal(detail.subject,raw);
 assert.equal(detail.displaySubject,'BSS Task 10 — café');
 const d=dom();await vm.runInNewContext('(async()=>{'+script+'\n})()',{document:d.document,fetch:async(path,o={})=>f.request(path,o.body,{headers:o.headers})});
 assert.equal(d.get('queue').children[0].textContent,'BSS Task 10 — café');
 await d.get('queue').children[0].onclick();
 assert.equal(d.get('subject').textContent,'BSS Task 10 — café');
 d.get('draft').value='Owner reply';
 await d.get('review').onclick();
 assert.match(d.get('envelope').textContent,/Subject: =\?UTF-8\?Q\?BSS_Task_10_/);
 assert.equal(f.calls(),0);
});

test('mobile layout hides inactive pane but keeps desktop two-column access',()=>{
 assert.match(html,/id="maildesk-layout" data-view="inbox"/);
 assert.match(html,/id="back-inbox"/);
 assert.match(css,/main\[data-view="inbox"\] #detail\s*\{\s*display:none;/);
 assert.match(css,/main\[data-view="case"\] aside\s*\{\s*display:none;/);
 assert.match(css,/#back-inbox\s*\{\s*display:inline-flex;/);
 assert.match(css,/@media \(min-width:800px\)/);
 assert.doesNotMatch(script,/innerHTML|outerHTML|insertAdjacentHTML/);
});

for (const policy of ['owner-self-v1','owner-reviewed-customers-v1','owner-reviewed-customers-v2']) test(`live UI ${policy} copy, exact destination confirmation and lost response no retry`,async()=>{
 const d=dom();let confirms=0,sends=0,confirmation;
 const c={id:crypto.randomUUID(),subject:'Exact subject <b>inert</b>',requester_name:'Requester',requester_email:'Customer@example.test',channel:'support',revision:0,draft:'Exact body <script>inert</script>',messages:[],deliveries:[]};
 const fetcher=async(path)=>{
  if(path==='/api/session')return Response.json({csrf:'offline',sendMode:'live',replyPolicy:policy});
  if(path==='/api/cases')return Response.json([c]);
  if(path.endsWith('/draft'))return Response.json({...c,revision:1});
  if(path.endsWith('/review'))return Response.json({id:'offline',mode:'live',policy,to:c.requester_email,from:'support@bigsoxstudios.com',subject:c.subject,body:c.draft,approval:'offline'});
  if(path.endsWith('/send')){sends++;throw Error('offline lost browser response');}
  return Response.json(c);
 };
 await vm.runInNewContext(`(async()=>{${script}\n})()`,{window:{confirm:text=>{confirms++;confirmation=text;return true;}},document:d.document,fetch:fetcher});
 assert.match(d.get('mode-notice').textContent,policy==='owner-self-v1'?/owner Gmail only/:/Envelope sender can be spoofed/);
 if(policy!=='owner-self-v1')assert.match(d.get('mode-notice').textContent,/Manual Review & Send confirmation required for every message/);
 await d.get('queue').children[0].onclick();await d.get('review').onclick();
 assert.equal(d.get('preview').textContent,c.draft);assert.ok(d.get('envelope').textContent.includes(c.subject));
 if(policy!=='owner-self-v1')assert.match(d.get('review-note').textContent,/Envelope sender can be spoofed/);
 await d.get('send').onclick();await d.get('send').onclick();
 assert.equal(confirmation,`Send this exact reviewed reply to ${c.requester_email} now?`);
 assert.equal(confirms,1);assert.equal(sends,1);assert.match(d.get('status').textContent,/never retry/);
});
