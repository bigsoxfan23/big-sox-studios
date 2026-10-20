import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyAccess, accessConfig } from '../src/auth.mjs';
import { access, keys, resolver, timestamp, environment } from './helpers.mjs';
const request = (token, extra = {}) => new Request('https://canary.test', { headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...extra } });
const check = (token, extra) => verifyAccess(request(token, extra), environment(), resolver, timestamp);
test('valid signed RS256 exact owner with signed MFA', async () => {
 const result = await check(await access()); assert.equal(result.sub, 'offline-owner-sub');
});
const badClaims = [
 ['issuer', { iss: 'https://evil.test' }], ['audience', { aud: 'evil' }],
 ['principal', { sub: 'attacker' }], ['email case', { email: 'Owner@identity.test' }],
 ['expired', { exp: timestamp }], ['future iat', { iat: timestamp + 1 }],
 ['future nbf', { nbf: timestamp + 1 }], ['missing nbf', { nbf: undefined }],
 ['missing exp', { exp: undefined }], ['missing sub', { sub: undefined }],
 ['missing type', { type: undefined }], ['service type', { type: 'service' }],
 ['service common name', { common_name: 'service' }], ['service id', { service_token_id: 'id' }],
 ['missing MFA', { amr: undefined }], ['false MFA', { amr: ['pwd'] }],
 ['string MFA', { amr: 'mfa' }], ['boolean MFA', { amr: true }],
 ['long lifetime', { exp: timestamp + 601 }], ['stale auth', { iat: timestamp - 601, nbf: timestamp - 601 }]
];
for (const [name, patch] of badClaims) test(`reject ${name}`, async () => {
 await assert.rejects(check(await access(patch), { 'mfa': 'true', 'amr': 'mfa', 'Cf-Access-Authenticated-User-Email': 'owner@identity.test' }));
});
test('missing assertion and unsigned MFA headers fail', async () => { await assert.rejects(check(null, { mfa: 'true', amr: 'mfa' })); });
test('wrong signature fails', async () => { const wrong = await generateKeyPair('RS256'); await assert.rejects(check(await access({}, wrong.privateKey))); });
test('tampered signed claims fail', async () => {
 const t = (await access({ amr: ['pwd'] })).split('.');
 const p = JSON.parse(Buffer.from(t[1], 'base64url')); p.amr = ['mfa'];
 t[1] = Buffer.from(JSON.stringify(p)).toString('base64url'); await assert.rejects(check(t.join('.')));
});
test('none algorithm fails', async () => { await assert.rejects(check(`${Buffer.from('{"alg":"none"}').toString('base64url')}.e30.`)); });
test('HS256 algorithm confusion fails', async () => {
 const t = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'offline-key' }).sign(new Uint8Array(64));
 await assert.rejects(check(t));
});
for (const header of [{ kid: '' }, { jku: 'https://evil.test/keys' }, { x5u: 'https://evil.test' }, { jwk: { kty: 'RSA' } }]) test(`untrusted header ${JSON.stringify(header)}`, async () => { await assert.rejects(check(await access({}, keys.privateKey, header))); });
test('service token headers denied even with owner JWT', async () => { await assert.rejects(check(await access(), { 'CF-Access-Client-Id': 'service' })); });
for (const host of ['evil.test', 'https://team.cloudflareaccess.com', 'team.cloudflareaccess.com.evil.test', 'team.cloudflareaccess.com/path', 'team.cloudflareaccess.com:443']) test(`issuer host pinned: ${host}`, () => {
 assert.throws(() => accessConfig({ ...environment(), ACCESS_TEAM_HOST: host }));
});
