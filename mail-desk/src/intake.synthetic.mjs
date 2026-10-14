// Offline test/fixture helper. Never exposed through Worker routes or email handlers.
import { stmt, now, senders } from './store.mjs';
import { requireThat } from './security.mjs';
export async function syntheticIntake(db, input) {
 requireThat(input.synthetic === true && input.requester_email.endsWith('@example.test') && /^[^\s@<>]+@example\.test$/.test(input.requester_email));
 requireThat(Object.hasOwn(senders, input.channel) && typeof input.key === 'string' && input.key.length <= 200 && input.key.length > 0);
 requireThat(typeof input.subject === 'string' && input.subject.length <= 200 && typeof input.body === 'string' && input.body.length <= 10000 && typeof input.requester_name === 'string' && input.requester_name.length <= 200);
 const id = crypto.randomUUID(); const time = now();
 // Deterministic winner in a D1 atomic batch; loser creates no case or message.
 await db.batch([
  stmt(db, `INSERT INTO cases SELECT ?,?,?,?,?,0,'',?,? WHERE NOT EXISTS(SELECT 1 FROM inbound_dedupe WHERE inbound_key=?)`, id, input.channel, input.requester_name, input.requester_email, input.subject, time, time, input.key),
  stmt(db, `INSERT INTO inbound_dedupe SELECT ?,id,? FROM cases WHERE id=? ON CONFLICT(inbound_key) DO NOTHING`, input.key, time, id),
  stmt(db, `INSERT INTO messages SELECT ?,case_id,'inbound',?, ?,NULL FROM inbound_dedupe WHERE inbound_key=? AND case_id=?`, crypto.randomUUID(), input.body, time, input.key, id),
  stmt(db, `INSERT INTO sync_jobs(id,case_id,kind,next_attempt,created_at) SELECT ?,id,'case_created',?,? FROM cases WHERE id=?`, crypto.randomUUID(), time, time, id)
 ]);
 return (await stmt(db, 'SELECT case_id FROM inbound_dedupe WHERE inbound_key=?', input.key).first()).case_id;
}
