import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import production, { createAuthProbe } from '../src/auth-probe.mjs';

globalThis.fetch = () => { throw new Error('NETWORK FORBIDDEN IN TESTS'); };
const time = 1800000000;
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'probe-offline-key', alg: 'RS256', use: 'sig' };
const localKeys = createLocalJWKSet({ keys: [jwk] });
let resolutions = 0;
const probe = createAuthProbe({ keyResolver: (...args) => { resolutions++; return localKeys(...args); }, now: () => time });
const env = {
 AUTH_PROBE_ENABLED: 'owner-auth-diagnostic-v1', APP_ORIGIN: 'https://probe.test',
 ACCESS_TEAM_HOST: 'probe-offline.cloudflareaccess.com', ACCESS_AUD: 'probe-offline-audience', OWNER_ACCESS_EMAIL: 'owner@identity.test'
};
const claims = {
 iss: 'https://probe-offline.cloudflareaccess.com', aud: env.ACCESS_AUD,
 sub: 'new-real-provider-subject', email: env.OWNER_ACCESS_EMAIL, type: 'app', iat: time, exp: time + 600
};
const sign = (patch = {}, header = {}, key = keys.privateKey) => new SignJWT({ ...claims, ...patch })
 .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, ...header }).sign(key);
const request = (token, { url = `${env.APP_ORIGIN}/`, method = 'GET', headers = {} } = {}) => new Request(url, {
 method, headers: { ...(token === undefined ? {} : { 'Cf-Access-Jwt-Assertion': token }), ...headers }
});
const call = (token, options, settings = env, target = probe) => target.fetch(request(token, options), settings);
async function denied(response) {
 assert.equal(response.status, 503);
 assert.deepEqual(await response.json(), { error: 'auth_unavailable' });
 assert.equal(response.headers.get('cache-control'), 'no-store, private');
 assert.equal(response.headers.has('set-cookie'), false);
}

test('diagnostic reports only verified facts, accepts unknown subject and missing amr/nbf', async () => {
 const token = await sign({ arbitrarySecret: 'must-not-escape' });
 const response = await call(token, { headers: { Cookie: 'secret-cookie', amr: 'mfa', mfa: 'true' } }, {
  ...env, OWNER_PRINCIPAL: 'different-config-sub', MFA_CONTRACT: 'anything', verify: () => claims,
  fetch: () => { throw new Error('environment transport invoked'); },
  CANARY_DB: new Proxy({}, { get() { throw new Error('D1 touched'); } }), RESEND_API_KEY: 'must-not-escape'
 });
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), {
  sub: claims.sub, email: claims.email, iss: claims.iss, aud: claims.aud, iat: time, nbf: null, exp: time + 600,
  nbfPresent: false, amrPresent: false, sendAuthority: false, mfaVerified: false, diagnosticOnly: true
 });
 assert.equal(response.headers.get('cache-control'), 'no-store, private');
 assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
 assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
 assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
 assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
 assert.equal(response.headers.has('set-cookie'), false);
 assert.equal(response.headers.has('access-control-allow-origin'), false);
});
test('diagnostic accepts signed singleton audience array and reports its original shape', async () => {
 const aud = [env.ACCESS_AUD];
 const response = await call(await sign({ aud }));
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), {
  sub: claims.sub, email: claims.email, iss: claims.iss, aud, iat: time, nbf: null, exp: time + 600,
  nbfPresent: false, amrPresent: false, sendAuthority: false, mfaVerified: false, diagnosticOnly: true
 });
});
for (const amr of [[], ['pwd'], ['pwd', 'mfa'], ['provider-specific-method']]) test(`signed amr is a fact only: ${JSON.stringify(amr)}`, async () => {
 const response = await call(await sign({ amr, nbf: time - 1 }), { headers: { Origin: env.APP_ORIGIN } });
 assert.equal(response.status, 200);
 const body = await response.json();
 assert.deepEqual(body.amr, amr); assert.equal(body.amrPresent, true);
 assert.equal(body.nbfPresent, true); assert.equal(body.nbf, time - 1);
 assert.equal(body.mfaVerified, false); assert.equal(body.sendAuthority, false);
});

const badClaims = [
 ['issuer', { iss: 'https://evil.test' }], ['missing issuer', { iss: undefined }],
 ['audience', { aud: 'wrong-audience' }], ['empty audience list', { aud: [] }],
 ['wrong audience list', { aud: ['wrong-audience'] }], ['empty string audience list', { aud: [''] }],
 ['duplicate audience list', { aud: [env.ACCESS_AUD, env.ACCESS_AUD] }],
 ...[null, 1, true, {}, [env.ACCESS_AUD]].flatMap(value => [
  [`non-string audience list ${JSON.stringify(value)}`, { aud: [value] }],
  [`mixed-type audience list ${JSON.stringify(value)}`, { aud: [env.ACCESS_AUD, value] }]
 ]),
 ['mixed audience list', { aud: [env.ACCESS_AUD, 'other'] }], ['missing audience', { aud: undefined }],
 ['wrong email', { email: 'other@identity.test' }], ['email case', { email: 'Owner@identity.test' }],
 ['missing email', { email: undefined }], ['empty email', { email: '' }], ['email type', { email: [] }],
 ['missing sub', { sub: undefined }], ['empty sub', { sub: '' }], ['sub type', { sub: 1 }],
 ['long sub', { sub: 'x'.repeat(257) }], ['sub control', { sub: 'a\nb' }],
 ['missing type', { type: undefined }], ['service type', { type: 'service' }], ['type array', { type: ['app'] }],
 ...['common_name', 'service_token_id'].flatMap(name => ['', null, false, 'service'].map(value => [`${name} ${value}`, { [name]: value }])),
 ['missing iat', { iat: undefined }], ['missing exp', { exp: undefined }],
 ['future iat', { iat: time + 1 }], ['expired', { exp: time }], ['reversed times', { exp: time - 1 }],
 ['long lifetime', { exp: time + 601 }], ['stale', { iat: time - 601 }],
 ...['iat', 'exp', 'nbf'].flatMap(name => [null, '1800000000', 1.5, -1, Number.MAX_SAFE_INTEGER + 1].map(value => [`${name} ${value}`, { [name]: value }])),
 ['future nbf', { nbf: time + 1 }], ['nbf past expiration', { nbf: time + 600 }],
 ...[null, 'mfa', true, {}, [1], [''], ['x'.repeat(129)], Array(17).fill('mfa')].map(amr => [`amr ${JSON.stringify(amr)}`, { amr }])
];
for (const [name, patch] of badClaims) test(`probe denies signed ${name}`, async () => denied(await call(await sign(patch))));

test('temporal near boundary succeeds without clock tolerance', async () => {
 const response = await call(await sign({ iat: time - 599, exp: time + 1, nbf: time }));
 assert.equal(response.status, 200);
});
for (const header of [
 { kid: undefined }, { kid: '' }, { kid: 1 }, { kid: 'x'.repeat(129) }, { kid: '../key' }, { kid: 'https://evil.test' },
 { kid: 'unknown-key' }, { typ: 'service' }, { typ: null }, { jku: 'https://evil.test/keys' }, { jwk },
 { x5u: 'https://evil.test' }, { x5c: [] }, { crit: ['evil'], evil: true }
]) test(`probe denies JWT header ${JSON.stringify(header)}`, async () => {
 // Unknown critical extensions cannot be signed by jose; construct a tampered header.
 let token = await sign({}, header.crit ? {} : header);
 if (header.crit) {
  const parts = token.split('.'); parts[0] = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, ...header })).toString('base64url'); token = parts.join('.');
 }
 const before = resolutions;
 await denied(await call(token));
 if (header.kid !== 'unknown-key') assert.equal(resolutions, before, 'bad header rejected before key lookup');
});
test('signature forgery, tampering, malformed, unsigned and symmetric assertions fail', async () => {
 const wrongKeys = await generateKeyPair('RS256');
 await denied(await call(await sign({}, {}, wrongKeys.privateKey)));
 const token = await sign(); const parts = token.split('.');
 parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'tampered' })).toString('base64url');
 const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: jwk.kid }).sign(new Uint8Array(64));
 for (const value of [undefined, '', 'invalid', 'x'.repeat(16384), parts.join('.'), hs, 'eyJhbGciOiJub25lIn0.e30.']) await denied(await call(value));
});
for (const options of [
 ...['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'].map(method => ({ method })),
 ...['https://probe.test/?', 'https://probe.test/?amr=mfa', 'https://probe.test/#fragment', 'https://probe.test/status', 'https://other.test/', 'http://probe.test/'].map(url => ({ url })),
 ...[{ Origin: 'https://evil.test' }, { Origin: 'null' }, { Origin: '' }, { 'CF-Access-Client-Id': '' }, { 'CF-Access-Client-Secret': 'service' }].map(headers => ({ headers }))
]) test(`probe preflight rejects ${JSON.stringify(options)}`, async () => {
 const before = resolutions; await denied(await call(await sign(), options)); assert.equal(resolutions, before);
});
test('credentials in request URL are rejected by the Request API', () => {
 assert.throws(() => request(undefined, { url: 'https://user@probe.test/' }), TypeError);
});
for (const patch of [
 { AUTH_PROBE_ENABLED: '' }, { AUTH_PROBE_ENABLED: 'true' }, { APP_ORIGIN: '' },
 ...['http://probe.test', 'https://probe.test/', 'https://probe.test/path', 'https://user@probe.test', 'https://probe.test?x', 'https://probe.test#x'].map(APP_ORIGIN => ({ APP_ORIGIN })),
 ...['evil.test', 'https://team.cloudflareaccess.com', 'team.cloudflareaccess.com.evil.test', 'team.cloudflareaccess.com/path', 'team.cloudflareaccess.com:443'].map(ACCESS_TEAM_HOST => ({ ACCESS_TEAM_HOST })),
 { ACCESS_AUD: '' }, { ACCESS_AUD: ['probe-offline-audience'] }, { ACCESS_AUD: 'x'.repeat(257) },
 { OWNER_ACCESS_EMAIL: '' }, { OWNER_ACCESS_EMAIL: 'bad-email' }, { OWNER_ACCESS_EMAIL: 'x'.repeat(255) }
]) test(`probe config fails closed ${JSON.stringify(patch)}`, async () => {
 const before = resolutions; await denied(await call(await sign(), undefined, { ...env, ...patch })); assert.equal(resolutions, before);
});

test('default entrypoint pins JWKS URL, ignores injected environment dependencies, and returns no token', async t => {
 const calls = [];
 t.mock.method(globalThis, 'fetch', async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });
 });
 const current = Math.floor(Date.now() / 1000);
 const token = await sign({ iat: current, exp: current + 600 });
 const response = await call(token, undefined, { ...env, keyResolver: () => { throw new Error('injection'); }, now: () => time }, production);
 assert.equal(response.status, 200);
 assert.equal(calls.length, 1);
 assert.equal(calls[0].url, 'https://probe-offline.cloudflareaccess.com/cdn-cgi/access/certs');
 assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'manual');
 assert.equal(JSON.stringify(await response.json()).includes(token), false);
});
test('JWKS refusal/redirect returns only generic error without fallback', async t => {
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }); });
 const current = Math.floor(Date.now() / 1000);
 await denied(await call(await sign({ iat: current, exp: current + 600 }), undefined, env, createAuthProbe()));
 assert.equal(calls, 1);
});
test('blank config is disabled; runtime imports only jose and has no sending/state dependencies', async () => {
 const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
 const source = read('../src/auth-probe.mjs');
 assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map(match => match[1]), ['jose']);
 assert.doesNotMatch(source, /\b(?:CANARY_DB|RESEND_API_KEY|APPROVAL_SIGNING_KEY|console\.|put\(|prepare\(|send\(|approve\()/);
 assert.doesNotMatch(source, /(?:await|return|=)\s*fetch\(/);
 assert.match(source, /export default createAuthProbe\(\)/);
 const config = read('../wrangler.auth-probe.toml');
 assert.match(config, /main = "src\/auth-probe.mjs"/);
 for (const line of ['workers_dev = false', 'preview_urls = false', 'routes = []', 'AUTH_PROBE_ENABLED = ""', 'APP_ORIGIN = ""', 'ACCESS_TEAM_HOST = ""', 'ACCESS_AUD = ""', 'OWNER_ACCESS_EMAIL = ""']) assert.ok(config.includes(line));
 assert.doesNotMatch(config, /\[\[|account_id\s*=|binding\s*=|secret\s*=|\[triggers\]|\[assets\]/);
 await denied(await production.fetch(request(await sign()), {}));
});
