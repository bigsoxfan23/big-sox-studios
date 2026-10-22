import { createProviders, MANUAL, OWNER, SENDER } from './providers.mjs';
const DAY = 86400000;
const categories = new Set(['configuration','notion_read','notion_unknown','notion_conflict','notion_update','resend_unknown','resend_refused','storage']);
const timestamp = value => typeof value==='string' && /^[1-9]\d{12}$/.test(value) ? Number(value) : 0;
export function emailReady(env,time) {
 const until=timestamp(env.PROVIDER_VERIFIED_UNTIL_MS),start=timestamp(env.NOTIFY_START_MS);
 const limit=Number(env.PROVIDER_DAILY_LIMIT);
 return env.EMAIL_ENABLED==='true' && env.OWNER_EMAIL===OWNER && env.SENDER_EMAIL===SENDER &&
  until>time && until<=time+DAY && start>0 && start<=time &&
  typeof env.PROVIDER_DAILY_LIMIT==='string' && /^(?:[1-9]|10)$/.test(env.PROVIDER_DAILY_LIMIT) && limit<=10 &&
  typeof env.RESEND_API_KEY==='string' && /^[\x21-\x7e]{12,1024}$/.test(env.RESEND_API_KEY);
}
export function createWorker({fetcher=fetch,now=()=>Date.now(),logFailure=category=>console.error('membership_notify',category),timeout=5000}={}) {
 const log=category=>{try {logFailure(categories.has(category)?category:'storage');} catch { /* Fixed categories only. */ }};
 async function run(env) {
  const d=env.MEMBERSHIP_DB;
  if(!d) return;
  const sql=(query,...values)=>d.prepare(query).bind(...values);
  const write=async(query,...values)=>{const result=await sql(query,...values).run();if(result.success!==true)throw Error('storage');};
  const claimedWrite=async(query,...values)=>{
   if(!(await sql(query+' RETURNING application_id',...values).first())) throw Error('storage claim lost');
  };
  // Privacy housekeeping runs even when dispatch is disabled or providers fail.
  // Indexed age scan + fixed batch avoids sorting/scanning the whole event log.
  // Keep unresolved work and durable effect/suppression tombstones indefinitely.
  await write(`DELETE FROM membership_notify_outbox WHERE id IN
   (SELECT id FROM membership_notify_outbox WHERE state='done' AND occurred_at<=? ORDER BY occurred_at,id LIMIT 100)`,now()-365*DAY);
  if(env.NOTIFY_ENABLED!=='true' || env.NOTION_ENABLED!=='true') return;
  if(!(await sql('SELECT version FROM schema_versions WHERE version=3').first())) {log('configuration');return;}
  const jobs=await sql(`SELECT * FROM membership_notify_outbox WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt,id LIMIT 1`,now()).all();
  if(!jobs.results.length) return;
  // Reserve a shared persistent probe budget BEFORE any network attempt. This
  // CAS also throttles concurrent invocations and crashes/uncertain DB acks.
  // After eight failures only one probe/day is allowed, while due work remains.
  // Never block events for a provider-wide failure: repaired schemas recover on
  // the next probe without resetting events or weakening UNKNOWN protections.
  const check=await sql('SELECT * FROM membership_notify_provider_check WHERE id=1').first();
  const time=now(),probe=crypto.randomUUID();
  if(!check || check.next_attempt>time) return;
  const delay=check.attempts>=7?DAY:300000*2**check.attempts;
  const reserved=await sql(`UPDATE membership_notify_provider_check
   SET attempts=MIN(attempts+1,8),next_attempt=?,token=?
   WHERE id=1 AND next_attempt<=? RETURNING id`,time+delay,probe,time).first();
  if(!reserved) return;
  const providers=createProviders(env,fetcher,timeout);
  try {await providers.schema();}
  catch {log('configuration');return;}
  // A stale/expired probe cannot clear a newer reservation or dispatch effects.
  if(!(await sql(`UPDATE membership_notify_provider_check SET attempts=0,next_attempt=0,token=NULL
   WHERE id=1 AND token=? AND next_attempt>? RETURNING id`,probe,now()).first())) return;
  for(const job of jobs.results) {
   const token=crypto.randomUUID(); const time=now(); let category='storage';
   // Per-application durable CAS lease. A crashed read/PATCH can resume; effect
   // intent states are never reset by lease expiry. Deadline < lease duration.
   const claim=await sql(`UPDATE membership_notify_cases SET lease_until=?,lease_token=?
    WHERE application_id=? AND lease_until<=? RETURNING *`,time+120000,token,job.application_id,time).first();
   if(!claim) continue;
   try {
    const current=await sql("SELECT state FROM membership_notify_outbox WHERE id=?",job.id).first();
    if(current?.state!=='pending') continue;
    let page=claim.notion_page_id;
    category='notion_read';
    // Always reconcile, even a stored link: reject duplicates, wrong kind/channel,
    // archived pages and stale links before any mutation.
    const found=await providers.find(job.application_id);
    if(found && page && found.id!==page) throw Object.assign(Error('conflict'),{category:'notion_conflict'});
    if(!found && (claim.notion_state!=='NEW' || job.kind==='adopt' || job.application_id===MANUAL)) {
     category='notion_unknown'; throw Error('reconciliation required');
    }
    if(found) page=found.id;
    else {
     category='storage';
     // Persist BEFORE dispatch. A timeout/crash/link-write failure may only query
     // thereafter. An empty eventually consistent result NEVER permits recreation.
     await claimedWrite("UPDATE membership_notify_cases SET notion_state='UNKNOWN' WHERE application_id=? AND lease_token=? AND lease_until>? AND notion_state='NEW'",job.application_id,token,now());
     category='notion_unknown';
     page=(await providers.create(job.application_id)).id;
    }
    category='storage';
    await claimedWrite("UPDATE membership_notify_cases SET notion_state='LINKED',notion_page_id=? WHERE application_id=? AND lease_token=? AND lease_until>?",page,job.application_id,token,now());
    if(job.kind!=='adopt') {
     const application=await sql('SELECT status FROM membership_requests WHERE id=?',job.application_id).first();
     category='notion_update';
     if(!application) throw Error('missing application');
     // Reconcile current decision even for a delayed submission before completing it.
     await providers.sync(page,job.application_id,application.status);
    }
    if(job.kind==='submitted' && claim.email_state==='NEW') {
     if(claim.suppress_email===1 || job.application_id===MANUAL || (timestamp(env.NOTIFY_START_MS)>0 && claim.created_at<timestamp(env.NOTIFY_START_MS))) {
      await write("UPDATE membership_notify_cases SET email_state='SUPPRESSED' WHERE application_id=? AND lease_token=?",job.application_id,token);
     } else {
      category='configuration';
      if(!emailReady(env,now())) throw Object.assign(Error('email disabled or unattested'),{waiting:true});
      // Atomic quota reservation also protects persistence uncertainty before
      // intent recording. A used reservation is never automatic retry authority.
      category='storage';
      const day=Math.floor(now()/DAY);
      // Reservation and dispatch intent commit together. A failed transaction
      // leaves NEW safely resumable; after commit UNKNOWN forbids every retry.
      const reserved=await d.batch([
       sql(`INSERT INTO membership_notify_send_attempts(application_id,utc_day)
        SELECT ?,? WHERE (SELECT COUNT(*) FROM membership_notify_send_attempts WHERE utc_day=?)<?
        AND EXISTS(SELECT 1 FROM membership_notify_cases WHERE application_id=? AND email_state='NEW'
         AND suppress_email=0 AND lease_token=? AND lease_until>?)
        ON CONFLICT(application_id) DO NOTHING`,job.application_id,day,day,
        Number(env.PROVIDER_DAILY_LIMIT),job.application_id,token,now()),
       sql(`UPDATE membership_notify_cases SET email_state='UNKNOWN' WHERE application_id=? AND email_state='NEW'
        AND suppress_email=0 AND lease_token=? AND lease_until>?
        AND EXISTS(SELECT 1 FROM membership_notify_send_attempts WHERE application_id=?)`,job.application_id,token,now(),job.application_id)
      ]);
      if(reserved.length!==2 || reserved.some(result=>result.success!==true)) throw Error('storage reservation failed');
      if(reserved[1].meta.changes!==1) {
       category='configuration';throw Object.assign(Error('daily budget unavailable'),{waiting:true});
      }
      category='resend_unknown';
      try { await providers.send(job.application_id); }
      catch(error) {
       if(error.category==='resend_refused') {
        await write("UPDATE membership_notify_cases SET email_state='REFUSED' WHERE application_id=? AND lease_token=?",job.application_id,token);
       }
       throw error;
      }
      category='storage';
      await write("UPDATE membership_notify_cases SET email_state='SENT' WHERE application_id=? AND lease_token=?",job.application_id,token);
     }
    } else if(job.kind==='submitted' && ['UNKNOWN','REFUSED'].includes(claim.email_state)) {
     category=claim.email_state==='UNKNOWN'?'resend_unknown':'resend_refused';throw Error('manual provider review required');
    }
    category='storage';
    // Idempotent D1 batch commits completion and releases this claim together.
    const completed=await d.batch([
     sql("UPDATE membership_notify_outbox SET state='done',failure=NULL WHERE id=?",job.id),
     sql('UPDATE membership_notify_cases SET lease_until=0,lease_token=NULL WHERE application_id=? AND lease_token=?',job.application_id,token)
    ]);
    if(completed.length!==2 || completed.some(result=>result.success!==true)) throw Error('storage completion failed');
   } catch(error) {
    const failure=categories.has(error.category)?error.category:category;
    log(failure);
    if(error.waiting) {
     // Policy and quota waits consume no failure attempts and rotate behind other
     // due work, so a disabled sender cannot starve decision/expiration closure.
     await write('UPDATE membership_notify_outbox SET next_attempt=?,failure=? WHERE id=?',now()+3600000,failure,job.id);
     continue;
    }
    await write(`UPDATE membership_notify_outbox SET attempts=attempts+1,state=CASE WHEN attempts>=7 THEN 'blocked' ELSE 'pending' END,
     next_attempt=?,failure=? WHERE id=?`,now()+Math.min(3600000,300000*2**Math.min(job.attempts,4)),failure,job.id);
   } finally {
    await write('UPDATE membership_notify_cases SET lease_until=0,lease_token=NULL WHERE application_id=? AND lease_token=?',job.application_id,token);
   }
  }
 }
 return {
  fetch(){return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});},
  async scheduled(_event,env,ctx){ctx.waitUntil(run(env).catch(()=>log('storage')));},
  run
 };
}
export default createWorker();
