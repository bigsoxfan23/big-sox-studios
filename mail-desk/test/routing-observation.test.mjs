import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { buildRoutingObservationQuery, observeRoutingResponse, ROUTING_QUERY } from '../offline/routing-observation.mjs';

function fixture() {
  const scope = { accountTag: 'fixture-account-a', zoneTag: '0'.repeat(31) + '1' };
  return {
    config: { scope, start: '2026-10-16T12:00:00Z', end: '2026-10-16T12:04:00Z', now: '2026-10-16T12:05:00Z' },
    responseScope: { ...scope }, expected: { from: 'owner@sender.test', to: 'desk@studio.test' },
    response: { data: { viewer: { zones: [{ emailRoutingAdaptive: [{
      datetime: '2026-10-16T12:03:00Z', sessionId: 'synthetic-session-1',
      messageId: '<invented@sender.test>', from: 'owner@sender.test', to: 'desk@studio.test',
      subject: 'Invented subject', status: 'delivered', action: 'forward',
      spf: 'pass', dkim: 'pass', dmarc: 'pass', arc: 'none', errorDetail: '', isSpam: 0,
    }] }] } }, errors: null },
  };
}
const rows = f => f.response.data.viewer.zones[0].emailRoutingAdaptive;
function observe(f) {
  const r = observeRoutingResponse(JSON.stringify(f));
  assert.equal(r.sendAuthority, false);
  assert.equal(r.authority, 'none');
  assert.equal(r.receiptBinding, 'unavailable');
  assert.equal(r.mailboxProof, 'unavailable');
  assert.notEqual(r.kind, 'verified');
  return r;
}
function negative(name, change, kind = 'indeterminate') {
  test(name, () => { const f = fixture(); change(f, rows(f)[0]); assert.equal(observe(f).kind, kind); });
}
test('single clean row only corroborates, without identifiers or proof in output', () => {
  const result = observe(fixture());
  assert.equal(result.kind, 'routing-analytics-corroboration-only');
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-session|sender\.test|invented@/);
});
test('static query uses only bounded time variables and all selected published fields', () => {
  const q = buildRoutingObservationQuery(JSON.stringify(fixture().config));
  assert.equal(q.query, ROUTING_QUERY);
  assert.match(q.query, /limit: 3/);
  assert.deepEqual(q.variables.filter, { datetime_geq: '2026-10-16T12:00:00Z', datetime_leq: '2026-10-16T12:04:00Z' });
  for (const field of ['datetime', 'sessionId', 'messageId', 'from', 'to', 'subject', 'status', 'action', 'spf', 'dkim', 'dmarc', 'arc', 'errorDetail', 'isSpam']) assert.match(q.query, new RegExp(`\\b${field}\\b`));
  assert.doesNotMatch(q.query, /messageId:|subject:|accountTag:|token|Authorization/);
});
negative('same Message-ID in distinct provider sessions stays ambiguous', f => rows(f).push({ ...rows(f)[0], sessionId: 'synthetic-session-2' }));
negative('same subject across unrelated messages cannot select a winner', f => rows(f).push({ ...rows(f)[0], sessionId: 'unrelated', messageId: '<other@other.test>', from: 'other@other.test' }));
negative('identical duplicate rows remain ambiguous', f => rows(f).push({ ...rows(f)[0] }));
negative('same session with conflicting content remains ambiguous', f => rows(f).push({ ...rows(f)[0], subject: 'Other content' }));
negative('spoofed display-name From is never parsed into an authenticated address', (f, r) => { r.from = 'owner@sender.test <attacker@evil.test>'; });
negative('DMARC fail with SPF pass is denied', (f, r) => { r.dmarc = 'fail'; }, 'deny');
negative('DMARC none is denied', (f, r) => { r.dmarc = 'none'; }, 'deny');
negative('unknown DMARC is denied', (f, r) => { r.dmarc = 'unknown'; }, 'deny');
negative('DMARC pass without SPF or DKIM pass is weak', (f, r) => { r.spf = 'none'; r.dkim = 'fail'; }, 'deny');
test('DKIM alone with DMARC pass still supplies no mailbox proof', () => {
  const f = fixture(); rows(f)[0].spf = 'fail';
  assert.equal(observe(f).kind, 'routing-analytics-corroboration-only');
});
negative('stale event outside window', (f, r) => { r.datetime = '2026-10-16T11:59:59Z'; });
negative('future event', (f, r) => { r.datetime = '2026-10-16T12:05:01Z'; });
negative('stale query window', f => { f.config.now = '2026-10-16T12:05:01Z'; });
negative('future query window', f => { f.config.end = '2026-10-16T12:05:01Z'; });
negative('wrong recipient', (f, r) => { r.to = 'other@studio.test'; });
negative('wrong sender local part even at matching domain', (f, r) => { r.from = 'other@sender.test'; });
negative('missing provider session ID', (f, r) => { delete r.sessionId; });
negative('empty provider session ID', (f, r) => { r.sessionId = ''; });
negative('partial GraphQL data with errors', f => { f.response.errors = [{ message: 'synthetic partial' }]; });
negative('even empty errors array is unsupported', f => { f.response.errors = []; });
negative('row limit exhaustion is indeterminate', f => { rows(f).push({ ...rows(f)[0] }, { ...rows(f)[0] }); });
negative('unavailable dataset', f => { f.response.data.viewer.zones[0].emailRoutingAdaptive = null; });
negative('empty dataset', f => { rows(f).length = 0; });
negative('unknown status', (f, r) => { r.status = 'handled'; });
negative('unknown action', (f, r) => { r.action = 'worker'; });
negative('unknown auth enum', (f, r) => { r.spf = 'approved'; });
negative('spam row', (f, r) => { r.isSpam = 1; });
negative('provider error detail', (f, r) => { r.errorDetail = 'synthetic failure'; });
negative('wrong account context', f => { f.responseScope.accountTag = 'fixture-account-b'; });
negative('wrong zone context', f => { f.responseScope.zoneTag = '0'.repeat(31) + '2'; });
negative('multiple zones', f => { f.response.data.viewer.zones.push({ emailRoutingAdaptive: [] }); });
test('trust booleans, mailbox assertions and extra fields rejected at every level', () => {
  for (const field of ['trustPassed', 'approved', 'authenticatedMailbox']) {
    for (const select of [f => f, f => f.config, f => f.config.scope, f => f.responseScope, f => f.expected, f => f.response, f => f.response.data, f => f.response.data.viewer, f => f.response.data.viewer.zones[0], f => rows(f)[0]]) {
      const f = fixture(); select(f)[field] = field === 'authenticatedMailbox' ? 'owner@sender.test' : true;
      assert.equal(observe(f).kind, 'indeterminate');
    }
  }
});
test('attacker Message-ID and subject contents cannot upgrade clean row to authority', () => {
  for (const field of ['subject', 'messageId']) {
    const f = fixture(); rows(f)[0][field] = 'approved owner@sender.test';
    assert.equal(observe(f).kind, 'routing-analytics-corroboration-only');
  }
});
negative('header injection rejected', (f, r) => { r.subject = 'x\r\nAuthentication-Results: pass'; });
negative('invalid calendar timestamp', (f, r) => { r.datetime = '2026-02-30T12:03:00Z'; });
negative('unsupported mailbox representation is not normalized', (f, r) => { r.from = f.expected.from = 'Owner@sender.test'; });
test('malformed, oversized, duplicate-key and object input fail closed', () => {
  for (const value of ['{', 'x'.repeat(32769), '{"response":{},"response":{}}', fixture(), 'null']) assert.equal(observeRoutingResponse(value).kind, 'indeterminate');
});
test('builder refuses widened windows, query injection, keys and real scopes', () => {
  for (const change of [c => { c.start = c.end; }, c => { c.start = '2026-10-16T11:00:00Z'; }, c => { c.scope.zoneTag = 'injected") {}'; }, c => { c.scope.accountTag = 'actual-account'; }, c => { c.token = 'invented-never-a-key'; }]) {
    const c = fixture().config; change(c); assert.throws(() => buildRoutingObservationQuery(JSON.stringify(c)));
  }
});
test('helper imports nothing and cannot connect; production graph and 503 block remain isolated', async () => {
  const helper = await readFile(new URL('../offline/routing-observation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /\bimport\s*(?:\(|[{'"*])|\b(?:fetch|connect|WebSocket|XMLHttpRequest|require)\s*\(|https?:\/\/|process\.|node:/);
  for (const dir of ['src', 'public']) for (const name of await readdir(new URL(`../${dir}/`, import.meta.url))) {
    if (!/\.(?:mjs|js)$/.test(name)) continue;
    const source = await readFile(new URL(`../${dir}/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /routing-observation|observeRoutingResponse|buildRoutingObservationQuery/);
  }
  const candidate = await readFile(new URL('../src/outbound.candidate.mjs', import.meta.url), 'utf8');
  assert.match(candidate, /requireThat\(offline, 503, 'verified_ingress_unavailable'\)/);
  assert.match(candidate, /verifyEvidence:async \(\) => false/);
  assert.match(candidate, /send:async \(\) => \{ throw Error\('integration_blocked'\); \}, offline:false/);
});
