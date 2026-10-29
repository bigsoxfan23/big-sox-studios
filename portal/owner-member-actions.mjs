// Task 12.1: staging-only Owner actions. No sends, claims, grants or account activation.
// Requires explicit feature flag and the reviewed Phase 2 D1 nonce migration.
import {createRepository} from './repository.mjs';

export const ownerActionCookie='__Host-bss-owner-action';
const encoder=new TextEncoder();
const validToken=/^[A-Za-z0-9_-]{43}$/;
const validId=/^[A-Za-z0-9_-]{1,128}$/;
const allowedKeys=new Set(['csrf','action','member','contact']);
const requireThat=ok=>{if(!ok)throw Error('owner action denied');};
const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
const hash=async value=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const randomToken=()=>{
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
};
const clock=()=>Math.floor(Date.now()/1000);
function sessionToken(request) {
 const token=request.headers.get('Cf-Access-Jwt-Assertion');
 requireThat(typeof token==='string' && token.length>80 && token.length<16384 && token.split('.').length===3);
 return token; // already verified by the caller's mandatory signed OTP authenticator
}
export function ownerActionSetCookie(token) {
 requireThat(validToken.test(token));
 return `${ownerActionCookie}=${token}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`;
}
export async function prepareOwnerAction(db,request,ownerId,expiresAt,now=clock) {
 requireThat(validId.test(ownerId));
 const at=now(),until=Math.min(at+600,expiresAt);
 requireThat(Number.isSafeInteger(at)&&Number.isSafeInteger(until)&&until>at);
 const csrf=randomToken();
 const digest=await hash(csrf),sessionDigest=await hash(sessionToken(request));
 await db.prepare(`INSERT INTO owner_action_nonces(digest,actor_id,session_digest,issued_at,expires_at)
 VALUES(?,?,?,?,?)`).bind(digest,ownerId,sessionDigest,at,until).run();
 return csrf;
}
async function getForm(request) {
 requireThat(request.method==='POST' && request.headers.get('Content-Type')==='application/x-www-form-urlencoded');
 const origin=new URL(request.url).origin;
 requireThat(request.headers.get('Origin')===origin);
 const site=request.headers.get('Sec-Fetch-Site');
 requireThat(!site || site==='same-origin');
 const reader=request.body?.getReader();requireThat(reader);
 let bytes=0;const chunks=[];
 try {
  for(;;) {
   const {done,value}=await reader.read();if(done)break;
   bytes+=value.length;requireThat(bytes<=4096);chunks.push(value);
  }
 }finally{await reader.cancel().catch(()=>{});}
 const raw=new Uint8Array(bytes);let offset=0;
 for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
 const form=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 requireThat([...form.keys()].every(k=>allowedKeys.has(k)&&form.getAll(k).length===1));
 const action=form.get('action'),contact=form.get('contact'),member=form.get('member');
 requireThat(['create','issue','reissue','cancel'].includes(action) && form.has('csrf'));
 if(action==='create')requireThat(contact!==null && contact.length<=254 && member===null);
 else requireThat(contact===null && typeof member==='string' && validId.test(member));
 return form;
}
function tokenCookie(request) {
 const matches=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(ownerActionCookie+'='));
 requireThat(matches.length===1);
 const value=matches[0].slice(ownerActionCookie.length+1);
 requireThat(validToken.test(value));
 return value;
}
// Consume the nonce on the shared D1 BEFORE action. Even concurrent duplicate
// submissions can enter at most one action. A failed action needs a fresh form.
export async function executeOwnerAction(db,request,ownerId,now=clock) {
 requireThat(validId.test(ownerId));
 const form=await getForm(request),csrf=form.get('csrf'),cookie=tokenCookie(request);
 requireThat(validToken.test(csrf) && csrf===cookie);
 const at=now();requireThat(Number.isSafeInteger(at) && at>=0);
 const digest=await hash(csrf),sessionDigest=await hash(sessionToken(request));
 const claimed=await db.prepare(`UPDATE owner_action_nonces SET used_at=? WHERE digest=? AND actor_id=?
 AND session_digest=? AND used_at IS NULL AND expires_at>? RETURNING digest`)
  .bind(at,digest,ownerId,sessionDigest,at).first();
 requireThat(claimed?.digest===digest);
 // Recheck D1 in the repository, never infer role from request fields.
 const repo=createRepository(db,{now});
 const action=form.get('action'),member=form.get('member');
 if(action==='create') await repo.createPending(ownerId,form.get('contact'));
 else if(action==='issue'){
  const prev=await db.prepare('SELECT id FROM invitations WHERE member_id=? LIMIT 1').bind(member).first();
  requireThat(!prev); // Separate action for reissue
  await repo.issue(ownerId,member); // blocked draft; secret intentionally discarded
 }else if(action==='reissue'){
  const prev=await db.prepare('SELECT id FROM invitations WHERE member_id=? LIMIT 1').bind(member).first();
  requireThat(prev);
  await repo.issue(ownerId,member); // new blocked revision, old secret invalidated
 }else if(action==='cancel') await repo.cancelInvitation(ownerId,member);
 return action;
}
