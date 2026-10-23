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
