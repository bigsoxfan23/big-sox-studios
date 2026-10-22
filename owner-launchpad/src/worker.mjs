import { membershipRoute, pendingBadge } from './membership.mjs';
import { createAuthenticator, httpsOrigin, validateConfig } from './security.mjs';

const CMS_URL = 'https://bigsoxstudios.com/admin/';
// All responses, including denials and HEAD, receive the same security policy.
const headers = {
 'Content-Type': 'text/html; charset=utf-8',
 'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'sha256-2zMC2031mhgTytlETPL7JZ0ryixdp7SvvReHl55JUqQ='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
 'Strict-Transport-Security': 'max-age=31536000',
 'Cache-Control': 'no-store',
 'Referrer-Policy': 'no-referrer',
 'X-Content-Type-Options': 'nosniff',
 'X-Frame-Options': 'DENY',
 'X-Robots-Tag': 'noindex, nofollow, noarchive',
 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function mailDeskUrl(value) {
 const url = new URL(value);
 httpsOrigin(url.origin);
 if (url.username || url.password || url.search || url.hash || url.href !== value || /[<>"'\s]/.test(value)) throw new Error('configuration');
 return value;
}
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function page(mailDesk, pending) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio · Owner desk</title><style>
:root{color-scheme:light;font-family:system-ui,sans-serif;background:#f6f1e8;color:#17243b}*{box-sizing:border-box}body{margin:0}main{max-width:850px;margin:auto;padding:clamp(28px,7vw,80px) 24px}.brand{font-size:13px;letter-spacing:.16em;text-transform:uppercase}.mark{display:inline-block;background:#c74c27;width:12px;height:12px;border-radius:50%;margin-right:10px}h1{font-family:Georgia,serif;font-size:clamp(40px,7vw,64px);font-weight:400;letter-spacing:-.04em;margin:44px 0 14px}p{line-height:1.6;color:#526071}nav{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;margin-top:36px}a{color:inherit;text-decoration:none;border:1px solid #c5c6c5;border-radius:12px;background:#fffcf7;padding:28px;min-height:180px}a:hover{border-color:#c74c27}a:focus-visible{outline:3px solid #c74c27;outline-offset:5px}h2{font-size:22px;margin:12px 0}a p{margin:0}.number{color:#a14325;font-size:12px;letter-spacing:.12em}footer{border-top:1px solid #d3d0ca;margin-top:48px;padding-top:20px;font-size:13px;color:#526071}
</style></head><body><main><div class="brand"><span class="mark"></span>Big Sox Studios · Private</div><h1>A little room to run the studio.</h1><p>Your website and correspondence, together in one place.</p><nav aria-label="Studio administration"><a href="${CMS_URL}" rel="noreferrer"><span class="number">01 / WEBSITE</span><h2>Content editor ↗</h2><p>Update the stories, projects, and pages.</p></a><a href="${escape(mailDesk)}" rel="noreferrer"><span class="number">02 / CORRESPONDENCE</span><h2>Mail Desk ↗</h2><p>Open your private studio inbox.</p></a><a href="/membership/requests/"><span class="number">03 / MEMBERSHIP</span><h2>Membership requests</h2><p>Pending: ${escape(pending)} · Review applications privately.</p></a></nav><footer>Owner access only · Save this page as your personal admin bookmark.</footer></main></body></html>`;
}
export function createWorker(options = {}) {
 const authenticate = createAuthenticator(options);
 return { async fetch(request, env) {
  const respond = (status, body, extra = {}) => new Response(request.method === 'HEAD' ? null : body, { status, headers: { ...headers, ...extra } });
  try {
   validateConfig(env);
   const destination = mailDeskUrl(env.MAIL_DESK_URL);
   const url = new URL(request.url);
   if (url.origin !== env.APP_ORIGIN || (request.headers.has('Origin') && request.headers.get('Origin') !== env.APP_ORIGIN)) return respond(403, 'Forbidden');
   await authenticate(request, env); // Includes assets, unknown paths, and methods.
   if (url.pathname.startsWith('/membership/')) return membershipRoute(request, env, {now:options.now, respond});
   if (!['GET', 'HEAD'].includes(request.method)) return respond(405, 'Method not allowed', { Allow: 'GET, HEAD' });
   if (url.pathname !== '/') return respond(404, 'Not found');
   if (url.search) return respond(302, null, { Location: '/' });
   return respond(200, page(destination, await pendingBadge(env)));
  } catch { return respond(401, 'Unauthorized'); }
 } };
}
export default createWorker();
