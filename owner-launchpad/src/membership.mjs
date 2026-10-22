import { DAY, clean, db, escapeHTML as e, hmac, readBody, requireThat, sameSite, secret } from '../../membership/common.mjs';
const BASE = '/membership/requests/';
const COOKIE = '__Host-bss-membership-csrf';
const labels = {pending:'Pending',approved:'Invite-ready',rejected:'Rejected',revoked:'Approval withdrawn',expired:'Expired'};
const transitions = {pending:['approved','rejected'],approved:['revoked'],rejected:[],revoked:[],expired:[]};
const css = 'body{font:1rem system-ui;background:#fbf6ea;color:#17243b;margin:0}main{max-width:900px;margin:auto;padding:24px}article{border:1px solid #96948e;border-radius:12px;padding:20px;margin:24px 0;overflow-wrap:anywhere}p{line-height:1.6;white-space:pre-wrap}label{display:block;margin:12px 0}textarea{display:block;width:100%;box-sizing:border-box;min-height:90px}button,a{min-height:44px;padding:8px;display:inline-block;color:inherit}button{cursor:pointer}input,select,textarea,button{font:inherit}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #a14325;outline-offset:3px}';
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
export async function membershipRoute(request, env, {now = () => Date.now(), respond}) {
 const url = new URL(request.url);
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
   return respond(303,null,{Location:BASE});
  }
  const params = url.searchParams;
  requireThat([...params.keys()].every(k=>k==='before') && params.getAll('before').length<=1);
  const cursor = params.get('before'); let time = Number.MAX_SAFE_INTEGER, id = 'z';
  if (cursor) { requireThat(/^\d{13}\.[a-f0-9-]{36}$/.test(cursor)); const parts=cursor.split('.'); time=Number(parts[0]); id=parts[1]; }
  const rows = await database.prepare(`SELECT id,name,email,reason,owner_note,status,revision,created_at,pii_cleared_at
   FROM membership_requests WHERE created_at<? OR (created_at=? AND id<?) ORDER BY created_at DESC,id DESC LIMIT 21`).bind(time,time,id).all();
  const recentAudit = await database.prepare('SELECT request_id,event,from_status,to_status,revision,occurred_at FROM audit_events ORDER BY occurred_at DESC,id DESC LIMIT 20').all();
  const auditHTML = recentAudit.results.map(event=>`<li>${e(event.request_id)} · ${e(new Date(event.occurred_at).toISOString())} · ${e(event.event)} · ${e(labels[event.from_status] || 'New request')} → ${e(labels[event.to_status])} · revision ${e(event.revision)}</li>`).join('');
  const token = await issue(request,env,now());
  const items = rows.results.slice(0,20).map(row=>`<article><h2>${e(row.name || 'Details removed')} · ${e(labels[row.status])}</h2>
   <p>${e(row.email)}</p><p>${e(row.reason)}</p><p>Request ${e(row.id)} · Received ${e(new Date(row.created_at).toISOString().slice(0,10))}${row.status==='approved' && row.created_at<=now()-365*DAY ? ' · Annual owner review due' : ''}</p>
   ${row.pii_cleared_at !== null ? '<p>Personal details cleared under retention policy.</p>' : `<form method="post" action="${BASE}${e(row.id)}/decision">
   <input type="hidden" name="csrf" value="${e(token)}"><input type="hidden" name="revision" value="${row.revision}">
   <label>Application status <select name="status">${[row.status,...transitions[row.status]].map(status=>`<option value="${status}">${labels[status]}</option>`).join('')}</select></label>
   <label>Private owner note (500 characters)<textarea name="note" maxlength="500">${e(row.owner_note)}</textarea></label>
   <button type="submit">Save review</button></form>`}</article>`).join('');
  const last = rows.results[19];
  const next = rows.results.length>20 ? `<a href="${BASE}?before=${last.created_at}.${e(last.id)}">Older requests →</a>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Membership requests · Owner desk</title><style>${css}</style></head><body><main><a href="/">← Owner desk</a><h1>Membership requests</h1><p>Unverified applicant details. Invite-ready is an application decision only. Saving never creates an account, authorizes access, sends an invitation, or sends email. Approval withdrawn does not revoke any member account.</p><p>Newest first · 20 per page. Terminal decisions cannot be reopened. For an invited or otherwise closed application, withdraw its approval here; manage any account separately through the future authorized process.</p>${items || '<p>No requests.</p>'}${next}<details><summary>Recent private audit (20 events)</summary><ul>${auditHTML || '<li>No events.</li>'}</ul></details></main></body></html>`;
  const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(css)))));
  return respond(200,html,{'Set-Cookie':`${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`,
   'Content-Security-Policy':`default-src 'none'; script-src 'none'; style-src 'sha256-${hash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`});
 } catch(error) {
  const status = [400,403,409,413,415].includes(error.status) ? error.status : 503;
  return respond(status,status===409 ? 'Review conflict. Return to the queue and reload before trying again.' : 'Review unavailable. Return to the queue and try again.');
 }
}
