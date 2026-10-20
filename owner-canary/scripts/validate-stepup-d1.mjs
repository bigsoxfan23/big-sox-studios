// Local only. Usage: node scripts/validate-stepup-d1.mjs /absolute/path/to/tools/node_modules
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stepupStore } from '../src/stepup.mjs';
import { createCandidate } from '../src/worker.mjs';

const localFetch = globalThis.fetch;
const { stepupFixture } = await import('../tests/stepup-fixtures.mjs');
globalThis.fetch = localFetch;
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(process.argv[2], 'miniflare/dist/src/index.js')));
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
 script: 'export default {fetch(){return new Response("local only")}}', compatibilityDate: '2026-10-01',
 d1Databases: ['FLOW', 'BOUNDS'], telemetry: { enabled: false }, cf: false,
 outboundService: () => { throw new Error('external network forbidden'); }
}));
let s;
let cryptoWorker;
try {
 const db = await mf.getD1Database('FLOW'), bounds = await mf.getD1Database('BOUNDS');
 for (const name of ['0001_canary.sql', '0002_stepup.sql']) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  const statements = sql.match(/CREATE TABLE[\s\S]*?\n\);|CREATE TRIGGER[\s\S]*?END;/g);
  for (const statement of statements) { await db.prepare(statement).run(); await bounds.prepare(statement).run(); }
 }
 s = await stepupFixture(null, db);
 const candidate = await s.enroll(), proven = await s.possession(candidate);
 assert.equal(proven.r.status, 200);
 assert.equal((await db.prepare('SELECT count(*) n FROM canary_campaign').first()).n, 0);
 const candidateRow = await db.prepare('SELECT * FROM stepup_candidate').first();
 assert.equal(candidateRow.id, candidate); assert.equal(candidateRow.fingerprint, await s.fingerprint());
 assert.equal(candidateRow.public_id, proven.data.candidateID); assert.notEqual(candidateRow.public_id, candidate);
 for (const sql of ["UPDATE stepup_candidate SET record='{}'", 'UPDATE stepup_candidate SET expires=expires+1', 'UPDATE stepup_candidate SET proof=NULL,verified=NULL']) {
  await assert.rejects(db.prepare(sql).run());
 }
 const o = await s.call('/stepup/challenge', { purpose: 'preview' });
 const body = { purpose: 'preview', id: o.data.id, response: s.auth.assert(o.data.publicKey.challenge) };
 const verifies = await Promise.all(Array.from({ length: 32 }, () => s.call('/stepup/verify', body)));
 assert.equal(verifies.filter(x => x.r.ok).length, 1);
 const previews = await Promise.all(Array.from({ length: 32 }, () => s.call('/preview', { proof: o.data.id })));
 assert.equal(previews.filter(x => x.r.ok).length, 1);
 for (const path of ['/review', '/approve']) assert.equal((await s.call(path, { token: s.stageToken })).r.status, 200);
 await s.confirm();
 const proof = await s.proof('dispatch'), dispatch = { token: s.stageToken, proof };
 const second = createCandidate(s.deps);
 const results = await Promise.all(Array.from({ length: 32 }, (_, i) => s.call('/dispatch', dispatch, { target: i % 2 ? s.worker : second })));
 assert.equal(results.filter(x => x.r.ok).length, 1); assert.equal(s.f.sends, 1);
 assert.equal((await s.call('/dispatch', dispatch)).r.status, 503);
 assert.equal((await db.prepare('SELECT status FROM canary_campaign').first()).status, 'accepted');
 const challenge = await db.prepare('SELECT * FROM stepup_challenge WHERE id=?').bind(proof).first();
 assert.equal(challenge.state, 'used');
 for (const sql of ["UPDATE stepup_challenge SET context='forged'", "UPDATE stepup_challenge SET state='verified',consumed=NULL", 'UPDATE stepup_challenge SET expires=expires+1',
  'DELETE FROM canary_campaign', "UPDATE canary_campaign SET status='approved'"]) await assert.rejects(db.prepare(sql).run());
 const store = stepupStore(bounds), a = await store.issue('{"local":"bounded"}', 1000);
 const verifyRaces = await Promise.all(Array.from({ length: 32 }, () => store.verify(a, 1001)));
 assert.equal(verifyRaces.filter(Boolean).length, 1);
 const consumeRaces = await Promise.all(Array.from({ length: 32 }, () => store.consume(a.id, a.context, 1001)));
 assert.equal(consumeRaces.filter(Boolean).length, 1);
 for (let n = 1; n < 128; n++) await store.issue('local-bound-context', 1000);
 await assert.rejects(store.issue('overflow', 1000));
 assert.equal(await store.consume(a.id, a.context, 1120), null);
 await store.issue('after-expiry', 1120);
 assert.equal((await bounds.prepare('SELECT count(*) n FROM stepup_challenge').first()).n, 1);
 assert.equal((await bounds.prepare('SELECT count(*) n FROM canary_campaign').first()).n, 0);
 // Verify library/runtime compatibility inside actual workerd too, with a
 // disposable harness that has no sender or production authentication seams.
 const { build } = await import(pathToFileURL(resolve(process.argv[2], 'esbuild/lib/main.js')));
 const modulePath = fileURLToPath(new URL('../src/stepup.mjs', import.meta.url));
 const bundled = await build({ stdin: { resolveDir: resolve(modulePath, '..'), contents: `import { registration, assertion } from ${JSON.stringify(modulePath)};
 export default { async fetch(request) { try { const b = await request.json();
 if(b.kind==='register') await registration(b.response,b.row,b.settings);
 else await assertion(b.response,b.row,b.record);
 return new Response('verified'); } catch { return new Response('denied',{status:503}); } } };` },
 bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', tsconfigRaw: {} });
 cryptoWorker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-10-01', telemetry: { enabled: false }, cf: false,
  outboundService: () => { throw new Error('external network forbidden'); } }));
 const ceremony = { challenge: 'A'.repeat(43) };
 const settings = { rpID: s.auth.record.rpID, origin: s.auth.record.origin, owner: s.auth.record.owner,
  email: s.auth.record.email, epoch: s.auth.record.epoch };
 const runtime = body => cryptoWorker.dispatchFetch('https://canary.test/fixture', { method: 'POST', body: JSON.stringify(body) });
 assert.equal((await runtime({ kind: 'register', row: ceremony, settings, response: s.auth.register(ceremony.challenge) })).status, 200);
 assert.equal((await runtime({ kind: 'assert', row: ceremony, record: s.auth.record, response: s.auth.assert(ceremony.challenge) })).status, 200);
 assert.equal((await runtime({ kind: 'assert', row: ceremony, record: s.auth.record, response: s.auth.assert(ceremony.challenge, { flags: 1 }) })).status, 503);
 console.log(JSON.stringify({ result: 'PASS', engine: 'local Miniflare/workerd D1', realES256: true,
  enrollmentCampaignRows: 0, challengeVerifyContenders: 32, previewContenders: 32, challengeConsumeContenders: 32,
  dispatchContenders: 32, winnersPerTransition: 1, stubTransports: s.f.sends,
  immutableBindings: 'enforced', challengeLimit: 128, expiryPruning: 'verified',
  actualWorkerdRegistrationAndES256Authentication: 'PASS', remoteIO: false }));
} finally { s?.f.cleanup(); await cryptoWorker?.dispose(); await mf.dispose(); }
