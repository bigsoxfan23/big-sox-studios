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
 const d=dom();const context={document:d.document,fetch:async(path,options={})=>f.request(path,options.body,{headers:options.headers}),pwned:false};
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
 const visited=new Set();async function walk(path){if(visited.has(path))return;visited.add(path);const source=await readFile(new URL(`../src/${path}`,import.meta.url),'utf8');assert.ok(!source.includes('api.resend.com'));assert.ok(!source.includes('RESEND_API_KEY'));assert.ok(!/import\s*\(/.test(source));for(const match of source.matchAll(/from ['"]\.\/(.*?)['"]/g)) await walk(match[1]);}
 await walk('worker.mjs');assert.ok(!visited.has('resend.future.mjs'));
});
test('standalone staging config has closed defaults and protects all static assets',async()=>{
 const config=await readFile(new URL('../wrangler.staging.toml',import.meta.url),'utf8');
 for(const key of ['ACCESS_ISSUER','ACCESS_AUDIENCE','OWNER_EMAIL','APP_ORIGIN']) assert.match(config,new RegExp(`^${key} = ""$`,'m'));
 assert.match(config,/^name = "bss-mail-desk-staging"$/m);assert.match(config,/^run_worker_first = true$/m);assert.match(config,/^workers_dev = false$/m);assert.match(config,/^preview_urls = false$/m);assert.match(config,/^NOTION_SYNC_MODE = "off"$/m);assert.match(config,/^SEND_MODE = "mock"$/m);assert.match(config,/^ALLOW_REAL_SEND = "false"$/m);assert.match(config,/database_id = "[0-9a-f-]{36}"/);assert.doesNotMatch(config,/database_id = "00000000-0000-0000-0000-000000000000"/);assert.ok(!/^\s*(routes?|custom_domain|crons)\s*=/m.test(config));assert.ok(!/RESEND_API_KEY\s*=|NOTION_TOKEN\s*=|CSRF_SECRET\s*=/.test(config));
});
