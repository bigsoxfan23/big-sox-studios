import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fixture, access, timestamp } from './helpers.mjs';
import production from '../src/worker.mjs';
import { assets } from '../src/ui-assets.mjs';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const paths = ['/', '/app.js', '/styles.css'];
const get = (f, path, headers = {}) => new Request(`https://canary.test${path}`, { headers: { 'Cf-Access-Jwt-Assertion': f.token, ...headers } });
for (const path of paths) {
 test(`private asset ${path}: exact static bytes, strict CSP, no cache/cookies/DB writes/secrets`, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const response = await f.worker.fetch(get(f, path), f.env);
  assert.equal(response.status, 200); assert.equal(await response.text(), assets[path].body);
  assert.equal(response.headers.get('content-type'), assets[path].type);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.match(response.headers.get('vary'), /Cf-Access-Jwt-Assertion/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const csp = response.headers.get('content-security-policy');
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive));
  assert.doesNotMatch(csp, /unsafe-|https:/);
  for (const h of ['set-cookie', 'access-control-allow-origin']) assert.equal(response.headers.get(h), null);
  for (const value of [f.env.APPROVAL_SIGNING_KEY, f.env.RESEND_API_KEY, f.env.CANARY_OWNER_MAILBOX, f.token]) assert.ok(!assets[path].body.includes(value));
  assert.equal(f.row(), undefined); assert.equal(f.sends, 0);
 });
 for (const [name, claims] of [['missing MFA', { amr: ['pwd'] }], ['wrong owner', { sub: 'other' }], ['expired', { exp: timestamp }]]) {
  test(`${path} denies signed ${name} without leaking asset`, async t => {
   const f = await fixture(); t.after(() => f.cleanup());
   const r = await f.worker.fetch(get(f, path, { 'Cf-Access-Jwt-Assertion': await access(claims) }), f.env);
   assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'canary_unavailable' });
  });
 }
 test(`${path} missing/forged assertion denied by default entrypoint`, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  for (const assertion of ['', 'forged']) {
   const r = await production.fetch(get(f, path, { 'Cf-Access-Jwt-Assertion': assertion }), f.env);
   assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'canary_unavailable' });
  }
 });
 for (const headers of [{ Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'CF-Access-Client-Id': 'service' }]) {
  test(`${path} denies asset origin/service bypass ${JSON.stringify(headers)}`, async t => {
   const f = await fixture(); t.after(() => f.cleanup());
   assert.equal((await f.worker.fetch(get(f, path, headers), f.env)).status, 503);
  });
 }
 test(`${path} reauthenticates and preserves offline configuration block`, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  assert.equal((await f.worker.fetch(get(f, path), { ...f.env, MFA_CONTRACT: 'unverified' })).status, 503);
  f.revoke(); assert.equal((await f.worker.fetch(get(f, path), f.env)).status, 503);
 });
}
for (const path of ['/index.html', '/public/app.js', '/assets/app.js', '/?token=secret', '/app.js?x=1', '/status?x=1', '/owner', '/health']) test(`no alternate public path ${path}`, async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 assert.equal((await f.worker.fetch(get(f, path), f.env)).status, 503);
});
test('UI bundle matches reviewed files; HTML is static and contains no external or inline resources', () => {
 for (const [path, file] of [['/', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css']]) assert.equal(assets[path].body, readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
 assert.match(assets['/'].body, /<script src="\/app.js" defer><\/script>/);
 assert.doesNotMatch(assets['/'].body, /https?:|<style|\son\w+=|<input|<form/);
 assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|document\.cookie|location\.|eval\(|console\.|sendBeacon/);
});

// Execute the real browser script against the real Worker with a minimal DOM.
// No test provider request reaches a network. DOM text sinks reject HTML writes.
async function browser(t, options = {}) {
 const f = await fixture(options); t.after(() => f.cleanup());
 const nodes = new Map(), calls = [], events = {}, intervals = [];
 const el = id => {
  if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: true, hidden: true, open: false, handlers: {},
   set innerHTML(_) { throw new Error('HTML sink forbidden'); },
   addEventListener(name, fn) { this.handlers[name] = fn; },
   showModal() { this.open = true; }, close() { this.open = false; }
  });
  return nodes.get(id);
 };
 let cookie = '', previewToken, ms = timestamp * 1000;
 const context = vm.createContext({ document: { getElementById: el }, window: { addEventListener: (n, fn) => { events[n] = fn; } },
  setInterval: fn => intervals.push(fn), Date: class extends Date { constructor(...args) { super(...(args.length ? args : [ms])); } static now() { return ms; } },
  fetch: async (path, init) => {
   calls.push({ path, init });
   assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
   if (options.intercept) { const intercepted = options.intercept(path); if (intercepted) return intercepted; }
   const request = new Request(`https://canary.test${path}`, { ...init, headers: { ...init.headers,
    'Cf-Access-Jwt-Assertion': f.token, Origin: f.env.APP_ORIGIN, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
   const response = await f.worker.fetch(request, f.env);
   if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
   if (path === '/preview' && response.ok) previewToken = (await response.clone().json()).token;
   return response;
  } });
 vm.runInContext(source, context);
 const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
 const click = async id => { await el(id).handlers.click(); await settle(); };
 await settle();
 return { f, calls, el, click, events, async approved() { for (const id of ['preview', 'review', 'approve']) await click(id); },
  async consumePreview() {
   const r = await f.worker.fetch(new Request('https://canary.test/review', { method: 'POST', headers: {
    'Cf-Access-Jwt-Assertion': f.token, Origin: f.env.APP_ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json', 'X-Canary-Action': 'review', Cookie: cookie
   }, body: JSON.stringify({ token: previewToken }) }), f.env);
   assert.equal(r.status, 200);
  },
  expire() { ms += 301000; f.advance(301); for (const fn of intervals) fn(); } };
}
test('browser → Worker: preview/review/approve do not send; dialog cancellation; explicit single dispatch', async t => {
 const b = await browser(t);
 assert.deepEqual(b.calls.map(x => x.path), ['/status']);
 await b.click('send'); assert.equal(b.f.sends, 0);
 await b.approved(); assert.equal(b.f.sends, 0); assert.equal(b.f.row().status, 'approved');
 assert.match(b.el('status').textContent, /No message sent/);
 await b.click('dispatch'); assert.equal(b.el('confirmation').open, true); assert.equal(b.f.sends, 0);
 for (const field of ['from', 'to', 'subject', 'text']) assert.equal(b.el(field).textContent, b.el(`confirm-${field}`).textContent);
 await b.click('cancel'); await b.click('send'); assert.equal(b.f.sends, 0);
 await b.click('dispatch'); await b.click('send'); await b.click('send'); await b.click('dispatch'); await b.click('preview');
 assert.equal(b.f.sends, 1); assert.match(b.el('status').textContent, /Provider accepted.*Delivered not yet verified/);
 assert.equal(b.calls.filter(x => x.path === '/dispatch').length, 1);
 for (const { path, init } of b.calls.filter(x => x.init.method === 'POST')) {
  assert.equal(init.headers['X-Canary-Action'], path.slice(1));
  assert.deepEqual(Object.keys(JSON.parse(init.body)), path === '/preview' ? [] : ['token']);
 }
 for (const id of ['preview','review','approve','dispatch','send']) assert.equal(b.el(id).disabled, true);
});
test('default release authority disables browser and all mutation handlers', async t => {
 const b = await browser(t, { dispatchAuthorized: false });
 for (const id of ['preview','review','approve','dispatch','send']) await b.click(id);
 assert.deepEqual(b.calls.map(x => x.path), ['/status']); assert.equal(b.f.row(), undefined);
 assert.match(b.el('status').textContent, /Disabled.*Security blocked/);
});
test('hostile snapshot is displayed verbatim as text in preview and confirmation', async t => {
 const hostile = '<img src=x onerror=alert(1)> & " </script>';
 const b = await browser(t, { intercept: path => path === '/preview' ? new Response(JSON.stringify({ token: 'test-only', expires: timestamp + 300, snapshot: { payload: { from: hostile, to: hostile, subject: hostile, text: hostile } } })) : null });
 await b.click('preview');
 for (const field of ['from','to','subject','text']) { assert.equal(b.el(field).textContent, hostile); assert.equal(b.el(`confirm-${field}`).textContent, hostile); }
});
for (const failure of ['expired', 'revoked', 'replayed']) test(`browser halts on ${failure}, never creates second campaign`, async t => {
 const b = await browser(t); await b.click('preview');
 if (failure === 'expired') b.expire();
 if (failure === 'revoked') b.f.revoke();
 if (failure === 'replayed') {
  await b.consumePreview();
 }
 await b.click('review'); await b.click('preview'); await b.click('dispatch');
 assert.equal(b.calls.filter(x => x.path === '/preview').length, 1); assert.equal(b.f.sends, 0);
 assert.match(b.el('status').textContent, /blocked/i);
});
for (const [name, transport, label] of [
 ['refused', async () => new Response('{"name":"validation_error"}', { status: 422, headers: { 'Content-Type': 'application/json' } }), /Rejected.*No retry/],
 ['ambiguous', async () => { throw new Error('private provider exception'); }, /UNKNOWN/]
]) test(`browser ${name} outcome remains terminal`, async t => {
 const b = await browser(t, { transport }); await b.approved(); await b.click('dispatch'); await b.click('send');
 assert.match(b.el('status').textContent, label); await b.click('send'); await b.click('preview'); assert.equal(b.f.sends, 1);
});
test('browser network failure during dispatch locks all controls, never retries', async t => {
 const b = await browser(t, { intercept: path => { if (path === '/dispatch') throw new Error('<secret>'); } });
 await b.approved(); await b.click('dispatch'); await b.click('send'); await b.click('send'); await b.click('preview');
 assert.equal(b.calls.filter(x => x.path === '/dispatch').length, 1); assert.match(b.el('status').textContent, /UNKNOWN/); assert.doesNotMatch(b.el('status').textContent, /secret/);
});
for (const status of ['previewed','reviewed','approved','submitted','accepted','refused','UNKNOWN']) test(`reload with ${status} cannot resume or preview again`, async t => {
 const b = await browser(t, { intercept: path => path === '/status' ? new Response(JSON.stringify({ status, sendAuthority: true })) : null });
 await b.click('preview'); await b.click('dispatch'); await b.click('send'); assert.equal(b.calls.length, 1);
 assert.equal(b.el('preview').disabled, true);
});
test('back-forward cache restore halts and clears authority to transition', async t => {
 const b = await browser(t); await b.approved(); b.events.pagehide(); b.events.pageshow({ persisted: true });
 await b.click('dispatch'); await b.click('send'); assert.equal(b.f.sends, 0); assert.match(b.el('status').textContent, /Security blocked/);
});
test('expiry while confirmation is open closes dialog and blocks send', async t => {
 const b = await browser(t); await b.approved(); await b.click('dispatch'); b.expire();
 assert.equal(b.el('confirmation').open, false); await b.click('send'); assert.equal(b.f.sends, 0);
});
test('overlapping human clicks cannot start parallel transitions or dispatch twice', async t => {
 const b = await browser(t); await Promise.all([b.click('preview'), b.click('preview')]);
 assert.equal(b.calls.filter(x => x.path === '/preview').length, 1);
 await b.click('review'); await b.click('approve'); await b.click('dispatch');
 await Promise.all([b.click('send'), b.click('send')]); assert.equal(b.f.sends, 1);
});
for (const path of paths) for (const method of ['POST','HEAD','OPTIONS']) test(`${method} ${path} cannot expose assets or mutate ledger`, async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 const r = await f.worker.fetch(new Request(`https://canary.test${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': f.token } }), f.env);
 assert.equal(r.status, 503); assert.equal(f.row(), undefined); assert.equal(f.sends, 0);
});

test('no platform assets binding can bypass worker authentication', () => {
 const config = readFileSync(new URL('../wrangler.candidate.toml', import.meta.url), 'utf8');
 assert.doesNotMatch(config, /\[assets\]|binding\s*=\s*["']ASSETS|run_worker_first/);
});
