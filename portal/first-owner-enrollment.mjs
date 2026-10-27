import {createFirstOwnerBootstrap} from './first-owner-bootstrap.mjs';
import {b64,unb64} from './access.mjs';

export const enrollmentPath='/owner/enroll';
const cookieName='__Host-first-owner-confirm';
const encoder=new TextEncoder();
const need=value=>{if(!value) throw Error('enrollment denied');};
const headers={
 'Cache-Control':'private, no-store, max-age=0',
 'Content-Type':'text/html; charset=utf-8',
 'Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'X-Robots-Tag':'noindex, nofollow, noarchive, nosnippet',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Strict-Transport-Security':'max-age=31536000; includeSubDomains'
};
const cookie=(value,maxAge)=>`${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
const page=(body,status=200,setCookie)=>new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>First Owner enrollment</title><main><h1>First Owner enrollment</h1>${body}</main></html>`,
 {status,headers:{...headers,...(setCookie?{'Set-Cookie':setCookie}:{})}});
const hash=async value=>b64(await crypto.subtle.digest('SHA-256',encoder.encode(value)));

// All dependencies are trusted server source injections, never browser/env proof.
// The key must be a reviewed shared HMAC SHA-256 CryptoKey, separate from Access.
// No default key or approved recipient is provided.
export function createFirstOwnerEnrollment({confirmationKey,...options}={}) {
 const enabled=confirmationKey?.type==='secret' && confirmationKey.algorithm?.name==='HMAC' &&
  confirmationKey.algorithm?.hash?.name==='SHA-256' && confirmationKey.algorithm?.length>=256 &&
  confirmationKey.usages.includes('sign') && confirmationKey.usages.includes('verify');
 const bootstrap=createFirstOwnerBootstrap({...options,mode:'staging-enrollment-source'});
 const now=options.now??(()=>Date.now());
 const seconds=()=>{const at=Math.floor(now()/1000);need(Number.isSafeInteger(at)&&at>=0);return at;};
 const sign=async payload=>{
  const data=b64(encoder.encode(JSON.stringify(payload)));
  return `${data}.${b64(await crypto.subtle.sign('HMAC',confirmationKey,encoder.encode(data)))}`;
 };
 return {async fetch(request,env,ctx) {
  if(!enabled || env?.PORTAL_MODE!=='staging-enrollment-source') return page('<p>Not found</p>',404);
  let committing=false;
  let stage='route';
  try {
   const url=new URL(request.url);
   need(url.pathname===enrollmentPath && !url.search && !url.hash);
   need(request.method==='GET' || request.method==='POST');
   // Reuse the exact signed OTP, approved target and fresh-session checks.
   const internal=new Request(new URL('/',url),{method:'POST',headers:request.headers});
   if(request.method==='GET') {
    // GET is read-only. Access sign-in redirects and external Safari links can
    // legitimately arrive as cross-site top-level navigations. Only the
    // account-creating POST below must be same-origin and user initiated.
    const at=seconds();
    const plan=await bootstrap(internal,env,ctx);
    const secret=b64(crypto.getRandomValues(new Uint8Array(32)));
    const ticket=await sign({context:plan.confirmationDigest,cookie:await hash(secret),at,exp:at+300});
    need(seconds()<at+300);
    return page(`<p>The approved signed-in OTP identity will become the first active Owner. This action can succeed only once.</p><p>Continue only if you intend to accept the Owner role. Cloudflare Access manages MFA. Clicking confirm approves this Owner enrollment.</p><form method="post" action="${enrollmentPath}"><input type="hidden" name="ticket" value="${ticket}"><button type="submit" name="decision" value="confirm-first-owner">Confirm first Owner enrollment</button></form>`,200,cookie(secret,300));
   }
   // A top-level, user-initiated browser form POST, never GET or an API fetch.
   // Origin may be omitted by intermediaries on legitimate same-site POSTs.
   // Reject a foreign or literal null Origin when supplied. A valid HMAC ticket,
   // same-site secure cookie and signed Access OTP session remain mandatory.
   stage='browser-origin';
   const origin=request.headers.get('Origin');
   need(origin===null || origin===env.APP_ORIGIN);
   stage='browser-site';
   need(request.headers.get('Sec-Fetch-Site')!=='cross-site');
   stage='browser-content-type';
   need((request.headers.get('Content-Type')??'').split(';')[0].trim().toLowerCase()==='application/x-www-form-urlencoded');
   // Bound streaming reads as well as Content-Length; never buffer an unlimited body.
   stage='form-body';
   const reader=request.body?.getReader();need(reader);
   let body='';let size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
   try {while(true) {const {done,value}=await reader.read();if(done) break;size+=value.length;need(size<=2048);body+=decoder.decode(value,{stream:true});}body+=decoder.decode();}
   finally {await reader.cancel().catch(()=>{});}
   const form=new URLSearchParams(body);
   need([...form.keys()].length===2 && form.getAll('ticket').length===1 && form.getAll('decision').length===1 && form.get('decision')==='confirm-first-owner');
   stage='signed-ticket';
   const ticket=form.get('ticket');need(ticket && ticket.length<1600);
   const parts=ticket.split('.');need(parts.length===2);
   need(await crypto.subtle.verify('HMAC',confirmationKey,unb64(parts[1]),encoder.encode(parts[0])));
   const proof=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unb64(parts[0])));
   const at=seconds();
   need(Number.isSafeInteger(proof.at) && proof.at>=0 && proof.at<=at && proof.exp===proof.at+300 && proof.exp>at);
   stage='confirmation-cookie';
   const cookies=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(`${cookieName}=`));
   need(cookies.length===1);
   const secret=cookies[0].slice(cookieName.length+1);need(/^[A-Za-z0-9_-]{43}$/.test(secret));
   need(await hash(secret)===proof.cookie);
   stage='otp-identity';
   const plan=await bootstrap(internal,env,ctx);
   need(plan.confirmationDigest===proof.context && seconds()<proof.exp);
   stage='database-commit';
   committing=true;
   await bootstrap(internal,env,ctx,{commit:true,expectedConfirmationDigest:proof.context,confirmationExpiresAt:proof.exp,
    browserTicketDigest:[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(ticket)))].map(b=>b.toString(16).padStart(2,'0')).join('')});
   return page('<p>First Owner enrollment completed.</p>',200,cookie('',0));
  } catch {
   // Sanitized stage only; no email, token, cookie, request or exception.
   // Any commit error may be an ambiguous successful write. Never auto-retry.
   console.warn('Task12 owner enrollment rejected at stage:',stage);
   const message=committing?'<p>Enrollment outcome requires operator inspection. Do not retry.</p>':
    '<p>Enrollment unavailable. No confirmation accepted.</p><p>Check: '+stage+'</p>';
   return page(message,committing?503:403,cookie('',0));
  }
 }};
}

export default createFirstOwnerEnrollment();
