import {PINS,must,guard,sha256,stmt,changed} from './config.mjs';
import {boundary,createSecurity,csrfToken,formBody,fresh} from './security.mjs';
import {verifiedProviders,providerPayload,once} from './providers.mjs';
const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store',
 'Content-Security-Policy':"default-src 'none'; script-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','X-Robots-Tag':'noindex, nofollow, noarchive',
 'Strict-Transport-Security':'max-age=31536000'};
const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const response=(status,body,extra={})=>new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Private TEST acceptance</title><h1>Private TEST acceptance</h1><p>TEST only. No real service access.</p>${body}</html>`,{status,headers:{...headers,...extra}});
const conflict=()=>response(409,'<p>TEST action unavailable or permanently locked. Do not retry provider attempts.</p>');
const fields=(form,allowed)=>must([...form.keys()].every(k=>['csrf','source_revision',...allowed].includes(k)));
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const actionRe=new RegExp(`^/acceptance/requests/(${uuid})/(dispatch|decision|send-welcome)$`);
const removeRe=new RegExp(`^/acceptance/members/(${uuid})/remove$`);
const requestRow=(db,env,id)=>stmt(db,'SELECT * FROM acceptance_requests WHERE run_id=? AND id=?',env.ACCEPTANCE_RUN_ID,id).first();
const effects=async(db,id)=>(await stmt(db,'SELECT kind,state,provider_id FROM acceptance_effects WHERE request_id=? ORDER BY kind',id).all()).results;
const receipts=rows=>['notion_ticket','owner_notice'].every(kind=>rows.some(r=>r.kind===kind && r.state==='accepted' && r.provider_id));
const alive=(session,now)=>{fresh(session,now);return session.expiresAt;};
export function createAcceptanceWorker({role,base,fetcher=fetch,now=()=>Date.now(),verifyAccessPolicy,providers}={}) {
 must(['owner','member'].includes(role) && typeof base?.fetch==='function');
 const authenticate=createSecurity({fetcher,now,verifyAccessPolicy});
 return {async fetch(request,env,ctx){
  const path=new URL(request.url).pathname;
  // Existing paths retain their exact handler and environment, including sessions.
  if(path!=='/acceptance' && !path.startsWith('/acceptance/')) return base.fetch(request,env,ctx);
  let session,db;
  try {boundary(request,role);session=await authenticate(request,env,ctx,role);} catch {return response(403,'<p>Access verification required.</p>');}
  try {db=await guard(env);fresh(session,now);} catch {return response(503,'<p>TEST isolation or configuration unavailable.</p>');}
  try {
   const digest=await sha256(PINS.tester);
   const render=async body=>{
    fresh(session,now);
    const csrf=await csrfToken(request,env,session.expiresAt,now);
    const form=(action,label,revision=1,confirm='TEST')=>`<form method="post" action="${html(action)}"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="source_revision" value="${PINS.revision}"><input type="hidden" name="revision" value="${revision}"><input type="hidden" name="confirm" value="${html(confirm)}"><button>${html(label)}</button></form>`;
    return response(200,await body(form),{'Set-Cookie':`__Host-task12=${csrf}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`});
   };
   if(role==='member' && path==='/acceptance/request') {
    if(request.method==='GET') return render(form=>`<p>One fresh TEST request for run ${html(db.runId)}. Signed OTP, independent MFA and session-bound form protect this private intake.</p>${form(path,'Submit one TEST request')}`);
    const form=await formBody(request,env,session,now);fields(form,['revision','confirm']);must(form.get('confirm')==='TEST' && form.get('revision')==='1');
    const id=crypto.randomUUID();
    const result=await db.requests.batch([
     stmt(db.requests,'INSERT OR IGNORE INTO acceptance_run VALUES(1,?,?)',db.runId,db.nonceDigest),
     stmt(db.requests,"INSERT INTO acceptance_requests(id,run_id,recipient_digest,created_at,updated_at) SELECT ?,?,?,unixepoch(),unixepoch() WHERE unixepoch()<? AND EXISTS(SELECT 1 FROM acceptance_run WHERE singleton=1 AND run_id=? AND nonce_digest=?)",id,db.runId,digest,alive(session,now),db.runId,db.nonceDigest),
     stmt(db.requests,"INSERT INTO acceptance_outbox SELECT ?,'ready' WHERE EXISTS(SELECT 1 FROM acceptance_requests WHERE id=?)",id,id),
    ]);
    return changed(result[1])?response(201,'<p>TEST request recorded. No provider call made. Greg must explicitly dispatch from the protected Owner queue.</p>'):conflict();
   }
   if(role==='member' && path==='/acceptance/app' && request.method==='GET') {
    const row=await stmt(db.requests,"SELECT r.*,e.id AS welcome_id FROM acceptance_requests r JOIN acceptance_effects e ON e.request_id=r.id AND e.kind='test_welcome' AND e.recipient_digest=r.recipient_digest AND e.state='accepted' AND e.provider_id IS NOT NULL WHERE r.run_id=? AND r.recipient_digest=? AND r.status='approved'",db.runId,digest).first();
    if(!row) return response(403,'<p>Approved TEST request and accepted TEST welcome required.</p>');
    const member=await stmt(db.members,"SELECT * FROM acceptance_members WHERE request_id=? AND run_id=? AND recipient_digest=? AND status IN ('pending','active')",row.id,db.runId,digest).first();
    if(!member) return response(403,'<p>TEST membership unavailable.</p>');
    // Atomic identity bind + activation; SQL database time checks the signed session.
    await db.members.batch([
     stmt(db.members,"INSERT OR IGNORE INTO acceptance_identities SELECT 'otp',?,id,unixepoch() FROM acceptance_members WHERE id=? AND status IN ('pending','active') AND unixepoch()<?",session.digest,member.id,alive(session,now)),
     stmt(db.members,"UPDATE acceptance_members SET status='active',active_at=unixepoch(),welcome_effect_id=? WHERE id=? AND status='pending' AND unixepoch()<? AND EXISTS(SELECT 1 FROM acceptance_identities WHERE provider='otp' AND subject_digest=? AND member_id=?)",row.welcome_id,member.id,alive(session,now),session.digest,member.id),
    ]);
    const finalMember=await stmt(db.members,"SELECT id FROM acceptance_members WHERE id=? AND status='active' AND welcome_effect_id=? AND EXISTS(SELECT 1 FROM acceptance_identities WHERE provider='otp' AND subject_digest=? AND member_id=?) AND NOT EXISTS(SELECT 1 FROM service_grants)",member.id,row.welcome_id,session.digest,member.id).first();
    // Cross-D1 revocation always checks Requests again after any awaited member writes.
    const finalRequest=await requestRow(db.requests,env,row.id);fresh(session,now);
    if(!finalMember || finalRequest?.status!=='approved') return response(403,'<p>TEST membership revoked or unavailable.</p>');
    return response(200,'<h2>TEST Membership Active</h2><p>Jellyfin, Palworld and all real services: access denied. This TEST grants no service accounts or permissions.</p>');
   }
   if(role!=='owner') return response(403,'<p>TEST service access denied.</p>');
   if(request.method==='GET' && ['/acceptance/requests/','/acceptance/members/'].includes(path)) {
    const rows=(await stmt(db.requests,'SELECT * FROM acceptance_requests WHERE run_id=?',db.runId).all()).results;
    const members=(await stmt(db.members,'SELECT * FROM acceptance_members WHERE run_id=?',db.runId).all()).results;
    return render(async form=>{
     let body=`<p>TEST run ${html(db.runId)}. Owner notification: ${html(PINS.owner)}. TEST welcome: ${html(PINS.tester)}. No CC/BCC. No real services.</p>`;
     for(const row of rows) {
      const ledger=await effects(db.requests,row.id);
      body+=`<article><h2>TEST request ${html(row.id)}</h2><p>${html(row.status)} · revision ${row.revision}</p><p>${html(ledger.map(e=>`${e.kind}: ${e.state}`).join('; '))}</p>`;
      if(row.status==='pending') {
       body+=form(`/acceptance/requests/${row.id}/dispatch`,'Confirm one TEST ticket and one TEST Owner notification',row.revision,PINS.owner);
       body+=form(`/acceptance/requests/${row.id}/decision`,'Approve TEST request; no services',row.revision);
      }
      if(row.status==='approved') body+=`<a href="/acceptance/requests/${row.id}/send-welcome">Review one TEST welcome</a>`;
      const member=members.find(m=>m.request_id===row.id);
      if(member) body+=`<p>TEST member ${html(member.id)}: ${html(member.status)}. Real service access denied.</p>${member.status!=='revoked'?form(`/acceptance/members/${member.id}/remove`,'Revoke TEST membership',row.revision):''}`;
      body+='</article>';
     }
     fresh(session,now);return body;
    });
   }
   const action=path.match(actionRe),removal=path.match(removeRe);
   if(request.method==='GET' && action?.[2]==='send-welcome') {
    const row=await requestRow(db.requests,env,action[1]);
    if(!row || row.status!=='approved') return conflict();
    const ledger=await effects(db.requests,row.id);
    if(!receipts(ledger) || ledger.some(e=>e.kind==='test_welcome')) return conflict();
    return render(form=>`<p>Confirm ONE TEST welcome to ${html(PINS.tester)}, run ${html(db.runId)}, request ${html(row.id)}. No CC/BCC. No real service credentials or grants. Accepted means provider acceptance, not verified inbox delivery.</p>${form(path,`Send one TEST welcome to ${PINS.tester}`,row.revision,PINS.tester)}`);
   }
   if(request.method!=='POST' || (!action && !removal)) return response(404,'<p>Not found.</p>');
   const form=await formBody(request,env,session,now);fields(form,['revision','confirm']);
   must(/^[1-9][0-9]?$/.test(form.get('revision')));
   const revision=Number(form.get('revision'));
   if(removal) {
    must(form.get('confirm')==='TEST');
    const member=await stmt(db.members,'SELECT * FROM acceptance_members WHERE id=? AND run_id=?',removal[1],db.runId).first();
    if(!member || member.status==='revoked') return conflict();
    // Requests is the immediate deny authority, even if the next D1 write crashes.
    const result=await stmt(db.requests,"UPDATE acceptance_requests SET status='revoked',revision=revision+1,revoked_at=unixepoch(),updated_at=unixepoch() WHERE id=? AND run_id=? AND revision=? AND status='approved' AND unixepoch()<?",member.request_id,db.runId,revision,alive(session,now)).run();
    if(!changed(result)) return conflict();
    await stmt(db.members,"UPDATE acceptance_members SET status='revoked',revoked_at=unixepoch() WHERE id=? AND status IN ('pending','active')",member.id).run();
    return response(200,'<p>TEST membership revoked. Original session denied. Audit, identity and all provider attempts retained.</p>');
   }
   const row=await requestRow(db.requests,env,action[1]);fresh(session,now);
   if(!row || row.revision!==revision || row.recipient_digest!==digest) return conflict();
   const ledger=await effects(db.requests,row.id);fresh(session,now);
   if(action[2]==='decision') {
    must(form.get('confirm')==='TEST');
    if(row.status!=='pending' || !receipts(ledger)) return conflict();
    const result=await stmt(db.requests,"UPDATE acceptance_requests SET status='approved',revision=revision+1,approved_at=unixepoch(),updated_at=unixepoch() WHERE id=? AND run_id=? AND revision=? AND status='pending' AND unixepoch()<?",row.id,db.runId,revision,alive(session,now)).run();
    if(!changed(result)) return conflict();
    const check=await requestRow(db.requests,env,row.id);fresh(session,now);must(check?.status==='approved');
    const memberId=crypto.randomUUID();
    const resultMember=await stmt(db.members,"INSERT INTO acceptance_members(id,request_id,run_id,recipient_digest,created_at) SELECT ?,?,?,?,unixepoch() WHERE unixepoch()<? AND NOT EXISTS(SELECT 1 FROM service_grants)",memberId,row.id,db.runId,digest,alive(session,now)).run();
    return changed(resultMember)?response(200,'<p>TEST approval recorded; one pending TEST Member. No real services.</p>'):conflict();
   }
   const welcome=action[2]==='send-welcome';
   must(form.get('confirm')===(welcome?PINS.tester:PINS.owner));
   if(welcome ? row.status!=='approved' || !receipts(ledger) || ledger.some(e=>e.kind==='test_welcome') : row.status!=='pending' || ledger.length>0) return conflict();
   if(welcome) must(await stmt(db.members,"SELECT id FROM acceptance_members WHERE request_id=? AND run_id=? AND status='pending'",row.id,db.runId).first());
   const proof=await verifiedProviders(providers,env,session,now);fresh(session,now);
   const kinds=welcome?['test_welcome']:['notion_ticket','owner_notice'];
   const intents=await Promise.all(kinds.map(async kind=>({id:crypto.randomUUID(),kind,recipient:await sha256(kind==='notion_ticket'?PINS.parent:kind==='owner_notice'?PINS.owner:PINS.tester)})));
   const expiry=Math.min(alive(session,now),proof.expiresAt);
   const batch=[];
   if(!welcome) batch.push(stmt(db.requests,"UPDATE acceptance_outbox SET state='locked' WHERE request_id=? AND state='ready' AND unixepoch()<? AND EXISTS(SELECT 1 FROM acceptance_requests WHERE id=? AND status='pending' AND revision=?) AND NOT EXISTS(SELECT 1 FROM acceptance_effects WHERE request_id=?)",row.id,expiry,row.id,revision,row.id));
   for(const intent of intents) batch.push(stmt(db.requests,`INSERT INTO acceptance_effects(id,request_id,kind,recipient_digest,state,created_at,updated_at) SELECT ?,?,?,?,'reserved',unixepoch(),unixepoch() WHERE unixepoch()<? AND EXISTS(SELECT 1 FROM acceptance_requests WHERE id=? AND run_id=? AND revision=? AND status=?) ${welcome?'':"AND EXISTS(SELECT 1 FROM acceptance_outbox WHERE request_id=? AND state='locked') AND changes()=1"}`,intent.id,row.id,intent.kind,intent.recipient,expiry,row.id,db.runId,revision,welcome?'approved':'pending',...(!welcome?[row.id]:[])));
   const reserved=await db.requests.batch(batch);
   if(!intents.every((_,i)=>changed(reserved[i+(welcome?0:1)]))) return conflict();
   // All intents reserved atomically BEFORE any external I/O. Never replay a
   // reserved, unknown, refused or accepted intent, including after a crash.
   for(const intent of intents) {
    const current=await requestRow(db.requests,env,row.id);fresh(session,now);
    must(current?.status===(welcome?'approved':'pending') && proof.expiresAt>Math.floor(now()/1000));
    const payload=providerPayload(intent.kind,row,intent.id,intent.recipient);
    const outcome=await once(providers,intent.kind,payload,intent.kind==='notion_ticket'?env.ACCEPTANCE_NOTION_CREDENTIAL:env.ACCEPTANCE_SENDER_CREDENTIAL);
    await stmt(db.requests,"UPDATE acceptance_effects SET state=?,provider_id=?,updated_at=unixepoch() WHERE id=? AND state='reserved'",outcome.state,outcome.providerId,intent.id).run();
    if(outcome.state!=='accepted') return conflict();
   }
   return response(200,'<p>TEST provider acceptance recorded. Inbox delivery remains unverified. Each attempt is permanently consumed.</p>');
  } catch {return conflict();}
 }};
}
