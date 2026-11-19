// Read-only Member surface. The route supplies an existing branded identity,
// never a request profile/email value. No account binding or service grants here.
import {requireIdentity} from './identity.mjs';
import {requireOtpIdentity} from './otp-identity.mjs';
import {authorizeMember} from './authorization.mjs';
import {studioPage,escapeHtml as e} from './studio-ui.mjs';
const deny=()=>{throw Error('Member access unavailable.');};
const time=now=>{const at=now();if(!Number.isSafeInteger(at)||at<0)deny();return at;};
function identityProof(identity,at) {
 try{return requireIdentity(identity,at);}catch{try{return requireOtpIdentity(identity,at);}catch{deny();}}
}
function serviceURL(value,origin) {
 let u;try{u=new URL(value);}catch{deny();}
 if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password||u.search||u.hash||u.href!==value)deny();
 return u.href;
}
// Deliberately read from D1 every invocation. Old signed sessions confer no
// entitlement after revocation, including for direct service-link requests.
export async function loadSimplifiedMember(db,identity,{now=()=>Math.floor(Date.now()/1000),jellyfinOrigin}={}) {
 identityProof(identity,time(now));
 if(!['otp','google'].includes(identity.provider))deny();
 if(!db?.prepare)deny();
 const row=await db.prepare(`SELECT m.id,m.recipient,m.role,m.status,
  o.jellyfin_ready_at,o.jellyfin_username,o.jellyfin_url,
  COALESCE((SELECT json_group_array(service) FROM service_grants g WHERE g.member_id=m.id),'[]') grants
  FROM identities i JOIN members m ON m.id=i.member_id
  LEFT JOIN member_onboarding o ON o.member_id=m.id
  WHERE i.provider=? AND i.subject=?`).bind(identity.provider,identity.subject).first();
 identityProof(identity,time(now));
 if(!row || row.role!=='member'||!authorizeMember(row))deny();
 // OTP's stable subject is the exact verified email. Generic provider identities
 // carry the independently verified exact email in their existing identity brand.
 if(row.recipient!==(identity.provider==='otp'&&identity.email===undefined?identity.subject:identity.email))deny();
 let grants;try{grants=JSON.parse(row.grants);}catch{deny();}
 if(!Array.isArray(grants))deny();
 const authorized={...row,grants};
 const ready=Number.isSafeInteger(row.jellyfin_ready_at)&&row.jellyfin_ready_at>0;
 const url=ready&&authorizeMember(authorized,'jellyfin')?serviceURL(row.jellyfin_url,jellyfinOrigin):null;
 return Object.freeze({id:row.id,email:row.recipient,jellyfinURL:url,jellyfinReady:ready&&url!==null});
}
export async function simplifiedMemberDashboard(db,identity,options={}) {
 const member=await loadSimplifiedMember(db,identity,options);
 const jellyfin=member.jellyfinReady?
  '<span class="status">Ready</span><p>Your Jellyfin account is ready. Use the separate Jellyfin username and password Greg shared with you.</p><a class="button" href="'+e(member.jellyfinURL)+'" rel="noreferrer">Open Jellyfin</a>':
  '<span class="status preview">Getting ready</span><p>Greg is getting your Jellyfin access ready. Your Member sign-in and Jellyfin account are separate.</p>';
 return studioPage('Welcome to the studio',
  '<p class="lede">A little home for our projects, movies and good company.</p><p class="fine muted" style="overflow-wrap:anywhere">Signed in as '+e(member.email)+'</p><div class="grid">'+
  '<section class="panel wide"><div class="eyeline"><h2>Jellyfin</h2></div>'+jellyfin+'</section>'+
  '<section class="panel"><h2>Palworld</h2><span class="status preview">Coming Soon</span><p class="muted">More adventures are on the way.</p></section>'+
  '<section class="panel"><h2>More from the studio</h2><span class="status preview">Coming Soon</span><p class="muted">We will share new projects here when they are ready.</p></section></div>'+
  '<p><a class="button secondary" href="/cdn-cgi/access/logout">Sign out</a></p>','Members');
}
