import { readBody } from '../membership/common.mjs';
export const SOURCE = '103d8328-de8b-4b7f-8986-000ce40450b5';
export const QUEUE = 'https://owner.bigsoxstudios.com/membership/requests/';
export const OWNER = 'fridman.greg@gmail.com';
export const SENDER = 'support@bigsoxstudios.com';
export const MANUAL = 'c3250338-3691-4fae-a7ae-35ed66a31a23';
export const decisions = {pending:'Pending',approved:'Approved',rejected:'Declined',revoked:'Declined',expired:'Not applicable'};
export const statuses = {pending:'Inbox',approved:'Waiting',rejected:'Closed',revoked:'Closed',expired:'Closed'};
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const normalize = id => id.replaceAll('-','').toLowerCase();
const rich = content => ({rich_text:[{text:{content}}]});
const select = name => ({select:{name}});
const fail = category => { throw Object.assign(new Error(category),{category}); };
export function payload(id) {
 if (!uuid(id)) fail('notion_conflict');
 return {parent:{type:'data_source_id',data_source_id:SOURCE},properties:{
  Title:{title:[{text:{content:'Website membership request'}}]},
  'Ticket Kind':select('Membership'),'Request Channel':select('Website'),Status:select('Inbox'),
  'Membership Decision':select('Pending'),'External Case ID':rich(id),'Link':{url:QUEUE}
 }};
}
export function createProviders(env, fetcher = fetch, timeout = 5000) {
 async function request(host,path,method,body,key) {
  const token = host === 'notion' ? env.NOTION_API_TOKEN : env.RESEND_API_KEY;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{12,1024}$/.test(token)) fail('configuration');
  const controller = new AbortController(); let timer;
  try {
   return await Promise.race([(async()=>{
    const response = await fetcher(`${host === 'notion' ? 'https://api.notion.com/v1/' : 'https://api.resend.com/'}${path}`,{
     method,redirect:'manual',signal:controller.signal,
     headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',
      ...(host === 'notion' ? {'Notion-Version':'2025-09-03'} : {'Idempotency-Key':key})},
     ...(body === undefined ? {} : {body:JSON.stringify(body)})
    });
    if (response.status !== 200 || response.redirected) {
     await response.body?.cancel().catch(()=>{});
     fail(host === 'resend' && [400,401,403,422,429].includes(response.status) ? 'resend_refused' : 'transport');
    }
    return JSON.parse(await readBody(response,65536));
   })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('deadline'));},timeout);})]);
  } finally { clearTimeout(timer); controller.abort(); }
 }
 function validatePage(page,id) {
  const p=page?.properties;
  const parts=p?.['External Case ID']?.rich_text;
  if (page?.object !== 'page' || !uuid(page.id) || page.archived !== false || page.in_trash === true ||
   normalize(page.parent?.data_source_id || '') !== normalize(SOURCE) || !Array.isArray(parts) ||
   parts.map(x=>x.plain_text ?? x.text?.content ?? '').join('') !== id ||
   p['Ticket Kind']?.select?.name !== 'Membership' || p['Request Channel']?.select?.name !== 'Website') fail('notion_conflict');
  return page.id;
 }
 return {
  async schema() {
   const schema = await request('notion',`data_sources/${SOURCE}`,'GET');
   if (normalize(schema.id || '') !== normalize(SOURCE)) fail('configuration');
   const expected={Title:'title','Ticket Kind':'select','Request Channel':'select',Status:'select','Membership Decision':'select','External Case ID':'rich_text','Link':'url'};
   for (const [name,type] of Object.entries(expected)) if (schema.properties?.[name]?.type !== type) fail('configuration');
   for (const [name,names] of Object.entries({'Ticket Kind':['Membership'],'Request Channel':['Website'],Status:['Inbox','New','Waiting','Closed','Done','Dropped'],'Membership Decision':[...new Set(Object.values(decisions))]})) {
    const options=schema.properties[name].select?.options;
    if (!Array.isArray(options) || names.some(n=>options.filter(o=>o.name===n).length!==1) || (name==='Membership Decision' && options.length!==names.length)) fail('configuration');
   }
  },
  async find(id) {
   let cursor; const seen=new Set(); const found=[];
   for(let i=0;i<2;i++) {
    const result=await request('notion',`data_sources/${SOURCE}/query`,'POST',{
     filter:{property:'External Case ID',rich_text:{equals:id}},page_size:2,...(cursor?{start_cursor:cursor}:{})});
    if (!Array.isArray(result.results) || result.results.length>2 || typeof result.has_more!=='boolean') fail('notion_conflict');
    for (const page of result.results) {validatePage(page,id);found.push(page);}
    if(found.length>1) fail('notion_conflict');
    if(!result.has_more) return found[0] || null;
    cursor=result.next_cursor;
    if(typeof cursor!=='string' || !cursor || cursor.length>256 || seen.has(cursor)) fail('notion_conflict');
    seen.add(cursor);
   }
   fail('notion_conflict');
  },
  async create(id) { const page=await request('notion','pages','POST',payload(id)); validatePage(page,id); return page; },
  async sync(page,id,status) {
   if(!uuid(page) || !Object.hasOwn(decisions,status)) fail('notion_conflict');
   const result=await request('notion',`pages/${page}`,'PATCH',{properties:{Status:select(statuses[status]),'Membership Decision':select(decisions[status])}});
   if (validatePage(result,id)!==page || result.properties['Membership Decision']?.select?.name!==decisions[status] || result.properties.Status?.select?.name!==statuses[status]) fail('notion_conflict');
  },
  async send(id) {
   if(!uuid(id) || id===MANUAL || env.OWNER_EMAIL!==OWNER || env.SENDER_EMAIL!==SENDER) fail('configuration');
   const result=await request('resend','emails','POST',{
    from:SENDER,to:[OWNER],subject:'New website membership request',text:`A new membership request is ready for private owner review.\n${QUEUE}`
   },`membership-notify-v1-${id}`);
   if(!uuid(result.id)) fail('resend_unknown');
  }
 };
}
