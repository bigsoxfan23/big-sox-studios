import {onboardingRoute,onboardingEnabled,onboardingApi} from './onboarding-route.mjs';
import {welcomeRoute} from './welcome-route.mjs';
import {welcomeLiveRoute} from './welcome-live-route.mjs';
import {memberRemovalRoute} from './member-removal-route.mjs';
import { DAY, clean, db, escapeHTML as e, hmac, readBody, requireThat, sameSite, secret } from '../../membership/common.mjs';
const BASE = '/membership/requests/';
const COOKIE = '__Host-bss-membership-csrf';
const views = Object.freeze({
 pending: {label:'New',statuses:['pending'],predicate:'status IN (?)',empty:'No new requests.'},
 'invite-ready': {label:'Setting Up',statuses:['approved'],predicate:'status IN (?)',empty:'No approved requests awaiting setup.'},
 history: {label:'History',statuses:['rejected','revoked','expired'],predicate:'status IN (?,?,?)',empty:'No rejected, withdrawn, or expired applications.'},
});
const viewForStatus = status => status==='pending' ? 'pending' : status==='approved' ? 'invite-ready' : 'history';
const viewURL = view => view==='pending' ? BASE : `${BASE}?view=${view}`;
const labels = {pending:'New',approved:'Setting Up',rejected:'Declined',revoked:'Approval withdrawn',expired:'Expired'};
const transitions = {pending:['approved','rejected'],approved:['revoked'],rejected:[],revoked:[],expired:[]};
const css = 'body{font:1rem system-ui;background:#fbf6ea;color:#17243b;margin:0}main{max-width:900px;margin:auto;padding:24px}article{border:1px solid #96948e;border-radius:12px;padding:20px;margin:24px 0;overflow-wrap:anywhere}p{line-height:1.6;white-space:pre-wrap}label{display:block;margin:12px 0}textarea{display:block;width:100%;box-sizing:border-box;min-height:90px}button,a{min-height:44px;padding:8px;display:inline-block;color:inherit}nav{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0}nav a{box-sizing:border-box;min-height:44px;padding:12px;border:1px solid #96948e;border-radius:8px}nav a[aria-current=page]{background:#17243b;color:#fbf6ea;font-weight:700}button{cursor:pointer}input,select,textarea,button{font:inherit}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #a14325;outline-offset:3px}h1{font:400 clamp(32px,6vw,48px) Georgia,serif}article{background:#fffcf7;border-color:#d3c6b7}article header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}article h2{margin:0;font-size:22px}.initial{border-radius:50%;background:#efddc8;padding:12px 18px}.status{color:#803c24;font-weight:600}small{display:block;color:#526071}summary{cursor:pointer;min-height:44px;padding:12px 0}details p{font-size:.95rem}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}button{border:1px solid #803c24;border-radius:8px;background:#803c24;color:#fff;padding:12px 18px}button[formnovalidate]{background:transparent;color:#17243b}.confirmation input{min-width:22px;min-height:22px}textarea{font:inherit;padding:10px;border-radius:8px;max-width:100%}article{overflow-wrap:anywhere}';
function equal(a,b) { if (a.length !== b.length) return false; let diff=0; for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i); return diff===0; }
async function session(request, env) { return hmac(env.MEMBERSHIP_CSRF_KEY,`session:${request.headers.get('Cf-Access-Jwt-Assertion')}`); }
async function issue(request, env, now) {
 const payload = `${now+900000}.${crypto.randomUUID()}`;
 return `${payload}.${await hmac(env.MEMBERSHIP_CSRF_KEY,`${await session(request,env)}:${payload}`)}`;
}
async function check(request, env, token, now) {
 const cookies = (request.headers.get('Cookie') || '').split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${COOKIE}=`));
 requireThat(cookies.length === 1 && cookies[0].slice(COOKIE.length+1) === token,403);
 requireThat(typeof token === 'string' && /^\d{13}\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token),403);
 const [expiry,nonce,signature] = token.split('.');
 requireThat(Number(expiry)>now && Number(expiry)<=now+900000,403);
 requireThat(equal(signature,await hmac(env.MEMBERSHIP_CSRF_KEY,`${await session(request,env)}:${expiry}.${nonce}`)),403);
}
export async function pendingBadge(env) {
 try { const row = await db(env).prepare("SELECT COUNT(*) AS count FROM membership_requests WHERE status='pending'").first(); return String(row.count); }
 catch { return 'unavailable'; }
}
export async function membershipRoute(request, env, {now = () => Date.now(), respond,expiresAt}) {
 const url = new URL(request.url);
 const liveWelcome=await welcomeLiveRoute(request,env,{now,respond,expiresAt,issue,check,css,cookie:COOKIE});
 if(liveWelcome)return liveWelcome;
 const removal=await memberRemovalRoute(request,env,{now,respond,expiresAt,css});
 if(removal)return removal;
 const welcome=await welcomeRoute(request,env,{now,respond,expiresAt,issue,check,css,cookie:COOKIE});
 if(welcome)return welcome;
 const setup=await onboardingRoute(request,env,{now,respond,expiresAt,issue,check,css,cookie:COOKIE});
 if(setup)return setup;
 const decision = /^\/membership\/requests\/([a-f0-9-]{36})\/decision$/.exec(url.pathname);
 if (url.pathname !== BASE && !decision) return respond(404,'Not found');
 const allowed = decision ? ['POST'] : ['GET','HEAD'];
 if (!allowed.includes(request.method)) return respond(405,'Method not allowed',{Allow:allowed.join(', ')});
 try {
  const database = db(env); secret(env.MEMBERSHIP_CSRF_KEY);
  if (decision) {
   sameSite(request,env.APP_ORIGIN); requireThat(!url.search,400);
   requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/x-www-form-urlencoded',415);
   const fields = new URLSearchParams(await readBody(request,8192));
   requireThat([...fields.keys()].length === 4 && ['csrf','revision','status','note'].every(key=>fields.getAll(key).length===1));
   await check(request,env,fields.get('csrf'),now());
   const revision = Number(fields.get('revision')), status = fields.get('status'), note = clean(fields.get('note'),500,false);
   requireThat(Number.isSafeInteger(revision) && revision>0 && Object.hasOwn(labels,status));
   // A guessed/nonexistent ID and a stale revision both produce the same private conflict.
   const current = await database.prepare('SELECT status,pii_cleared_at FROM membership_requests WHERE id=? AND revision=?').bind(decision[1],revision).first();
   requireThat(current && current.pii_cleared_at === null && (status===current.status || transitions[current.status].includes(status)),409);
   const time = now();
   const updated = await database.prepare(`UPDATE membership_requests SET status=?,owner_note=?,revision=revision+1,updated_at=?,
    closed_at=CASE WHEN ? IN ('rejected','revoked','expired') THEN COALESCE(closed_at,?) ELSE closed_at END
    WHERE id=? AND revision=? AND status=? AND pii_cleared_at IS NULL RETURNING id`)
    .bind(status,note,time,status,time,decision[1],revision,current.status).first();
   // D1 meta.changes may include trigger writes; RETURNING identifies the
   // conditional application update itself without relying on that counter.
   requireThat(updated?.id===decision[1],409);
   if(current.status==='pending' && status==='approved' && onboardingEnabled(env)) {
    try { await (await onboardingApi(env,expiresAt,now)).link(decision[1],revision+1); }
    catch { return respond(503,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup needs attention · Big Sox Studios</title><main><h1>Request approved. Setup needs attention.</h1><p>Your approval was saved, but the pending Member link could not be confirmed. No email was sent and website access is not active.</p><a href="${BASE}${e(decision[1])}/setup">Continue member setup</a><p><a href="${BASE}?view=invite-ready">Return to Setting Up</a></p></main></html>`); }
   }
   return respond(303,null,{Location:viewURL(viewForStatus(status))});
  }
  const params = url.searchParams;
  requireThat([...params.keys()].every(k=>k==='before' || k==='view') && ['before','view'].every(k=>params.getAll(k).length<=1));
  const view = params.has('view') ? params.get('view') : 'pending';
  requireThat(Object.hasOwn(views,view));
  const selected = views[view];
  const cursor = params.get('before'); let time = Number.MAX_SAFE_INTEGER, id = 'z';
  if (params.has('before')) { requireThat(/^\d{13}\.[a-f0-9-]{36}$/.test(cursor)); const parts=cursor.split('.'); time=Number(parts[0]); id=parts[1]; }
  const rows = await database.prepare(`SELECT id,name,email,reason,owner_note,status,revision,created_at,pii_cleared_at
   FROM membership_requests WHERE ${selected.predicate} AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 21`).bind(...selected.statuses,time,time,id).all();
  const recentAudit = await database.prepare(`SELECT request_id,event,from_status,to_status,revision,occurred_at FROM audit_events WHERE request_id IN (SELECT id FROM membership_requests WHERE ${selected.predicate}) ORDER BY occurred_at DESC,id DESC LIMIT 20`).bind(...selected.statuses).all();
  const auditHTML = recentAudit.results.map(event=>`<li>${e(event.request_id)} · ${e(new Date(event.occurred_at).toISOString())} · ${e(event.event)} · ${e(labels[event.from_status] || 'New request')} → ${e(labels[event.to_status])} · revision ${e(event.revision)}</li>`).join('');
  const token = await issue(request,env,now());
  const items = rows.results.slice(0,20).map(row=>`<article><header><span class="initial" aria-hidden="true">${e((row.name || '?').trim().slice(0,1).toUpperCase())}</span><h2>${e(row.name || 'Details removed')}</h2><span class="status">${e(labels[row.status])}</span></header>
   <p>${e(row.email)} <small>Submitted email · not yet verified</small></p><p>${e(row.reason)}</p><p>Received ${e(new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeZone:'America/Chicago'}).format(new Date(row.created_at)))}${row.status==='approved' && row.created_at<=now()-365*DAY ? ' · Annual owner review due' : ''}</p>
   ${row.status==='approved' && onboardingEnabled(env)?`<p><a href="${BASE}${e(row.id)}/setup">Continue member setup</a></p>`:''}
   ${row.status==='approved' ? '<p>Membership approved. Manual Jellyfin setup and a welcome email are still separate steps. Approval alone does not activate website access.</p>' : ''}
   ${row.pii_cleared_at !== null ? '<p>Personal details cleared under retention policy.</p>' : `<details><summary>Review Request</summary><form method="post" action="${BASE}${e(row.id)}/decision">
   <input type="hidden" name="csrf" value="${e(token)}"><input type="hidden" name="revision" value="${row.revision}">
   <label>Private note (only you can see this)<textarea name="note" maxlength="500">${e(row.owner_note)}</textarea></label>
   ${transitions[row.status].length ? '<label class="confirmation"><input type="checkbox" required> I have reviewed this request and confirm my decision. This does not send email or grant access.</label>' : ''}
   <div class="actions">${transitions[row.status].map(status=>`<button type="submit" name="status" value="${status}">${status==='approved'?'Approve':status==='rejected'?'Decline':'Withdraw approval'}</button>`).join('')}<button type="submit" name="status" value="${row.status}" formnovalidate>Save private note</button></div></form></details>`}
   <details><summary>Record details</summary><p>Request ${e(row.id)}</p></details></article>`).join('');
  const last = rows.results[19];
  const next = rows.results.length>20 ? `<a href="${BASE}?view=${view}&amp;before=${last.created_at}.${e(last.id)}">Older requests →</a>` : '';
  const navigation = `<nav aria-label="Membership request views">${Object.entries(views).map(([key,value])=>`<a href="${viewURL(key)}"${key===view ? ' aria-current="page"' : ''}>${value.label}</a>`).join('')}</nav>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${selected.label} membership requests · Owner desk</title><style>${css}</style></head><body><main><a href="/">← Owner desk</a><h1>Membership Requests</h1><p>Review who’s interested in joining Big Sox Studios.</p><p>Application details are submitted by the visitor. Approving a request starts setup; it never sends email or grants access.</p><details><summary>Help with requests</summary><p>Newest first · 20 per page. Private notes are never sent to applicants. Closed decisions cannot be reopened. Withdrawing an approval does not remove an existing member account; manage that separately. Setup tracking and welcome sending are not connected yet.</p></details>${navigation}<h2>${selected.label}</h2>${items || `<p>${selected.empty}</p>`}${next}<details><summary>Recent private audit for this view (20 events)</summary><ul>${auditHTML || '<li>No events.</li>'}</ul></details></main></body></html>`;
  const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(css)))));
  return respond(200,html,{'Set-Cookie':`${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`,
   // Preserve same-origin form POST Origin in Safari without cross-site referrers.
   ...(request.method==='GET' ? {'Referrer-Policy':'same-origin'} : {}),
   'Content-Security-Policy':`default-src 'none'; script-src 'none'; style-src 'sha256-${hash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`});
 } catch(error) {
  const status = [400,403,409,413,415].includes(error.status) ? error.status : 503;
  return respond(status,status===409 ? 'Review conflict. Return to the queue and reload before trying again.' : 'Review unavailable. Return to the queue and try again.');
 }
}

