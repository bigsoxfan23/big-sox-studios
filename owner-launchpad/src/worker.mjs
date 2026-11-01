import {onboardingEnabled} from './onboarding-route.mjs';
import { membershipRoute, pendingBadge } from './membership.mjs';
import { createAuthenticator, httpsOrigin, validateConfig } from './security.mjs';

const CMS_URL = 'https://bigsoxstudios.com/admin/';
// All responses, including denials and HEAD, receive the same security policy.
const headers = {
 'Content-Type': 'text/html; charset=utf-8',
 'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'sha256-wM1JwymS/kT4MaqW4upcF6tHfQq0zU0a0QO/bMwHxXo='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
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
const MEMBERS_URL = 'https://members-staging.bigsoxstudios.com/app/manage';
const css = `:root{color-scheme:light;font-family:system-ui,sans-serif;background:#f6f1e8;color:#17243b}*{box-sizing:border-box}body{margin:0}main{max-width:960px;margin:auto;padding:clamp(24px,6vw,64px) 24px;overflow-wrap:anywhere}.brand{font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#8d3b23}h1{font:400 clamp(38px,7vw,64px)/1.1 Georgia,serif;letter-spacing:-.035em;margin:32px 0 16px}h2{font:400 26px Georgia,serif;margin:0 0 12px}p{line-height:1.6;color:#526071}.attention{background:#f2dfce;border:1px solid #cda784;padding:24px;border-radius:16px;margin:32px 0}.attention p{margin:8px 0 20px}.button{display:inline-flex;align-items:center;min-height:44px;border-radius:8px;background:#8d3b23;color:#fff;padding:12px 18px;text-decoration:none;font-weight:600}nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.card{color:inherit;text-decoration:none;border:1px solid #c5c6c5;border-radius:16px;background:#fffcf7;padding:26px;min-height:170px}.card:hover{border-color:#8d3b23;background:#fff}.card p{margin:0}.eyebrow{display:block;color:#8d3b23;font-size:12px;letter-spacing:.1em;margin-bottom:16px}a:focus-visible{outline:3px solid #8d3b23;outline-offset:4px}footer{display:flex;gap:12px 24px;flex-wrap:wrap;border-top:1px solid #d3d0ca;margin-top:40px;padding-top:20px}footer a,.back{color:#17243b;display:inline-flex;align-items:center;min-height:44px}article{background:#fffcf7;border:1px solid #c5c6c5;border-radius:16px;padding:24px;margin:24px 0}.status{font-weight:600;color:#8d3b23}@media(max-width:560px){main{padding:24px 18px}nav{grid-template-columns:1fr}.card{min-height:140px;padding:22px}}`;
async function presentation(body) {
 const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(css)))));
 return {body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Big Sox Studios · Owner Dashboard</title><style>${css}</style></head><body><main>${body}</main></body></html>`,csp:`default-src 'none'; script-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`};
}
function page(mailDesk, pending, onboarding) {
 const count = /^\d+$/.test(pending) ? Number(pending) : null;
 const attention = count===null ? 'The request count is unavailable. Open the queue to check.' : count===0 ? 'You’re all caught up. No new membership requests.' : `${count} new membership ${count===1?'request is':'requests are'} waiting for your review.`;
 return presentation(`<div class="brand">Big Sox Studios · Private</div><h1>Welcome back, Greg.</h1><p>Here's what's happening around your studio.</p><section class="attention" aria-labelledby="attention"><h2 id="attention">Needs your attention</h2><p>${attention}</p><a class="button" href="/membership/requests/">Review membership requests</a></section><nav aria-label="Studio administration"><a class="card" href="/membership/requests/"><span class="eyebrow">01 / PEOPLE</span><h2>Membership Requests</h2><p>Review new applications.</p></a><a class="card" href="${onboarding?'/membership/members/':MEMBERS_URL}"><span class="eyebrow">02 / MEMBERSHIP</span><h2>Members</h2><p>Manage people and access.</p></a><a class="card" href="${escape(mailDesk)}" rel="noreferrer"><span class="eyebrow">03 / CORRESPONDENCE</span><h2>Mail Desk ↗</h2><p>Read and send messages.</p></a><a class="card" href="/services/"><span class="eyebrow">04 / AROUND THE STUDIO</span><h2>Services</h2><p>Jellyfin and future apps.</p></a></nav><footer><a href="${CMS_URL}" rel="noreferrer">Website Editor ↗</a><a href="/cdn-cgi/access/logout">Sign out</a></footer>`);
}
function servicesPage(onboarding) {
 return presentation(`<a class="back" href="/">← Owner Dashboard</a><div class="brand">Big Sox Studios · Private</div><h1>Services</h1><p>A little more from your studio.</p><article><h2>Jellyfin</h2><p class="status">Manual setup</p><p>Create each account in Jellyfin yourself. Website membership and Jellyfin access are separate.</p><p>Provisioning and welcome-email tracking are not connected yet. This page does not create accounts or grant access.</p><a class="button" href="${onboarding?'/membership/members/':MEMBERS_URL}">Open Members</a></article><article><h2>Palworld</h2><p>Coming Soon</p></article><footer><a href="/">Owner Dashboard</a><a href="/cdn-cgi/access/logout">Sign out</a></footer>`);
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
   const ownerSession=await authenticate(request, env); // Includes assets, unknown paths, and methods.
   if (url.pathname.startsWith('/membership/')) return membershipRoute(request, env, {now:options.now, respond, expiresAt:ownerSession.expiresAt});
   if (!['GET', 'HEAD'].includes(request.method)) return respond(405, 'Method not allowed', { Allow: 'GET, HEAD' });
   if (!['/','/services/'].includes(url.pathname)) return respond(404, 'Not found');
   if (url.search) return respond(302, null, { Location: url.pathname });
   const rendered = await (url.pathname==='/services/' ? servicesPage(onboardingEnabled(env)) : page(destination, await pendingBadge(env),onboardingEnabled(env)));
   return respond(200, rendered.body, {'Content-Security-Policy':rendered.csp});
  } catch { return respond(401, 'Unauthorized'); }
 } };
}
export default createWorker();

