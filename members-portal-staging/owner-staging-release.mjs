import {createStagingOwnerEnrollment} from './owner-enrollment-assembly.mjs';
import {createStagingDashboard} from './dashboard-assembly.mjs';
import {createStagingWorker} from './worker.mjs';
import {unb64} from '../portal/access.mjs';

// Existing dedicated Phase 2 D1. Review the Wrangler binding before deployment.
// This is not the Task #11 membership-request database.
export const phase2DatabaseId='43a8a15b-e195-4712-9198-1dcc9f0152af';
export const ownerSourceRevision='task12-cloudflare-mfa-20261026-v1';
const noStore={'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'};

export function createOwnerStagingRelease({fetcher=fetch,now=()=>Date.now()}={}) {
 // One verifier per isolate reuses public Access signing keys for their short
 // validated cache TTL; every request still re-verifies JWT and reads live D1.
 const dashboard=createStagingDashboard({fetcher,now});
 const blank=createStagingWorker({memberApp:dashboard});
 return {async fetch(request,env,ctx) {
  const url=new URL(request.url);
  if (url.pathname!=='/owner/enroll' && url.pathname!=='/app' && !url.pathname.startsWith('/app/'))
   return blank.fetch(request,env,ctx);
  // Once enrollment is accepted, the confirmation key can be retired without
  // disabling existing, D1-authorized member logins. There is no JIT here.
  if (url.pathname==='/app' || url.pathname.startsWith('/app/')) {
   if (!env?.DB || env.BOOTSTRAP_DATABASE_ID!==phase2DatabaseId)
    return new Response('Members Portal setup unavailable',{status:503,headers:noStore});
   return dashboard.fetch(request,env,ctx);
  }
  try {
   // All values originate in reviewed server configuration, never query/form
   // input. Missing credentials or wrong target do not partially enable writes.
   if(!env?.DB || env.PORTAL_MODE!=='staging-enrollment-source' ||
      env.BOOTSTRAP_DATABASE_ID!==phase2DatabaseId ||
      typeof env.DIAGNOSTIC_OWNER_EMAIL!=='string' ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.DIAGNOSTIC_OWNER_EMAIL) ||
      typeof env.OWNER_ENROLLMENT_HMAC_KEY!=='string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(env.OWNER_ENROLLMENT_HMAC_KEY) ||
      typeof env.OWNER_ENROLLMENT_NONCE!=='string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(env.OWNER_ENROLLMENT_NONCE))
    throw Error('not provisioned');
   const keyBytes=unb64(env.OWNER_ENROLLMENT_HMAC_KEY);
   if(keyBytes.byteLength!==32) throw Error('invalid key');
   const confirmationKey=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
   const target=Object.freeze({role:'owner',recipient:env.DIAGNOSTIC_OWNER_EMAIL,
    databaseId:phase2DatabaseId,revision:ownerSourceRevision,nonce:env.OWNER_ENROLLMENT_NONCE});
   const app=createStagingOwnerEnrollment({target,confirmationKey,fetcher,now});
   return app.fetch(request,env,ctx);
  } catch {return new Response('Members Portal setup unavailable',{status:503,headers:noStore});}
 }};
}

export default createOwnerStagingRelease();
