import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import production from '../src/worker.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const base = 'ceb08a8351349f66d0fbe92ca1c4adc00d7d6e6e';

test('all tracked baseline files match exact base Git blob manifest', () => {
 const manifest = JSON.parse(read('owner-canary/tests/baseline.json'));
 assert.equal(manifest.base, base);
 for (const [path, expected] of Object.entries(manifest.files)) {
  const bytes = readFileSync(resolve(root, path));
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(actual, expected, path);
 }
});
test('no legacy modules, ticket bindings, schedules, or bypasses in isolated runtime', () => {
 for (const file of readdirSync(resolve(root, 'owner-canary/src'))) {
  const source = read(`owner-canary/src/${file}`);
  assert.doesNotMatch(source, /\.\.\/|owner-canary-rehearsal|outbound\.candidate|provenance|NOTION|scheduled\s*\(|queue\s*\(/);
 }
 const worker = read('owner-canary/src/worker.mjs');
 assert.match(worker, /export default createCandidate\(\{ verify: authenticate, transport: fetch,\s*dispatchAuthorized: OWNER_CONFIRMED_RELEASE, enforceRelease: true \}\)/);
 assert.doesNotMatch(worker, /console\.|env\.(?:fetch|transport|verify|dispatchAuthorized)/);
});
test('candidate config has explicit disabled routes and no credentials/bindings', () => {
 const config = read('owner-canary/wrangler.candidate.toml');
 assert.match(config, /workers_dev = false/); assert.match(config, /preview_urls = false/);
 assert.match(config, /routes = \[\]/); assert.match(config, /CANARY_SEND_ENABLED = "false"/);
 assert.match(config, /DEPLOYMENT_STAGE = "offline"/); assert.match(config, /MFA_CONTRACT = "unverified"/);
 assert.doesNotMatch(config, /\[\[d1_databases\]\]|account_id\s*=|database_id\s*=|RESEND_API_KEY\s*=|APPROVAL_SIGNING_KEY\s*=|\[triggers\]|\[\[queues/);
});
test('unauthenticated default entrypoint discloses no snapshot and makes no network calls', async t => {
 const f = await fixture(); t.after(() => f.cleanup());
 for (const path of ['/preview','/status','/dispatch']) {
  const r = await production.fetch(new Request(`https://canary.test${path}`, { method: path === '/status' ? 'GET' : 'POST' }), f.env);
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'canary_unavailable' });
  assert.equal(r.headers.get('cache-control'), 'no-store, private');
 }
 assert.equal(f.sends, 0); assert.equal(f.row(), undefined);
});
