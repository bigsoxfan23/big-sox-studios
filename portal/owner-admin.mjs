// Offline factory ONLY. No default export, route, env activation or production resolver.
import {createRepository} from './repository.mjs';
import {httpsOrigin,b64} from './access.mjs';
const cookieName='__Host-owner-admin-csrf';
const headers={
 'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store, max-age=0',
 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'X-Robots-Tag':'noindex, nofollow, noarchive'
};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const need=value=>{if(!value) throw Error('denied');};
async function body(request) {
 need(request.headers.get('Content-Type')==='application/x-www-form-urlencoded');
 const reader=request.body?.getReader(); need(reader);
 let size=0; const chunks=[];
 try { for(;;) {const {done,value}=await reader.read(); if(done) break; size+=value.length; need(size<=8192); chunks.push(value);} }
 finally {await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size); let offset=0;
 for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
 const form=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 need([...form.keys()].every(key=>['csrf','action','member','contact'].includes(key) && form.getAll(key).length===1));
 return form;
}
function page(csrf,rows=null) {
 const field=`<input type="hidden" name="csrf" value="${escape(csrf)}">`;
 const form=(action,fields,label)=>`<form method="post" action="/">${field}<input type="hidden" name="action" value="${action}">${fields}<button>${label}</button></form>`;
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Private owner invitations — offline</title>
 <style>body{font:1rem system-ui;max-width:55rem;margin:2rem auto;padding:0 1rem}section{border-top:1px solid #888;padding:1rem 0}li{margin:1rem 0;overflow-wrap:anywhere}input,button{font:inherit;padding:.5rem;margin:.3rem}form{display:inline-block}h1{font-size:1.6rem}</style>
 <h1>Private owner invitations — offline</h1><p>Projection BLOCKED. No delivery or activation is available. Issue/reissue discards its secret; a future verified delivery workflow must reissue.</p>
 <section><h2>Candidate people</h2>${form('view','','Show private people')}<ul>${rows===null?'<li>Private records hidden until requested.</li>':rows.map(row=>`<li>${escape(row.recipient)} — ${escape(row.status)}${row.status!=='revoked' && row.role!=='owner'?form('revoke',`<input type="hidden" name="member" value="${escape(row.id)}">`,'Revoke'):''}</li>`).join('')}</ul></section>
 <section><h2>Invitations and expiry</h2><ul>${rows===null?'<li>Private records hidden until requested.</li>':rows.map(row=>`<li>${escape(row.recipient)} — ${escape(row.invitation_status??'none')}; expiry ${row.expires_at?escape(new Date(row.expires_at*1000).toISOString()):'none'}${row.status==='pending'?form('issue',`<input type="hidden" name="member" value="${escape(row.id)}">`,'Issue/reissue (blocked)'):''}</li>`).join('')}</ul></section>
 <section><h2>Create pending member</h2><p>Verify the person and contact privately first. This creates no provider identity.</p>${form('create','<label>Contact <input type="email" name="contact" maxlength="254" required></label>','Create pending')}</section></html>`;
}
export function createOwnerAdminWorker({mode,origin,ownerAudience,membersAudience,issuer,authenticate,resolveOwnerActor,now=()=>Math.floor(Date.now()/1000)}={}) {
 // authenticate MUST verify the exact Owner app JWT. resolveOwnerActor is a
 // separate trusted subject/MFA resolver, never email matching or browser JSON.
 // Bounded volatile controls are offline single-instance only, NOT distributed replay protection.
 const sessions=new Map(); let budgetStart=0,actions=0;
 return {async fetch(request,env) {
  const respond=(status,text,extra={})=>new Response(text,{status,headers:{...headers,...extra}});
  try {
   need(mode==='offline-test' && env?.DB && typeof authenticate==='function' && typeof resolveOwnerActor==='function');
   const configured=httpsOrigin(origin),trustedIssuer=httpsOrigin(issuer),url=new URL(request.url);
   need(/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(trustedIssuer.hostname) && !trustedIssuer.port);
   need(!configured.port && !configured.hostname.endsWith('.workers.dev') && url.origin===origin && url.pathname==='/' && !url.search);
   need(!request.headers.has('Host') || request.headers.get('Host')===configured.host);
   need(!request.headers.has('Origin') || request.headers.get('Origin')===origin);
   need(['GET','POST'].includes(request.method));
   need(typeof ownerAudience==='string' && ownerAudience.length>0 && typeof membersAudience==='string' && membersAudience.length>0 && ownerAudience!==membersAudience);
   const claims=await authenticate(request,env),at=now();
   need(Number.isSafeInteger(at) && claims?.iss===issuer && typeof claims.sub==='string' && claims.sub.length>0 && Number.isSafeInteger(claims.exp) && claims.exp>at);
   need(claims.aud===ownerAudience || (Array.isArray(claims.aud) && claims.aud.length===1 && claims.aud[0]===ownerAudience));
   const actor=await resolveOwnerActor(claims,request,env);
   need(actor?.accessSubject===claims.sub && typeof actor.memberId==='string');
   // CURRENT D1 role, for every path/action; resolver-supplied roles are ignored.
   need(await env.DB.prepare("SELECT id FROM members WHERE id=? AND role='owner' AND status='active'").bind(actor.memberId).first());
   const jwt=request.headers.get('Cf-Access-Jwt-Assertion'); need(jwt && jwt.length<16384);
   const session=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(jwt)));
   for(const [key,value] of sessions) if(value.until<=at) sessions.delete(key);
   let show=false;
   if(request.method==='POST') {
    need(request.headers.get('Origin')===origin && (!request.headers.has('Sec-Fetch-Site') || request.headers.get('Sec-Fetch-Site')==='same-origin'));
    const form=await body(request),state=sessions.get(session);
    const cookies=(request.headers.get('Cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
    need(state && state.actor===actor.memberId && cookies.length===1 && cookies[0]===`${cookieName}=${state.csrf}` && form.get('csrf')===state.csrf);
    sessions.delete(session); // consume synchronously before any mutation/await; retries require a fresh page
    if(at-budgetStart>=60) {budgetStart=at;actions=0;} need(++actions<=30);
    const action=form.get('action'),member=form.get('member');
    need(['view','create','issue','revoke'].includes(action));
    need(action==='create'?form.has('contact') && !form.has('member'):!form.has('contact'));
    need(['issue','revoke'].includes(action)?typeof member==='string' && member.length>0 && member.length<=128:!form.has('member'));
    const repo=createRepository(env.DB,{now});
    if(action==='create') await repo.createPending(actor.memberId,form.get('contact'));
    if(action==='issue') await repo.issue(actor.memberId,member); // deliberately discard secret; no projection/delivery surface
    if(action==='revoke') {
     const target=await env.DB.prepare('SELECT role,status FROM members WHERE id=?').bind(member).first();
     need(target && target.role!=='owner');
     if(target.status!=='revoked') await repo.revoke(actor.memberId,member);
    }
    show=true;
   }
   need(sessions.has(session) || sessions.size<128);
   const csrf=b64(crypto.getRandomValues(new Uint8Array(32)));
   sessions.set(session,{csrf,actor:actor.memberId,until:Math.min(at+600,claims.exp)});
   const rows=show?(await env.DB.prepare(`SELECT m.id,m.recipient,m.role,m.status,i.status AS invitation_status,i.expires_at
    FROM members m LEFT JOIN invitations i ON i.id=(SELECT id FROM invitations WHERE member_id=m.id ORDER BY revision DESC LIMIT 1)
    ORDER BY m.created_at,m.id LIMIT 101`).all()).results:null;
   // Fail closed rather than silently truncate a larger private directory.
   need(!rows || rows.length<=100);
   return respond(200,page(csrf,rows),{'Set-Cookie':`${cookieName}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`});
  } catch {return respond(403,'Request unavailable. Reload the private owner page.');}
 }};
}
