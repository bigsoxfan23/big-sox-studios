import { generateKeyPairSync, createHash, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { fixture, access, resolver, timestamp } from './helpers.mjs';
import { verifySignedOwnerIdentity } from '../src/auth.mjs';
import { STEPUP_CONTRACT } from '../src/stepup-release.mjs';
import { createEnrollment } from '../src/enrollment.mjs';
import { createCandidate } from '../src/worker.mjs';
import { fingerprint, sha256 } from '../src/stepup.mjs';

const b64 = value => Buffer.from(value).toString('base64url');
const sha = value => createHash('sha256').update(value).digest();
export function authenticator() {
 const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = pair.publicKey.export({ format: 'jwk' });
 const id = randomBytes(32);
 const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
 const record = { credentialID: b64(id), publicKey: b64(cose), algorithm: -7, rpID: 'canary.test', origin: 'https://canary.test',
  owner: 'offline-owner-sub', email: 'owner@identity.test', epoch: 'offline-session-epoch-v1' };
 function response(challenge, options = {}, registration = false) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: registration ? 'webauthn.create' : 'webauthn.get',
   challenge, origin: record.origin, crossOrigin: false, ...options.client }));
  const counter = Buffer.alloc(4); counter.writeUInt32BE(options.counter ?? 0);
  let auth = Buffer.concat([sha(options.rpID ?? record.rpID), Buffer.from([options.flags ?? (registration ? 0x45 : 0x05)]), counter]);
  if (registration) auth = Buffer.concat([auth, Buffer.alloc(16), Buffer.from([id.length >> 8, id.length & 255]), id, options.cose ?? cose]);
  const data = registration
   ? { attestationObject: b64(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(auth)]]))) }
   : { authenticatorData: b64(auth), signature: b64(sign('sha256', Buffer.concat([auth, sha(clientDataJSON)]), options.privateKey ?? pair.privateKey)) };
  return { id: record.credentialID, rawId: record.credentialID, type: 'public-key', response: { clientDataJSON: b64(clientDataJSON), ...data }, clientExtensionResults: {} };
 }
 return { record, pair, register: (c, o) => response(c, o, true), assert: response };
}

export async function stepupFixture(t, db) {
 const f = await fixture(); if (t) t.after(() => f.cleanup());
 f.a.exec(readFileSync(new URL('../migrations/0002_stepup.sql', import.meta.url), 'utf8'));
 if (db) f.env.CANARY_DB = db;
 f.env.MFA_CONTRACT = STEPUP_CONTRACT;
 let time = timestamp, token = await access({ amr: undefined }), cookies = '', stageToken;
 const auth = authenticator();
 const verify = (r, e) => verifySignedOwnerIdentity(r, e, resolver, time);
 const now = () => time;
 const deps = { ...f.deps, verify, now, credentialPin: auth.record };
 let worker = createCandidate(deps), enrollment = createEnrollment({ verify, now });
 const s = { f, auth, deps, enrollment, now, get worker() { return worker; }, get cookies() { return cookies; },
  get stageToken() { return stageToken; }, get token() { return token; },
  setToken(v) { token = v; }, setCookies(v) { cookies = v; }, advance(n) { time += n; },
  async call(path, body = {}, options = {}) {
   const { target = worker, env = f.env, headers = {}, ...init } = options;
   const r = await target.fetch(new Request(f.env.APP_ORIGIN + path, { method: 'POST', headers: {
    'Cf-Access-Jwt-Assertion': token, Origin: f.env.APP_ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json', 'X-Canary-Action': path.slice(1), Cookie: cookies, ...headers
   }, body: JSON.stringify(body), ...init }), env);
   const data = await r.json();
   if (r.ok) {
    if (r.headers.has('set-cookie')) {
     const c = r.headers.get('set-cookie').split(';')[0], name = c.split('=')[0];
     cookies = cookies.split('; ').filter(v => v && v.split('=')[0] !== name).concat(c).join('; ');
    }
    if (data.token) stageToken = data.token;
   }
   return { r, data };
  },
  async session(target = worker) { return s.call('/stepup/session', {}, { target }); },
  async proof(purpose, options = {}) {
   const o = await s.call('/stepup/challenge', { purpose }, options);
   if (!o.r.ok) throw new Error('challenge denied');
   const v = await s.call('/stepup/verify', { purpose, id: o.data.id, response: auth.assert(o.data.publicKey.challenge) }, options);
   if (!v.r.ok) throw new Error('assertion denied');
   return v.data.proof;
  },
  async preview() {
   await s.session();
   const p = await s.call('/preview', { proof: await s.proof('preview') });
   if (!p.r.ok) throw new Error('preview denied');
   return p.data;
  },
  async approved() { await s.preview(); for (const path of ['/review', '/approve']) {
   if (!(await s.call(path, { token: stageToken })).r.ok) throw new Error('stage denied');
  } },
  async confirm() {
   const row = db ? await db.prepare('SELECT * FROM canary_campaign').first() : f.row();
   deps.finalConfirmation = { configDigest: row.digest, epoch: f.env.SESSION_EPOCH,
    envelopeDigest: await sha256(JSON.stringify(JSON.parse(row.snapshot).payload)) };
   worker = createCandidate(deps);
  },
  async enroll() {
   await s.session(enrollment);
   const o = await s.call('/enroll/register/options', {}, { target: enrollment });
   const r = await s.call('/enroll/register/verify', { id: o.data.id, response: auth.register(o.data.publicKey.challenge) }, { target: enrollment });
   if (!r.r.ok) throw new Error('registration denied');
   return r.data.candidateHandle;
  },
  async possession(candidate) {
   const o = await s.call('/enroll/prove/options', { candidate }, { target: enrollment });
   if (!o.r.ok) throw new Error('possession options denied');
   return s.call('/enroll/prove/verify', { candidate, id: o.data.id, response: auth.assert(o.data.publicKey.challenge) }, { target: enrollment });
  },
  fingerprint: () => fingerprint(auth.record)
 };
 return s;
}
