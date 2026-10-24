import {validateConfig} from './access.mjs';
import {createOwnerProof} from './owner-proof.mjs';
import {createRepository} from './repository.mjs';
import {mayManageMembers} from './authorization.mjs';

const headers={
 'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store, max-age=0',
 'Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox",
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'X-Robots-Tag':'noindex, nofollow, noarchive'
};
// No default export, Wrangler config, route, environment activation switch or
// production mode. Existing portal Worker remains entirely disconnected.
export function createOwnerPreview(options={}) {
 const authenticate=createOwnerProof(options);
 return {async fetch(request,env) {
  const respond=(status,text)=>new Response(request.method==='HEAD'?null:
   `<!doctype html><html lang="en"><meta charset="utf-8"><title>Owner preview</title><h1>${text}</h1></html>`,{status,headers});
  try {
   validateConfig(env);
   const url=new URL(request.url);
   if(url.origin!==env.APP_ORIGIN || (request.headers.has('Host') && request.headers.get('Host')!==url.host) ||
    (request.headers.has('Origin') && request.headers.get('Origin')!==env.APP_ORIGIN)) return respond(403,'Access denied');
   if(options.mode!=='offline-test') return respond(503,'Owner preview unavailable');
   if(!['GET','HEAD'].includes(request.method) || url.pathname!=='/owner-preview' || url.search ||
    !env.DB || typeof env.OWNER_MEMBER_ID!=='string' || !env.OWNER_MEMBER_ID.length || env.OWNER_MEMBER_ID.length>128 ||
    request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') ||
    (request.headers.has('Sec-Fetch-Site') && !['same-origin','none'].includes(request.headers.get('Sec-Fetch-Site')))) return respond(403,'Access denied');
   const identity=await authenticate(request,env);
   const repo=createRepository(env.DB,{now:options.now?()=>Math.floor(options.now()/1000):undefined});
   const member=await repo.lookup(identity); // Live snapshot on every greeting.
   if(!mayManageMembers(member) || member.id!==env.OWNER_MEMBER_ID) return respond(403,'Access denied');
   return respond(200,'Welcome, Owner');
  } catch {return respond(403,'Access denied');}
 }};
}
