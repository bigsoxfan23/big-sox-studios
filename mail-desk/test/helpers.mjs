import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createWorker } from '../src/worker.mjs';
import { b64, clearJwksCache } from '../src/security.mjs';
import { offlineDelivery } from '../src/providers.mjs';
import { syntheticIntake } from '../src/intake.synthetic.mjs';
const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
const migration2 = await readFile(new URL('../migrations/0002_inbound_and_notion.sql', import.meta.url), 'utf8');
const migration3 = await readFile(new URL('../migrations/0003_notion_activity.sql', import.meta.url), 'utf8');
const keys = await crypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' }, true, ['sign','verify']);
export const jwk = { ...await crypto.subtle.exportKey('jwk',keys.publicKey), kid:'fixture-key', alg:'RS256', use:'sig' };
export const origin = 'https://desk.example.test';
export async function token(changes = {}, headerChanges = {}, signingKey = keys.privateKey) {
 const time = Math.floor(Date.now()/1000);
 const claims = { iss:'https://fixture.cloudflareaccess.com', aud:['fixture-audience'], email:'owner@example.test', sub:'owner-fixture', iat:time-10, nbf:time-10, exp:time+3600, ...changes };
 const header = b64(new TextEncoder().encode(JSON.stringify({ alg:'RS256', kid:'fixture-key', ...headerChanges })));
 const payload = b64(new TextEncoder().encode(JSON.stringify(claims)));
 const signature = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(`${header}.${payload}`)));
 return `${header}.${payload}.${signature}`;
}
export class D1 {
 constructor({ initialOnly = false, notion = false } = {}) { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(migration); if (!initialOnly) { this.sqlite.exec(migration2); if (notion) this.sqlite.exec(migration3); } }
 prepare(sql) {
  const db = this.sqlite;
  const make = args => ({
   bind: (...values) => make(values),
   async first() { return db.prepare(sql).get(...args) ?? null; },
   async all() { return { results:db.prepare(sql).all(...args), success:true }; },
   async run() { const result = db.prepare(sql).run(...args); return { success:true, meta:{ changes:Number(result.changes) } }; },
   _execute() { return db.prepare(sql).all(...args); }
  }); return make([]);
 }
 async batch(statements) {
  this.sqlite.exec('BEGIN IMMEDIATE');
  try { const results = statements.map(s => ({ results:s._execute(), success:true })); this.sqlite.exec('COMMIT'); return results; }
  catch (e) { this.sqlite.exec('ROLLBACK'); throw e; }
 }
 close() { this.sqlite.close(); }
}
export const input = (overrides = {}) => ({ synthetic:true, key:'synthetic-inbound-1', channel:'members', requester_name:'Synthetic Person', requester_email:'person@example.test', subject:'Synthetic membership question', body:'Hello studio.', ...overrides });
export async function fixture(t, options = {}) {
 clearJwksCache();
 const DB = new D1({ notion: options.notion === true }); t.after(() => DB.close());
 const env = { DB, ACCESS_ISSUER:'https://fixture.cloudflareaccess.com', ACCESS_AUDIENCE:'fixture-audience', OWNER_EMAIL:'owner@example.test', APP_ORIGIN:origin, CSRF_SECRET:'synthetic-only-secret-at-least-32-characters', SEND_MODE:'mock', ALLOW_REAL_SEND:'false', DEPLOYMENT_STAGE:'staging', NOTION_SYNC_MODE:'off', ...options.env };
 env.ASSETS = { async fetch(req) { const path = new URL(req.url).pathname; const file = path === '/' ? 'index.html' : path.slice(1); return new Response(await readFile(new URL(`../public/${file}`,import.meta.url)), { headers:{ 'Content-Type':file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } }); } };
 const simulation = offlineDelivery(options.simulation);
 let fetchCalls = 0;
 const worker = createWorker({ fetcher:async url => { fetchCalls++; if (url !== `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`) throw new Error('Unexpected network'); return Response.json({ keys:[jwk] }); }, simulation: simulation.handle });
 const jwt = await token(); let cookie, csrf;
 async function request(path, data, custom = {}) {
  const h = { 'Cf-Access-Jwt-Assertion':jwt, ...(cookie ? { Cookie:cookie } : {}), ...(data === undefined ? {} : { Origin:origin, 'Content-Type':'application/json', 'X-CSRF-Token':csrf }), ...custom.headers };
  for (const key of Object.keys(h)) if (h[key] == null) delete h[key];
  return worker.fetch(new Request(`${origin}${path}`, { method:data === undefined ? 'GET' : 'POST', ...custom, headers:h, ...(data === undefined ? {} : { body:typeof data === 'string' ? data : JSON.stringify(data) }) }), env);
 }
 async function session() { const r = await request('/api/session'); const v = await r.json(); cookie = r.headers.get('Set-Cookie')?.split(';')[0]; csrf = v.csrf; return { r,v,cookie,csrf }; }
 async function seed(overrides) { return syntheticIntake(DB,input(overrides)); }
 async function review(id, body = 'Synthetic reply') {
  const c = await (await request(`/api/cases/${id}`)).json();
  const d = await request(`/api/cases/${id}/draft`, { revision:c.revision,body }); if (d.status !== 200) throw new Error(`draft: ${await d.text()}`);
  const r = await request(`/api/cases/${id}/review`, { revision:(await d.json()).revision }); if (r.status !== 200) throw new Error(`review: ${await r.text()}`); return r.json();
 }
 const send = (id,r,custom) => request(`/api/cases/${id}/send`, { intentId:r.id,approval:r.approval }, custom);
 return { DB,env,worker,jwt,request,session,seed,review,send, calls:simulation.calls, release:simulation.release, fetches:() => fetchCalls };
}
