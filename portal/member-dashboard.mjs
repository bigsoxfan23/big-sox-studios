import {checkOtpHost,createOtpAuthenticator} from './otp-identity.mjs';
import {authorizeMember,mayManageMembers,SERVICES} from './authorization.mjs';

const headers={
 'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store',
 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'X-Robots-Tag':'noindex, nofollow, noarchive','Content-Type':'text/html; charset=utf-8'
};
const page=(title,body)=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Big Sox Studios</title><style>
:root{color-scheme:dark;font:100%/1.6 system-ui,sans-serif;background:#101820;color:#f6f4ee}body{margin:auto;max-width:46rem;padding:clamp(1rem,5vw,3rem)}header{border-bottom:3px solid #ffba70;margin-bottom:2rem}h1{line-height:1.2}section{background:#1c2a36;padding:1.5rem;border-radius:.75rem;margin:1.5rem 0}a{color:#ffd49f;display:inline-block;padding:.75rem 0}a:focus-visible{outline:3px solid #fff;outline-offset:4px}dt{font-weight:700}dd{margin:0 0 1rem}footer{color:#d1d9df}</style><header><p>BIG SOX STUDIOS</p><h1>${title}</h1></header><main>${body}</main></html>`;
const dashboard=member=>page('Member portal',`<section aria-labelledby="membership"><h2 id="membership">Your membership</h2><dl><dt>Role</dt><dd>${{owner:'Owner',trusted:'Trusted member',member:'Member'}[member.role]}</dd><dt>Status</dt><dd>Active</dd></dl></section><section aria-labelledby="services"><h2 id="services">Services coming soon</h2><p>Service access is not connected yet.</p></section><footer><a href="/cdn-cgi/access/logout">Sign out of Cloudflare Access</a><p>This ends your Access session across applications. It does not sign you out of your email provider. Close this tab after signing out if you use a shared device.</p></footer>`);

// verifyActivation is intentionally absent by default. A future reviewed server
// adapter must validate REAL effective independent MFA policy readback and ONE
// explicit audited owner approval. Browser/env booleans are not evidence.
async function activation(env,verifyActivation,at) {
 if (typeof verifyActivation!=='function') return false;
 const proof=await verifyActivation(Object.freeze({issuer:env.ACCESS_ISSUER,audience:env.ACCESS_AUDIENCE,origin:env.APP_ORIGIN}));
 return Boolean(proof && proof.issuer===env.ACCESS_ISSUER && proof.audience===env.ACCESS_AUDIENCE && proof.origin===env.APP_ORIGIN &&
  proof.source==='cloudflare-effective-policy-readback' && proof.independentMfaRequired===true &&
  proof.otpIdentityShapeVerified===true && typeof proof.policyDigest==='string' && /^[a-f0-9]{64}$/.test(proof.policyDigest) &&
  typeof proof.ownerApprovalAuditId==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(proof.ownerApprovalAuditId) && proof.ownerApprovalCount===1 &&
  Number.isSafeInteger(at) && Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt>=0 && proof.verifiedAt<=at &&
  Number.isSafeInteger(proof.expiresAt) && proof.expiresAt>at && proof.expiresAt<=proof.verifiedAt+300);
}

export function createMemberDashboard({verifyAccess,verifyActivation,now=()=>Date.now()}={}) {
 const authenticate=createOtpAuthenticator({verifyAccess,now});
 return {async fetch(request,env,ctx) {
  const respond=(status,title,body)=>new Response(request.method==='HEAD'?null:page(title,`<p>${body}</p>`),{status,headers});
  try {
   checkOtpHost(request,env);
   if (!await activation(env,verifyActivation,Math.floor(now()/1000))) return respond(503,'Portal unavailable','Activation is blocked.');
   const identity=await authenticate(request,env,ctx);
   // One live snapshot, every path/method. No login writes, no email fallback,
   // no owner shortcut and no cached membership, roles or service grants.
   const member=await env.DB.prepare(`SELECT m.id,m.role,m.status,
    COALESCE(json_group_array(g.service) FILTER(WHERE g.service IS NOT NULL),'[]') AS grants
    FROM identities i JOIN members m ON m.id=i.member_id LEFT JOIN service_grants g ON g.member_id=m.id
    WHERE i.provider=? AND i.subject=? GROUP BY m.id`).bind(identity.provider,identity.subject).first();
   if (!member || typeof member.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(member.id)) throw Error('denied');
   member.grants=JSON.parse(member.grants);
   if (!authorizeMember(member) || identity.expiresAt<=Math.floor(now()/1000)) throw Error('denied');
   if (!['GET','HEAD'].includes(request.method)) return respond(405,'Unavailable','This method is unavailable.');
   const url=new URL(request.url);
   if (url.search) return respond(400,'Unavailable','This address is unavailable.');
   if (url.pathname==='/') return new Response(request.method==='HEAD'?null:dashboard(member),{status:200,headers});
   if (url.pathname==='/api/owner' && !mayManageMembers(member)) throw Error('denied');
   // Own and legacy service paths are guarded even though no service is wired.
   const service=/^\/(?:api\/)?services\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1];
   if (service && (!SERVICES.includes(service) || !authorizeMember(member,service))) throw Error('denied');
   return respond(404,'Unavailable','This resource is not connected.');
  } catch { return respond(403,'Access unavailable','Access could not be verified.'); }
 }};
}
// No entrypoint imports this module. This export cannot activate with env flags.
export default createMemberDashboard();
