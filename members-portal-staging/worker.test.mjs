import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
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

// Synthetic identities only; these values are never live owner configuration.
const customHost = 'members-staging.bigsoxstudios.com';
const customAudience = hosts[customHost];
const diagnosticUrl = `https://${customHost}/owner/identity-check`;
const ownerEnv = { DIAGNOSTIC_OWNER_EMAIL: 'member@example.com' };
const fullIdentity = {
  email: 'member@example.com', name: 'PRIVATE_NAME', id: 'PRIVATE_ID',
  idp: { type: 'PRIVATE_PROVIDER' }, oidc_fields: { sub: 'PRIVATE_SUB', other: 'PRIVATE_ATTRIBUTE' },
  amr: ['PRIVATE_METHOD'], groups: ['PRIVATE_GROUP'],
};
const accessContext = (identity = fullIdentity, aud = customAudience) => ({ access: { aud, getIdentity: async () => identity } });
function diagnosticRequest({ url = diagnosticUrl, jwt = token(customAudience), method = 'GET', headers = {} } = {}) {
  return new Request(url, { method, headers: { 'Cf-Access-Jwt-Assertion': jwt, Cookie: 'PRIVATE_COOKIE', ...headers } });
}
async function withKeys(run) {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
    assert.deepEqual(options, { headers: { Accept: 'application/json' } });
    return certFetch();
  };
  try { await run(); } finally { globalThis.fetch = originalFetch; }
}
function assertPrivate(body) {
  for (const value of ['member@example.com', 'PRIVATE_', 'Cf-Access', 'eyJ', 'Error:', 'stack', 'onetimepin', 'google', issuer, ...Object.keys(hosts), ...Object.values(hosts)]) assert.ok(!body.includes(value));
}
function diagnosticFields(body) {
  return Object.fromEntries([...body.matchAll(/<dt>(.*?)<\/dt><dd>(true|false)<\/dd>/g)].map(match => [match[1], match[2] === 'true']));
}
function assertDiagnosticHeaders(response) {
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'none'/);
  assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
}

test('diagnostic signed owner with matching Access context outputs only boolean field values', async () => withKeys(async () => {
  const response = await worker.fetch(diagnosticRequest(), ownerEnv, accessContext());
  assert.equal(response.status, 200);
  assertDiagnosticHeaders(response);
  const body = await response.text();
  assertPrivate(body);
  assert.deepEqual(diagnosticFields(body), {
    accessContextAvailable: true, idpTypePresent: true, oidcSubjectPresent: true,
    amrArrayPresent: true, otpProviderConfirmed: false,
    signedJwtRuntimeEmailExactMatch: true, memberAppAudienceConfirmed: true,
    mfaEvidenceEstablished: false,
  });
  assert.match(body, /MFA NOT VERIFIED/);
  assert.ok(!body.includes('<script'));
}));

test('diagnostic missing context and failing identity read are sanitized unavailable states', async () => withKeys(async () => {
  for (const ctx of [undefined, {}, accessContext(null), { access: { aud: customAudience, getIdentity: async () => undefined } }, { access: { aud: customAudience, getIdentity() { throw new Error('PRIVATE_EXCEPTION'); } } }]) {
    const response = await worker.fetch(diagnosticRequest(), ownerEnv, ctx);
    assert.equal(response.status, 503);
    assertDiagnosticHeaders(response);
    const body = await response.text();
    assert.match(body, /unavailable/);
    assertPrivate(body);
    assert.match(body, /mfaEvidenceEstablished<\/dt><dd>false/);
    assert.match(body, /MFA NOT VERIFIED/);
    const fields = diagnosticFields(body);
    assert.equal(fields.otpProviderConfirmed, false);
    assert.equal(fields.signedJwtRuntimeEmailExactMatch, false);
    assert.equal(fields.memberAppAudienceConfirmed, false);
  }
}));

test('diagnostic absent and mistyped fields stay false and AMR never establishes MFA', async () => withKeys(async () => {
  for (const identity of [{ email: ownerEnv.DIAGNOSTIC_OWNER_EMAIL }, { email: ownerEnv.DIAGNOSTIC_OWNER_EMAIL, idp: { type: {} }, oidc_fields: { sub: [] }, amr: 'mfa' }]) {
    const response = await worker.fetch(diagnosticRequest(), ownerEnv, accessContext(identity));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.deepEqual(diagnosticFields(body), {
      accessContextAvailable: true, idpTypePresent: false, oidcSubjectPresent: false,
      amrArrayPresent: false, otpProviderConfirmed: false,
      signedJwtRuntimeEmailExactMatch: true, memberAppAudienceConfirmed: true,
      mfaEvidenceEstablished: false,
    });
  }
}));

test('diagnostic confirms only exact runtime OTP type and never infers MFA', async () => withKeys(async () => {
  for (const type of ['onetimepin', 'google', 'Onetimepin', 'ONETIMEPIN', 'onetimepin ', ' onetimepin', '', null, undefined, 1, {}, ['onetimepin']]) {
    const identity = { ...fullIdentity, idp: { type }, amr: ['otp', 'mfa'], mfa: true };
    const response = await worker.fetch(diagnosticRequest({ headers: { Origin: `https://${customHost}` } }), ownerEnv, accessContext(identity));
    assert.equal(response.status, 200);
    assertDiagnosticHeaders(response);
    const body = await response.text();
    assertPrivate(body);
    const fields = diagnosticFields(body);
    assert.equal(fields.otpProviderConfirmed, type === 'onetimepin');
    assert.equal(fields.signedJwtRuntimeEmailExactMatch, true);
    assert.equal(fields.memberAppAudienceConfirmed, true);
    assert.equal(fields.mfaEvidenceEstablished, false);
    assert.match(body, /MFA NOT VERIFIED/);
  }
}));

test('diagnostic absent owner configuration returns 404 without reading identity', async () => {
  const ctx = { access: { getIdentity() { assert.fail('Must not read identity'); } } };
  for (const env of [undefined, {}, { DIAGNOSTIC_OWNER_EMAIL: '' }, { DIAGNOSTIC_OWNER_EMAIL: ' member@example.com' }]) {
    const response = await worker.fetch(diagnosticRequest(), env, ctx);
    assert.equal(response.status, 404);
    assertDiagnosticHeaders(response);
  }
});

test('diagnostic blocks direct Worker, unknown/mismatched Host, HTTP, port, query and methods', async () => withKeys(async () => {
  const cases = [
    { url: `https://${Object.keys(hosts)[1]}/owner/identity-check`, jwt: token(Object.values(hosts)[1]) },
    { url: 'https://unknown.example/owner/identity-check' },
    { headers: { Host: Object.keys(hosts)[1] } },
    { headers: { Origin: 'https://unknown.example' } },
    { headers: { Origin: 'null' } },
    { url: 'https://unknown.example/owner/identity-check', headers: { Host: customHost } },
    { url: diagnosticUrl.replace('https:', 'http:') },
    { url: diagnosticUrl.replace(customHost, `${customHost}:8443`) },
    { url: diagnosticUrl + '?debug=1' }, { url: diagnosticUrl + '?' },
    { method: 'POST' }, { method: 'HEAD' }, { method: 'OPTIONS' },
  ];
  for (const options of cases) {
    const response = await worker.fetch(diagnosticRequest(options), ownerEnv, accessContext());
    assert.equal(response.status, 404);
    assertDiagnosticHeaders(response);
    assertPrivate(await response.text());
  }
}));

test('diagnostic rejects wrong or multiple audience, issuer, time, signature and forged identity headers', async () => withKeys(async () => {
  const now = Math.floor(Date.now() / 1000);
  const changes = [
    { aud: [Object.values(hosts)[1]] }, { aud: [customAudience, Object.values(hosts)[1]] },
    { aud: [customAudience, customAudience] }, { aud: customAudience },
    { iss: 'https://forged.example' }, { exp: now }, { iat: now + 30 }, { nbf: now + 30 },
    { email: 'unknown@example.com' }, { email: 'Member@example.com' },
  ];
  const valid = token(customAudience);
  for (const jwt of ['', valid.slice(0, -12) + 'AAAAAAAAAAAA', ...changes.map(change => token(customAudience, change))]) {
    const response = await worker.fetch(diagnosticRequest({ jwt, headers: {
      'Cf-Access-Authenticated-User-Email': ownerEnv.DIAGNOSTIC_OWNER_EMAIL,
      'X-Identity': JSON.stringify(fullIdentity),
    } }), ownerEnv, accessContext());
    assert.equal(response.status, 403);
    assertPrivate(await response.text());
  }
}));

test('diagnostic requires context audience and matching identity, never email headers alone', async () => withKeys(async () => {
  const noAudience = accessContext();
  delete noAudience.access.aud;
  for (const ctx of [accessContext(fullIdentity, Object.values(hosts)[1]), accessContext(fullIdentity, [customAudience]), noAudience, accessContext({ ...fullIdentity, idp: { type: 'onetimepin' }, email: 'unknown@example.com' }), accessContext({ email: 'Member@example.com' }), accessContext({})]) {
    const response = await worker.fetch(diagnosticRequest(), ownerEnv, ctx);
    assert.equal(response.status, 403);
    assertPrivate(await response.text());
  }
}));

test('homepage retains upstream rendered bytes, HEAD, headers and both audiences', async () => withKeys(async () => {
  for (const [host, audience] of Object.entries(hosts)) {
    const request = new Request(`https://${host}/`, { headers: { 'Cf-Access-Jwt-Assertion': token(audience) } });
    const response = await worker.fetch(request, ownerEnv, accessContext());
    assert.equal(response.status, 200);
    assert.equal(createHash('sha256').update(await response.text()).digest('hex'), 'fa45ec84ff4ede79babe580e7400eb718fd290ce441954dc0197d70c4fb65663');
    assert.equal(response.headers.get('X-Robots-Tag'), null);
    const head = await worker.fetch(new Request(request, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
}));
