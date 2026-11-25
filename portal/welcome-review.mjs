// Source-only preparation, NOT a sender or a one-use dispatch authorization.
// Route must authenticate the Owner, protect POSTs, use no-store/no telemetry,
// and pass its server-owned onboarding API plus a session-bound value.
// A future sender MUST atomically claim a durable per-onboarding intent before
// transport. Never put these returned text fields in Mail Desk drafts or logs.
import {normalizeEmail} from './identity.mjs';
const fail=()=>{throw Error('Welcome preview unavailable. Reload member setup.');};
const validId=s=>typeof s==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const safeTime=t=>Number.isSafeInteger(t) && t>=0;
const encoder=new TextEncoder();
const bytes=s=>encoder.encode(s);
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const fields=['message','password'];
const forbidden=/[\p{Cc}\p{Cf}\p{Cs}]/u;
function https(value,originOnly=false) {
 let u;try{u=new URL(value);}catch{fail();}
 if(u.protocol!=='https:' || u.username || u.password || u.search || u.hash || (originOnly?u.origin!==value:u.href!==value))fail();
 return u;
}
export function createWelcomeReview({onboarding,actorId,sessionBinding,signingKey,expiresAt,jellyfinOrigin,memberLoginUrl,now=()=>Math.floor(Date.now()/1000)}={}) {
 if(typeof onboarding?.read!=='function' || !validId(actorId) || typeof sessionBinding!=='string' || sessionBinding.length<32 || sessionBinding.length>512
  || typeof signingKey!=='string' || bytes(signingKey).length<32 || !safeTime(expiresAt))fail();
 https(jellyfinOrigin,true);https(memberLoginUrl);
 // Domain separation lets the existing staging CSRF key be reused, without a
 // new credential. No password/body/hash is embedded in the confirmation token.
 const value=(row,requestId,requestRevision,mail,issued,until,nonce)=>JSON.stringify(['bss-welcome-review-v1',actorId,sessionBinding,requestId,requestRevision,
  row.source_database,row.member_id,row.revision,row.jellyfin_ready_at,mail,issued,until,nonce]);
 const key=()=>crypto.subtle.importKey('raw',bytes(signingKey),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 function time(){const t=now();if(!safeTime(t)||t>=expiresAt)fail();return t;}
 async function content(requestId,requestRevision,form) {
  if(!validId(requestId)||!Number.isSafeInteger(requestRevision)||requestRevision<1 || !form || Object.getPrototypeOf(form)!==Object.prototype
   || Object.keys(form).length!==fields.length || fields.some(k=>!Object.hasOwn(form,k)))fail();
  const {message,password}=form;
  if(typeof message!=='string'||!message.trim()||message.length>4000||forbidden.test(message.replace(/[\n\r\t]/g,''))
   || typeof password!=='string'||password.length<1||password.length>128||password!==password.trim()||forbidden.test(password))fail();
  time();const row=await onboarding.read(requestId,requestRevision);time();
  if(!row || !validId(row.source_database)||!validId(row.member_id)||!Number.isSafeInteger(row.revision)||row.revision<1
   || row.role!=='member'||row.status!=='pending'||!safeTime(row.jellyfin_ready_at)||row.jellyfin_ready_at===0
   || typeof row.jellyfin_username!=='string'||row.jellyfin_username.length<1||row.jellyfin_username.length>128||forbidden.test(row.jellyfin_username))fail();
  const u=https(row.jellyfin_url);if(u.origin!==jellyfinOrigin)fail();
  let recipient;try{recipient=normalizeEmail(row.recipient);}catch{fail();}
  const mail={recipient,subject:'Welcome to Big Sox Studios',text:[message,'','Your Big Sox Studios membership',
   'Sign in using the one-time code sent to your approved email.',
   `Member sign-in: ${memberLoginUrl}`,`Approved email: ${recipient}`,'','Jellyfin',`Website: ${u.href}`,
   `Username: ${row.jellyfin_username}`,`Temporary password: ${password}`,
   'Jellyfin uses a separate account from your Member sign-in. Change your temporary password after signing in when available.','','— Greg'].join('\n')};
  return {row,mail};
 }
 return Object.freeze({
  async preview(requestId,requestRevision,form) {
   const {row,mail}=await content(requestId,requestRevision,form),issued=time(),until=Math.min(issued+300,expiresAt),nonce=hex(crypto.getRandomValues(new Uint8Array(16)));
   const signature=hex(await crypto.subtle.sign('HMAC',await key(),bytes(value(row,requestId,requestRevision,mail,issued,until,nonce))));time();
   return {...mail,review:`${issued}.${until}.${nonce}.${signature}`,expiresAt:until};
  },
  async confirm(requestId,requestRevision,form,{review,confirmed}={}) {
   if(confirmed!==true || typeof review!=='string'||review.length>200)fail();
   const m=review.match(/^(\d{1,12})\.(\d{1,12})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);if(!m)fail();
   const [,start,end,nonce,signature]=m,issued=Number(start),until=Number(end),t=time();
   if(String(issued)!==start||String(until)!==end||issued>t||until<=t||until>expiresAt||until<=issued||until>issued+300)fail();
   const {row,mail}=await content(requestId,requestRevision,form);
   const ok=await crypto.subtle.verify('HMAC',await key(),Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)),bytes(value(row,requestId,requestRevision,mail,issued,until,nonce)));
   if(!ok||time()>=until)fail();
   // Transient only. Caller must still enforce durable deduplication, uncertainty
   // locks, provider policy and current authorization at its dispatch boundary.
   return Object.freeze({...mail,memberId:row.member_id,onboardingRevision:row.revision,reviewExpiresAt:until});
  }
 });
}
