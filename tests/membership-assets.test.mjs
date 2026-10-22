import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
test('built request form has accessible labels, honest copy, constrained fields and fail-closed configuration',()=>{
 const html=read('dist/members/request/index.html');
 for(const id of ['request-name','request-email','request-reason']) {assert.ok(html.includes(`for="${id}"`));assert.ok(html.includes(`id="${id}"`));}
 assert.match(html,/<form[^>]*method="post"[^>]*action="\/api\/membership\/requests"/);
 assert.match(html,/maxlength="500"/);assert.match(html,/name="acknowledgement" type="checkbox" required/);assert.match(html,/role="status" aria-live="polite"/);
 for(const text of ['support@bigsoxstudios.com','not open','Greg personally reviews','proofread','No account','no email','may only hear back','data-persist-theme="false"'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes("const saved=localStorage"));
 // Default local build intentionally has no real widget key; configured builds may contain it.
 if(!process.env.PUBLIC_TURNSTILE_SITE_KEY) {assert.match(html,/temporarily unavailable/);assert.match(html,/id="request-submit"[^>]*disabled/);assert.ok(!html.includes('src="https://challenges.cloudflare.com'));}
});
test('request CSP permits exactly the existing inline theme code, Turnstile frames and same-origin API',()=>{
 const html=read('dist/members/request/index.html'),headers=read('dist/_headers');
 const scripts=[...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
 assert.ok(scripts.length >= 1);
 for(const script of scripts)assert.ok(headers.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
 assert.match(headers,/frame-src https:\/\/challenges.cloudflare.com/);assert.match(headers,/form-action 'self'/);assert.match(headers,/frame-ancestors 'none'/);assert.ok(!headers.includes("script-src 'unsafe-inline'"));
});
test('members page links to form and preserves future invite-only and coming-soon sign-in',()=>{
 const html=read('dist/members/index.html');assert.match(html,/href="\/members\/request\/"/);assert.ok(!html.includes("There isn't an online application"));assert.match(html,/future invite-only/);assert.match(html,/Member Sign In <small[^>]*>Coming Soon/);
});
test('Wrangler preserves static routing and dedicated production D1 with daily public retention cron; owner configs have no cron and review stays unbound',()=>{
 const config=read('wrangler.toml');assert.match(config,/run_worker_first = \["\/api\/membership\/\*"\]/);assert.match(config,/not_found_handling = "404-page"/);assert.match(config,/html_handling = "auto-trailing-slash"/);assert.match(config,/binding = "ASSETS"/);assert.match(config,/simple = \{ limit = 6, period = 60 \}/);
 for(const productionConfig of [config,read('owner-launchpad/wrangler.production.toml')]) {
  const bindings=[...productionConfig.matchAll(/^\[\[d1_databases\]\][^\S\n]*\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/gm)];
  assert.equal(bindings.length,1);
  const binding=bindings[0][1];
  assert.match(binding,/^binding = "MEMBERSHIP_DB"$/m);
  assert.match(binding,/^database_name = "bss-membership-requests"$/m);
  assert.match(binding,/^database_id = "21e13fa1-0ab3-4573-8d20-983c847ba0e9"$/m);
  assert.doesNotMatch(binding,/bss-owner-canary|bss-mail-desk-staging/);
 }
 const triggers=[...config.matchAll(/^\[triggers\][^\S\n]*\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/gm)];
 assert.equal(triggers.length,1);
 assert.equal(triggers[0][1].trim(),'crons = ["17 4 * * *"]');
 for(const ownerConfig of ['owner-launchpad/wrangler.production.toml','owner-launchpad/wrangler.toml'])assert.doesNotMatch(read(ownerConfig),/^\[triggers\]/m);
 assert.ok(!/^\[\[d1_databases\]\]/m.test(read('owner-launchpad/wrangler.toml')));
 assert.equal(read('dist/admin/index.html'),read('public/admin/index.html'));
});
