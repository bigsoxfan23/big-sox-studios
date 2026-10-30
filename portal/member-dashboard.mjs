import {handleInvitationClaim,scriptCsp} from './invitation-claim.mjs';
import {checkOtpHost,createOtpAuthenticator} from './otp-identity.mjs';
import {authorizeMember,mayManageMembers,SERVICES} from './authorization.mjs';
import {studioPage,studioPreview} from './studio-ui.mjs';
import {ownerMembersView} from './owner-members-view.mjs';
import {prepareOwnerAction,executeOwnerAction,ownerActionSetCookie} from './owner-member-actions.mjs';

const headers={
 'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store',
 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src https://bigsoxstudios.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
 // Native same-origin form POSTs need a non-opaque Origin; no-referrer makes browsers send null.
 // Keep exact Origin validation and suppress referrers for cross-origin navigation.
 'Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'X-Robots-Tag':'noindex, nofollow, noarchive','Content-Type':'text/html; charset=utf-8'
};
// Failure responses stay intentionally tiny and avoid echoing private identifiers.
const page=(title,body)=>'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Big Sox Studios</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101821;color:#f6eedf;margin:0;padding:3rem max(1rem,calc((100vw - 44rem)/2))}h1{font:600 2.6rem Georgia,serif;color:#f6eedf}main{border:1px solid #5c6470;border-radius:1rem;padding:1.5rem;background:#17212c}strong{color:#f2a33b}</style><main><strong>Big Sox Studios</strong><h1>'+title+'</h1>'+body+'</main></html>';
const dashboard=(member,mountPath)=>{
 const role={owner:'Owner',trusted:'Trusted member',member:'Member'}[member.role];
 const owner=mayManageMembers(member);
 const services=member.grants.filter(x=>SERVICES.includes(x));
 const serviceCopy=services.length?'Your granted services will be shown here once connected.':'Your studio services will appear here once connected and approved.';
 const ownerPanel=owner?'<section class="panel wide"><div class="eyeline"><h2>Owner workspace</h2><span class="status preview">Coming next</span></div><p class="muted">Review your members and the existing request queue. Invitation controls are next.</p><a class="button" href="'+(mountPath==='/app'?'/app/ui-preview':'/ui-preview')+'">Preview the studio designs</a> <a class="button secondary" href="'+(mountPath==='/app'?'/app/manage':'/manage')+'">Manage members</a></section>':'';
 return studioPage('Your studio, your space',
 '<p class="lede">Welcome back to Big Sox Studios. Your access is checked securely on every visit.</p><div class="grid">'+
 '<section class="panel"><div class="eyeline"><h2>Your membership</h2><span class="status">Active</span></div><dl><div><dt>Role</dt><dd>'+role+'</dd></div><div><dt>Status</dt><dd>Active</dd></div></dl></section>'+
 '<section class="panel"><div class="eyeline"><h2>Services coming soon</h2><span class="status preview">Not connected</span></div><p class="muted">'+serviceCopy+'</p><p class="fine muted">Signing in does not automatically grant access to services.</p></section>'+
 ownerPanel+'</div><p><a class="button secondary" href="/cdn-cgi/access/logout">Sign out of Cloudflare Access</a></p><p class="fine muted">Signing out ends your Access session across applications, but not your email provider session.</p>','Member portal');
};

export function createMemberDashboard({verifyAccess,now=()=>Date.now(),mountPath='/',projectInvitation,preflightInvitation}={}) {
 if (!['/','/app'].includes(mountPath)) throw Error('invalid mount');
 const authenticate=createOtpAuthenticator({verifyAccess,now});
 return {async fetch(request,env,ctx) {
  const respond=(status,title,body)=>new Response(request.method==='HEAD'?null:page(title,`<p>${body}</p>`),{status,headers});
  let stage='host';
  try {
   checkOtpHost(request,env);
   stage='jwt-otp';
   const identity=await authenticate(request,env,ctx);
   const claimUrl=new URL(request.url);
   if(claimUrl.pathname===(mountPath==='/app'?'/app/invite':'/invite') && env.PORTAL_INVITATIONS==='enabled-12-2')
    return await handleInvitationClaim(request,env,identity,mountPath==='/app'?'/app':'',()=>Math.floor(now()/1000));
   stage='d1-lookup';
   // One live snapshot, every path/method. No login writes, no email fallback,
   // no owner shortcut and no cached membership, roles or service grants.
   const member=await env.DB.prepare(`SELECT m.id,m.role,m.status,
    COALESCE(json_group_array(g.service) FILTER(WHERE g.service IS NOT NULL),'[]') AS grants
    FROM identities i JOIN members m ON m.id=i.member_id LEFT JOIN service_grants g ON g.member_id=m.id
    WHERE i.provider=? AND i.subject=? GROUP BY m.id`).bind(identity.provider,identity.subject).first();
   stage='member-decode';
   if (!member || typeof member.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(member.id)) throw Error('denied');
   member.grants=JSON.parse(member.grants);
   stage='authorization';
   // The signed session must still be current after the live D1 read.
   const at=Math.floor(now()/1000);
   if (!authorizeMember(member) || !Number.isSafeInteger(at) || at<0 ||
    identity.expiresAt<=at) throw Error('denied');
   const url=new URL(request.url);
   if (url.search) return respond(400,'Unavailable','This address is unavailable.');
   stage='route';
   const path=mountPath==='/'?url.pathname:(url.pathname==='/app'?'/':url.pathname.startsWith('/app/')?url.pathname.slice(4):null);
   if (path===null) throw Error('denied');
   if(path==='/manage/invitation-preflight'){
    if(!mayManageMembers(member)||env.PORTAL_INVITATIONS!=='enabled-12-2')throw Error('denied');
    if(!['GET','HEAD'].includes(request.method))return respond(405,'Unavailable','This method is unavailable.');
    if(typeof preflightInvitation!=='function')return respond(503,'Invitation setup unavailable','Policy readiness could not be verified. No invitation was created.');
    try{
     const result=await preflightInvitation(env.DB);
     if(result?.ready!==true||Math.floor(now()/1000)>=identity.expiresAt)throw Error('unavailable');
     return respond(200,'Invitation setup ready','Access policy readback passed. No invitation was created.');
    }catch{return respond(503,'Invitation setup unavailable','Policy readiness could not be verified. No invitation was created.');}
   }
   if(path==='/manage') {
    if(!mayManageMembers(member)) throw Error('denied');
    const enabled=env.PORTAL_OWNER_CONTROLS==='enabled-12-1';
    if(request.method==='POST') {
     if(!enabled)return respond(405,'Unavailable','This method is unavailable.');
     if(Math.floor(now()/1000)>=identity.expiresAt)throw Error('expired');
     const outcome=await executeOwnerAction(env.DB,request,member.id,identity.expiresAt,()=>Math.floor(now()/1000),{allowDelivery:env.PORTAL_INVITATIONS==='enabled-12-2',projectInvitation:env.PORTAL_INVITATIONS==='enabled-12-2'?(projectInvitation??(async()=>{throw Error('Access eligibility unavailable');})):undefined});
     if(outcome?.invitation) {
      const deliveryCsrf=await prepareOwnerAction(env.DB,request,member.id,identity.expiresAt,()=>Math.floor(now()/1000));
      const invite=outcome.invitation,prefix=mountPath==='/app'?'/app':'';
      const link=env.APP_ORIGIN+prefix+'/invite';
      const code=invite.id+'.'+invite.secret;
      const script="document.getElementById('copy-invitation').addEventListener('click',async()=>{const field=document.getElementById('claim-link');field.select();try{await navigator.clipboard.writeText(field.value);document.getElementById('copy-result').textContent='Link copied. Copy the separate invitation code privately too.';}catch{document.getElementById('copy-result').textContent='Select and copy the link above.';}});document.getElementById('copy-code').addEventListener('click',async()=>{const field=document.getElementById('claim-code');field.select();try{await navigator.clipboard.writeText(field.value);document.getElementById('copy-result').textContent='Invitation code copied';}catch{document.getElementById('copy-result').textContent='Select and copy the code above.';}});";
      const html=studioPage('Your invitation is ready','<section class="panel"><p>Expires '+new Date(invite.expiresAt*1000).toISOString()+'. Share the sign-in link and separate code privately with the approved recipient. The code is shown once. Keep the code out of browser addresses.</p><label>Sign-in link <textarea id="claim-link" readonly>'+link+'</textarea></label><button id="copy-invitation">Copy sign-in link</button><label>Private invitation code <textarea id="claim-code" readonly>'+code+'</textarea></label><button id="copy-code">Copy invitation code</button><p id="copy-result" role="status"></p><p>After privately sharing both items with the approved recipient, confirm delivery to enable acceptance.</p><form method="post" action="'+prefix+'/manage"><input type="hidden" name="csrf" value="'+deliveryCsrf+'"><input type="hidden" name="action" value="deliver"><input type="hidden" name="member" value="'+invite.id+'"><button type="submit">Confirm private delivery</button></form><a class="button" href="'+prefix+'/manage">Back to members</a></section><script>'+script+'</script>','Owner workspace');
      return new Response(html,{status:200,headers:{...headers,'Content-Security-Policy':headers['Content-Security-Policy'].replace("form-action 'none'","form-action 'self'")+'; script-src '+await scriptCsp(script),'Set-Cookie':ownerActionSetCookie(deliveryCsrf)}});
     }
     if(outcome?.unreleased)return respond(409,'Invitation not ready','Access eligibility or delivery readiness could not be confirmed. No invitation code was released. Reload the member list to check the current invitation status.');
     // DB-time expiry is checked atomically at mutation. Do not report 403 after a committed write.
     return new Response(null,{status:303,headers:{...headers,Location:mountPath==='/app'?'/app/manage':'/manage'}});
    }
    if(!['GET','HEAD'].includes(request.method))return respond(405,'Unavailable','This method is unavailable.');
    const csrf=enabled&&request.method==='GET'
     ?await prepareOwnerAction(env.DB,request,member.id,identity.expiresAt,()=>Math.floor(now()/1000)):null;
    const html=await ownerMembersView(env.DB,mountPath,csrf,env.PORTAL_INVITATIONS==='enabled-12-2');
    if(Math.floor(now()/1000)>=identity.expiresAt)throw Error('expired');
    const privateHeaders=csrf?{...headers,
     'Content-Security-Policy':headers['Content-Security-Policy'].replace("form-action 'none'","form-action 'self'"),
     'Set-Cookie':ownerActionSetCookie(csrf)}:headers;
    return new Response(request.method==='HEAD'?null:html,{status:200,headers:privateHeaders});
   }
   if (!['GET','HEAD'].includes(request.method)) return respond(405,'Unavailable','This method is unavailable.');
   if (path==='/') {
    stage='dashboard-render';
    return new Response(request.method==='HEAD'?null:dashboard(member,mountPath),{status:200,headers});
   }
   if(path==='/ui-preview') {
    if(!mayManageMembers(member)) throw Error('denied');
    return new Response(request.method==='HEAD'?null:studioPreview(mountPath),{status:200,headers});
   }
   if (path==='/api/owner' && !mayManageMembers(member)) throw Error('denied');
   // Own and legacy service paths are guarded even though no service is wired.
   const service=/^\/(?:api\/)?services\/([^/]+)(?:\/|$)/.exec(path)?.[1];
   if (service && (!SERVICES.includes(service) || !authorizeMember(member,service))) throw Error('denied');
   return respond(404,'Unavailable','This resource is not connected.');
  } catch {
   // Server-internal callback is supplied only during an existing Owner-only
   // identity check. No error message, user identifier, cookie or JWT is emitted.
   try { if(typeof env?.__bssOwnerRouteProbe==='function') env.__bssOwnerRouteProbe(stage); } catch { /* Fail closed. */ }
   return respond(403,'Access unavailable','Access could not be verified.');
  }
 }};
}
// Deployment remains safe-off in members-portal-staging/worker.mjs.
export default createMemberDashboard();
