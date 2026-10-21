import { stmt, now } from './store.mjs';
import { LiveNotion, liveEnabled, syncStart } from './notion.live.mjs';
import { requireFolders } from './folders.mjs';
async function recordFailure(db, caseId, stage, error) {
 try {
  // Exact, bounded categories only: never persist arbitrary exception contents.
  const message = error?.message;
  const category = typeof message === 'string' && message.length <= 64 && message === message.trim() && /^(?:notion_http_(?:400|401|403|404|409|422|429|500|502|503|504|other)|notion_(?:invalid_query|incomplete_query|duplicate_matches|link_conflict|invalid_patch|invalid_patch_response|json_invalid|json_oversize|json_empty|deadline|transport_abort|transport_type|credential_format|transport_fetch_type|transport_body_type|request_failed|disabled))$/.test(message)
   ? (/^notion_http_5/.test(message) ? 'notion_http_5xx' : message) : 'other';
  const event = `folder_sync_error_${stage}_${category}`;
  // Unlike audit(), a single conditional INSERT deduplicates concurrent attempts
  // atomically, without deleting historical audit or requiring a new schema.
  await stmt(db, `INSERT INTO audit_events (id,event,case_id,intent_id,created_at)
   SELECT ?,?,?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM audit_events WHERE case_id=? AND event=?)`,
   crypto.randomUUID(),event,caseId,now(),caseId,event).run();
 } catch { /* Diagnostics must never interfere with sync or lease cleanup. */ }
}
// A separate provisioned property and explicit operator gate. No schema writes.
export async function syncFolders(env, fetcher = fetch) {
 if (!liveEnabled(env) || env.NOTION_MAIL_DESK_FOLDER_READY !== 'true') return {status:'off',processed:0};
 const db = env.DB;
 await requireFolders(db);
 const pending = (await stmt(db, `SELECT c.id,c.channel,f.folder,f.version,l.page_id FROM case_folders f
 JOIN cases c ON c.id=f.case_id JOIN case_folder_sync s ON s.case_id=f.case_id
 JOIN notion_links l ON l.case_id=f.case_id AND l.state='linked'
 WHERE c.channel='support'
 AND NOT EXISTS(SELECT 1 FROM inbound_dedupe d WHERE d.case_id=c.id)
 AND EXISTS(SELECT 1 FROM email_receipts r WHERE r.case_id=c.id AND r.envelope_to='support@bigsoxstudios.com' AND r.forward_state='forwarded' AND r.created_at>?) AND s.next_attempt<=? AND s.lease_until<=?
 ORDER BY s.next_attempt,f.updated_at,f.case_id LIMIT 5`, syncStart(env), now(), now()).all()).results;
 let processed = 0, unresolved = 0;
 const api = new LiveNotion(env, fetcher);
 for (const c of pending) {
  const token = crypto.randomUUID();
  const claim = await stmt(db, `UPDATE case_folder_sync SET lease_token=?,lease_until=? WHERE case_id=? AND lease_until<=?
   AND EXISTS(SELECT 1 FROM case_folders f WHERE f.case_id=? AND f.version=?) RETURNING case_id`, token, now()+120,c.id,now(),c.id,c.version).first();
  if (!claim) continue;
  let stage = 'notion_query';
  try {
   // Query reconciliation only: uncertain or invisible links never authorize create.
   const found = await api.findTicket(c);
   stage = 'identity_match';
   if (found.length!==1 || found[0].id.replaceAll('-','').toLowerCase()!==c.page_id.replaceAll('-','').toLowerCase()) throw Error('notion_link_conflict');
   stage = 'version_check';
   const current = await stmt(db, `SELECT f.version FROM case_folders f JOIN notion_links l ON l.case_id=f.case_id
    WHERE f.case_id=? AND f.version=? AND l.state='linked' AND l.page_id=?`, c.id,c.version,c.page_id).first();
   if (!current) continue;
   const names = {inbox:'Inbox',archive:'Archive',trash:'Trash'};
   // Reconcile acknowledged pages too: delayed remote writes cannot leave a
   // stale folder indefinitely. Matching assignments need no PATCH.
   stage = 'notion_patch';
   if (found[0].properties?.['Mail Desk Folder']?.select?.name !== names[c.folder]) await api.updateFolder(c,c.page_id,c.folder);
   // An older in-flight assignment cannot acknowledge a newer folder version.
   stage = 'db_ack';
   const ack = await stmt(db, `UPDATE case_folder_sync SET synced_version=? WHERE case_id=? AND lease_token=?
    AND EXISTS(SELECT 1 FROM case_folders WHERE case_id=? AND version=?) RETURNING case_id`,c.version,c.id,token,c.id,c.version).first();
   if (ack) processed++;
  } catch (error) { unresolved++; await recordFailure(db,c.id,stage,error); }
  finally {
   try {
    await stmt(db, `UPDATE case_folder_sync SET lease_token=NULL,lease_until=0,next_attempt=CASE WHEN EXISTS(SELECT 1 FROM case_folders WHERE case_id=? AND version=?) THEN ? ELSE 0 END WHERE case_id=? AND lease_token=?`,c.id,c.version,now()+300,c.id,token).run();
   } catch (error) { await recordFailure(db,c.id,'cleanup',error); throw error; }
  }
 }
 return {status:unresolved ? 'partial':'complete',processed,unresolved};
}
