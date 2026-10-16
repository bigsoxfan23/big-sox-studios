// Ephemeral signer for adversarial offline tests. No private key export or real identities.
import { fixtureSha256, inspectFixtureRaw, createOfflineIngressPolicy } from '../offline/ingress.policy.mjs';
if (!process.env.NODE_TEST_CONTEXT && !process.execArgv.includes('--test')) throw Error('test_runner_only');
const enc = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const testMailbox = s => typeof s === 'string' && /^[a-z0-9._+-]+@(?:[a-z0-9-]+\.)+test$/.test(s);
function testIdentity(c) {
 for (const key of ['envelopeFrom','envelopeTo','mailbox']) {
  if (key in c && !testMailbox(c[key])) throw Error('fixture_identity_only');
 }
 if (c.mode !== 'offline-fixture' || !/^https:\/\/[a-z.-]+\.test$/.test(c.issuer)) throw Error('fixture_identity_only');
}
export async function ingressFixture() {
 const time = 1800000000, keys = await crypto.subtle.generateKey('Ed25519', false, ['sign','verify']);
 const challengeKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign','verify']);
 const anchor = async (pair, name, role) => ({ issuer:`https://${name}.example.test`, keyId:name,
  publicKey:b64(await crypto.subtle.exportKey('raw', pair.publicKey)), notBefore:time-100, notAfter:time+1000, role });
 const config = { mode:'offline-fixture', owner:'owner@example.test', sender:'support@studio.test', cutoff:time-60,
  ingress:await anchor(keys,'ingress','fixture-ingress'), challenge:await anchor(challengeKeys,'challenge','fixture-challenge') };
 const raw = enc.encode('From: owner@example.test\r\nTo: support@studio.test\r\nMessage-ID: <one@example.test>\r\nReply-To: owner@example.test\r\n\r\nFixture body\r\n');
 const parsed = inspectFixtureRaw(raw);
 const expected = { receiptKey:'receipt-1', caseId:'case-1', messageId:'message-1', envelopeFrom:config.owner,
  envelopeTo:config.sender, receivedAt:time-10, messageCreatedAt:time-9 };
 const claims = { version:2, mode:'offline-fixture', purpose:'maildesk-offline-ingress-v2', algorithm:'Ed25519',
  issuer:config.ingress.issuer, keyId:config.ingress.keyId, eventId:'event-1', ...expected,
  issuedAt:time-8, expiresAt:time+60, rawHeaders:parsed.pairs, headerSha256:await fixtureSha256(parsed.headerBytes),
  bodySha256:await fixtureSha256(parsed.bodyBytes), authentication:{source:'fixture-independent-provider', evidenceId:'provider-event-1',
   dmarc:'pass', method:'dkim', domain:'example.test'}, challengeId:'challenge-1' };
 async function sign(c, pair) {
  testIdentity(c); const payload = JSON.stringify(c);
  return { payload, signature:b64(await crypto.subtle.sign('Ed25519', pair.privateKey, enc.encode(payload))) };
 }
 async function input(changes = {}, proofChanges = {}, rawBytes = raw) {
  const e = { ...structuredClone(claims), ...changes };
  const event = await sign(e, keys);
  const p = { version:2, mode:'offline-fixture', purpose:'maildesk-offline-mailbox-v2', algorithm:'Ed25519',
   issuer:config.challenge.issuer, keyId:config.challenge.keyId, challengeId:e.challengeId, mailbox:config.owner,
   ingressSha256:await fixtureSha256(enc.encode(event.payload)), verifiedAt:time-5, expiresAt:time+120,
   method:'fixture-standalone-challenge', ...proofChanges };
  return { event, proof:await sign(p, challengeKeys), expected:structuredClone(expected), raw:rawBytes.slice() };
 }
 return { time, config, claims, raw, expected, input, policy:() => createOfflineIngressPolicy(config, () => time) };
}
