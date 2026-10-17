import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { decodeCredentialPublicKey, decodeAttestationObject } from '@simplewebauthn/server/helpers';

const deny = value => { if (!value) throw new Error('denied'); };
export const sha256 = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
export const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function decode(value, max = 4096) {
 deny(typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value));
 const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
 deny(encode(bytes) === value);
 return bytes;
}
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const second = n => Number.isSafeInteger(n) && n >= 0;
export const exact = (value, names) => deny(value && Object.getPrototypeOf(value) === Object.prototype &&
 Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n)));
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);

export function site(env, identity) {
 deny(identity.identityContract === 'signed-owner-identity-v1' && !identity.assurance && identity.sub === env.OWNER_PRINCIPAL);
 const origin = new URL(env.APP_ORIGIN);
 deny(origin.protocol === 'https:' && origin.origin === env.APP_ORIGIN && !origin.port);
 deny(bounded(env.OWNER_PRINCIPAL, 256) && bounded(env.OWNER_ACCESS_EMAIL, 254));
 deny(/^[A-Za-z0-9_-]{16,128}$/.test(env.SESSION_EPOCH));
 return { origin: origin.origin, rpID: origin.hostname, owner: env.OWNER_PRINCIPAL,
  email: env.OWNER_ACCESS_EMAIL, epoch: env.SESSION_EPOCH };
}

// Canonical public bytes, fixed field order. No counter is trusted as replay defense.
export function credentialRecord(record) {
 const fields = ['credentialID', 'publicKey', 'algorithm', 'rpID', 'origin', 'owner', 'email', 'epoch'];
 exact(record, fields);
 decode(record.credentialID, 1400);
 const key = decodeCredentialPublicKey(decode(record.publicKey, 512));
 deny(record.algorithm === -7 && key.size === 5 && key.get(1) === 2 && key.get(3) === -7 && key.get(-1) === 1);
 deny(key.get(-2) instanceof Uint8Array && key.get(-2).length === 32 && key.get(-3) instanceof Uint8Array && key.get(-3).length === 32);
 const origin = new URL(record.origin);
 deny(origin.protocol === 'https:' && origin.origin === record.origin && !origin.port && record.rpID === origin.hostname);
 deny(bounded(record.owner, 256) && bounded(record.email, 254) && /^[A-Za-z0-9_-]{16,128}$/.test(record.epoch));
 return Object.freeze(Object.fromEntries(fields.map(f => [f, record[f]])));
}
export const fingerprint = async record => `sha256:${await sha256(JSON.stringify(credentialRecord(record)))}`;
export function pinnedRecord(record, env, identity) {
 const pin = credentialRecord(record), settings = site(env, identity);
 for (const field of ['rpID', 'origin', 'owner', 'email', 'epoch']) deny(pin[field] === settings[field]);
 return pin;
}

export const stepupHeaders = {
 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
 'Vary': 'Cookie, Cf-Access-Jwt-Assertion', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};
export const reply = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { ...stepupHeaders, ...headers } });
export function cookie(request, optional = false) {
 const raw = request.headers.get('Cookie') ?? ''; deny(raw.length <= 4096);
 const all = raw.split(';').map(x => x.trim());
 const matches = all.filter(x => x.split('=')[0].trim() === '__Host-stepup');
 deny(matches.length === 1 || (optional && matches.length === 0));
 if (!matches.length) return null;
 deny(matches[0].startsWith('__Host-stepup='));
 const value = matches[0].slice('__Host-stepup='.length);
 deny(decode(value, 43).length === 32);
 return value;
}
export async function input(request, env, path) {
 deny(request.method === 'POST' && request.url === env.APP_ORIGIN + path);
 deny(request.headers.get('Origin') === env.APP_ORIGIN && request.headers.get('Sec-Fetch-Site') === 'same-origin');
 deny(request.headers.get('Content-Type') === 'application/json' && request.headers.get('X-Canary-Action') === path.slice(1));
 deny(!request.headers.has('Authorization'));
 const reader = request.body?.getReader(); deny(reader);
 let count = 0, text = '';
 const decoder = new TextDecoder('utf-8', { fatal: true });
 while (true) {
  const { value, done } = await reader.read(); if (done) break;
  count += value.length;
  if (count > 16384) { await reader.cancel(); throw new Error('denied'); }
  text += decoder.decode(value, { stream: true });
 }
 const body = JSON.parse(text + decoder.decode());
 deny(body && Object.getPrototypeOf(body) === Object.prototype);
 return body;
}
async function sessionContext(env, identity) {
 return JSON.stringify({ jwt: await sha256(identity.token), ...site(env, identity),
  issuer: env.ACCESS_TEAM_HOST, audience: env.ACCESS_AUD });
}
async function validSession(request, env, identity, now) {
 const value = cookie(request), ctx = await sessionContext(env, identity);
 const row = await env.CANARY_DB.prepare('SELECT * FROM stepup_challenge WHERE session_hash=?').bind(await sha256(value)).first();
 fresh(row, ctx, identity, now());
 return value;
}
export async function sessionBinding(request, env, identity, now) {
 return sha256(await validSession(request, env, identity, now));
}
export async function session(request, env, identity, now) {
 exact(await input(request, env, '/stepup/session'), []);
 const old = cookie(request, true);
 if (old) {
  await validSession(request, env, identity, now);
  return reply({ ready: true });
 }
 const value = random(), ctx = await sessionContext(env, identity);
 deny(identity.expires > now());
 await stepupStore(env.CANARY_DB).issue(ctx, now(), await sha256(value));
 return reply({ ready: true }, 200, {
  'Set-Cookie': `__Host-stepup=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600` });
}
export async function context(request, env, identity, purpose, config, extra = {}, now = () => Math.floor(Date.now() / 1000)) {
 deny(['register', 'possession', 'preview', 'dispatch'].includes(purpose));
 deny(/^[0-9a-f]{64}$/.test(config));
 return JSON.stringify({ jwt: await sha256(identity.token), cookie: await sha256(await validSession(request, env, identity, now)),
  purpose, config, epoch: env.SESSION_EPOCH, ...extra });
}

export function stepupStore(db) {
 const first = (sql, args = []) => db.prepare(sql).bind(...args).first();
 return {
  async issue(ctx, time, sessionHash = null) {
   deny(second(time));
   // Expired public candidates/proofs can be pruned, never trusted/pinned records.
   await first('DELETE FROM stepup_challenge WHERE expires<=? RETURNING id', [time]);
   await first('DELETE FROM stepup_candidate WHERE expires<=? RETURNING id', [time]);
   const row = { id: random(), challenge: random(), context: ctx, created: time, expires: time + (sessionHash ? 600 : 120), session_hash: sessionHash };
   deny(await first('INSERT INTO stepup_challenge(id,challenge,context,created,expires,session_hash) VALUES(?,?,?,?,?,?) RETURNING id', Object.values(row)));
   return row;
  },
  get: id => { decode(id, 43); return first('SELECT * FROM stepup_challenge WHERE id=?', [id]); },
  verify: (row, time) => first(`UPDATE stepup_challenge SET state='verified',verified=?
   WHERE id=? AND context=? AND session_hash IS NULL AND state='issued' AND created<=? AND expires>? RETURNING *`, [time, row.id, row.context, time, time]),
  consume: (id, ctx, time) => first(`UPDATE stepup_challenge SET state='used',consumed=?
   WHERE id=? AND context=? AND state='verified' AND created<=? AND verified<=? AND expires>? RETURNING *`, [time, id, ctx, time, time, time]),
  candidate: id => { decode(id, 43); return first('SELECT * FROM stepup_candidate WHERE id=?', [id]); },
  addCandidate: (row, record, fp, ctx, time) => first(`INSERT INTO stepup_candidate(id,record,fingerprint,context,created,expires)
   SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM stepup_challenge WHERE id=? AND state='used' AND expires>?) RETURNING id`,
  [row.id, JSON.stringify(record), fp, ctx, time, time + 600, row.id, time]),
  proveCandidate: (id, ctx, proof, time) => first(`UPDATE stepup_candidate SET proof=?,verified=?,public_id=?
   WHERE id=? AND context=? AND proof IS NULL AND created<=? AND expires>?
   AND EXISTS(SELECT 1 FROM stepup_challenge WHERE id=? AND state='used' AND expires>?) RETURNING *`,
  [proof, time, random(), id, ctx, time, time, proof, time])
 };
}
export function fresh(row, ctx, identity, time, state = 'issued') {
 deny(second(time) && row && row.context === ctx && row.state === state && row.created <= time && row.expires > time && identity.expires > time);
}
function responseBounds(response, registration) {
 deny(response && typeof response === 'object' && response.type === 'public-key');
 decode(response.id, 1400); deny(response.id === response.rawId);
 const r = response.response; deny(r && typeof r === 'object');
 const client = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(r.clientDataJSON, 4096)));
 deny((client.crossOrigin === undefined || client.crossOrigin === false) && client.topOrigin === undefined);
 decode(client.challenge, 43);
 if (registration) decode(r.attestationObject, 8192);
 else {
  decode(r.authenticatorData, 2048); decode(r.signature, 256);
  if (r.userHandle !== undefined && r.userHandle !== null) decode(r.userHandle, 256);
 }
}
export async function registration(response, row, settings) {
 responseBounds(response, true);
 // None only: no certificate/metadata/network attestation path is accepted.
 const attestation = decodeAttestationObject(decode(response.response.attestationObject, 8192));
 deny(attestation.get('fmt') === 'none' && attestation.get('attStmt') instanceof Map && attestation.get('attStmt').size === 0);
 const result = await verifyRegistrationResponse({ response, expectedChallenge: row.challenge,
  expectedOrigin: settings.origin, expectedRPID: settings.rpID, requireUserPresence: true,
  requireUserVerification: true, supportedAlgorithmIDs: [-7] });
 deny(result.verified && result.registrationInfo?.fmt === 'none');
 const c = result.registrationInfo.credential;
 deny(c.id === response.id);
 return credentialRecord({ credentialID: c.id, publicKey: encode(c.publicKey), algorithm: -7, ...settings });
}
export async function assertion(response, row, record) {
 const pin = credentialRecord(record);
 responseBounds(response, false);
 deny(response.id === pin.credentialID);
 const result = await verifyAuthenticationResponse({ response, expectedChallenge: row.challenge,
  expectedOrigin: pin.origin, expectedRPID: pin.rpID, requireUserVerification: true,
  credential: { id: pin.credentialID, publicKey: decode(pin.publicKey, 512), counter: 0 } });
 deny(result.verified && result.authenticationInfo.userVerified);
}
export function authenticationOptions(row, record) {
 return { challenge: row.challenge, rpId: record.rpID, timeout: 120000, userVerification: 'required',
  allowCredentials: [{ type: 'public-key', id: record.credentialID }] };
}

// Reusable sender endpoints. Grants remain in the challenge table; consuming one
// before the original campaign CAS burns it even if the process crashes.
export async function senderStepup(request, env, identity, pin, config, target, now) {
 const path = new URL(request.url).pathname;
 if (path === '/stepup/session') return session(request, env, identity, now);
 deny(['/stepup/challenge', '/stepup/verify'].includes(path));
 const body = await input(request, env, path);
 const names = path.endsWith('challenge') ? ['purpose'] : ['purpose', 'id', 'response'];
 exact(body, names); deny(['preview', 'dispatch'].includes(body.purpose));
 const extra = body.purpose === 'dispatch' ? target : {};
 deny(body.purpose !== 'dispatch' || (extra && extra.status === 'approved'));
 const ctx = await context(request, env, identity, body.purpose, config, extra, now);
 const store = stepupStore(env.CANARY_DB);
 if (path.endsWith('challenge')) {
  deny(identity.expires > now());
  const row = await store.issue(ctx, now());
  return reply({ id: row.id, publicKey: authenticationOptions(row, pin) });
 }
 const row = await store.get(body.id);
 fresh(row, ctx, identity, now());
 await assertion(body.response, row, pin);
 fresh(row, ctx, identity, now()); // actual crypto may have crossed the deadline
 deny(await store.verify(row, now()));
 return reply({ proof: row.id, expires: row.expires });
}
export async function consumeProof(request, env, identity, purpose, config, target, id, now) {
 decode(id, 43);
 const ctx = await context(request, env, identity, purpose, config, target, now);
 deny(identity.expires > now());
 const consumed = await stepupStore(env.CANARY_DB).consume(id, ctx, now());
 deny(consumed);
 return consumed;
}
