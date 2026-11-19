// Task #12 production-only candidate. Never use the staging Worker domain.
// Source-only until separate production Access app, Members D1, review and release.
// Do not expose a workers.dev address or preview route for this Worker.
import {createAuthenticator} from '../portal/access.mjs';
import {createMemberDashboard} from '../portal/member-dashboard.mjs';

const HOST='members.bigsoxstudios.com';
const ORIGIN='https://'+HOST;
const ISSUER='https://old-hill-995d.cloudflareaccess.com';
const OWNER_AUDIENCE='e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0';
const REQUESTS_D1='21e13fa1-0ab3-4573-8d20-983c847ba0e9';
const STAGING_D1='43a8a15b-e195-4712-9198-1dcc9f0152af';
const STAGING_AUDIENCE='f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const D1=value=>value&&typeof value.prepare==='function'&&typeof value.batch==='function';
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

export function productionBindingsReady(env) {
 if(!env || env.APP_ORIGIN!==ORIGIN || env.ACCESS_ISSUER!==ISSUER ||
    env.OWNER_ACCESS_AUDIENCE!==OWNER_AUDIENCE ||
    typeof env.ACCESS_AUDIENCE!=='string' || !/^[0-9a-f]{64}$/.test(env.ACCESS_AUDIENCE) ||
    env.ACCESS_AUDIENCE===OWNER_AUDIENCE || env.ACCESS_AUDIENCE===STAGING_AUDIENCE ||
    env.APPROVED_REQUESTS_ID!==REQUESTS_D1 ||
    !UUID.test(env.APPROVED_MEMBER_DB_ID) ||
    env.APPROVED_MEMBER_DB_ID===STAGING_D1 ||
    env.APPROVED_MEMBER_DB_ID===REQUESTS_D1 ||
    env.BOOTSTRAP_DATABASE_ID!==env.APPROVED_MEMBER_DB_ID ||
    !Array.isArray(env.OTP_CUSTOM_HOSTS) || env.OTP_CUSTOM_HOSTS.length!==1 ||
    env.OTP_CUSTOM_HOSTS[0]!==HOST ||
    env.PORTAL_PRODUCTION_MODE!=='reviewed-production-12' ||
    env.PORTAL_APPROVED_OTP_ASSEMBLY!=='reviewed-production-12' ||
    env.PORTAL_APPROVED_MEMBERS!=='enabled-12-approved' ||
    env.PORTAL_SIMPLIFIED_MEMBER_UI!=='enabled-12' ||
    !D1(env.DB) || !D1(env.APPROVED_REQUESTS_DB) ||
    env.DB===env.APPROVED_REQUESTS_DB) return false;
 return true;
}

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
