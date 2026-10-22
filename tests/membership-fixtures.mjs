import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export const TIME = 1800000000000;
export const DAY = 86400000;
export function database() {
 const sqlite = new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../membership/migrations/0001_membership.sql',import.meta.url),'utf8'));
 let writes = 0;
 const wrap = (sql,values=[]) => ({
  bind(...args) { return wrap(sql,args); },
  async run() { writes++; const result=sqlite.prepare(sql).run(...values); return {success:true,meta:{changes:Number(result.changes)}}; },
  async first() { return sqlite.prepare(sql).get(...values) || null; },
  async all() { return {results:sqlite.prepare(sql).all(...values)}; }
 });
 return {
  prepare:sql=>wrap(sql),
  async batch(statements) { sqlite.exec('BEGIN'); try { const results=[]; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; } catch(error) { sqlite.exec('ROLLBACK'); throw error; } },
  rows:()=>sqlite.prepare('SELECT * FROM membership_requests').all(),
  audit:()=>sqlite.prepare('SELECT * FROM audit_events').all(),
  get writes() { return writes; }, sqlite
 };
}
export function seed(database, {id=crypto.randomUUID(),hash=crypto.randomUUID(),status='pending',created=TIME,closed=null,name='Synthetic Visitor',email='visitor@example.test',reason='Synthetic request',note=''}={}) {
 database.sqlite.prepare('INSERT INTO membership_requests(id,email_hash,name,email,reason,owner_note,status,created_at,updated_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,hash,name,email,reason,note,status,created,created,closed);
 return id;
}
