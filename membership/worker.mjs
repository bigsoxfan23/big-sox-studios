import { ORIGIN, clean, db, hmac, readBody, requireThat, sameSite, secret, sweep } from './common.mjs';
const SUCCESS = 'Thank you. Greg personally reviews membership requests. No account has been created and no email has been sent. You may only hear back if Greg eventually invites you. The members portal is not open yet.';
const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
export function createWorker({fetcher = fetch, now = () => Date.now()} = {}) {
 return {
  async fetch(request, env) {
   const url = new URL(request.url);
   if (!url.pathname.startsWith('/api/membership/')) return env.ASSETS.fetch(request);
   const respond = (status, message, extra={}) => new Response(request.method === 'HEAD' ? null : JSON.stringify({message}),{status,headers:{...headers,...extra}});
   if (url.pathname !== '/api/membership/requests' || url.search) return respond(404,'Not found');
   if (request.method !== 'POST') return respond(405,'Method not allowed',{Allow:'POST'});
   try {
    sameSite(request,ORIGIN);
    requireThat(request.headers.get('Content-Type')?.split(';')[0].trim() === 'application/json',415);
    const database = db(env); secret(env.EMAIL_HMAC_KEY); secret(env.RATE_HMAC_KEY); secret(env.TURNSTILE_SECRET_KEY);
    requireThat(typeof env.REQUEST_LIMITER?.limit === 'function',503);
    // Only CF's edge header is accepted, never X-Forwarded-For. Direct origins must remain disabled.
    const ip = request.headers.get('CF-Connecting-IP');
    requireThat(ip && (validIPv4(ip) || validIPv6(ip)),403);
    const key = await hmac(env.RATE_HMAC_KEY, `membership-ip:${ip.toLowerCase()}`);
    requireThat((await env.REQUEST_LIMITER.limit({key})).success === true,429);
    const raw = await readBody(request);
    let data; try { data = JSON.parse(raw); } catch { requireThat(false); }
    requireThat(data && typeof data === 'object' && !Array.isArray(data));
    const name = clean(data.name,100), email = clean(data.email,254).toLowerCase(), reason = clean(data.reason,500);
    requireThat(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email));
    requireThat(email.split('@')[0].length <= 64 && !email.startsWith('.') && !email.includes('..') && !email.includes('.@'));
    requireThat(data.acknowledgement === true);
    const emailRateKey = await hmac(env.RATE_HMAC_KEY, `membership-email-rate:${email}`);
    requireThat((await env.REQUEST_LIMITER.limit({key:emailRateKey})).success === true,429);
    requireThat(typeof data.token === 'string' && /^[A-Za-z0-9_.-]{1,2048}$/.test(data.token));
    // Every otherwise admissible submission, including duplicates, consumes Siteverify.
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
     method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
     body:new URLSearchParams({secret:env.TURNSTILE_SECRET_KEY,response:data.token})
    });
    requireThat(response.status === 200,503);
    let verdict;
    try { verdict = JSON.parse(await readBody(response,16384)); } catch { requireThat(false,503); }
    requireThat(verdict && typeof verdict === 'object',503);
    const age = now() - Date.parse(verdict.challenge_ts);
    requireThat(verdict.success === true && verdict.hostname === 'bigsoxstudios.com' && verdict.action === 'membership_request' && Number.isFinite(age) && age >= 0 && age < 300000,400);
    const emailHash = await hmac(env.EMAIL_HMAC_KEY,`membership-email:v1:${email}`);
    const time = now();
    // Conflict does nothing: submitted identity is unverified and cannot change a decision.
    const inserted = await database.prepare(`INSERT INTO membership_requests(id,email_hash,name,email,reason,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(email_hash) DO NOTHING`).bind(crypto.randomUUID(),emailHash,name,email,reason,time,time).run();
    requireThat(inserted.success === true,503);
    return respond(200,SUCCESS);
   } catch (error) {
    const status = [400,403,413,415,429,503].includes(error.status) ? error.status : 503;
    return respond(status,status === 429 ? 'Too many attempts. Please wait a minute and try again.' : 'We could not confirm your request. Please check your details, refresh the security check, and try again.',status === 429 ? {'Retry-After':'60'} : {});
   }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(sweep(env,now())); }
 };
}
function validIPv4(ip) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(n=>Number(n)<=255 && String(Number(n))===n); }
function validIPv6(ip) { try { return ip.includes(':') && /^[0-9a-f:]+$/i.test(ip) && new URL(`https://[${ip}]/`).hostname.startsWith('['); } catch { return false; } }
export default createWorker();
