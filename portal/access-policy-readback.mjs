// Read-only, deliberately narrow Access policy subset. No policy writes, logs,
// credential forwarding, cached authorization or user-controlled API targets.
import {normalizeEmail} from './identity.mjs';

export const stagingAccessTarget=Object.freeze({
 accountId:'4c36a1a54dbe7ce85839b555fefb2b72',
 applicationId:'42fd6150-5f0e-4a1c-a0ba-952148b73b18',
 ownerPolicyId:'b3cf1b27-c1ac-4a7a-adb7-f31c344b47a0',
 launcherApplicationId:'fc6b8306-bab6-449b-8260-151bf144d06b',
 launcherHost:'old-hill-995d.cloudflareaccess.com',
 host:'members-staging.bigsoxstudios.com',
 audience:'f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe'
});
const need=ok=>{if(!ok)throw Error('Access policy readback unavailable');};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const sameSet=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&new Set(a).size===a.length&&a.length===b.length&&a.every(x=>b.includes(x));
const seconds=value=>{
 const m=/^(\d+)(m|h)$/.exec(value||'');
 need(m); const n=Number(m[1])*(m[2]==='h'?3600:60);need(Number.isSafeInteger(n)&&n<=86400);return n;
};
function mfa(config,baseline=null){
 need(config&&config.mfa_disabled===false&&Array.isArray(config.allowed_authenticators)&&config.allowed_authenticators.length>0);
 need(new Set(config.allowed_authenticators).size===config.allowed_authenticators.length&&config.allowed_authenticators.every(x=>['totp','biometrics','security_key'].includes(x)));
 const duration=seconds(config.session_duration);
 if(baseline){need(duration<=seconds(baseline.session_duration));need(config.allowed_authenticators.every(x=>baseline.allowed_authenticators.includes(x)));}
}
function emailPolicy(policy,expected,applicationMfa){
 need(uuid(policy.id)&&policy.decision==='allow'&&Array.isArray(policy.include)&&policy.include.length===1);
 const rule=policy.include[0];need(rule&&Object.keys(rule).length===1&&rule.email&&Object.keys(rule.email).length===1);
 need(normalizeEmail(rule.email.email)===expected&&rule.email.email===expected);
 need(Array.isArray(policy.require)&&policy.require.length===0&&Array.isArray(policy.exclude)&&policy.exclude.length===0);
 need(!policy.approval_required&&!policy.purpose_justification_required&&!policy.isolation_required);
 if(policy.session_duration!=null)need(seconds(policy.session_duration)>0);
 if(policy.mfa_config!=null)mfa(policy.mfa_config,applicationMfa);
}
function matchingDomain(domain,host){
 if(typeof domain!=='string')return false;
 const hostname=domain.split('/')[0].toLowerCase().replace(/\.$/,'');
 need(/^(?:\*\.)?[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname));
 return hostname===host||(hostname.startsWith('*.')&&host.endsWith(hostname.slice(1)));
}
function routes(app){
 // The account inventory also includes its built-in App Launcher. Pin its
 // identity and host; never skip it or accept a routing-capable variant.
 if(app.type==='app_launcher'){
  need(app.id===stagingAccessTarget.launcherApplicationId&&app.domain===stagingAccessTarget.launcherHost);
  need(app.destinations==null&&app.self_hosted_domains==null);
  return [app.domain];
 }
 need(app.type==='self_hosted');
 const domains=[];
 if(app.domain!=null){need(typeof app.domain==='string'&&app.domain.length>0);matchingDomain(app.domain,'unused.example');domains.push(app.domain);}
 if(app.self_hosted_domains!=null){need(Array.isArray(app.self_hosted_domains));for(const d of app.self_hosted_domains){need(typeof d==='string');matchingDomain(d,'unused.example');domains.push(d);}}
 if(app.destinations!=null){
  need(Array.isArray(app.destinations)&&app.destinations.length>0);
  for(const d of app.destinations){
   need(d&&['public','worker','preview_worker'].includes(d.type));
   const keys=d.type==='public'?['type','uri','overrides']:['type','worker_id','overrides'];
   need(Object.keys(d).every(k=>keys.includes(k)));
   need(d.overrides==null||(Array.isArray(d.overrides)&&d.overrides.length===0));
   if(d.type==='public'){need(typeof d.uri==='string'&&d.uri.length>0);matchingDomain(d.uri,'unused.example');domains.push(d.uri);}
   else need(typeof d.worker_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(d.worker_id));
  }
 }else{
  need(domains.length>0);
 }
 return domains;
}

export function createAccessPolicyReader({fetcher=fetch,now=()=>Math.floor(Date.now()/1000),token,expectedIdps,recipient}={}){
 const target=stagingAccessTarget;
 return {async read(ownerEmail){
  need(typeof token==='string'&&token.length>=20&&token.length<=4096&&!/[\r\n]/.test(token));
  need(sameSet(expectedIdps,expectedIdps)&&expectedIdps.length>0&&expectedIdps.every(uuid));
  need(normalizeEmail(recipient)===recipient&&normalizeEmail(ownerEmail)===ownerEmail&&recipient!==ownerEmail);
  const started=now();need(Number.isSafeInteger(started)&&started>=0);
  // All requests share a bounded deadline and may never follow credential-bearing redirects.
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  let calls=0;
  const base='https://api.cloudflare.com/client/v4/accounts/'+target.accountId+'/access';
  async function get(path){
   // Leave headroom within the existing Free-plan external subrequest budget.
   need(++calls<=40&&now()-started<=15);
   const res=await fetcher(base+path,{method:'GET',redirect:'manual',signal:controller.signal,headers:{Authorization:'Bearer '+token,Accept:'application/json','Cache-Control':'no-store'}});
   need(res.ok&&!res.redirected);
   const reader=res.body?.getReader();need(reader);let count=0;const chunks=[];
   try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;need(count<=1048576);chunks.push(value);}}
   finally{await reader.cancel().catch(()=>{});}
   const bytes=new Uint8Array(count);let off=0;for(const chunk of chunks){bytes.set(chunk,off);off+=chunk.length;}
   const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   need(data.success===true&&Array.isArray(data.errors)&&data.errors.length===0);return data;
  }
  async function list(path){
   const rows=[],seen=new Set();let total=null,pages=null;
   for(let page=1;page<=10;page++){
    const data=await get(path+'?page='+page+'&per_page=50'),info=data.result_info;
    need(Array.isArray(data.result)&&info&&info.page===page&&Number.isSafeInteger(info.total_count)&&Number.isSafeInteger(info.total_pages));
    need(info.count===data.result.length&&Number.isSafeInteger(info.per_page)&&info.per_page>0&&info.per_page<=100&&info.per_page>=data.result.length&&info.total_count>=0&&info.total_pages>=0&&info.total_pages<=10);
    if(info.total_pages===0){need(page===1&&info.total_count===0&&data.result.length===0);return [];}
    if(total===null){total=info.total_count;pages=info.total_pages;}need(total===info.total_count&&pages===info.total_pages);
    for(const row of data.result){need(row&&uuid(row.id)&&!seen.has(row.id));seen.add(row.id);rows.push(row);}
    need(rows.length<=100);
    if(page===pages){need(rows.length===total);return rows;}
   }
   throw Error('Access policy readback unavailable');
  }
  async function inventorySnapshot(){
   const apps=await list('/apps');need(apps.length>0&&apps.length<=20);
   const sorted=apps.sort((a,b)=>a.id.localeCompare(b.id));
   const inventory=new Array(sorted.length);let next=0;
   // Two applications at a time, each with independent detail/policy reads:
   // at most four external requests, below the Worker connection limit.
   await Promise.all(Array.from({length:Math.min(2,sorted.length)},async()=>{
    for(;;){
     const index=next++;if(index>=sorted.length)return;const summary=sorted[index];
     const [detail,policyRows]=await Promise.all([get('/apps/'+summary.id),list('/apps/'+summary.id+'/policies')]);
     const app=detail.result;need(app&&app.id===summary.id);
     const policies=policyRows.sort((a,b)=>a.id.localeCompare(b.id));
     need(Array.isArray(app.policies)&&sameSet(app.policies.map(p=>p.id),policies.map(p=>p.id)));
     inventory[index]={app,policies};
    }
   }));
   return inventory;
  }
  try{
   const inventory=await inventorySnapshot();
   const selected=inventory.find(x=>x.app.id===target.applicationId);need(selected);const app=selected.app;
   need(app.type==='self_hosted'&&app.domain===target.host&&app.aud===target.audience);
   need(seconds(app.session_duration)>0);
   need(sameSet(app.allowed_idps,expectedIdps)&&app.allow_authenticate_via_warp!==true);
   mfa(app.mfa_config);
   // A single exact hostname is supported. Unknown destination representations fail closed.
   const selectedRoutes=routes(app);need(selectedRoutes.length>=1&&selectedRoutes.every(d=>d===target.host||d===target.host+'/'));
   if(app.destinations!=null)need(app.destinations.length===1&&app.destinations[0].type==='public');
   for(const other of inventory){
    if(other===selected)continue;
    need(!routes(other.app).some(d=>matchingDomain(d,target.host)));
   }
   need(selected.policies.length===2);
   const owner=selected.policies.find(p=>p.id===target.ownerPolicyId),invite=selected.policies.find(p=>p.id!==target.ownerPolicyId);
   need(owner&&invite);emailPolicy(owner,ownerEmail,app.mfa_config);emailPolicy(invite,recipient,app.mfa_config);
   need(Number.isSafeInteger(owner.precedence)&&Number.isSafeInteger(invite.precedence)&&owner.precedence!==invite.precedence);
   for(const other of inventory)if(other!==selected)need(!other.policies.some(p=>p.id===invite.id));
   // Repeat the complete inventory, not only the target. A concurrent new route,
   // changed policy attachment or extra recipient allowance must invalidate it.
   need(JSON.stringify(await inventorySnapshot())===JSON.stringify(inventory));
   const ended=now();need(Number.isSafeInteger(ended)&&ended>=started&&ended-started<=15);
   return Object.freeze({contacts:Object.freeze([ownerEmail,recipient].sort()),verifiedAt:ended});
  }catch{throw Error('Access policy readback unavailable');}
  finally{clearTimeout(timer);}
 }};
}
