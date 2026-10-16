// Air-gapped local simulation only. No real authority, identity, MFA or delivery.
// Object-identity tokens are ephemeral process-local handles, not signed approvals.
// Reconstructing this instance loses all replay state. Never deploy or adapt it.
export const FIXTURE_MESSAGE = Object.freeze({
 sender: 'support@studio.test', recipient: 'owner@personal.test',
 subject: 'Offline owner canary rehearsal', body: 'This is an invented plain-text rehearsal message.'
});
const PURPOSE = 'local-owner-canary-simulation-only';
const TTL = 600;
function requireLocal(value) { if (!value) throw Error('local_simulation_denied'); }
function exact(value, keys) {
 requireLocal(value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => {
   const d = Object.getOwnPropertyDescriptor(value, key);
   return d && 'value' in d;
  }));
}
function content(message) {
 exact(message, ['sender', 'recipient', 'subject', 'body']);
 const copy = { ...message };
 requireLocal(copy.sender === FIXTURE_MESSAGE.sender && copy.recipient === FIXTURE_MESSAGE.recipient);
 for (const [key, max] of [['subject', 200], ['body', 10000]]) {
  const value = copy[key];
  requireLocal(typeof value === 'string' && value.trim().length > 0 && value.length <= max);
  // Restrained ASCII plain text: subject has no controls; body permits LF only.
  requireLocal([...value].every(c => (c >= ' ' && c <= '~') || (key === 'body' && c === '\n')));
 }
 return Object.freeze(copy);
}
export function createOwnerCanaryRehearsal(...args) {
 requireLocal(args.length === 0); // No configuration, callbacks or real identities.
 let time = 0, state = 'empty', ownerSession, snapshot, reviewToken, approvalToken, expires, attempts = 0;
 const sessions = new WeakSet();
 function bound(session, value) {
  requireLocal(sessions.has(session) && session === ownerSession && value === snapshot && time < expires);
 }
 function report() {
  return Object.freeze({ purpose: PURPOSE, state, attempts, sendAuthority: false,
   delivery: 'unverified', durableReplayProtection: false });
 }
 return Object.freeze({
  openSession() {
   const session = Object.freeze({ purpose: PURPOSE }); sessions.add(session); return session;
  },
  preview(session, message) {
   requireLocal(sessions.has(session) && state === 'empty');
   const frozen = content(message);
   snapshot = Object.freeze({ purpose: PURPOSE, message: frozen, expires: time + TTL });
   ownerSession = session; expires = snapshot.expires; state = 'preview'; return snapshot;
  },
  review(session, value) {
   bound(session, value); requireLocal(state === 'preview');
   state = 'reviewed'; reviewToken = Object.freeze({ purpose: PURPOSE, stage: 'review' }); return reviewToken;
  },
  approve(session, value, token) {
   bound(session, value); requireLocal(state === 'reviewed' && token === reviewToken);
   reviewToken = undefined; state = 'approved';
   approvalToken = Object.freeze({ purpose: PURPOSE, stage: 'simulate-once' }); return approvalToken;
  },
  async simulateOnce(session, value, token, scriptedOutcome = 'accepted') {
   bound(session, value); requireLocal(state === 'approved' && token === approvalToken);
   // Claim synchronously before yielding: exactly one invocation per instance.
   approvalToken = undefined; state = 'dispatching'; attempts++;
   await Promise.resolve();
   // Every unknown/mixed/malformed script hard-stops; there is no external action.
   state = time >= expires ? 'UNKNOWN' : scriptedOutcome === 'accepted' ? 'simulated-acceptance' :
    scriptedOutcome === 'rejected' ? 'simulated-rejection' : 'UNKNOWN';
   return report();
  },
  advance(seconds) {
   requireLocal(Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(time + seconds));
   time += seconds;
   if (time >= expires && ['preview', 'reviewed', 'approved'].includes(state)) {
    state = 'expired'; reviewToken = approvalToken = undefined;
   }
   return report();
  },
  status: report
 });
}
