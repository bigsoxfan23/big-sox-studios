export function ledger(db) {
 const first = (sql, args = []) => db.prepare(sql).bind(...args).first();
 return {
  get: () => first('SELECT * FROM canary_campaign WHERE id = 1'),
  initialize: row => first(`INSERT INTO canary_campaign
   (id,campaign,snapshot,digest,binding,expires,created,status,capability)
   VALUES (1,?,?,?,?,?,?,'previewed',?) ON CONFLICT(id) DO NOTHING RETURNING *`,
  [row.campaign, row.snapshot, row.digest, row.binding, row.expires, row.created, row.capability]),
  advance: (from, to, row, capability, time) => {
   const column = { reviewed: 'reviewed', approved: 'approved', submitted: 'claimed' }[to];
   if (!column) throw new Error('invalid transition');
   // One atomic SQL statement. No transaction is held across HTTP/provider I/O.
   return first(`UPDATE canary_campaign SET status=?, capability=?, ${column}=?
    WHERE id=1 AND status=? AND campaign=? AND digest=? AND binding=? AND capability=? AND expires>?
    RETURNING *`, [to, capability, time, from, row.campaign, row.digest, row.binding, row.capability, time]);
  },
  finish: (outcome, time) => first(`UPDATE canary_campaign SET status=?, provider_id=?, finished=?
   WHERE id=1 AND status='submitted' RETURNING *`, [outcome.status, outcome.id ?? null, time])
 };
}
