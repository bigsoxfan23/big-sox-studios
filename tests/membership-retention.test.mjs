import test from 'node:test';
import assert from 'node:assert/strict';
import {sweep} from '../membership/common.mjs';
import {createWorker} from '../membership/worker.mjs';
import {database,seed,TIME,DAY} from './membership-fixtures.mjs';
test('local SQL migration has version, unique identity and atomic minimal audit',async()=>{
 const d=database();assert.equal(d.sqlite.prepare('SELECT version FROM schema_versions').get().version,1);
 seed(d,{hash:'same'});assert.throws(()=>seed(d,{hash:'same'}),/UNIQUE/);assert.equal(d.audit().length,1);
 const audit=JSON.stringify(d.audit()); for(const text of ['visitor@','Synthetic','note','reason','email_hash'])assert.ok(!audit.includes(text));
});
test('90-day expiration and 30-day PII clearing boundaries, terminal states and retained invite-ready details',async()=>{
 const d=database(); const at=seed(d,{created:TIME-90*DAY}),before=seed(d,{created:TIME-90*DAY+1});
 const approved=seed(d,{status:'approved',created:TIME-800*DAY});
 const ids=[];for(const status of ['rejected','revoked','expired']) { ids.push(seed(d,{status,closed:TIME-30*DAY}));ids.push(seed(d,{status,closed:TIME-30*DAY+1})); }
 await sweep({MEMBERSHIP_DB:d},TIME);
 const get=id=>d.rows().find(r=>r.id===id);
 assert.equal(get(at).status,'expired');assert.equal(get(at).closed_at,TIME);assert.equal(get(before).status,'pending');assert.equal(get(approved).email,'visitor@example.test');assert.equal(get(approved).status,'approved');
 ids.forEach((id,i)=>{const row=get(id); if(i%2===0) for(const field of ['name','email','reason','owner_note'])assert.equal(row[field],null);else assert.equal(row.email,'visitor@example.test');});
 const audits=d.audit().length;await sweep({MEMBERSHIP_DB:d},TIME);assert.equal(d.audit().length,audits);
 await sweep({MEMBERSHIP_DB:d},TIME+30*DAY);assert.equal(get(at).email,null);assert.equal(get(approved).email,'visitor@example.test');
});
test('approved records and all personal fields survive repeated annual sweeps without mutation or closure',async()=>{
 const d=database();
 const ids=[365*DAY-1,365*DAY,800*DAY].map(age=>seed(d,{status:'approved',created:TIME-age,note:'Annual owner review: retain'}));
 const original=d.rows();
 for(const time of [TIME,TIME+30*DAY,TIME+365*DAY,TIME+3*365*DAY])await sweep({MEMBERSHIP_DB:d},time);
 assert.deepEqual(d.rows(),original);
 assert.equal(d.audit().length,0); // Audit TTL does not delete applications.
 assert.equal(d.sqlite.prepare("SELECT count(*) AS n FROM membership_notify_outbox WHERE kind='status'").get().n,0);
 assert.ok(ids.every(id=>d.rows().some(row=>row.id===id && row.closed_at===null && row.pii_cleared_at===null)));
});
test('bounded sweep catches up idempotently; deidentified audit has 365-day TTL',async()=>{
 const d=database();for(let i=0;i<205;i++)seed(d,{created:TIME-90*DAY});
 const old=seed(d,{status:'approved',created:TIME-365*DAY});
 const fresh=seed(d,{status:'approved',created:TIME-365*DAY+1});
 await sweep({MEMBERSHIP_DB:d},TIME);assert.equal(d.rows().filter(r=>r.status==='expired').length,100);assert.ok(!d.audit().some(r=>r.request_id===old && r.event==='submitted'));assert.ok(d.audit().some(r=>r.request_id===fresh));
 await sweep({MEMBERSHIP_DB:d},TIME);await sweep({MEMBERSHIP_DB:d},TIME);assert.equal(d.rows().filter(r=>r.status==='expired').length,205);
});
test('scheduled handler uses deterministic clock and waitUntil',async()=>{
 const d=database();seed(d,{created:TIME-90*DAY});let job;createWorker({now:()=>TIME}).scheduled({}, {MEMBERSHIP_DB:d}, {waitUntil(p){job=p;}});await job;assert.equal(d.rows()[0].status,'expired');
});
