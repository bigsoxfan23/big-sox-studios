// Offline synthetic observation ONLY. An Analytics row is NOT cryptographic proof,
// a trusted receipt binding, exact-mailbox authentication, or send authorization.
// No imports, transport, credentials, signing, persistence, or live integration.
export const ROUTING_ROW_LIMIT = 3;
export const ROUTING_QUERY = `query EmailRoutingActivity($zoneTag: string, $filter: EmailRoutingAdaptiveFilter_InputObject) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      emailRoutingAdaptive(filter: $filter, limit: 3, orderBy: [datetime_DESC]) {
        datetime sessionId messageId from to subject status action spf dkim dmarc arc errorDetail isSpam
      }
    }
  }
}`;

const fields = 'datetime sessionId messageId from to subject status action spf dkim dmarc arc errorDetail isSpam';
function requireShape(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(' ') !== keys.split(' ').sort().join(' ')) throw Error('schema');
}
function requireThat(condition, reason) { if (!condition) throw Error(reason); }
function timestamp(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value), 'timestamp');
  const ms = Date.parse(value);
  requireThat(Number.isFinite(ms) && new Date(ms).toISOString() === value.replace('Z', '.000Z'), 'timestamp');
  return ms;
}
function scope(value) {
  requireShape(value, 'accountTag zoneTag');
  // Deliberately invented fixture identities; no constructor for real accounts.
  requireThat(/^fixture-account-[ab]$/.test(value.accountTag) &&
    typeof value.accountTag === 'string' && typeof value.zoneTag === 'string' &&
    /^0{31}[12]$/.test(value.zoneTag), 'fixture_scope_only');
}
function mailbox(value) {
  requireThat(typeof value === 'string' && /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.test$/.test(value) && value.length <= 254, 'fixture_mailbox_only');
}

// JSON text keeps the interface data-only. Requiring canonical JSON also rejects
// duplicate member names, instead of silently trusting the last occurrence.
function parse(text) {
  requireThat(typeof text === 'string' && text.length <= 32768, 'bounded_json');
  const value = JSON.parse(text);
  requireThat(JSON.stringify(value) === text, 'canonical_json');
  return value;
}
export function buildRoutingObservationQuery(configJson) {
  const config = parse(configJson);
  requireShape(config, 'scope start end now');
  scope(config.scope);
  const start = timestamp(config.start), end = timestamp(config.end), now = timestamp(config.now);
  requireThat(start < end && end <= now && now - start <= 300000, 'window');
  return { query: ROUTING_QUERY, variables: { zoneTag: config.scope.zoneTag,
    filter: { datetime_geq: config.start, datetime_leq: config.end } } };
}

function result(kind, reason) {
  // No event IDs or copied message data that could be reused as evidence.
  return Object.freeze({ kind, reason, authority: 'none', receiptBinding: 'unavailable',
    mailboxProof: 'unavailable', sendAuthority: false });
}

// The wrapper's scope is synthetic caller context, NOT a provider-signed claim.
// Even matching context and a single clean row cannot close the sessionId gap.
export function observeRoutingResponse(fixtureJson) {
  try {
    const input = parse(fixtureJson);
    requireShape(input, 'config responseScope expected response');
    buildRoutingObservationQuery(JSON.stringify(input.config));
    scope(input.responseScope);
    requireThat(input.responseScope.accountTag === input.config.scope.accountTag &&
      input.responseScope.zoneTag === input.config.scope.zoneTag, 'scope_mismatch');
    requireShape(input.expected, 'from to');
    mailbox(input.expected.from); mailbox(input.expected.to);
    const response = input.response;
    requireShape(response, 'data errors');
    if (response.errors !== null) return result('indeterminate', 'graphql_errors_or_partial');
    requireShape(response.data, 'viewer');
    requireShape(response.data.viewer, 'zones');
    const zones = response.data.viewer.zones;
    requireThat(Array.isArray(zones) && zones.length === 1, 'zone_unavailable_or_ambiguous');
    requireShape(zones[0], 'emailRoutingAdaptive');
    const rows = zones[0].emailRoutingAdaptive;
    requireThat(Array.isArray(rows), 'dataset_unavailable');
    if (rows.length >= ROUTING_ROW_LIMIT) return result('indeterminate', 'limit_exhausted');
    if (rows.length === 0) return result('indeterminate', 'no_observation');
    // Do not select a friendly row using Message-ID, subject, addresses or time.
    // Duplicate rows, duplicate sessions and unrelated events all remain ambiguous.
    if (rows.length !== 1) return result('indeterminate', 'competing_or_duplicate_events');
    const row = rows[0];
    requireShape(row, fields);
    for (const field of fields.split(' ').filter(f => f !== 'isSpam')) {
      requireThat(typeof row[field] === 'string' && row[field].length <= 1024 &&
        !Array.from(row[field]).some(c => c.codePointAt(0) < 32 || c.codePointAt(0) === 127), 'row_field');
    }
    requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(row.sessionId), 'missing_or_invalid_session');
    const time = timestamp(row.datetime);
    requireThat(time >= timestamp(input.config.start) && time <= timestamp(input.config.end), 'event_outside_window');
    mailbox(row.from); mailbox(row.to); // Reject display-name forms; never parse them as identity.
    requireThat(row.from === input.expected.from && row.to === input.expected.to, 'address_mismatch');
    requireThat(['pass', 'fail', 'none', 'neutral', 'softfail', 'temperror', 'permerror'].includes(row.spf) &&
      ['pass', 'fail', 'none', 'neutral', 'temperror', 'permerror'].includes(row.dkim) &&
      ['pass', 'fail', 'none'].includes(row.arc), 'unknown_auth');
    if (row.dmarc !== 'pass' || (row.spf !== 'pass' && row.dkim !== 'pass')) return result('deny', 'failed_or_weak_auth');
    // Only the published tutorial's delivered/forward pair is rehearsed here.
    // No invented mapping of dashboard labels to API status enums.
    requireThat(row.status === 'delivered' && row.action === 'forward', 'unsupported_status_or_action');
    requireThat(row.errorDetail === '' && row.isSpam === 0, 'error_or_spam');
    return result('routing-analytics-corroboration-only', 'synthetic_row_without_trusted_receipt_bridge');
  } catch {
    return result('indeterminate', 'invalid_or_unsupported_fixture');
  }
}
