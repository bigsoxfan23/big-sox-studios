import {checkOtpHost,createOtpAuthenticator} from './otp-identity.mjs';
import {authorizeMember,mayManageMembers,SERVICES} from './authorization.mjs';
import {studioPage,studioPreview} from './studio-ui.mjs';

const headers={
 'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store',
 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src https://bigsoxstudios.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'X-Robots-Tag':'noindex, nofollow, noarchive','Content-Type':'text/html; charset=utf-8'
};
// Failure responses stay intentionally tiny and avoid echoing private identifiers.
const page=(title,body)=>'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Big Sox Studios</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#101821;color:#f6eedf;margin:0;padding:3rem max(1rem,calc((100vw - 44rem)/2))}h1{font:600 2.6rem Georgia,serif;color:#f6eedf}main{border:1px solid #5c6470;border-radius:1rem;padding:1.5rem;background:#17212c}strong{color:#f2a33b}</style><main><strong>Big Sox Studios</strong><h1>'+title+'</h1>'+body+'</main></html>';
const dashboard=(member,mountPath)=>{
 const role={owner:'Owner',trusted:'Trusted member',member:'Member'}[member.role];
 const owner=mayManageMembers(member);
 const services=member.grants.filter(x=>SERVICES.includes(x));
 const serviceCopy=services.length?'Your granted services will be shown here once connected.':'Your studio services will appear here once connected and approved.';
 const ownerPanel=owner?'<section class="panel wide"><div class="eyeline"><h2>Owner workspace</h2><span class="status preview">Coming next</span></div><p class="muted">Member invitations, permission controls and revocation are the next features.</p><a class="button" href="'+(mountPath==='/app'?'/app/ui-preview':'/ui-preview')+'">Preview the studio designs</a></section>':'';
 return studioPage('Your studio, your space',
 '<p class="lede">Welcome back to Big Sox Studios. Your access is checked securely on every visit.</p><div class="grid">'+
 '<section class="panel"><div class="eyeline"><h2>Your membership</h2><span class="status">Active</span></div><dl><div><dt>Role</dt><dd>'+role+'</dd></div><div><dt>Status</dt><dd>Active</dd></div></dl></section>'+
 '<section class="panel"><div class="eyeline"><h2>Services coming soon</h2><span class="status preview">Not connected</span></div><p class="muted">'+serviceCopy+'</p><p class="fine muted">Signing in does not automatically grant access to services.</p></section>'+
 ownerPanel+'</div><p><a class="button secondary" href="/cdn-cgi/access/logout">Sign out of Cloudflare Access</a></p><p class="fine muted">Signing out ends your Access session across applications, but not your email provider session.</p>','Member portal');
};

export function createMemberDashboard({verifyAccess,now=()=>Date.now(),mountPath='/'}={}) {
 if (!['/','/app'].includes(mountPath)) throw Error('invalid mount');
 const authenticate=createOtpAuthenticator({verifyAccess,now});
 return {async fetch(request,env,ctx) {
  const respond=(status,title,body)=>new Response(request.method==='HEAD'?null:page(title,`<p>${body}</p>`),{status,headers});
  try {
   checkOtpHost(request,env);
   const identity=await authenticate(request,env,ctx);
   // One live snapshot, every path/method. No login writes, no email fallback,
   // no owner shortcut and no cached membership, roles or service grants.
   const member=await env.DB.prepare(`SELECT m.id,m.role,m.status,
    COALESCE(json_group_array(g.service) FILTER(WHERE g.service IS NOT NULL),'[]') AS grants
    FROM identities i JOIN members m ON m.id=i.member_id LEFT JOIN service_grants g ON g.member_id=m.id
    WHERE i.provider=? AND i.subject=? GROUP BY m.id`).bind(identity.provider,identity.subject).first();
   if (!member || typeof member.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(member.id)) throw Error('denied');
   member.grants=JSON.parse(member.grants);
   // The signed session must still be current after the live D1 read.
   const at=Math.floor(now()/1000);
   if (!authorizeMember(member) || !Number.isSafeInteger(at) || at<0 ||
    identity.expiresAt<=at) throw Error('denied');
   if (!['GET','HEAD'].includes(request.method)) return respond(405,'Unavailable','This method is unavailable.');
   const url=new URL(request.url);
   if (url.search) return respond(400,'Unavailable','This address is unavailable.');
   const path=mountPath==='/'?url.pathname:(url.pathname==='/app'?'/':url.pathname.startsWith('/app/')?url.pathname.slice(4):null);
   if (path===null) throw Error('denied');
   if (path==='/') return new Response(request.method==='HEAD'?null:dashboard(member,mountPath),{status:200,headers});
   if(path==='/ui-preview') {
    if(!mayManageMembers(member)) throw Error('denied');
    return new Response(request.method==='HEAD'?null:studioPreview(mountPath),{status:200,headers});
   }
   if (path==='/api/owner' && !mayManageMembers(member)) throw Error('denied');
   // Own and legacy service paths are guarded even though no service is wired.
   const service=/^\/(?:api\/)?services\/([^/]+)(?:\/|$)/.exec(path)?.[1];
   if (service && (!SERVICES.includes(service) || !authorizeMember(member,service))) throw Error('denied');
   return respond(404,'Unavailable','This resource is not connected.');
  } catch { return respond(403,'Access unavailable','Access could not be verified.'); }
 }};
}
// Deployment remains safe-off in members-portal-staging/worker.mjs.
export default createMemberDashboard();
