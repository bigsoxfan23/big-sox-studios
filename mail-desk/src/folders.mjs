import { stmt, now } from './store.mjs';
import { requireThat, HttpError } from './security.mjs';
export const folders = ['inbox','archive','trash'];
const targets = { archive:'archive', trash:'trash', restore:'inbox' };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export async function requireFolders(db) {
 const row = await stmt(db, "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('case_folders','case_folder_sync')").first();
 requireThat(row.n === 2, 503, 'folder_migration_required');
}
export async function listFolder(db, folder) {
 await requireFolders(db); requireThat(folders.includes(folder), 400, 'invalid_folder');
 // One read snapshot provides both rows and counts, including counts beyond LIMIT.
 const row = await stmt(db, `SELECT
 (SELECT json_group_array(json_object('id',id,'channel',channel,'subject',subject,'requester_name',requester_name,'updated_at',updated_at,'folder',folder,'folderVersion',version))
 FROM (SELECT c.*,f.folder,f.version FROM cases c JOIN case_folders f ON f.case_id=c.id WHERE f.folder=? ORDER BY c.updated_at DESC,c.id LIMIT 100)) cases_json,
 (SELECT count(*) FROM case_folders WHERE folder='inbox') inbox,
 (SELECT count(*) FROM case_folders WHERE folder='archive') archive,
 (SELECT count(*) FROM case_folders WHERE folder='trash') trash`, folder).first();
 return { folder, cases:JSON.parse(row.cases_json), counts:{inbox:row.inbox,archive:row.archive,trash:row.trash} };
}
export async function moveFolders(db, data) {
 await requireFolders(db);
 requireThat(typeof data.action === 'string' && Object.hasOwn(targets, data.action) && Array.isArray(data.cases) && data.cases.length>=1 && data.cases.length<=25, 400, 'invalid_folder_action');
 const seen = new Set();
 for (const c of data.cases) {
  requireThat(c && typeof c==='object' && Object.keys(c).length===2 && uuid(c.id) && Number.isSafeInteger(c.version) && c.version>=0 && !seen.has(c.id), 400, 'invalid_folder_cases');
  seen.add(c.id);
 }
 const target = targets[data.action], results = [];
 const hasLive = await stmt(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='live_outbound_reviews'").first();
 for (const c of data.cases) {
  try {
   const row = await stmt(db, `UPDATE case_folders SET folder=?,version=version+1,updated_at=?,
    invalidated_revision=(SELECT revision+1 FROM cases WHERE id=case_id)
    WHERE case_id=? AND version=? AND folder<>? AND (?<>'archive' OR folder='inbox')
    AND NOT EXISTS(SELECT 1 FROM outbound_intents o WHERE o.case_id=case_folders.case_id AND o.status='dispatching')
    ${hasLive ? "AND NOT EXISTS(SELECT 1 FROM live_outbound_reviews l WHERE l.case_id=case_folders.case_id AND l.status='dispatching')" : ''}
    RETURNING case_id id,folder,version`, target, now(), c.id, c.version, target, target).first();
   if (row) results.push({...row,ok:true});
   else {
    const latest = await stmt(db, 'SELECT folder,version FROM case_folders WHERE case_id=?', c.id).first();
    results.push({id:c.id,ok:false,error:latest ? 'folder_conflict' : 'case_not_found',...(latest ?? {})});
   }
  } catch (error) {
   // A storage failure may have committed; refresh rather than assume success/retry.
   results.push({id:c.id,ok:false,error:error instanceof HttpError ? error.message : 'folder_outcome_unconfirmed'});
  }
 }
 return { results };
}
// Called in the same receipt-claim transaction, scoped to a NEW claim token.
export function reopenOnReceipt(db, token, time) {
 return stmt(db, `UPDATE case_folders SET folder='inbox',version=version+1,updated_at=?,
 invalidated_revision=(SELECT revision+1 FROM cases WHERE id=case_id)
 WHERE folder<>'inbox' AND case_id IN (SELECT case_id FROM email_receipts WHERE claim_token=?)`, time, token);
}
