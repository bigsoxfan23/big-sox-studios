// OFFLINE CONTRACT REHEARSAL ONLY. No provider verifier, persistence, HTTP or send authority.
// A signature proves key possession, not truth. Fixture producers can lie successfully.
// Never import this module into a Worker or translate its result into v1 provenance.
const encoder = new TextEncoder();
const MODE = 'offline-fixture';
const EVENT = 'maildesk-offline-ingress-v2';
const CHALLENGE = 'maildesk-offline-mailbox-v2';
function deny(condition, reason) { if (!condition) throw Error(reason); }
function shape(value, keys) {
 deny(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.split(' ').sort().join(','), 'shape');
}
const integer = n => Number.isSafeInteger(n) && n >= 0;
const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const mailbox = s => typeof s === 'string' && /^[a-z0-9._+-]+@(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)+test$/.test(s);
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function origin(s) {
 try { const u = new URL(s); return u.origin === s && u.protocol === 'https:' && u.hostname.endsWith('.test'); }
 catch { return false; }
}
function decode(s, length) {
 deny(typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length <= 128, 'encoding');
 const bytes = Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
 deny(bytes.length === length && encode(bytes) === s, 'encoding'); return bytes;
}
function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export async function fixtureSha256(bytes) {
 deny(bytes instanceof Uint8Array && bytes.length <= 131072, 'hash_input');
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Lossless for this deliberately narrow ASCII/unfolded subset only. No Headers API,
// MIME decoding, trimming, case repair, unfolding, or duplicate coalescing.
export function inspectFixtureRaw(raw) {
 deny(raw instanceof Uint8Array && raw.length > 0 && raw.length <= 131072, 'raw_bounds');
 let end = -1;
 for (let i = 0; i + 3 < raw.length && i < 32768; i++) {
  if (raw[i] === 13 && raw[i+1] === 10 && raw[i+2] === 13 && raw[i+3] === 10) { end = i; break; }
 }
 deny(end > 0 && end + 4 <= 32768, 'header_bounds');
 const headerBytes = raw.slice(0, end + 4), bodyBytes = raw.slice(end + 4);
 deny(bodyBytes.length <= 98304, 'body_bounds');
 const text = new TextDecoder('ascii').decode(raw.slice(0, end));
 deny(!/[^\x20-\x7e\r\n]/.test(text), 'header_controls');
 const lines = text.split('\r\n'), pairs = [], seen = new Set();
 deny(lines.length <= 100, 'header_count');
 for (const line of lines) {
  const colon = line.indexOf(':'), name = line.slice(0, colon), value = line.slice(colon + 1);
  deny(colon > 0 && /^[A-Za-z0-9-]+$/.test(name) && !/[\r\n]/.test(value) && line.length <= 4096, 'header_syntax');
  const lower = name.toLowerCase(); deny(!seen.has(lower), 'duplicate_header'); seen.add(lower);
  pairs.push([name, value]);
 }
 return { pairs, headerBytes, bodyBytes };
}
function readSigned(wire) {
 shape(wire, 'payload signature');
 deny(typeof wire.payload === 'string' && encoder.encode(wire.payload).length <= 65536, 'payload_bounds');
 const claims = JSON.parse(wire.payload);
 // Also rejects duplicate JSON members and noncanonical whitespace/number encodings.
 deny(JSON.stringify(claims) === wire.payload, 'payload_encoding');
 return { claims, bytes:encoder.encode(wire.payload), signature:decode(wire.signature, 64) };
}
async function anchor(a, role) {
 shape(a, 'issuer keyId publicKey notBefore notAfter role');
 deny(origin(a.issuer) && id(a.keyId) && a.role === role && integer(a.notBefore) &&
  integer(a.notAfter) && a.notAfter > a.notBefore, 'anchor');
 return { ...a, key:await crypto.subtle.importKey('raw', decode(a.publicKey, 32), 'Ed25519', false, ['verify']) };
}
async function verify(wire, a, purpose, now) {
 const signed = readSigned(wire), c = signed.claims;
 deny(c.version === 2 && c.mode === MODE && c.purpose === purpose && c.algorithm === 'Ed25519' &&
  c.issuer === a.issuer && c.keyId === a.keyId, 'signature_context');
 deny(now >= a.notBefore && now < a.notAfter, 'anchor_expired');
 deny(await crypto.subtle.verify('Ed25519', a.key, signed.signature, signed.bytes), 'signature');
 return c;
}
// Pinned .test anchors only; no key URL/JWK from evidence, callback verifier, or boolean trust override.
// Replay state is bounded and process-local: intentionally unsuitable for durable acceptance.
export async function createOfflineIngressPolicy(config, clock = () => Math.floor(Date.now()/1000)) {
 const cfg = JSON.parse(JSON.stringify(config));
 shape(cfg, 'mode owner sender cutoff ingress challenge');
 deny(cfg.mode === MODE && mailbox(cfg.owner) && mailbox(cfg.sender) && cfg.owner !== cfg.sender && integer(cfg.cutoff) && cfg.cutoff > 0, 'offline_only');
 const ingress = await anchor(cfg.ingress, 'fixture-ingress'), challenge = await anchor(cfg.challenge, 'fixture-challenge');
 deny(ingress.publicKey !== challenge.publicKey && ingress.issuer !== challenge.issuer, 'separate_trust_anchors');
 const consumed = new Set(); let accepted = 0;
 return Object.freeze({ async accept(input) {
  // Snapshot all caller-owned data before the first await.
  shape(input, 'event proof expected raw');
  deny(input.raw instanceof Uint8Array && input.raw.length > 0 && input.raw.length <= 131072, 'raw_bounds');
  readSigned(input.event); readSigned(input.proof);
  const raw = input.raw.slice(), local = JSON.parse(JSON.stringify({ event:input.event, proof:input.proof, expected:input.expected }));
  const now = clock(); deny(integer(now) && now > cfg.cutoff, 'clock');
  const e = await verify(local.event, ingress, EVENT, now);
  shape(e, 'version mode purpose algorithm issuer keyId eventId receiptKey caseId messageId envelopeFrom envelopeTo receivedAt messageCreatedAt issuedAt expiresAt rawHeaders headerSha256 bodySha256 authentication challengeId');
  const expected = local.expected;
  shape(expected, 'receiptKey caseId messageId envelopeFrom envelopeTo receivedAt messageCreatedAt');
  for (const key of Object.keys(expected)) deny(e[key] === expected[key], 'binding');
  deny(['eventId','receiptKey','caseId','messageId','challengeId'].every(k => id(e[k])), 'identifier');
  deny(e.envelopeFrom === cfg.owner && e.envelopeTo === cfg.sender, 'exact_envelope');
  deny(['receivedAt','messageCreatedAt','issuedAt','expiresAt'].every(k => integer(e[k])) &&
   e.receivedAt > cfg.cutoff && e.messageCreatedAt > cfg.cutoff && e.receivedAt <= e.messageCreatedAt &&
   e.messageCreatedAt <= e.issuedAt && e.issuedAt <= now && now - e.receivedAt <= 300 &&
   e.expiresAt > now && e.expiresAt > e.issuedAt && e.expiresAt <= e.issuedAt + 300, 'freshness');
  deny(e.receivedAt >= ingress.notBefore && e.issuedAt < ingress.notAfter, 'anchor_time');
  const parsed = inspectFixtureRaw(raw), headers = new Map(parsed.pairs.map(([k,v]) => [k.toLowerCase(),v]));
  deny(JSON.stringify(parsed.pairs) === JSON.stringify(e.rawHeaders), 'raw_pairs');
  deny(headers.get('from') === ` ${cfg.owner}` && headers.get('to') === ` ${cfg.sender}` &&
   (!headers.has('reply-to') || headers.get('reply-to') === ` ${cfg.owner}`), 'mailbox_headers');
  deny(/^ <[A-Za-z0-9._-]+@[a-z0-9.-]+\.test>$/.test(headers.get('message-id') ?? ''), 'message_header');
  deny(hex(e.headerSha256) && hex(e.bodySha256) && e.headerSha256 === await fixtureSha256(parsed.headerBytes) &&
   e.bodySha256 === await fixtureSha256(parsed.bodyBytes), 'hash_binding');
  const a = e.authentication;
  shape(a, 'source evidenceId dmarc method domain');
  // Structural check of producer assertions ONLY. This code performs no SPF/DKIM/DMARC verification.
  // Exact domain equality is a conservative strict-alignment subset; no PSL/relaxed alignment guesses.
  deny(a.source === 'fixture-independent-provider' && id(a.evidenceId) && a.dmarc === 'pass' &&
   ['spf','dkim'].includes(a.method) && a.domain === cfg.owner.split('@')[1] &&
   (a.method !== 'spf' || a.domain === e.envelopeFrom.split('@')[1]), 'aligned_assertion');
  const p = await verify(local.proof, challenge, CHALLENGE, now);
  shape(p, 'version mode purpose algorithm issuer keyId challengeId mailbox ingressSha256 verifiedAt expiresAt method');
  deny(p.challengeId === e.challengeId && p.mailbox === cfg.owner && p.method === 'fixture-standalone-challenge' &&
   hex(p.ingressSha256) && p.ingressSha256 === await fixtureSha256(encoder.encode(local.event.payload)), 'challenge_binding');
  deny(integer(p.verifiedAt) && integer(p.expiresAt) && p.verifiedAt > cfg.cutoff && p.verifiedAt >= e.issuedAt && p.verifiedAt <= now &&
   p.verifiedAt >= challenge.notBefore && p.verifiedAt < challenge.notAfter &&
   p.expiresAt > now && p.expiresAt > p.verifiedAt && p.expiresAt <= p.verifiedAt + 600, 'challenge_expired');
  const keys = [`event:${e.eventId}`, `receipt:${e.receiptKey}`, `message:${e.messageId}`, `challenge:${p.challengeId}`];
  deny(accepted < 10000 && keys.every(k => !consumed.has(k)), 'replay');
  // No await between final conflict test and reservation: one winner within this process only.
  keys.forEach(k => consumed.add(k)); accepted++;
  return Object.freeze({ kind:'offline-policy-accepted-not-authority', eventId:e.eventId });
 } });
}
