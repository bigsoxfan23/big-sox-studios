import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,NoOpLog,convertV4MiniflareOptions} from 'miniflare';
import {SOURCE,OWNER,SENDER} from '../providers.mjs';
import {schema} from './schema.mjs';
function statements(file) {
 const lines=readFileSync(new URL(file,import.meta.url),'utf8').split('\n');
 const result=[];let buffer='',trigger=false;
 for(const line of lines) {
  if(!line.trim() || line.trim().startsWith('--'))continue;
  buffer+=line+'\n';if(/^CREATE TRIGGER/.test(line))trigger=true;
  if(line.trim().endsWith(';') && (!trigger || line.trim()==='END;')) {result.push(buffer);buffer='';trigger=false;}
 }
 assert.equal(buffer,'');return result;
}
for(const permanent of [false,true])test(`real workerd/D1 (${permanent?'permanent':'temporary'}): concurrent intake, atomic reservations and independent owner decisions`,async()=>{
 const time=Date.parse('2028-01-20T12:00:00Z');
 const calls=[],pages=new Map();
 const contract=schema();
 const mf=new Miniflare(convertV4MiniflareOptions({
  log:new NoOpLog(),compatibilityDate:'2026-09-29',name:'notify-offline-test',d1Databases:['MEMBERSHIP_DB'],
  bindings:{OFFLINE_NOW:String(time),NOTIFY_ENABLED:'true',NOTION_ENABLED:'true',EMAIL_ENABLED:'true',PROVIDER_DAILY_LIMIT:'10',OWNER_EMAIL:OWNER,SENDER_EMAIL:SENDER,
   NOTION_API_TOKEN:'synthetic_notion_token',RESEND_API_KEY:'synthetic_resend_token',
   NOTIFY_START_MS:String(time-1000),PROVIDER_VERIFIED_UNTIL_MS:String(time+3600000),
   ...(permanent?{PERMANENT_OWNER_FREE_MODE:'true',PROVIDER_DAILY_LIMIT:'0',PROVIDER_VERIFIED_UNTIL_MS:'0',
   PERMANENT_OWNER_FREE_DAILY_LIMIT:'1',PERMANENT_OWNER_FREE_MONTHLY_LIMIT:'15',
   PERMANENT_OWNER_FREE_ATTESTATION:'resend-free-sending-only-no-overages-v1',PERMANENT_OWNER_FREE_ATTESTED_AT_MS:String(time)}:{}),
   EMAIL_HMAC_KEY:'e'.repeat(32),RATE_HMAC_KEY:'r'.repeat(32),TURNSTILE_SECRET_KEY:'s'.repeat(32)},
  modules:[{type:'ESModule',path:'entry.mjs',contents:`
   import {createWorker as notify} from './membership-notify/worker.mjs';
   import {createWorker as publicWorker} from './membership/worker.mjs';
   export default {async fetch(request,env){
    if(new URL(request.url).pathname==='/offline-run') {const time=Number(new URL(request.url).searchParams.get('time') || env.OFFLINE_NOW);await notify({now:()=>time}).run(env);return new Response('ok');}
    return publicWorker({now:()=>Number(env.OFFLINE_NOW)}).fetch(request,{...env,REQUEST_LIMITER:{async limit(){return {success:true};}}});
   }};
  `},...['membership-notify/worker.mjs','membership-notify/providers.mjs','membership/common.mjs','membership/worker.mjs'].map(path=>({type:'ESModule',path,contents:readFileSync(new URL('../../'+path,import.meta.url),'utf8')}))],
  outboundService:async request=>{
   calls.push({url:request.url,method:request.method});
   if(request.url.includes('challenges.cloudflare.com'))return Response.json({success:true,hostname:'bigsoxstudios.com',action:'membership_request',challenge_ts:new Date(time).toISOString()});
   if(request.url.endsWith(SOURCE))return Response.json(contract);
   const body=await request.json();
   if(request.url.endsWith('/query'))return Response.json({results:[...pages.values()].filter(p=>p.properties['External Case ID'].rich_text[0].text.content===body.filter.rich_text.equals),has_more:false});
   if(request.url.endsWith('/pages')) {
    const page={object:'page',id:crypto.randomUUID(),archived:false,in_trash:false,...body};pages.set(page.id,page);return Response.json(page);
   }
   if(request.method==='PATCH') {const p=pages.get(request.url.split('/').at(-1));Object.assign(p.properties,body.properties);return Response.json(p);}
   if(request.url==='https://api.resend.com/emails') {assert.deepEqual(body.to,[OWNER]);return Response.json({id:crypto.randomUUID()});}
   throw Error('unmocked request');
  }
 }));
 try {
  const d=await mf.getD1Database('MEMBERSHIP_DB');
  await d.batch([...statements('../../membership/migrations/0001_membership.sql'),...statements('../../membership/migrations/0002_notifications.sql'),...statements('../../membership/migrations/0003_notification_provider_check.sql')].map(s=>d.prepare(s)));
  await d.prepare('DELETE FROM membership_notify_outbox').run();
  const post=()=>mf.dispatchFetch('https://bigsoxstudios.com/api/membership/requests',{method:'POST',headers:{Origin:'https://bigsoxstudios.com','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({name:'Synthetic',email:'synthetic@example.test',reason:'Offline integration only',acknowledgement:true,token:crypto.randomUUID()})});
  const responses=await Promise.all(Array.from({length:10},post));assert.ok(responses.every(r=>r.status===200));
  assert.equal((await d.prepare('SELECT count(*) AS n FROM membership_requests').first()).n,1);
  assert.equal((await d.prepare('SELECT count(*) AS n FROM membership_notify_outbox').first()).n,1);
  const run=()=>mf.dispatchFetch('https://offline.test/offline-run');
  await Promise.all([run(),run()]);
  assert.equal(calls.filter(c=>c.url.endsWith('/pages')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/emails')).length,1);
  await d.prepare("UPDATE membership_requests SET status='approved',revision=revision+1,updated_at=?").bind(time).run();
  await run();assert.equal(calls.filter(c=>c.url.endsWith('/emails')).length,1);assert.equal(calls.filter(c=>c.method==='PATCH').length,2);
  assert.equal((await d.prepare("SELECT count(*) AS n FROM membership_notify_outbox WHERE state='done'").first()).n,2);
  if(permanent) {
   const day=86400000;
   const id=crypto.randomUUID();
   await d.prepare('INSERT INTO membership_requests(id,email_hash,created_at,updated_at) VALUES(?,?,?,?)').bind(id,'synthetic-second',time,time).run();
   await Promise.all([run(),run(),run()]);
   assert.equal(calls.filter(c=>c.url.endsWith('/emails')).length,1);
   assert.equal((await d.prepare('SELECT email_state FROM membership_notify_cases WHERE application_id=?').bind(id).first()).email_state,'NEW');
   // 14 earlier durable reservations plus the successful dispatch reach 15.
   const date=new Date(time),monthStart=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/day;
   for(let i=0;i<14;i++) {
    const attempt=crypto.randomUUID();
    await d.batch([
     d.prepare("INSERT INTO membership_notify_cases(application_id,created_at,email_state) VALUES(?,?,'UNKNOWN')").bind(attempt,time),
     d.prepare('INSERT INTO membership_notify_send_attempts(application_id,utc_day) VALUES(?,?)').bind(attempt,monthStart)
    ]);
   }
   await mf.dispatchFetch(`https://offline.test/offline-run?time=${time+day}`);
   assert.equal(calls.filter(c=>c.url.endsWith('/emails')).length,1);
   assert.equal((await d.prepare('SELECT email_state FROM membership_notify_cases WHERE application_id=?').bind(id).first()).email_state,'NEW');
   const nextMonth=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
   await mf.dispatchFetch(`https://offline.test/offline-run?time=${nextMonth}`);
   assert.equal(calls.filter(c=>c.url.endsWith('/emails')).length,2);
   assert.equal((await d.prepare('SELECT email_state FROM membership_notify_cases WHERE application_id=?').bind(id).first()).email_state,'SENT');
   assert.equal((await d.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').first()).n,16);
  }
 } finally {await mf.dispose();}
});

// Execute the production batch SQL directly against workerd D1: no provider
// probe or application lease-acquisition CAS can serialize these contenders.
const workerSource=readFileSync(new URL('../worker.mjs',import.meta.url),'utf8');
const reservationSql=workerSource.match(/permanent \? sql\(`([^`]+)`/)[1];
const intentSql=workerSource.match(/sql\(`(UPDATE membership_notify_cases SET email_state='UNKNOWN'[^`]+)`/)[1]
 .replace("${permanent?'AND changes()=1':''}",'AND changes()=1');
async function reservationDatabase(check) {
 const mf=new Miniflare(convertV4MiniflareOptions({
  log:new NoOpLog(),compatibilityDate:'2026-09-29',name:'reservation-only-offline-test',
  d1Databases:['SYNTHETIC_DB'],modules:[{type:'ESModule',path:'entry.mjs',contents:"export default {fetch(){return new Response('offline');}}"}],
  outboundService:()=>{throw Error('external requests forbidden');}
 }));
 try {
  const d=await mf.getD1Database('SYNTHETIC_DB');
  await d.batch([...statements('../../membership/migrations/0001_membership.sql'),...statements('../../membership/migrations/0002_notifications.sql')].map(s=>d.prepare(s)));
  await d.prepare('DELETE FROM membership_notify_outbox').run();
  await d.prepare('DELETE FROM membership_notify_cases').run();
  await check(d);
 } finally {await mf.dispose();}
}
const reservationTime=Date.parse('2028-01-01T12:00:00Z');
const utcDay=time=>Math.floor(time/86400000);
async function newReservationCase(d) {
 const id=crypto.randomUUID();
 await d.prepare('INSERT INTO membership_notify_cases(application_id,created_at,lease_token,lease_until) VALUES(?,?,?,?)')
  .bind(id,reservationTime,id,reservationTime+3600000).run();
 return id;
}
function reserveBatch(d,id,day,monthStart,monthEnd) {
 return d.batch([
  d.prepare(reservationSql).bind(id,day,day,monthStart,monthEnd,id,id,reservationTime),
  d.prepare(intentSql).bind(id,id,reservationTime,id)
 ]);
}
async function expectReservations(d,count) {
 assert.equal((await d.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').first()).n,count);
 assert.equal((await d.prepare("SELECT count(*) AS n FROM membership_notify_cases WHERE email_state='UNKNOWN'").first()).n,count);
}
test('direct workerd/D1 daily reservation cap: ten rounds of eight distinct competing batches',async()=>{
 await reservationDatabase(async d=>{
  const start=utcDay(Date.UTC(2028,0,1)),end=utcDay(Date.UTC(2028,1,1));
  for(let round=0;round<10;round++) {
   const ids=await Promise.all(Array.from({length:8},()=>newReservationCase(d)));
   const results=await Promise.all(ids.map(id=>reserveBatch(d,id,start+round,start,end)));
   assert.ok(results.every(batch=>batch.every(r=>r.success===true)));
   assert.equal(results.filter(batch=>batch[0].meta.changes===1).length,1);
   assert.equal(results.filter(batch=>batch[1].meta.changes===1).length,1);
   for(const batch of results)assert.equal(batch[0].meta.changes,batch[1].meta.changes);
   assert.equal((await d.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts WHERE utc_day=?').bind(start+round).first()).n,1);
   await expectReservations(d,round+1);
  }
 });
});
test('direct workerd/D1 monthly reservation cap: ten rounds of eight competing batches on distinct UTC days',async()=>{
 await reservationDatabase(async d=>{
  for(let round=0;round<10;round++) {
   const start=utcDay(Date.UTC(2028,round,1)),end=utcDay(Date.UTC(2028,round+1,1));
   // Fourteen actual successful batches on distinct days leave one monthly slot.
   for(let day=0;day<14;day++) {
    const id=await newReservationCase(d);
    const batch=await reserveBatch(d,id,start+day,start,end);
    assert.deepEqual(batch.map(r=>r.meta.changes),[1,1]);
   }
   const ids=await Promise.all(Array.from({length:8},()=>newReservationCase(d)));
   const results=await Promise.all(ids.map((id,i)=>reserveBatch(d,id,start+14+i,start,end)));
   assert.ok(results.every(batch=>batch.every(r=>r.success===true)));
   assert.equal(results.filter(batch=>batch[0].meta.changes===1).length,1);
   assert.equal(results.filter(batch=>batch[1].meta.changes===1).length,1);
   for(const batch of results)assert.equal(batch[0].meta.changes,batch[1].meta.changes);
   assert.equal((await d.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts WHERE utc_day>=? AND utc_day<?').bind(start,end).first()).n,15);
   const later=await newReservationCase(d);
   assert.deepEqual((await reserveBatch(d,later,start+25,start,end)).map(r=>r.meta.changes),[0,0]);
   await expectReservations(d,(round+1)*15);
  }
 });
});
test('direct workerd/D1 changes()=1 rejects old same-application reservation despite available quota',async()=>{
 await reservationDatabase(async d=>{
  const start=utcDay(Date.UTC(2028,0,1)),end=utcDay(Date.UTC(2028,1,1));
  const id=await newReservationCase(d);
  await d.prepare('INSERT INTO membership_notify_send_attempts(application_id,utc_day) VALUES(?,?)').bind(id,start-1).run();
  const batch=await reserveBatch(d,id,start,start,end);
  assert.deepEqual(batch.map(r=>r.meta.changes),[0,0]);
  assert.equal((await d.prepare('SELECT email_state FROM membership_notify_cases WHERE application_id=?').bind(id).first()).email_state,'NEW');
  assert.equal((await d.prepare('SELECT utc_day FROM membership_notify_send_attempts WHERE application_id=?').bind(id).first()).utc_day,start-1);
  assert.equal((await d.prepare('SELECT count(*) AS n FROM membership_notify_send_attempts').first()).n,1);
  const fresh=await newReservationCase(d);
  assert.deepEqual((await reserveBatch(d,fresh,start,start,end)).map(r=>r.meta.changes),[1,1]);
 });
});
test('direct workerd/D1 transaction rolls back reservation when UNKNOWN intent update fails',async()=>{
 await reservationDatabase(async d=>{
  const start=utcDay(Date.UTC(2028,0,1)),end=utcDay(Date.UTC(2028,1,1));
  const id=await newReservationCase(d);
  await d.prepare("CREATE TRIGGER synthetic_fail_intent BEFORE UPDATE OF email_state ON membership_notify_cases WHEN NEW.email_state='UNKNOWN' BEGIN SELECT RAISE(ABORT,'synthetic intent failure'); END").run();
  await assert.rejects(reserveBatch(d,id,start,start,end),/synthetic intent failure/);
  await expectReservations(d,0);
  assert.equal((await d.prepare('SELECT email_state FROM membership_notify_cases WHERE application_id=?').bind(id).first()).email_state,'NEW');
  await d.prepare('DROP TRIGGER synthetic_fail_intent').run();
  assert.deepEqual((await reserveBatch(d,id,start,start,end)).map(r=>r.meta.changes),[1,1]);
  await expectReservations(d,1);
 });
});
