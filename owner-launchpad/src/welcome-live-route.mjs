// Source only. No configuration, credentials, migration or Access-policy changes.
// Called only after worker.authenticate(); MFA remains the existing Access policy.
import {createWelcomeReview} from '../../portal/welcome-review.mjs';
import {createWelcomeLiveDelivery} from '../../portal/welcome-live-delivery.mjs';
import {createResendWelcomeTransport} from '../../portal/welcome-resend-transport.mjs';
import {createWelcomeReconciliation,welcomeReconciliationProofValue} from '../../portal/welcome-reconciliation.mjs';
import {onboardingApi,onboardingEnabled,render} from './onboarding-route.mjs';
import {escapeHTML as e,hmac,readBody,requireThat,sameSite} from '../../membership/common.mjs';

export const welcomeLiveEnabled=env=>onboardingEnabled(env)&&env.PORTAL_WELCOME_LIVE_ROUTE==='review-only-12';
// A reviewed live welcome must never point production Members to staging.
// Both destinations stay disabled until their exact Access host is approved.
export const expectedMemberLoginUrl=env=>env?.APP_ORIGIN==='https://owner.bigsoxstudios.com'
 ?'https://members.bigsoxstudios.com/app'
 :env?.APP_ORIGIN==='https://bss-owner-launchpad-staging.fridman-greg.workers.dev'
  ?'https://members-staging.bigsoxstudios.com/app':null;
const schemas={
 preview:['message','password'],send:['message','password','review','confirm'],
 inspect:['intent_id','provider_id'],record:['evidence','issued_at','expires_at','nonce','signature','confirm'],
};
const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${e(String(value))}">`;
const nonceFor=(env,csrf)=>hmac(env.MEMBERSHIP_CSRF_KEY,'welcome-live-receipt-csrf:'+csrf).then(x=>x.slice(0,32));

// fetcher is injected in synthetic tests. The Worker never supplies credentials
// or opt-in flags itself; provider actions require both independently set gates.
export async function welcomeLiveRoute(request,env,{now,respond,expiresAt,issue,check,css,cookie,fetcher=fetch}) {
 const url=new URL(request.url),match=/^\/membership\/requests\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/welcome-live$/.exec(url.pathname);
 if(!match)return null;
 if(!welcomeLiveEnabled(env))return respond(404,'Not found');
 try{
  requireThat(url.origin===env.APP_ORIGIN,403);requireThat(!url.search,400);
  if(!['GET','HEAD','POST'].includes(request.method))return respond(405,'Method not allowed',{Allow:'GET, HEAD, POST'});
  requireThat(Number.isSafeInteger(expiresAt)&&Math.floor(now()/1000)<expiresAt,403);
  let fields,action,adapter;
  if(request.method==='POST'){
   sameSite(request,env.APP_ORIGIN);
   requireThat(request.headers.get('Content-Type')?.split(';')[0]==='application/x-www-form-urlencoded',415);
   fields=new URLSearchParams(await readBody(request,24576));action=fields.get('action');
   const keys=['csrf','request_revision','action',...(schemas[action]||[])];
   requireThat(Object.hasOwn(schemas,action)&&[...fields.keys()].length===keys.length&&keys.every(k=>fields.getAll(k).length===1),400);
   await check(request,env,fields.get('csrf'),now());
   if(action!=='preview'){
    // Validate all send configuration BEFORE any D1 operation or durable claim.
    requireThat(env.PORTAL_WELCOME_LIVE_SEND==='enabled-12',503);
    adapter=createResendWelcomeTransport({enabled:true,apiKey:env.RESEND_API_KEY,sender:env.SENDER_EMAIL,fetcher});
   }
  }
  const memberLoginUrl=expectedMemberLoginUrl(env);
  requireThat(memberLoginUrl!==null&&env.MEMBER_LOGIN_URL===memberLoginUrl,503);
  const api=await onboardingApi(env,expiresAt,now),requestId=match[1];
  const owners=(await env.PORTAL_DB.prepare("SELECT id,recipient FROM members WHERE role='owner' AND status='active' LIMIT 2").all()).results;
  requireThat(owners?.length===1&&owners[0].recipient===env.OWNER_EMAIL,403);
  const actorId=owners[0].id,seconds=()=>Math.floor(now()/1000);
  const source=await env.MEMBERSHIP_DB.prepare('SELECT revision FROM membership_requests WHERE id=?').bind(requestId).first();requireThat(source,409);
  if(fields)requireThat(fields.get('request_revision')===String(source.revision),409);
  const sessionBinding=await hmac(env.MEMBERSHIP_CSRF_KEY,'welcome-live-session:'+request.headers.get('Cf-Access-Jwt-Assertion'));
  const base={enabled:true,memberDb:env.PORTAL_DB,sourceDatabase:env.ONBOARDING_SOURCE_ID,actorId,expiresAt,now:seconds};
  const review=createWelcomeReview({onboarding:api,actorId,sessionBinding,signingKey:env.MEMBERSHIP_CSRF_KEY,expiresAt,
   jellyfinOrigin:env.JELLYFIN_ORIGIN,memberLoginUrl,now:seconds});
  const delivery=createWelcomeLiveDelivery({...base,onboarding:api,review,adapter:adapter||{send:async()=>{throw Error('disabled');}}});
  const token=await issue(request,env,now()),common=hidden('csrf',token)+hidden('request_revision',source.revision);
  let body='';
  if(action==='inspect'||action==='record'){
   const reconciliation=createWelcomeReconciliation({...base,adapter,sessionBinding,signingKey:env.MEMBERSHIP_CSRF_KEY});
   const evidence=action==='record'?JSON.parse(fields.get('evidence')):null;
   const intentId=action==='inspect'?fields.get('intent_id'):evidence?.intentId;
   // Never accept another request's intent through this route.
   requireThat(await env.PORTAL_DB.prepare("SELECT id FROM welcome_intents WHERE id=? AND request_id=? AND source_database=? AND actor_id=? AND mode='live'").bind(intentId,requestId,env.ONBOARDING_SOURCE_ID,actorId).first(),409);
   if(action==='inspect'){
    const result=await reconciliation.verifyReceipt(intentId,fields.get('provider_id')||undefined);
    if(result.state!=='provider-observed')body='<p>Receipt could not be corroborated. The original intent remains locked.</p>';
    else{
     const evidence=result.evidence,issuedAt=seconds(),until=Math.min(issuedAt+120,expiresAt),nonce=await nonceFor(env,token);
     const signature=await hmac(env.MEMBERSHIP_CSRF_KEY,welcomeReconciliationProofValue({...base,sessionBinding,evidence,issuedAt,expiresAt:until,nonce}));
     body=`<h2>Review corroborated receipt</h2><p>Provider observation: ${e(evidence.providerStatus)}. This evidence never activates membership or permits retry.</p><form method="post">${common}${hidden('action','record')}${hidden('evidence',JSON.stringify(evidence))}${hidden('issued_at',issuedAt)}${hidden('expires_at',until)}${hidden('nonce',nonce)}${hidden('signature',signature)}<label><input type="checkbox" name="confirm" value="yes" required> I reviewed this corroborated receipt.</label><button>Record receipt evidence once</button></form>`;
    }
   }else{
    // This newly issued receipt CSRF is bound to exactly one signed proof.
    // The existing UNIQUE proof_digest consumes it durably, including races.
    requireThat(fields.get('nonce')===await nonceFor(env,fields.get('csrf')),403);
    await reconciliation.recordEvidence(evidence,{issuedAt:Number(fields.get('issued_at')),expiresAt:Number(fields.get('expires_at')),
     nonce:fields.get('nonce'),signature:fields.get('signature'),confirmed:fields.get('confirm')==='yes'});
    body='<p>Receipt evidence recorded. The original intent remains locked. Membership was not activated.</p>';
   }
  }else if(action==='send'){
   const result=await delivery.send(requestId,source.revision,{message:fields.get('message'),password:fields.get('password')},
    {review:fields.get('review'),confirmed:fields.get('confirm')==='yes'},{signal:request.signal});
   body=`<h2>${result.state==='accepted'?'Provider accepted':result.state==='UNKNOWN'?'Outcome UNKNOWN':'Attempt failed'}</h2><p>Acceptance is not delivery. Website membership remains pending. Check recorded status before any further action.</p>`;
  }else{
   const status=await delivery.status(requestId,source.revision),locked=status.some(x=>['dispatching','UNKNOWN','accepted'].includes(x.state));
   if(action==='preview'){
    requireThat(!locked,409);
    const form={message:fields.get('message'),password:fields.get('password')},p=await review.preview(requestId,source.revision,form);
    body=`<h2>Review welcome</h2><p>To: ${e(p.recipient)}</p><p>Subject: ${e(p.subject)}</p><p>${e(p.text)}</p><p>The password is transient. Confirmation requires the separate send gate and valid sender configuration.</p><form method="post" autocomplete="off">${common}${hidden('action','send')}${hidden('review',p.review)}${hidden('message',form.message)}${hidden('password',form.password)}<label><input type="checkbox" name="confirm" value="yes" required> I reviewed this exact recipient and message for provider dispatch.</label><button>Confirm welcome dispatch</button></form>`;
   }else{
    body=`<p>Reviewed staging welcome. Website membership remains pending. Preview does not send email.</p>${status.map(x=>`<p>Recorded live attempt: ${e(x.state)}.</p>${['dispatching','UNKNOWN','accepted'].includes(x.state)?`<form method="post">${common}${hidden('action','inspect')}${hidden('intent_id',x.id)}<label>Provider receipt ID (requires independent readback)<input name="provider_id" maxlength="36"></label><button>Inspect receipt</button></form>`:''}`).join('')}`;
    body+=locked?'<p>The original attempt is locked. Receipt evidence never unlocks it or authorizes another send.</p>':`<form method="post" autocomplete="off">${common}${hidden('action','preview')}<label>Your personal message<textarea name="message" maxlength="4000" required></textarea></label><label>Unique initial Jellyfin password<input type="password" name="password" autocomplete="new-password" maxlength="128" required></label><button>Preview welcome</button></form>`;
   }
  }
  return render('Reviewed live welcome',`<article>${body}</article><a href="/membership/requests/${e(requestId)}/setup">Back to member setup</a>`,request,respond,css,
   `${cookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`);
 }catch(error){
  const status=[400,403,409,413,415,503].includes(error.status)?error.status:409;
  return respond(status,'Reviewed welcome unavailable. Reload setup and check recorded status before trying again.');
 }
}
