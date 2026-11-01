import {onboardingApi,onboardingEnabled,render} from './onboarding-route.mjs';
import {prepareMemberRemoval,executeMemberRemoval,manualJellyfinReminder} from './member-removal.mjs';
import {escapeHTML as e,requireThat} from '../../membership/common.mjs';
export const removalEnabled=env=>onboardingEnabled(env)&&env.PORTAL_MEMBER_REMOVAL==='enabled-12';
export async function memberRemovalRoute(request,env,{now,respond,expiresAt,css}) {
 const url=new URL(request.url),match=/^\/membership\/members\/([A-Za-z0-9_-]{1,128})\/remove$/.exec(url.pathname);
 if(!match)return null;if(!removalEnabled(env))return respond(404,'Not found');
 try{
  requireThat(!url.search,400);await onboardingApi(env,expiresAt,now);
  const owner=await env.PORTAL_DB.prepare("SELECT id FROM members WHERE role='owner' AND status='active'").first();requireThat(owner,403);
  if(request.method==='POST'){
   await executeMemberRemoval(env.PORTAL_DB,request,owner.id,expiresAt,{appOrigin:env.APP_ORIGIN,expectedMemberId:match[1],now:()=>Math.floor(now()/1000)});
   return render('Member removed',`<p>Website membership is now revoked. Existing sessions will be denied on their next request.</p><p>${e(manualJellyfinReminder)}</p><a href="/membership/members/">Back to Members</a>`,request,respond,css);
  }
  requireThat(['GET','HEAD'].includes(request.method),405);
  if(request.method==='HEAD')return respond(200,null);
  const prepared=await prepareMemberRemoval(env.PORTAL_DB,request,owner.id,match[1],expiresAt,{now:()=>Math.floor(now()/1000)});
  return render('Remove Member',`<article><h2>${e(prepared.email)}</h2><p>Revoke this person’s website membership. Their history and audit records are preserved.</p><p>${e(prepared.reminder)}</p><form method="post"><input type="hidden" name="csrf" value="${e(prepared.csrf)}"><input type="hidden" name="member" value="${e(prepared.memberId)}"><label><input type="checkbox" name="confirm" value="yes" required> I want to remove this Member’s website access.</label><button>Remove Member</button></form><a href="/membership/members/">Keep membership</a></article>`,request,respond,css,prepared.cookie);
 }catch{return respond(409,'Removal unavailable. Reload the Member record before trying again.');}
}
