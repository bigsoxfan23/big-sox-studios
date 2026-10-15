import { stmt, now } from './store.mjs';
export const DATA_SOURCE = '103d8328-de8b-4b7f-8986-000ce40450b5';
export const ACTIVITY_SOURCE = '17401fd3-c5f4-46bb-b516-c420b6e3ce24'; // Existing service owns activity writes.
export const NOTION_VERSION = '2025-09-03';
const select = name => ({ select: { name } });
const rich = content => ({ rich_text: [{ text: { content } }] });
export function mapNotion(c) {
 const membership = c.channel === 'members';
 if (!['members','support','hello'].includes(c.channel)) throw new Error('invalid_channel');
 return {
  parent: { type: 'data_source_id', data_source_id: DATA_SOURCE },
  properties: {
   Title: { title: [{ text: { content: c.subject } }] },
   'Ticket Family': select('Service Management'),
   'Ticket Kind': select(membership ? 'Membership' : c.channel === 'support' ? 'Incident / Support' : 'General inquiry'),
   Status: select('Inbox'), 'Request Channel': select(`${c.channel}@`),
   'Requester Name': rich(c.requester_name), 'Requester Email': { email: c.requester_email },
   'External Case ID': rich(c.id), 'Membership Decision': select(membership ? 'Pending' : 'Not applicable'),
   'Reply State': select('Needs approval'), 'Assigned To': select('Greg'), Priority: select('Normal'),
   'Project / System': select(membership ? 'Members Portal' : 'Other')
  }
 };
}
// Synthetic executor only. No Notion token, fetch, record update or live executor exists.
export async function runMockSync(db, env, execute = async () => {}) {
 if (env.NOTION_SYNC_MODE !== 'mock') return { processed: 0 };
 const time = now();
 // Recover only synthetic sync leases; delivery claims are never reclaimed.
 await stmt(db, `UPDATE sync_jobs SET status=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END WHERE status='running' AND next_attempt<=?`, time).run();
 const jobs = await stmt(db, `UPDATE sync_jobs SET status='running',attempts=attempts+1,next_attempt=? WHERE id IN
 (SELECT id FROM sync_jobs WHERE status='pending' AND next_attempt<=? AND attempts<5 LIMIT 10) RETURNING *`, time + 300, time).all();
 for (const job of jobs.results) {
  try {
   const c = await stmt(db, 'SELECT * FROM cases WHERE id=?', job.case_id).first();
   await execute(mapNotion(c)); await stmt(db, "UPDATE sync_jobs SET status='done' WHERE id=? AND status='running' AND attempts=?", job.id, job.attempts).run();
  } catch {
   await stmt(db, `UPDATE sync_jobs SET status=?,next_attempt=? WHERE id=? AND status='running' AND attempts=?`, job.attempts >= 5 ? 'dead' : 'pending', time + Math.min(3600, 30 * 2 ** (job.attempts - 1)), job.id, job.attempts).run();
  }
 }
 return { processed: jobs.results.length };
}
