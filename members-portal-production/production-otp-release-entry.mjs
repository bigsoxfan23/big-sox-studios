// Task #12 production-only candidate. Never use the staging Worker domain.
// Source-only until separate production Access app, Members D1, review and release.
// Do not expose a workers.dev address or preview route for this Worker.
import {createAuthenticator} from '../portal/access.mjs';
import {createMemberDashboard} from '../portal/member-dashboard.mjs';

import {productionBindingsReady,productionOwnerBoundary} from '../portal/production-boundary.mjs';
export {productionBindingsReady} from '../portal/production-boundary.mjs';
const ORIGIN=productionOwnerBoundary.origin;
const HOST=new URL(ORIGIN).hostname;
const headers=Object.freeze({
 'Cache-Control':'private, no-store, max-age=0',
 'CDN-Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff',
 'X-Robots-Tag':'noindex, nofollow, noarchive',
 'Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
 'X-Frame-Options':'DENY'
});
const response=(request,status,message)=>new Response(request.method==='HEAD'?null:message,{status,headers});

export function createProductionMemberWorker({fetcher=fetch,now=()=>Date.now()}={}) {
 const dashboard=createMemberDashboard({
   verifyAccess:createAuthenticator({fetcher,now}),
   now,
   mountPath:'/app'
 });
 return {async fetch(request,env,ctx) {
  const url=new URL(request.url);
  // Both the destination and the forwarded Host must match exactly.
  if(url.origin!==ORIGIN || url.hostname!==HOST || url.host!==HOST ||
    (request.headers.has('Host') && request.headers.get('Host')!==HOST))
   return response(request,404,'Not found');
  if(url.pathname!=='/' && url.pathname!=='/app' && !url.pathname.startsWith('/app/'))
   return response(request,404,'Not found');
  // This release gate is OFF by default. Missing or staging values cannot
  // accidentally activate a production Member or grant service access.
  if(!productionBindingsReady(env))
   return response(request,503,'Members Portal setup unavailable');
  if(url.pathname==='/') {
   if(!['GET','HEAD'].includes(request.method)) return response(request,405,'Method not allowed');
   return new Response(null,{status:303,headers:{...headers,Location:'/app'}});
  }
  return dashboard.fetch(request,env,ctx);
 }};
}
export default createProductionMemberWorker();
