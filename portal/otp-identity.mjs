import {createAuthenticator,validateConfig} from './access.mjs';
import {normalizeEmail} from './identity.mjs';

// This is an independent OTP namespace. It cannot mint the repository's generic
// identity brand or participate in invitation claims/links without further review.
export function checkOtpHost(request,env) {
 validateConfig(env);
 const url=new URL(request.url);
 const host=new URL(env.APP_ORIGIN).hostname;
 if (!Array.isArray(env.OTP_CUSTOM_HOSTS) || env.OTP_CUSTOM_HOSTS.length!==1 || env.OTP_CUSTOM_HOSTS[0]!==host ||
  /(?:^|\.)(?:workers\.dev|pages\.dev|cloudflareaccess\.com)$/.test(host) || new URL(env.APP_ORIGIN).port ||
  url.origin!==env.APP_ORIGIN || (request.headers.has('Host') && request.headers.get('Host')!==url.host) ||
  (request.headers.has('Origin') && request.headers.get('Origin')!==env.APP_ORIGIN)) throw Error('denied');
}

export function createOtpAuthenticator({verifyAccess=createAuthenticator(),now=()=>Date.now()}={}) {
 return async (request,env,ctx) => {
  checkOtpHost(request,env);
  // verifyAccess is a trusted server injection: it MUST verify signature, exact
  // issuer, exclusive intended audience and time. The default does all of these.
  const claims=await verifyAccess(request,env);
  const at=Math.floor(now()/1000);
  if (!Number.isSafeInteger(at) || at<0 || claims.iss!==env.ACCESS_ISSUER || !(claims.aud===env.ACCESS_AUDIENCE ||
   (Array.isArray(claims.aud) && claims.aud.length===1 && claims.aud[0]===env.ACCESS_AUDIENCE)) ||
   !Number.isSafeInteger(claims.exp) || claims.exp<=at || typeof claims.sub!=='string' ||
   !/^[A-Za-z0-9_-]{1,512}$/.test(claims.sub) || ctx?.access?.aud!==env.ACCESS_AUDIENCE ||
   typeof ctx.access.getIdentity!=='function') throw Error('denied');
  // Only runtime ctx.access is trusted. Never read forwarded email/identity headers.
  const identity=await ctx.access.getIdentity();
  if (identity?.idp?.type!=='onetimepin' || typeof claims.email!=='string' ||
   identity.email!==claims.email) throw Error('denied');
  normalizeEmail(claims.email); // syntax validation only; DO NOT normalize subject
  if (claims.exp<=Math.floor(now()/1000)) throw Error('denied');
  return Object.freeze({provider:'otp',subject:claims.email,expiresAt:claims.exp});
 };
}
