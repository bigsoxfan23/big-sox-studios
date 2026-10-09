import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker, { verifyAccessJwt } from './worker.mjs';

const issuer = 'https://old-hill-995d.cloudflareaccess.com';
const hosts = {
  'members-staging.bigsoxstudios.com': 'f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe',
  'big-sox-studios-members-staging.fridman-greg.workers.dev': 'f4057b183ae0b354ff3e9f161839fbf516e54c33c7714db645c3d5ac950969df',
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
const originalFetch = globalThis.fetch;

function token(audience, changes = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })}.${encode({ iss: issuer, aud: [audience], iat: now, exp: now + 300, email: 'member@example.com', ...changes })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}

const certFetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });

test('accepts a signed, current token for the matching Access app', async () => {
  const result = await verifyAccessJwt(token(hosts['members-staging.bigsoxstudios.com']), hosts['members-staging.bigsoxstudios.com'], certFetch);
  assert.equal(result.email, 'member@example.com');
});

test('rejects wrong audience, expired tokens, and altered signatures', async () => {
  const valid = token(hosts['members-staging.bigsoxstudios.com']);
  await assert.rejects(verifyAccessJwt(valid, hosts['big-sox-studios-members-staging.fridman-greg.workers.dev'], certFetch));
  await assert.rejects(verifyAccessJwt(token(hosts['members-staging.bigsoxstudios.com'], { exp: 1 }), hosts['members-staging.bigsoxstudios.com'], certFetch));
  await assert.rejects(verifyAccessJwt(valid.slice(0, -2) + 'ab', hosts['members-staging.bigsoxstudios.com'], certFetch));
});

test('serves only verified identity on either known hostname', async () => {
  globalThis.fetch = certFetch;
  try {
    for (const [host, audience] of Object.entries(hosts)) {
      const response = await worker.fetch(new Request(`https://${host}/`, { headers: { 'Cf-Access-Jwt-Assertion': token(audience) } }));
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /member@example\.com/);
      assert.match(html, /Not connected/);
      assert.match(html, /Staging preview/);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
      assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('fails closed for missing tokens, unknown hosts, and extra paths', async () => {
  const host = 'members-staging.bigsoxstudios.com';
  assert.equal((await worker.fetch(new Request(`https://${host}/`))).status, 403);
  assert.equal((await worker.fetch(new Request('https://unrecognized.example/'))).status, 404);
  globalThis.fetch = certFetch;
  try {
    assert.equal((await worker.fetch(new Request(`https://${host}/private`, { headers: { 'Cf-Access-Jwt-Assertion': token(hosts[host]) } }))).status, 404);
    assert.equal((await worker.fetch(new Request(`https://${host}/`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': token(hosts[host]) } }))).status, 405);
  } finally { globalThis.fetch = originalFetch; }
});
