import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { verifyAccess } from '../src/auth.mjs';

globalThis.fetch = () => { throw new Error('NETWORK FORBIDDEN IN TESTS'); };
const { createCandidate } = await import('../src/worker.mjs');
export const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'offline-key', use: 'sig', alg: 'RS256' };
export const resolver = createLocalJWKSet({ keys: [jwk] });
export const timestamp = 1800000000;
export const environment = () => ({
 DEPLOYMENT_STAGE: 'production', CANARY_SEND_ENABLED: 'owner-canary-v1-approved',
 MFA_CONTRACT: 'signed-amr-mfa-v1', ACCESS_TEAM_HOST: 'offline-test.cloudflareaccess.com',
 ACCESS_AUD: 'offline-audience-only', OWNER_PRINCIPAL: 'offline-owner-sub',
 OWNER_ACCESS_EMAIL: 'owner@identity.test', CANARY_OWNER_MAILBOX: 'owner@personal.test',
 APP_ORIGIN: 'https://canary.test', APPROVAL_SIGNING_KEY: 'X'.repeat(64),
 RESEND_API_KEY: `re_${'offline_not_a_credential_'.repeat(2)}`,
 CANARY_CAMPAIGN_ID: '11111111-1111-4111-8111-111111111111', SESSION_EPOCH: 'offline-session-epoch-v1'
});
export async function access(patch = {}, signingKey = keys.privateKey, header = {}) {
 return new SignJWT({ iss: 'https://offline-test.cloudflareaccess.com', aud: 'offline-audience-only',
  sub: 'offline-owner-sub', email: 'owner@identity.test', type: 'app', amr: ['pwd', 'mfa'],
  iat: timestamp, nbf: timestamp, exp: timestamp + 600, ...patch })
  .setProtectedHeader({ alg: 'RS256', kid: 'offline-key', ...header }).sign(signingKey);
}
export function database(connection) {
 return { prepare(sql) { return { bind(...args) { return { async first() {
  // Yield before each actual SQLite statement to model separate Worker instances.
  await Promise.resolve();
  return connection.prepare(sql).get(...args) ?? null;
 } }; } }; } };
}
export async function fixture(options = {}) {
 const directory = mkdtempSync(join(tmpdir(), 'owner-canary-'));
 const file = join(directory, 'ledger.sqlite');
 const a = new DatabaseSync(file), b = new DatabaseSync(file);
 a.exec(readFileSync(new URL('../migrations/0001_canary.sql', import.meta.url), 'utf8'));
 const env = environment(); env.CANARY_DB = database(a);
 let time = timestamp, count = 0, failAuth = false;
 const token = await access();
 const verify = async (request, e) => {
  if (failAuth) throw new Error('revoked fixture session');
  return verifyAccess(request, e, resolver, time);
 };
 const transport = async (...args) => {
  count++;
  return options.transport ? options.transport(...args) : new Response(JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
 };
 const deps = { verify, transport, dispatchAuthorized: options.dispatchAuthorized ?? true, now: () => time };
 const worker = createCandidate(deps), second = createCandidate(deps);
 let cookie = '', stageToken;
 const f = { env, a, b, worker, second, token, deps,
  get sends() { return count; }, get cookie() { return cookie; }, get stageToken() { return stageToken; },
  advance(seconds) { time += seconds; }, revoke() { failAuth = true; },
  cleanup() { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }); },
  row() { return a.prepare('SELECT * FROM canary_campaign').get(); },
  request(path, body = {}, patch = {}) {
   const { headers = {}, ...rest } = patch;
   return new Request(`https://canary.test${path}`, { method: 'POST', headers: {
    'Cf-Access-Jwt-Assertion': token, 'Origin': env.APP_ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json', 'X-Canary-Action': path.slice(1), 'Cookie': cookie, ...headers
   }, body: JSON.stringify(body), ...rest });
  },
  async call(path, body = undefined, patch = {}, target = worker, e = env) {
   const response = await target.fetch(f.request(path, body === undefined ? (path === '/preview' ? {} : { token: stageToken }) : body, patch), e);
   const data = await response.json();
   if (response.ok) {
    if (data.token) stageToken = data.token;
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
   }
   return { response, data };
  },
  async approved() { for (const step of ['/preview', '/review', '/approve']) {
   const result = await f.call(step);
   if (!result.response.ok) throw new Error(`fixture ${step} failed: ${JSON.stringify(result.data)}`);
  } }
 };
 return f;
}
