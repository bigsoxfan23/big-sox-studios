// Owner route integration contract: authenticate the exact signed Owner first,
// pass its live D1 Owner id and verified expiry, pin the approved APP_ORIGIN, and
// return no-store HTML. This module neither mints identities nor calls Jellyfin.
import {ownerActionCookie,ownerActionSetCookie} from '../../portal/owner-member-actions.mjs';
const deny=()=>{throw Error('Member removal unavailable. Reload the Member record.');};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const validToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const encoder=new TextEncoder();
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
export const manualJellyfinReminder='Also disable this Jellyfin account and its sessions manually. Website removal does not revoke Jellyfin.';
function safeNow(now,expiresAt){const at=now();if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(expiresAt)||at>=expiresAt)deny();return at;}
function session(request,memberId) {
 const token=request.headers.get('Cf-Access-Jwt-Assertion');
 if(typeof token!=='string'||token.length<81||token.length>16383||token.split('.').length!==3)deny();
 return 'bss-remove-member-v1:'+JSON.stringify([memberId,token]);
}
async function eligible(db,ownerId,memberId) {
 if(!db?.prepare||!validId(ownerId)||!validId(memberId)||ownerId===memberId)deny();
 const row=await db.prepare(`SELECT m.id,m.recipient,m.status FROM members m WHERE m.id=? AND m.role='member' AND m.status IN ('active','pending')
  AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active')`).bind(memberId,ownerId).first();
 if(!row)deny();return row;
}
export async function prepareMemberRemoval(db,request,ownerId,memberId,expiresAt,{now=()=>Math.floor(Date.now()/1000)}={}) {
 const at=safeNow(now,expiresAt),row=await eligible(db,ownerId,memberId);safeNow(now,expiresAt);
 const token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 const digest=await hash(token),bound=await hash(session(request,memberId)),until=Math.min(at+600,expiresAt);
 await db.prepare(`INSERT INTO owner_action_nonces(digest,actor_id,session_digest,issued_at,expires_at)
  SELECT ?,?,?,?,? WHERE unixepoch('now')<? AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active') RETURNING digest`)
  .bind(digest,ownerId,bound,at,until,expiresAt,ownerId).first().then(r=>{if(r?.digest!==digest)deny();});
 return Object.freeze({memberId:row.id,email:row.recipient,csrf:token,cookie:ownerActionSetCookie(token),reminder:manualJellyfinReminder});
}
async function formData(request,appOrigin) {
 let url,origin;try{url=new URL(request.url);origin=new URL(appOrigin);}catch{deny();}
 if(origin.protocol!=='https:'||origin.origin!==appOrigin||url.origin!==appOrigin||url.search||request.method!=='POST'||request.headers.get('Origin')!==appOrigin
  ||(request.headers.has('Host')&&request.headers.get('Host')!==url.host)
  ||request.headers.get('Content-Type')?.split(';')[0]!=='application/x-www-form-urlencoded'
  ||(request.headers.get('Sec-Fetch-Site')&&request.headers.get('Sec-Fetch-Site')!=='same-origin'))deny();
 const reader=request.body?.getReader();if(!reader)deny();const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048)deny();chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let form;try{form=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{deny();}
 const keys=['csrf','member','confirm'];if([...form.keys()].length!==keys.length||!keys.every(k=>form.getAll(k).length===1)||form.get('confirm')!=='yes')deny();
 return form;
}
export async function executeMemberRemoval(db,request,ownerId,expiresAt,{appOrigin,expectedMemberId,now=()=>Math.floor(Date.now()/1000)}={}) {
 // No client-supplied actor, origin, session deadline or recipient is trusted.
 const form=await formData(request,appOrigin),memberId=form.get('member'),token=form.get('csrf');
 if(expectedMemberId!==undefined&&memberId!==expectedMemberId)deny();
 if(!validToken(token))deny();await eligible(db,ownerId,memberId);
 const matches=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(ownerActionCookie+'='));
 if(matches.length!==1||matches[0].slice(ownerActionCookie.length+1)!==token)deny();
 const at=safeNow(now,expiresAt),digest=await hash(token),bound=await hash(session(request,memberId));
 const claimed=await db.prepare(`UPDATE owner_action_nonces SET used_at=? WHERE digest=? AND actor_id=? AND session_digest=?
  AND used_at IS NULL AND expires_at>? AND unixepoch('now')<expires_at AND unixepoch('now')<? RETURNING digest`)
  .bind(at,digest,ownerId,bound,at,expiresAt).first();
 if(claimed?.digest!==digest)deny();safeNow(now,expiresAt);
 // Existing revocation triggers atomically revoke website status, cancel live
 // invitations, remove grants, preserve audits and create manual offboarding tasks.
 const id=crypto.randomUUID();
 const revoked=await db.prepare(`INSERT INTO revocations(id,member_id,actor_id,at)
  SELECT ?,m.id,?,? FROM members m WHERE m.id=? AND m.role='member' AND m.status IN ('pending','active') AND m.id<>?
  AND EXISTS(SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active') AND unixepoch('now')<? RETURNING id`)
  .bind(id,ownerId,at,memberId,ownerId,ownerId,expiresAt).first();
 if(revoked?.id!==id)deny();return Object.freeze({memberId,status:'revoked',reminder:manualJellyfinReminder});
}
