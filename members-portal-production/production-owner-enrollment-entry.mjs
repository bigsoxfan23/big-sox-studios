// Source-only candidate. The existing production entrypoint has no enrollment
// route. Selecting this module alone cannot enable enrollment or the dashboard.
import {createProductionMemberWorker} from './production-otp-release-entry.mjs';
import {createFirstOwnerEnrollment,enrollmentPath} from '../portal/first-owner-enrollment.mjs';
import {createAuthenticator,unb64} from '../portal/access.mjs';
import {productionEnrollmentMode,productionEnrollmentReady,productionOwnerBoundary} from '../portal/production-boundary.mjs';

export const productionOwnerSourceRevision='task12-production-first-owner-20261124-v1';
const headers=Object.freeze({
 'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store',
 'X-Robots-Tag':'noindex, nofollow, noarchive','X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer',"Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'",
 'X-Frame-Options':'DENY'
});
const response=(request,status,message)=>new Response(request.method==='HEAD'?null:message,{status,headers});

export function createProductionOwnerEnrollment({fetcher=fetch,now=()=>Date.now()}={}) {
 const dashboard=createProductionMemberWorker({fetcher,now});
 const verifyAccess=createAuthenticator({fetcher,now});
 return {async fetch(request,bindings,ctx) {
  const url=new URL(request.url);
  if(url.pathname!==enrollmentPath) return dashboard.fetch(request,bindings,ctx);
  const host=new URL(productionOwnerBoundary.origin).host;
  if(url.origin!==productionOwnerBoundary.origin ||
    (request.headers.has('Host') && request.headers.get('Host')!==host))
   return response(request,404,'Not found');
  // Snapshot server configuration; nothing comes from URL, form or login claims.
  const env={...bindings};
  if(!productionEnrollmentReady(env)) return response(request,503,'Owner enrollment setup unavailable');
  try {
   if(typeof env.OWNER_ENROLLMENT_EMAIL!=='string' ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.OWNER_ENROLLMENT_EMAIL) ||
      typeof env.OWNER_ENROLLMENT_NONCE!=='string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(env.OWNER_ENROLLMENT_NONCE) ||
      typeof env.OWNER_ENROLLMENT_HMAC_KEY!=='string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(env.OWNER_ENROLLMENT_HMAC_KEY)) throw Error('unconfigured');
   const bytes=unb64(env.OWNER_ENROLLMENT_HMAC_KEY);
   if(bytes.byteLength!==32) throw Error('invalid key');
   const confirmationKey=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
   const target=Object.freeze({role:'owner',recipient:env.OWNER_ENROLLMENT_EMAIL,
    databaseId:productionOwnerBoundary.databaseId,revision:productionOwnerSourceRevision,nonce:env.OWNER_ENROLLMENT_NONCE});
   return await createFirstOwnerEnrollment({mode:productionEnrollmentMode,target,confirmationKey,verifyAccess,now}).fetch(request,env,ctx);
  } catch {return response(request,503,'Owner enrollment setup unavailable');}
 }};
}
export default createProductionOwnerEnrollment();
