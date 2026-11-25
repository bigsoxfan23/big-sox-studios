import {requireOtpIdentity} from './otp-identity.mjs';
import {digestSecret,equalDigest} from './repository.mjs';
import {studioPage,escapeHtml} from './studio-ui.mjs';
const cookie='__Host-bss-invitation-claim';
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const idPattern=/^[A-Za-z0-9_-]{1,128}$/;
const need=x=>{if(!x)throw Error('invitation unavailable');};
const hash=async x=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const session=request=>{const s=request.headers.get('Cf-Access-Jwt-Assertion');need(typeof s==='string'&&s.length>80&&s.length<16384);return hash(s);};
// Literal script, hashed in CSP. Proof is pasted only after authentication,
// never transported in a URL. No storage, external scripts or network requests.
export const claimScript="(()=>{history.replaceState(null,'',location.pathname);document.getElementById('restore-link').addEventListener('click',()=>{const field=document.getElementById('original-link'),parts=field.value.trim().split('.');if(parts.length===2&&/^[A-Za-z0-9_-]{1,128}$/.test(parts[0])&&/^[A-Za-z0-9_-]{43}$/.test(parts[1])){document.getElementById('invitation-id').value=parts[0];document.getElementById('invitation-proof').value=parts[1];document.getElementById('claim-button').disabled=false;field.value='';document.getElementById('claim-help').textContent='Your invitation code is ready. Accept it using the approved email address.';}else{document.getElementById('claim-help').textContent='This invitation code is incomplete. Ask the Owner for a new code.';}});})();";
export async function scriptCsp(script) {return "'sha256-"+btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(script)))))+"'";}
const result=(title,copy,path)=>studioPage(title,'<section class="panel"><p>'+copy+'</p><a class="button" href="'+path+'/">Open your dashboard</a></section>','Studio invitation');
export async function handleInvitationClaim(request,env,identity,prefix,now) {
 const at=now();requireOtpIdentity(identity,at);
 const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','X-Robots-Tag':'noindex, nofollow, noarchive'};
 const respond=(status,html,extra={})=>new Response(html,{status,headers:{...headers,...extra}});
 const csp="default-src 'none'; style-src 'unsafe-inline'; img-src https://bigsoxstudios.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
 need(!new URL(request.url).search);
 if(request.method==='GET') {
  const csrf=random(),until=Math.min(at+600,identity.expiresAt);
  await env.DB.prepare('DELETE FROM invitation_claim_nonces WHERE expires_at<=?').bind(at).run();
  await env.DB.prepare('INSERT INTO invitation_claim_nonces(digest,session_digest,expires_at) VALUES(?,?,?)').bind(await hash(csrf),await session(request),until).run();
  const html=studioPage('Your studio invitation','<section class="panel"><p id="claim-help">You are signed in. Paste the separate private invitation code from the Owner below. Never put the code in the browser address. This activates membership only.</p><label>Private invitation code <input id="original-link" type="text" autocomplete="off" spellcheck="false"></label><button id="restore-link" type="button">Use invitation code</button><form method="post" action="'+prefix+'/invite"><input type="hidden" name="csrf" value="'+escapeHtml(csrf)+'"><input id="invitation-id" type="hidden" name="invitation"><input id="invitation-proof" type="hidden" name="proof"><button id="claim-button" disabled type="submit">Accept invitation</button></form><noscript>JavaScript is required to safely read this private invitation code.</noscript></section><script>'+claimScript+'</script>','Studio invitation');
  requireOtpIdentity(identity,now());
  return respond(200,html,{'Content-Security-Policy':csp+'; script-src '+await scriptCsp(claimScript),'Set-Cookie':`${cookie}=${csrf}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`});
 }
 need(request.method==='POST'&&request.headers.get('Origin')===env.APP_ORIGIN&&request.headers.get('Content-Type')==='application/x-www-form-urlencoded');
 need(!request.headers.get('Sec-Fetch-Site')||request.headers.get('Sec-Fetch-Site')==='same-origin');
 const reader=request.body?.getReader();need(reader);let size=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;need(size<=2048);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const x of chunks){bytes.set(x,offset);offset+=x.length;}
 const form=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 need([...form.keys()].every(k=>['csrf','invitation','proof'].includes(k)&&form.getAll(k).length===1)&&[...form.keys()].length===3);
 const csrf=form.get('csrf'),id=form.get('invitation'),proof=form.get('proof');
 need(tokenPattern.test(csrf)&&idPattern.test(id)&&tokenPattern.test(proof));
 const cookies=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookie+'='));
 need(cookies.length===1&&cookies[0]===cookie+'='+csrf);
 const consumedAt=now();requireOtpIdentity(identity,consumedAt);
 const nonce=await env.DB.prepare('UPDATE invitation_claim_nonces SET used_at=? WHERE digest=? AND session_digest=? AND used_at IS NULL AND expires_at>? AND expires_at>unixepoch(\'now\') AND unixepoch(\'now\')<? RETURNING digest').bind(consumedAt,await hash(csrf),await session(request),consumedAt,identity.expiresAt).first();need(nonce);
 requireOtpIdentity(identity,now());
 const invite=await env.DB.prepare('SELECT recipient,status,expires_at,digest FROM invitations WHERE id=?').bind(id).first();
 // The wrong recipient receives no private contact, status or expiration detail.
 if(!invite||invite.recipient!==identity.subject)return respond(403,result('Invitation unavailable','Sign in with the approved email address, or ask the Owner for a new link.',prefix),{'Content-Security-Policy':csp});
 const states={claimed:['Invitation already used','Your invitation has already been accepted.'],expired:['Invitation expired','Ask the Owner for a new invitation.'],revoked:['Invitation canceled','Ask the Owner for a new invitation.'],superseded:['Invitation replaced','Use the newest link from the Owner.']};
 if(invite.expires_at<=now()&&['blocked','projected','delivered'].includes(invite.status)) {
  await env.DB.prepare("UPDATE invitations SET status='expired',digest=NULL,changed_at=MAX(changed_at,?),actor_id='system-expiry' WHERE id=? AND expires_at<=? AND status IN ('blocked','projected','delivered')").bind(now(),id,now()).run();
 }
 const state=states[invite.status]||(invite.expires_at<=now()?states.expired:null);
 if(state)return respond(409,result(...state,prefix),{'Content-Security-Policy':csp});
 need(invite.status==='delivered'&&equalDigest(invite.digest,await digestSecret(proof)));
 const claimedAt=now();requireOtpIdentity(identity,claimedAt);
 const row=await env.DB.prepare(`UPDATE invitations SET status='claimed',digest=NULL,claim_provider='otp',claim_subject=?,claimed_at=?,changed_at=?,actor_id=member_id
 WHERE id=? AND digest=? AND recipient=? AND status='delivered' AND expires_at>? AND unixepoch('now')<expires_at AND unixepoch('now')<? RETURNING id`).bind(identity.subject,claimedAt,claimedAt,id,await digestSecret(proof),identity.subject,claimedAt,identity.expiresAt).first();need(row);
 return respond(200,result('Welcome aboard','Your membership is active. Studio services require separate Owner approval.',prefix),{'Content-Security-Policy':csp});
}
