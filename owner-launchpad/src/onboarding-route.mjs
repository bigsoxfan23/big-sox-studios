import {createRequestOnboarding} from '../../portal/request-onboarding.mjs';
import {db,escapeHTML as e,readBody,requireThat,sameSite,secret} from '../../membership/common.mjs';
const SOURCE='48b0a0cc-40ad-4495-8883-a42b4a938b71';
const TARGET='43a8a15b-e195-4712-9198-1dcc9f0152af';
export const onboardingEnabled=env=>env.PORTAL_ONBOARDING==='staging-12' && env.APP_ORIGIN==='https://bss-owner-launchpad-staging.fridman-greg.workers.dev';
export async function onboardingApi(env,expiresAt,now) {
 requireThat(onboardingEnabled(env) && env.ONBOARDING_SOURCE_ID===SOURCE && env.ONBOARDING_MEMBER_DB_ID===TARGET && env.PORTAL_DB?.prepare,503);
 const owners=(await env.PORTAL_DB.prepare("SELECT id,recipient FROM members WHERE role='owner' AND status='active' LIMIT 2").all()).results;
 requireThat(owners?.length===1 && owners[0].recipient===env.OWNER_EMAIL,403);
 return createRequestOnboarding({requestDb:db(env),memberDb:env.PORTAL_DB,sourceDatabase:SOURCE,actorId:owners[0].id,expiresAt,now:()=>Math.floor(now()/1000),jellyfinOrigin:env.JELLYFIN_ORIGIN});
}
export async function onboardingRoute(request,env,{now,respond,expiresAt,issue,check,css,cookie}) {
 const url=new URL(request.url),match=/^\/membership\/requests\/([a-f0-9-]{36})\/setup$/.exec(url.pathname),list=url.pathname==='/membership/members/';
 if(!match&&!list)return null;
 if(!onboardingEnabled(env))return respond(404,'Not found');
 try{
  requireThat(!url.search,400);const api=await onboardingApi(env,expiresAt,now);secret(env.MEMBERSHIP_CSRF_KEY);
  if(list){
   if(!['GET','HEAD'].includes(request.method))return respond(405,'Method not allowed',{Allow:'GET, HEAD'});
   // This is the existing Phase2 directory's onboarding subset, never a new identity store.
   const rows=(await env.PORTAL_DB.prepare(`SELECT o.request_id,m.id,m.recipient,m.status,o.jellyfin_ready_at FROM member_onboarding o JOIN members m ON m.id=o.member_id WHERE o.source_database=? ORDER BY o.approved_at DESC,o.request_id LIMIT 100`).bind(SOURCE).all()).results;
   return render('Members',`<p>Approved people and manual setup.</p><p><a href="https://members-staging.bigsoxstudios.com/app/manage">Existing member directory and invitation history</a></p>${rows.map(r=>`<article><h2>${e(r.recipient)}</h2><p>${e(({pending:'Setting Up',active:'Active',revoked:'Removed'})[r.status]||r.status)} · ${r.jellyfin_ready_at===null?'Waiting for Jellyfin setup':'Jellyfin marked ready'}</p>${r.status==='pending'?`<a href="/membership/requests/${e(r.request_id)}/setup">Manage setup</a>`:''}${['pending','active'].includes(r.status)&&env.PORTAL_MEMBER_REMOVAL==='enabled-12'?`<a href="/membership/members/${e(r.id)}/remove">Remove Member</a>`:''}${r.status==='revoked'?'<p>Also disable this Jellyfin account and its sessions manually.</p>':''}</article>`).join('')||'<p>No linked members yet. Start setup from an approved request.</p>'}`,request,respond,css);
  }
  if(!['GET','HEAD','POST'].includes(request.method))return respond(405,'Method not allowed',{Allow:'GET, HEAD, POST'});
  const record=await db(env).prepare('SELECT id,name,email,status,revision,pii_cleared_at FROM membership_requests WHERE id=?').bind(match[1]).first();
  requireThat(record?.status==='approved' && record.pii_cleared_at===null,409);
  if(request.method==='POST'){
   sameSite(request,env.APP_ORIGIN);requireThat(request.headers.get('Content-Type')?.split(';')[0]==='application/x-www-form-urlencoded',415);
   const fields=new URLSearchParams(await readBody(request,4096)),action=fields.get('action');
   const keys=action==='start'?['csrf','request_revision','action','confirm']:action==='jellyfin-ready'?['csrf','request_revision','revision','action','confirm','username','url']:[];
   requireThat(keys.length>0 && [...fields.keys()].length===keys.length && keys.every(k=>fields.getAll(k).length===1),400);
   await check(request,env,fields.get('csrf'),now());requireThat(fields.get('confirm')==='yes',400);
   const revision=Number(fields.get('request_revision'));requireThat(revision===record.revision,409);
   if(action==='start')await api.link(record.id,revision);
   else await api.markJellyfinReady(record.id,revision,{expectedRevision:Number(fields.get('revision')),confirmed:true,username:fields.get('username'),url:fields.get('url')});
   return respond(303,null,{Location:url.pathname});
  }
  const link=await env.PORTAL_DB.prepare('SELECT member_id FROM member_onboarding WHERE source_database=? AND request_id=?').bind(SOURCE,record.id).first();
  const row=link?await api.read(record.id,record.revision):null;
  const token=await issue(request,env,now());
  const hidden=`<input type="hidden" name="csrf" value="${e(token)}"><input type="hidden" name="request_revision" value="${record.revision}">`;
  const start=`<form method="post" action="${e(url.pathname)}">${hidden}<input type="hidden" name="action" value="start"><label><input type="checkbox" name="confirm" value="yes" required> Create a pending regular Member for this approved request. No email or access grant.</label><button>Start pending setup</button></form>`;
  const readiness=row && row.jellyfin_ready_at===null ? `<p>Create this person’s account directly in Jellyfin first. This form only records your confirmation.</p>${env.JELLYFIN_ORIGIN?`<form method="post" action="${e(url.pathname)}">${hidden}<input type="hidden" name="revision" value="${row.revision}"><input type="hidden" name="action" value="jellyfin-ready"><label>Jellyfin username<input name="username" maxlength="128" required></label><label>Jellyfin URL<input name="url" type="url" value="${e(env.JELLYFIN_ORIGIN)}/" required></label><label><input type="checkbox" name="confirm" value="yes" required> I created this account manually in Jellyfin.</label><button>Mark Jellyfin ready</button></form>`:'<p>The verified Jellyfin address has not been configured yet. No password is requested or stored.</p>'}`:'';
  return render('Member setup',`<article><h2>${e(record.name)}</h2><p>${e(record.email)}</p><ol><li>Membership approved</li><li>${row?'Pending Member linked':'Pending Member not linked yet'}</li><li>${row?.jellyfin_ready_at?'Jellyfin marked ready':'Waiting for manual Jellyfin setup'}</li><li>Personalized welcome email — ${env.PORTAL_WELCOME==='simulation-12'?'preview and simulation available':'not connected yet'}</li><li>Welcome sent — not sent</li><li>Member active — not active</li></ol>${row?readiness:start}${row?.jellyfin_ready_at && env.PORTAL_WELCOME==='simulation-12'?`<p><a href="/membership/requests/${e(record.id)}/welcome">Prepare welcome email</a></p>`:''}<p>Website access remains pending. Approval and setup never send email or activate membership.</p></article>`,request,respond,css,`${cookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`);
 }catch(error){const status=[400,403,409,413,415,503].includes(error.status)?error.status:409;return respond(status,'Setup unavailable. Reload the approved request before trying again.');}
}
export async function render(title,body,request,respond,css,setCookie){
 const hash=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(css)))));
 return respond(200,`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · Big Sox Studios</title><style>${css}</style></head><body><main><a href="/">← Owner Dashboard</a><h1>${e(title)}</h1>${body}<a href="/membership/requests/?view=invite-ready">Approved requests</a></main></body></html>`,{'Content-Security-Policy':`default-src 'none'; script-src 'none'; style-src 'sha256-${hash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,...(request.method==='GET'?{'Referrer-Policy':'same-origin'}:{}),...(setCookie?{'Set-Cookie':setCookie}:{})});
}
