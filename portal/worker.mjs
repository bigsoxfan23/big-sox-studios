import {createAuthenticator,validateConfig} from './access.mjs';
import {createIdentityAuthenticator} from './identity.mjs';
import {createRepository} from './repository.mjs';
import {authorizeMember,mayManageMembers,SERVICES} from './authorization.mjs';
const headers={
 'Cache-Control':'private, no-store, max-age=0','Content-Type':'application/json',
 'Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'X-Robots-Tag':'noindex, nofollow, noarchive'
};
// Development test harness only. Default export has NO provider resolver and is
// deliberately inert even if someone fills in bindings/variables accidentally.
export function createWorker(options={}) {
 const authenticate=createIdentityAuthenticator({authenticate:createAuthenticator(options),resolveVerifiedIdentity:options.resolveVerifiedIdentity});
 return {async fetch(request,env) {
  const respond=(status,value)=>new Response(request.method==='HEAD'?null:JSON.stringify(value),{status,headers});
  try {
   validateConfig(env);
   const url=new URL(request.url);
   if (url.origin!==env.APP_ORIGIN || (request.headers.has('Host') && request.headers.get('Host')!==url.host) ||
    (request.headers.has('Origin') && request.headers.get('Origin')!==env.APP_ORIGIN)) return respond(403,{error:'denied'});
   if (env.PORTAL_MODE!=='offline-test' || !env.DB || !env.INVITE_SERVICE || !options.resolveVerifiedIdentity) return respond(503,{error:'activation blocked'});
   const identity=await authenticate(request,env);
   const repo=createRepository(env.DB,{now:options.now?()=>Math.floor(options.now()/1000):undefined});
   const member=await repo.lookup(identity);
   if (!authorizeMember(member)) return respond(403,{error:'denied'});
   // Live D1 read happens above for every path, method and direct service URL.
   if (!['GET','HEAD'].includes(request.method)) return respond(405,{error:'method disabled'});
   if (url.search) return respond(400,{error:'query disabled'});
   if (url.pathname==='/') return respond(200,{role:member.role,services:member.grants.filter(x=>SERVICES.includes(x))});
   if (url.pathname==='/api/owner') return respond(mayManageMembers(member)?200:403,{allowed:mayManageMembers(member)});
   const service=/^\/api\/services\/([a-z]+)$/.exec(url.pathname)?.[1];
   if (service) return respond(authorizeMember(member,service)?200:403,{allowed:authorizeMember(member,service),connected:false});
   return respond(404,{error:'not found'});
  } catch { return respond(403,{error:'denied'}); }
 }};
}
export default createWorker();
