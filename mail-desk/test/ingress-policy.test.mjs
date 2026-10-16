import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { ingressFixture } from './ingress.fixture.mjs';
import { createOfflineIngressPolicy, inspectFixtureRaw, fixtureSha256 } from '../offline/ingress.policy.mjs';
const enc = new TextEncoder();
const reject = async (f, input) => assert.rejects((await f.policy()).accept(input));
test('offline policy accepts bound ephemeral assertions once, without granting authority', async () => {
 const f = await ingressFixture(), p = await f.policy(), i = await f.input();
 assert.deepEqual(await p.accept(i), {kind:'offline-policy-accepted-not-authority',eventId:'event-1'});
 await assert.rejects(p.accept(i), /replay/);
 assert.equal(Object.isFrozen(p), true);
});
test('SPF strict-alignment assertion is supported as a fixture, independent of raw auth headers', async () => {
 const f = await ingressFixture();
 await (await f.policy()).accept(await f.input({authentication:{...f.claims.authentication,method:'spf'}}));
});
for (const [name, change] of [
 ['version',{version:1}], ['purpose',{purpose:'maildesk-ingress-v1'}], ['algorithm none',{algorithm:'none'}],
 ['algorithm HS256',{algorithm:'HS256'}], ['unknown issuer',{issuer:'https://evil.example.test'}], ['key confusion',{keyId:'challenge'}],
 ['receipt',{receiptKey:'other'}], ['case',{caseId:'other'}], ['message',{messageId:'other'}],
 ['envelope local part',{envelopeFrom:'other@example.test'}], ['envelope destination',{envelopeTo:'other@studio.test'}],
 ['receipt time',{receivedAt:1799999989}], ['message time',{messageCreatedAt:1799999990}],
 ['expired',{expiresAt:1800000000}], ['future issuance',{issuedAt:1800000001}],
 ['long-lived',{expiresAt:1800000500}], ['unknown field',{humanApproved:true}],
 ['swapped header hash',{headerSha256:'a'.repeat(64)}], ['swapped body hash',{bodySha256:'a'.repeat(64)}],
 ['missing challenge',{challengeId:''}], ['missing auth',{authentication:null}],
]) test(`signed event rejects ${name}`, async () => {
 const f = await ingressFixture(); await reject(f, await f.input(change));
});
for (const [name, change] of [
 ['misaligned SPF',{method:'spf',domain:'attacker.test'}], ['misaligned DKIM',{domain:'attacker.test'}],
 ['subdomain alignment',{domain:'mail.example.test'}], ['DMARC fail',{dmarc:'fail'}],
 ['DMARC absent',{dmarc:undefined}], ['forward-only',{source:'forward-success'}],
 ['user header source',{source:'Authentication-Results'}], ['no provider evidence',{evidenceId:''}],
 ['unsupported ARC',{method:'arc'}],
]) test(`producer assertion rejects ${name}`, async () => {
 const f = await ingressFixture(); await reject(f, await f.input({authentication:{...f.claims.authentication,...change}}));
});
for (const [name, change] of [
 ['unproven',{method:'user-approved'}], ['wrong mailbox',{mailbox:'other@example.test'}],
 ['expired',{expiresAt:1800000000}], ['future verification',{verifiedAt:1800000001}],
 ['historical',{verifiedAt:1799999940}], ['before event issuance',{verifiedAt:1799999991}], ['unbounded expiry',{expiresAt:1800001000}],
 ['wrong challenge',{challengeId:'other'}], ['swapped event',{ingressSha256:'0'.repeat(64)}],
 ['wrong purpose',{purpose:'maildesk-offline-ingress-v2'}], ['wrong issuer',{issuer:'https://ingress.example.test'}],
 ['wrong key',{keyId:'ingress'}], ['wrong algorithm',{algorithm:'HS256'}],
]) test(`separate signed challenge rejects ${name}`, async () => {
 const f = await ingressFixture(); await reject(f, await f.input({},change));
});
for (const [name, alter] of [
 ['duplicate From',s=>s.replace('\r\nTo:', '\r\nfRoM: owner@example.test\r\nTo:')],
 ['duplicate Reply-To',s=>s.replace('\r\n\r\n','\r\nreply-to: owner@example.test\r\n\r\n')],
 ['duplicate auth results',s=>s.replace('\r\n\r\n','\r\nAuthentication-Results: fake; dmarc=pass\r\nauthentication-results: fake; dmarc=pass\r\n\r\n')],
 ['fold',s=>s.replace('From: owner', 'From: \r\n owner')],
 ['bare LF',s=>s.replace('From: owner','From: owner\nBcc: evil')],
 ['NUL',s=>s.replace('From: owner','From: ow\0ner')],
 ['DEL',s=>s.replace('From: owner','From: ow\x7fner')],
 ['non ASCII',s=>s.replace('From: owner','From: ow\u0085ner')],
 ['space in name',s=>s.replace('From:', 'From :')],
 ['oversized line',s=>s.replace('From: owner','X-Test: '+ 'a'.repeat(4096)+'\r\nFrom: owner')],
]) test(`raw MIME rejects ${name} before normalization`, async () => {
 const f = await ingressFixture(), raw = enc.encode(alter(new TextDecoder().decode(f.raw)));
 assert.throws(()=>inspectFixtureRaw(raw)); await reject(f,await f.input({}, {}, raw));
});
test('forged aligned-looking Authentication-Results/Received never substitute for producer evidence', async () => {
 const f = await ingressFixture();
 const raw = enc.encode(new TextDecoder().decode(f.raw).replace('\r\n\r\n',
  '\r\nAuthentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=example.test\r\nReceived: from trusted.example.test\r\n\r\n'));
 const p = inspectFixtureRaw(raw), changes = {rawHeaders:p.pairs,headerSha256:await fixtureSha256(p.headerBytes)};
 await reject(f,await f.input({...changes,authentication:{...f.claims.authentication,dmarc:'fail'}},{},raw));
 await reject(f,await f.input({...changes,authentication:{...f.claims.authentication,source:'Authentication-Results'}},{},raw));
 // Even a trusted fixture key can sign a lie. Acceptance is explicitly non-authoritative.
 assert.equal((await (await f.policy()).accept(await f.input(changes,{},raw))).kind,'offline-policy-accepted-not-authority');
});
test('raw header pairs preserve casing, order and whitespace; altered pairs or bytes fail hashes', async () => {
 const f = await ingressFixture();
 assert.deepEqual(inspectFixtureRaw(f.raw).pairs[0],['From',' owner@example.test']);
 for (const pairs of [f.claims.rawHeaders.toReversed(),f.claims.rawHeaders.map(([k,v])=>[k.toLowerCase(),v]),
  f.claims.rawHeaders.map(([k,v])=>[k,v.trim()])]) await reject(f,await f.input({rawHeaders:pairs}));
 const bodySwap = f.raw.slice(); bodySwap[bodySwap.length-3] ^= 1;
 await reject(f,await f.input({}, {}, bodySwap));
 const headerSwap = enc.encode(new TextDecoder().decode(f.raw).replace('Reply-To:', 'reply-to:'));
 await reject(f,await f.input({}, {}, headerSwap));
});
test('receipt/message cutoff equality and older events cannot be made eligible by fresh signing', async () => {
 const f = await ingressFixture();
 for (const age of [60,61,301]) {
  const i = await f.input({receivedAt:f.time-age,messageCreatedAt:f.time-age});
  i.expected.receivedAt = i.expected.messageCreatedAt = f.time-age;
  await reject(f,i);
 }
 // Old but post-cutoff also rejected independently by freshness.
 f.config.cutoff = f.time-1000;
 const i = await f.input({receivedAt:f.time-301,messageCreatedAt:f.time-300});
 i.expected.receivedAt=f.time-301; i.expected.messageCreatedAt=f.time-300;
 await reject(f,i);
});
test('signature tampering, key substitution, noncanonical JSON and missing proof fail closed', async () => {
 const f = await ingressFixture();
 for (const which of ['event','proof']) {
  const i = await f.input(); i[which].signature = 'A'.repeat(86); await reject(f,i);
  const j = await f.input(); j[which].payload=j[which].payload.replace('"version":2','"version":1,"version":2'); await reject(f,j);
  const k = await f.input(); k[which].payload += ' '; await reject(f,k);
 }
 const i = await f.input(); i.proof=i.event; await reject(f,i);
 const j = await f.input(); j.proof=null; await reject(f,j);
 const other = await ingressFixture(); await reject(other,await f.input());
});
test('weak, shared, expired, future and non-test trust anchors are rejected', async () => {
 const f = await ingressFixture();
 for (const change of [
  c=>{c.mode='production';}, c=>{c.owner='owner@example.com';}, c=>{c.sender='support@bigsoxstudios.com';},
  c=>{c.cutoff=0;}, c=>{c.ingress.issuer='https://real.example.com';}, c=>{c.ingress.publicKey='short';},
  c=>{c.ingress.role='user-supplied';}, c=>{c.challenge.publicKey=c.ingress.publicKey;},
  c=>{c.challenge.issuer=c.ingress.issuer;}, c=>{c.ingress.jwksUrl='https://evil.test';},
 ]) {
  const c=structuredClone(f.config); change(c); await assert.rejects(createOfflineIngressPolicy(c,()=>f.time));
 }
 for (const role of ['ingress','challenge']) for (const range of [[f.time+1,f.time+100],[f.time-100,f.time]]) {
  const c=structuredClone(f.config); [c[role].notBefore,c[role].notAfter]=range;
  const p=await createOfflineIngressPolicy(c,()=>f.time); await assert.rejects(p.accept(await f.input()));
 }
});
test('re-signed replay with fresh event ID still cannot reuse receipt, message or challenge', async () => {
 const f=await ingressFixture(), p=await f.policy(); await p.accept(await f.input());
 for (const changes of [{eventId:'event-2'}, {eventId:'event-2',receiptKey:'receipt-2'},
  {eventId:'event-2',receiptKey:'receipt-2',messageId:'message-2'}]) {
  const i=await f.input(changes); Object.assign(i.expected,Object.fromEntries(Object.entries(changes).filter(([k])=>k!=='eventId')));
  await assert.rejects(p.accept(i),/replay/);
 }
});
test('concurrent duplicate acceptance has exactly one winner; invalid attempts do not consume', async () => {
 const f=await ingressFixture(), p=await f.policy(), bad=await f.input({bodySha256:'0'.repeat(64)});
 await assert.rejects(p.accept(bad)); const i=await f.input();
 const results=await Promise.allSettled(Array.from({length:8},()=>p.accept(i)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('snapshot prevents caller mutation during asynchronous verification', async () => {
 const f=await ingressFixture(), p=await f.policy(), i=await f.input(), pending=p.accept(i);
 i.raw.fill(0); i.expected.receiptKey='changed'; i.event.payload='{}'; i.proof.payload='{}';
 assert.equal((await pending).kind,'offline-policy-accepted-not-authority');
});
test('fixture signer rejects real mailbox identities and cannot load outside node test runner', async () => {
 const f=await ingressFixture(); await assert.rejects(f.input({envelopeFrom:'owner@example.com'}),/fixture_identity_only/);
 await assert.rejects(f.input({}, {mailbox:'owner@example.com'}),/fixture_identity_only/);
 const env={...process.env}; delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,['--input-type=module','-e',`import ${JSON.stringify(new URL('./ingress.fixture.mjs',import.meta.url).href)}`],{env,encoding:'utf8'});
 assert.notEqual(r.status,0); assert.match(r.stderr,/test_runner_only/);
});
test('no Worker/source imports the offline policy or signer; production hard block stays present', async () => {
 const {readdir}=await import('node:fs/promises');
 for (const name of await readdir(new URL('../src/',import.meta.url))) {
  if (!name.endsWith('.mjs')) continue;
  const src=await readFile(new URL(`../src/${name}`,import.meta.url),'utf8');
  assert.doesNotMatch(src,/offline\/ingress|ingress\.fixture|createOfflineIngressPolicy/);
 }
 const candidate=await readFile(new URL('../src/outbound.candidate.mjs',import.meta.url),'utf8');
 assert.match(candidate,/requireThat\(offline, 503, 'verified_ingress_unavailable'\)/);
 assert.match(candidate,/verifyEvidence:async \(\) => false/); assert.match(candidate,/offline:false/);
});
test('SHA256 hashes exact bytes with known vector; empty and binary bodies remain lossless', async () => {
 assert.equal(await fixtureSha256(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 const raw=enc.encode('X-Test:  preserved \r\n\r\n');
 assert.deepEqual(inspectFixtureRaw(raw).pairs,[['X-Test','  preserved ']]);
 assert.equal(inspectFixtureRaw(raw).bodyBytes.length,0);
 const binary=new Uint8Array([...raw,0,255,13,10]);
 assert.deepEqual(inspectFixtureRaw(binary).bodyBytes,new Uint8Array([0,255,13,10]));
});
test('raw byte, header byte, header count, missing separator and payload bounds fail closed', async () => {
 const f=await ingressFixture();
 for (const raw of [new Uint8Array(),new Uint8Array(131073),enc.encode('From: x\n\nbody'),
  enc.encode(Array.from({length:101},(_,i)=>`X-${i}: value`).join('\r\n')+'\r\n\r\n'),
  enc.encode(Array.from({length:10},(_,i)=>`X-${i}: ${'a'.repeat(4000)}`).join('\r\n')+'\r\n\r\n'),
  new Uint8Array([...enc.encode('X-A: b\r\n\r\n'),...new Uint8Array(98305)])]) {
  assert.throws(()=>inspectFixtureRaw(raw)); await reject(f,await f.input({}, {}, raw));
 }
 const i=await f.input(); i.event.payload='a'.repeat(65537); await reject(f,i);
});
test('fixture claims cannot masquerade as live attestations or introduce unpinned keys', async () => {
 const f=await ingressFixture();
 for (const which of ['event','proof']) {
  for (const change of [{mode:'production'},{purpose:'maildesk-ingress-v1'},{algorithm:'RS256'},{jwk:{kty:'OKP'}}]) {
   const i=await f.input(), c=JSON.parse(i[which].payload); Object.assign(c,change); i[which].payload=JSON.stringify(c);
   await reject(f,i);
  }
 }
 const i=await f.input(); i.expected.envelopeFrom='owner@example.com'; await reject(f,i);
});
test('challenge signature is independent and required even when ingress signer asserts ownership', async () => {
 const f=await ingressFixture(); await reject(f,await f.input({authenticatedMailbox:f.config.owner}));
 const i=await f.input(); i.proof.signature=i.event.signature; await reject(f,i);
});
test('trust configuration is snapshotted and clock/key outages deny acceptance', async () => {
 const f=await ingressFixture(), p=await f.policy(), i=await f.input();
 f.config.owner='other@example.test'; f.config.ingress.publicKey='short';
 assert.equal((await p.accept(i)).kind,'offline-policy-accepted-not-authority');
 const g=await ingressFixture();
 for (const now of [NaN,g.config.cutoff,g.time+1001,g.time-101]) {
  const q=await createOfflineIngressPolicy(g.config,()=>now); await assert.rejects(q.accept(await g.input()));
 }
});
for (const field of ['From','To','Reply-To']) test(`signed lossless ${field} conflicting with exact envelope is rejected`, async () => {
 const f=await ingressFixture();
 const original=field==='To' ? f.config.sender : f.config.owner;
 const raw=enc.encode(new TextDecoder().decode(f.raw).replace(`${field}: ${original}`,`${field}: attacker@evil.test`));
 const parsed=inspectFixtureRaw(raw);
 await reject(f,await f.input({rawHeaders:parsed.pairs,headerSha256:await fixtureSha256(parsed.headerBytes)},{},raw));
});
test('process-local replay protection deliberately resets on reconstruction and remains non-authoritative', async () => {
 const f=await ingressFixture(), i=await f.input();
 await (await f.policy()).accept(i);
 assert.equal((await (await f.policy()).accept(i)).kind,'offline-policy-accepted-not-authority');
});
