import {createWelcomeReview} from '../../portal/welcome-review.mjs';
import {createWelcomeDelivery} from '../../portal/welcome-delivery.mjs';
import {onboardingApi,onboardingEnabled,render} from './onboarding-route.mjs';
import {escapeHTML as e,hmac,readBody,requireThat,sameSite} from '../../membership/common.mjs';
export const welcomeEnabled=env=>onboardingEnabled(env)&&env.PORTAL_WELCOME==='simulation-12';
// Existing Owner staging only; no credential or live sender binding is used.
export async function welcomeRoute(request,env,{now,respond,expiresAt,issue,check,css,cookie}) {
 const url=new URL(request.url),match=/^\/membership\/requests\/([a-f0-9-]{36})\/welcome$/.exec(url.pathname);
 if(!match)return null;if(!welcomeEnabled(env))return respond(404,'Not found');
 try{
  requireThat(!url.search,400);requireThat(['GET','HEAD','POST'].includes(request.method),405);
  const api=await onboardingApi(env,expiresAt,now),requestId=match[1];
  const source=await env.MEMBERSHIP_DB.prepare('SELECT revision FROM membership_requests WHERE id=?').bind(requestId).first();requireThat(source,409);
  const current=await api.read(requestId,source.revision);
  if(!current.jellyfin_ready_at)return render('Welcome email','<p>Complete manual Jellyfin setup before preparing a welcome. No email has been sent.</p>',request,respond,css);
  const owner=await env.PORTAL_DB.prepare("SELECT id FROM members WHERE role='owner' AND status='active'").first();requireThat(owner,403);
  const review=createWelcomeReview({onboarding:api,actorId:owner.id,sessionBinding:await hmac(env.MEMBERSHIP_CSRF_KEY,'welcome-session:'+request.headers.get('Cf-Access-Jwt-Assertion')),
   signingKey:env.MEMBERSHIP_CSRF_KEY,expiresAt,jellyfinOrigin:env.JELLYFIN_ORIGIN,memberLoginUrl:'https://members-staging.bigsoxstudios.com/app',now:()=>Math.floor(now()/1000)});
  const delivery=createWelcomeDelivery({memberDb:env.PORTAL_DB,onboarding:api,review,sourceDatabase:env.ONBOARDING_SOURCE_ID,actorId:owner.id,expiresAt,now:()=>Math.floor(now()/1000)});
  const token=await issue(request,env,now()),setCookie=`${cookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`;
  const hidden=`<input type="hidden" name="csrf" value="${e(token)}"><input type="hidden" name="request_revision" value="${source.revision}">`;
  let body='';
  if(request.method==='POST'){
   sameSite(request,env.APP_ORIGIN);requireThat(request.headers.get('Content-Type')?.split(';')[0]==='application/x-www-form-urlencoded',415);
   const f=new URLSearchParams(await readBody(request,24576)),action=f.get('action'),keys=action==='preview'?['csrf','request_revision','message','password','action']:action==='send'?['csrf','request_revision','message','password','action','review','confirm']:[];
   requireThat(keys.length&&[...f.keys()].length===keys.length&&keys.every(k=>f.getAll(k).length===1),400);
   await check(request,env,f.get('csrf'),now());requireThat(Number(f.get('request_revision'))===source.revision,409);
   const form={message:f.get('message'),password:f.get('password')};
   if(action==='send'){
    const result=await delivery.send(requestId,source.revision,form,{review:f.get('review'),confirmed:f.get('confirm')==='yes'});
    body=`<h2>${result.state==='accepted'?'Simulation recorded':'Simulation needs attention'}</h2><p>No email was sent. Website membership remains pending.</p><p>${result.state==='UNKNOWN'?'The outcome is uncertain. Do not repeat the action; review its recorded status.':result.state==='failed'?'The provider refused this attempt. A new preview and confirmation are required to try again.':'The test provider accepted this simulated message. This is not actual delivery.'}</p>`;
   }else{
    const p=await review.preview(requestId,source.revision,form);
    body=`<h2>Review your welcome</h2><p>To: ${e(p.recipient)}</p><p>Subject: ${e(p.subject)}</p><p>${e(p.text)}</p><p>This is a staging simulation. No external email will be sent. The password is transient and is not saved as a draft.</p><form method="post" autocomplete="off">${hidden}<input type="hidden" name="action" value="send"><input type="hidden" name="review" value="${e(p.review)}"><input type="hidden" name="message" value="${e(form.message)}"><input type="hidden" name="password" value="${e(form.password)}"><label><input type="checkbox" name="confirm" value="yes" required> I reviewed this exact recipient and message.</label><button>Simulate welcome delivery</button></form>`;
   }
  }else{
   const status=await delivery.status(requestId,source.revision),lock=status.find(x=>['dispatching','accepted','UNKNOWN'].includes(x.state)&&x.mode==='simulated');
   body=lock?`<h2>Welcome simulation: ${e(lock.state)}</h2><p>No email was sent. ${lock.state==='accepted'?'A simulation has already been recorded.':'The outcome needs reconciliation. Do not repeat the action.'}</p>`:
    `<p>To: ${e(current.recipient)}</p><p>Jellyfin: ${e(current.jellyfin_url)} · ${e(current.jellyfin_username)}</p><p>Staging simulation only. No email will be sent or membership activated.</p><form method="post" autocomplete="off">${hidden}<input type="hidden" name="action" value="preview"><label>Your personal message<textarea name="message" maxlength="4000" required></textarea></label><label>Unique initial Jellyfin password<input type="password" name="password" autocomplete="new-password" maxlength="128" required></label><p>The password is used only for this preview and confirmation. It is never saved as a draft.</p><button>Preview welcome</button></form>`;
  }
  return render('Welcome email',`<article>${body}</article><a href="/membership/requests/${e(requestId)}/setup">Back to member setup</a>`,request,respond,css,setCookie);
 }catch{return respond(409,'Welcome unavailable. Reload member setup and check the recorded outcome before trying again.');}
}
