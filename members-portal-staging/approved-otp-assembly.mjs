// Source-only future staging composition; no deployment or Access approval.
// Source contribution: Codex CLI (OpenAI coding agent), 2026-11-01.
import {ACCESS_ISSUER,AUDIENCES,createStagingWorker} from './worker.mjs';
import {createAuthenticator} from '../portal/access.mjs';
import {createMemberDashboard} from '../portal/member-dashboard.mjs';

const host='members-staging.bigsoxstudios.com';
// Public resource identifiers from the reviewed source baseline, never credentials.
export const approvedOtpConfig=Object.freeze({
 APP_ORIGIN:`https://${host}`,
 ACCESS_ISSUER,
 ACCESS_AUDIENCE:AUDIENCES[host],
 OWNER_ACCESS_AUDIENCE:'e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0',
 PORTAL_APPROVED_OTP_ASSEMBLY:'reviewed-staging-12',
 PORTAL_APPROVED_MEMBERS:'enabled-12-approved',
 PORTAL_SIMPLIFIED_MEMBER_UI:'enabled-12',
 APPROVED_REQUESTS_ID:'48b0a0cc-40ad-4495-8883-a42b4a938b71',
 APPROVED_MEMBER_DB_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af',
 BOOTSTRAP_DATABASE_ID:'43a8a15b-e195-4712-9198-1dcc9f0152af',
});
const binding=value=>value!==null && typeof value==='object' &&
 typeof value.prepare==='function' && typeof value.batch==='function';
const headers={
 'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store',
 'X-Robots-Tag':'noindex, nofollow, noarchive','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
 'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'
};

export function createApprovedOtpAssembly({fetcher=fetch,now=()=>Date.now()}={}) {
 // No verifier override: the default path always verifies a signed Access JWT.
 // Tests may supply local JWKS transport and a clock, as in the existing assembly.
 const dashboard=createMemberDashboard({verifyAccess:createAuthenticator({fetcher,now}),now,mountPath:'/app'});
 return createStagingWorker({memberApp:{fetch(request,env,ctx){
  // Check runtime configuration, do not silently replace it with source pins.
  // This guard also wraps the existing Owner diagnostic's in-process /app probe.
  if(!env || !Object.entries(approvedOtpConfig).every(([key,value])=>env[key]===value) ||
   !Array.isArray(env.OTP_CUSTOM_HOSTS) || env.OTP_CUSTOM_HOSTS.length!==1 || env.OTP_CUSTOM_HOSTS[0]!==host ||
   !binding(env.DB) || !binding(env.APPROVED_REQUESTS_DB) || env.DB===env.APPROVED_REQUESTS_DB) {
   try { env?.__bssOwnerRouteProbe?.('assembly-guard'); } catch { /* Private diagnostic only. */ }
   return new Response(request.method==='HEAD'?null:'Members Portal setup unavailable',{status:503,headers});
  }
  // Existing OTP + runtime identity + current D1 approval/LIVE welcome checks
  // remain authoritative on every Member request. No invite fallback/projection.
  return dashboard.fetch(request,env,ctx);
 }}});
}
