import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE, envelope, submitOnce } from '../src/resend.mjs';

// Independent literal from Greg's October 16 one-message authorization.
// Synthetic recipient; no credentials or real network transport.
const authorized = {
 from: 'support@bigsoxstudios.com',
 subject: 'Big Sox Studios — Outbound Email Verification',
 text: 'This is a one-time test of the Big Sox Studios outbound email system.\n\nThe message verifies that support@bigsoxstudios.com can securely send email through Resend.\n\nNo customer tickets or customer messages are involved.\n\n— Big Sox Studios'
};
test('fixed immutable content exactly matches the owner authorization', () => {
 assert.deepEqual(MESSAGE, authorized);
 assert.equal(Object.isFrozen(MESSAGE), true);
 assert.deepEqual(envelope('owner@fixture.test'), { ...authorized, to: 'owner@fixture.test' });
});
test('provider submission uses exact authorized content and cannot substitute a changed snapshot', async () => {
 const env = { DEPLOYMENT_STAGE: 'production', CANARY_SEND_ENABLED: 'owner-canary-v1-approved',
  RESEND_API_KEY: 're_' + 'x'.repeat(24), CANARY_OWNER_MAILBOX: 'owner@fixture.test' };
 const row = { status: 'submitted', campaign: '11111111-1111-4111-8111-111111111111',
  digest: 'a'.repeat(64), snapshot: JSON.stringify({ payload: { ...authorized, to: 'owner@fixture.test' } }) };
 let calls = 0;
 const transport = async (url, options) => {
  calls++; assert.equal(url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(options.body), { ...authorized, to: 'owner@fixture.test' });
  return Response.json({ id: '22222222-2222-4222-8222-222222222222' });
 };
 assert.deepEqual(await submitOnce(row, env, transport), { status: 'accepted', id: '22222222-2222-4222-8222-222222222222' });
 assert.equal(calls, 1);
 const changed = { ...authorized, to: 'owner@fixture.test', text: authorized.text + '\nChanged' };
 assert.deepEqual(await submitOnce({ ...row, snapshot: JSON.stringify({ payload: changed }) }, env, transport), { status: 'UNKNOWN' });
 assert.equal(calls, 1);
});
