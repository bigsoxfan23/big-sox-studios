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
test('real workerd/D1: concurrent verified intake commits one outbox, cron claims one effect, owner decision never emails',async()=>{
 const calls=[],pages=new Map();
 const contract=schema();
 const mf=new Miniflare(convertV4MiniflareOptions({
  log:new NoOpLog(),compatibilityDate:'2026-09-29',name:'notify-offline-test',d1Databases:['MEMBERSHIP_DB'],
  bindings:{NOTIFY_ENABLED:'true',NOTION_ENABLED:'true',EMAIL_ENABLED:'true',PROVIDER_DAILY_LIMIT:'10',OWNER_EMAIL:OWNER,SENDER_EMAIL:SENDER,
   NOTION_API_TOKEN:'synthetic_notion_token',RESEND_API_KEY:'synthetic_resend_token',
   NOTIFY_START_MS:String(Date.now()-1000),PROVIDER_VERIFIED_UNTIL_MS:String(Date.now()+3600000),
   EMAIL_HMAC_KEY:'e'.repeat(32),RATE_HMAC_KEY:'r'.repeat(32),TURNSTILE_SECRET_KEY:'s'.repeat(32)},
  modules:[{type:'ESModule',path:'entry.mjs',contents:`
   import {createWorker as notify} from './membership-notify/worker.mjs';
   import {createWorker as publicWorker} from './membership/worker.mjs';
   export default {async fetch(request,env){
    if(new URL(request.url).pathname==='/offline-run') {await notify().run(env);return new Response('ok');}
    return publicWorker().fetch(request,{...env,REQUEST_LIMITER:{async limit(){return {success:true};}}});
   }};
  `},...['membership-notify/worker.mjs','membership-notify/providers.mjs','membership/common.mjs','membership/worker.mjs'].map(path=>({type:'ESModule',path,contents:readFileSync(new URL('../../'+path,import.meta.url),'utf8')}))],
  outboundService:async request=>{
   calls.push({url:request.url,method:request.method});
   if(request.url.includes('challenges.cloudflare.com'))return Response.json({success:true,hostname:'bigsoxstudios.com',action:'membership_request',challenge_ts:new Date().toISOString()});
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
  await d.prepare("UPDATE membership_requests SET status='approved',revision=revision+1,updated_at=?").bind(Date.now()).run();
  await run();assert.equal(calls.filter(c=>c.url.endsWith('/emails')).length,1);assert.equal(calls.filter(c=>c.method==='PATCH').length,2);
  assert.equal((await d.prepare("SELECT count(*) AS n FROM membership_notify_outbox WHERE state='done'").first()).n,2);
 } finally {await mf.dispose();}
});
