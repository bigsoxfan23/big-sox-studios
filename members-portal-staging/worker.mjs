// Big Sox Studios Members Portal, staging only.
// The two Access applications have distinct audiences. Never deploy this file
// to the public website Worker or use an unprotected preview route.
const ACCESS_ISSUER = 'https://old-hill-995d.cloudflareaccess.com';
const ACCESS_CERTS = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const AUDIENCES = Object.freeze({
  'members-staging.bigsoxstudios.com': 'f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe',
  'big-sox-studios-members-staging.fridman-greg.workers.dev': 'f4057b183ae0b354ff3e9f161839fbf516e54c33c7714db645c3d5ac950969df',
});

let cachedKeys = null;
let keysExpireAt = 0;

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid token encoding');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function accessKeys(fetcher = fetch) {
  if (cachedKeys && Date.now() < keysExpireAt) return cachedKeys;
  const response = await fetcher(ACCESS_CERTS, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Access keys unavailable');
  const body = await response.json();
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error('Access keys invalid');
  cachedKeys = body.keys;
  keysExpireAt = Date.now() + 5 * 60 * 1000;
  return cachedKeys;
}

export async function verifyAccessJwt(token, audience, fetcher = fetch) {
  if (typeof token !== 'string' || token.length > 16_384) throw new Error('Missing or oversized token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported signature');
  if (claims.iss !== ACCESS_ISSUER || !Array.isArray(claims.aud) || !claims.aud.includes(audience)) {
    throw new Error('Wrong token issuer or audience');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(claims.exp) || claims.exp <= now ||
      !Number.isInteger(claims.iat) || claims.iat > now + 60 ||
      (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now + 60))) {
    throw new Error('Token not current');
  }
  if (typeof claims.email !== 'string' || claims.email.length > 254 || !claims.email.includes('@')) {
    throw new Error('Missing verified identity');
  }
  const keys = await accessKeys(fetcher);
  const key = keys.find(item => item.kid === header.kid && item.kty === 'RSA' && item.use !== 'enc');
  if (!key) throw new Error('Signing key not found');
  const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('Invalid token signature');
  return { email: claims.email };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const icon = (name) => ({
  sparkle: '<path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z"/><path d="m20 18 .5 1.5L22 20l-1.5.5L20 22l-.5-1.5L18 20l1.5-.5L20 18Z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
  game: '<path d="M7 8h10a4 4 0 0 1 3.9 3.1l1 5A2.4 2.4 0 0 1 18 18l-3-2H9l-3 2a2.4 2.4 0 0 1-3.9-1.9l1-5A4 4 0 0 1 7 8Z"/><path d="M7 11v4m-2-2h4m7 0h.01M19 11h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  shield: '<path d="M12 2 4 5v6c0 5 3.4 8.6 8 11 4.6-2.4 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2-2.5 4m0 3h.01"/>',
}[name]);
const svg = (name, size = 24) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon(name)}</svg>`;

export function render(email) {
  const safeEmail = escapeHtml(email);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#faf5e9"><title>Members Portal · Big Sox Studios</title>
<style>
:root{color-scheme:light;--cream:#faf5e9;--paper:#fffcf5;--ink:#19232d;--muted:#64707a;--line:#ded6c8;--orange:#d97706;--amber:#f8c66e;--navy:#172534;--radius:22px}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--cream);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit}a:focus-visible{outline:3px solid var(--orange);outline-offset:4px;border-radius:5px}.skip{position:absolute;left:1rem;top:-5rem;padding:.6rem 1rem;background:var(--ink);color:white;z-index:5}.skip:focus{top:1rem}.shell{max-width:1180px;margin:auto;padding:0 28px}.topbar{border-bottom:1px solid var(--line);background:rgba(250,245,233,.94)}.topinner{min-height:82px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{text-decoration:none;display:flex;align-items:center;gap:12px;font-weight:950;letter-spacing:-.055em;line-height:.91;font-size:17px}.brandmark{height:44px;width:44px;display:grid;place-items:center;border-radius:14px;background:var(--orange);color:white;font-size:29px;font-family:Georgia,serif;transform:rotate(-7deg)}.brand small{display:block;margin-top:5px;font-size:9px;letter-spacing:.19em;font-weight:800;color:var(--orange)}.nav{display:flex;align-items:center;gap:4px}.nav a{padding:10px 13px;text-decoration:none;border-radius:12px;color:#48515a;font-size:13px;font-weight:750}.nav a:hover,.nav a.active{background:#efe5d2;color:var(--ink)}.memberpill{border:1px solid #d7c5a8;border-radius:100px;padding:10px 13px;font-size:12px;font-weight:800;white-space:nowrap}.memberpill span{display:inline-block;height:7px;width:7px;margin-right:7px;border-radius:50%;background:#72a66f}.hero{position:relative;overflow:hidden;margin-top:32px;padding:58px 62px 55px;border-radius:30px;background:radial-gradient(circle at 79% 20%,#334052 0,transparent 27%),linear-gradient(130deg,#1b2b3a,#12202d);color:#fff8ec;box-shadow:0 22px 50px #19232d1c}.hero:after{content:"";position:absolute;right:-100px;bottom:-270px;width:570px;height:570px;border:1px solid #e9a64f55;border-radius:50%;box-shadow:0 0 0 58px #e9a64f13,0 0 0 120px #e9a64f0d;pointer-events:none}.hero>*{position:relative;z-index:1}.kicker{display:flex;align-items:center;gap:8px;color:var(--amber);font-size:11px;font-weight:900;letter-spacing:.2em;text-transform:uppercase}.hero h1{max-width:700px;margin:24px 0 17px;font:normal clamp(46px,6vw,79px)/.98 Georgia,"Times New Roman",serif;letter-spacing:-.055em}.hero h1 em{font-style:italic;color:var(--amber)}.hero p{max-width:520px;margin:0;color:#e7dfd2;font-size:16px;line-height:1.7}.herofoot{display:flex;flex-wrap:wrap;align-items:center;gap:15px;margin-top:34px}.herobadge{border:1px solid #ffffff4a;border-radius:100px;padding:9px 13px;color:#fff3dc;font-size:12px;font-weight:750}.herofoot a{display:inline-flex;align-items:center;gap:9px;color:var(--amber);font-size:13px;font-weight:800;text-decoration:none}.section{margin-top:62px}.sectionhead{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.eyebrow{margin:0 0 10px;color:var(--orange);font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}h2{margin:0;font:normal clamp(32px,3.4vw,46px)/1.05 Georgia,"Times New Roman",serif;letter-spacing:-.04em}.sectionnote{max-width:390px;margin:0;color:var(--muted);font-size:13px;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px}.card{min-height:250px;padding:26px;border:1px solid var(--line);border-radius:var(--radius);background:var(--paper);box-shadow:0 10px 28px #19232d0a;display:flex;flex-direction:column}.cardtop{display:flex;justify-content:space-between;align-items:start;gap:10px}.iconbox{display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:#fbe8c9;color:#a9550b}.card:nth-child(2) .iconbox{background:#e7eced;color:#466676}.card:nth-child(3) .iconbox{background:#eee8d8;color:#74715e}.status{font-size:10px;letter-spacing:.05em;text-transform:uppercase;font-weight:850;color:#7c6541;background:#f5ead2;padding:7px 9px;border-radius:100px;white-space:nowrap}.card h3{margin:22px 0 8px;font:normal 27px/1 Georgia,serif;letter-spacing:-.03em}.card p{margin:0;color:var(--muted);font-size:13px;line-height:1.65}.cardbottom{margin-top:auto;padding-top:25px;font-size:11px;font-weight:850;color:#9a5a14;text-transform:uppercase;letter-spacing:.08em}.detailgrid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}.panel{padding:30px;border:1px solid var(--line);border-radius:var(--radius);background:var(--paper)}.panel.dark{background:var(--navy);border-color:var(--navy);color:#fff8ed}.panelhead{display:flex;align-items:center;gap:10px;color:var(--orange);font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.panel.dark .panelhead{color:var(--amber)}.panel h3{margin:18px 0 10px;font:normal 30px/1.07 Georgia,serif;letter-spacing:-.04em}.panel p{margin:0;color:var(--muted);font-size:13px;line-height:1.7}.panel.dark p{color:#d3dce0}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}.step{border-top:1px solid var(--line);padding-top:15px}.step b{display:block;color:var(--orange);font-size:11px;margin-bottom:8px}.step strong{display:block;font-size:13px;margin-bottom:5px}.step span{display:block;color:var(--muted);font-size:12px;line-height:1.5}.identity{margin-top:20px;padding:15px 17px;border:1px solid #ffffff35;border-radius:13px;background:#ffffff0d}.identity small{display:block;color:#b9c9ce;font-size:10px;text-transform:uppercase;letter-spacing:.12em;font-weight:800}.identity strong{display:block;margin-top:5px;font-size:13px;overflow-wrap:anywhere}.help{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:20px 0 65px;padding:27px 30px;border:1px solid var(--line);border-radius:var(--radius);background:#f1e8d7}.help h3{margin:0 0 7px;font:normal 27px Georgia,serif}.help p{margin:0;color:var(--muted);font-size:13px;line-height:1.6}.help svg{flex:none;color:var(--orange)}footer{border-top:1px solid var(--line);padding:25px 0 40px;color:var(--muted);font-size:12px}.footerinner{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.footerinner a{color:var(--orange);text-decoration:none;font-weight:800}@media(max-width:850px){.nav{display:none}.hero{padding:48px 38px}.cards{grid-template-columns:repeat(2,1fr)}.card:last-child{grid-column:span 2;min-height:190px}.detailgrid{grid-template-columns:1fr}}@media(max-width:600px){.shell{padding:0 17px}.topinner{min-height:72px}.brand{font-size:14px}.brandmark{height:40px;width:40px}.memberpill{font-size:10px;padding:8px}.hero{margin-top:16px;padding:38px 25px 42px;border-radius:23px}.hero h1{font-size:48px}.hero p{font-size:14px}.hero:after{right:-270px;bottom:-330px}.section{margin-top:48px}.sectionhead{display:block}.sectionnote{margin-top:11px}.cards,.steps{grid-template-columns:1fr}.card,.card:last-child{grid-column:auto;min-height:216px}.detailgrid{gap:14px}.panel{padding:25px}.steps{gap:10px}.step{padding-top:12px}.help{align-items:start;padding:23px}.help svg{width:22px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media(max-width:850px){.topinner{flex-wrap:wrap}.nav{display:flex;order:3;width:100%;overflow-x:auto;padding-bottom:10px}.nav a{white-space:nowrap}}
</style></head><body><a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="shell topinner"><a class="brand" href="/" aria-label="Big Sox Studios Members home"><span class="brandmark">B</span><span>BIG SOX<br>STUDIOS<small>MEMBERS PORTAL</small></span></a><nav class="nav" aria-label="Main navigation"><a class="active" href="#main">Overview</a><a href="#services">Services</a><a href="#membership">Membership</a><a href="#security">Account & security</a><a href="#help">Help</a></nav><span class="memberpill"><span></span>Staging access</span></div></header>
<main id="main" class="shell"><section class="hero" aria-labelledby="welcome"><div class="kicker">${svg('sparkle',17)} Your corner of the studio</div><h1 id="welcome">Welcome to<br><em>Big Sox Studios.</em></h1><p>A home for the people and experiences that make this little studio bigger. Your members space is taking shape.</p><div class="herofoot"><span class="herobadge">Invite-only · Phase 1 preview</span><a href="#services">Explore what’s coming ${svg('arrow',16)}</a></div></section>
<section id="services" class="section" aria-labelledby="services-title"><div class="sectionhead"><div><p class="eyebrow">01 / Studio services</p><h2 id="services-title">Good things are coming.</h2></div><p class="sectionnote">These are previews of planned services. No service connection or live availability data is active in this portal yet.</p></div><div class="cards"><article class="card"><div class="cardtop"><span class="iconbox">${svg('film')}</span><span class="status">Not connected</span></div><h3>Jellyfin</h3><p>A personal media space for members with their own approved Jellyfin account and library access.</p><div class="cardbottom">Integration planned</div></article><article class="card"><div class="cardtop"><span class="iconbox">${svg('game')}</span><span class="status">Not connected</span></div><h3>Palworld</h3><p>Game connection details and helpful information for members when this service is approved and ready.</p><div class="cardbottom">Integration planned</div></article><article class="card"><div class="cardtop"><span class="iconbox">${svg('grid')}</span><span class="status">Coming later</span></div><h3>More from the studio</h3><p>Other Big Sox Studios experiences may appear here as they are approved for members.</p><div class="cardbottom">No active integrations</div></article></div></section>
<section id="membership" class="section" aria-labelledby="membership-title"><div class="sectionhead"><div><p class="eyebrow">02 / Your membership</p><h2 id="membership-title">A little more, together.</h2></div></div><div class="detailgrid"><article class="panel"><div class="panelhead">${svg('sparkle',19)} How membership works</div><h3>Invited in. Thoughtfully connected.</h3><p>Membership is for people personally approved by Big Sox Studios. It can bring eligible services together in one place, with access to each service granted separately. This preview does not grant access to Jellyfin, Palworld, or any other service.</p><div class="steps"><div class="step"><b>01</b><strong>Get invited</strong><span>The studio approves your identity and invitation.</span></div><div class="step"><b>02</b><strong>Sign in securely</strong><span>Use an approved sign-in method and complete Cloudflare MFA.</span></div><div class="step"><b>03</b><strong>See your access</strong><span>Only individually granted services will appear when integrations launch.</span></div></div></article><article id="security" class="panel dark"><div class="panelhead">${svg('shield',19)} Account & security</div><h3>Your space, protected.</h3><p>Cloudflare Access protects this staging portal. Sign-in and an independent MFA check are required by the existing Access policy. Your portal session does not replace separate accounts required by individual services.</p><div class="identity"><small>Verified signed-in identity</small><strong>${safeEmail}</strong></div><div class="identity"><small>Portal status</small><strong>Staging preview · Service grants not active</strong></div></article></div></section>
<aside id="help" class="help" aria-labelledby="help-title"><div><h3 id="help-title">Need a hand?</h3><p>For an invitation, sign-in question, or service access issue, contact your Big Sox Studios host directly. Member support tools are planned for a later phase.</p></div>${svg('help',35)}</aside></main><footer><div class="shell footerinner"><span>© Big Sox Studios · A small studio for big ideas.</span><span>Members Portal · Staging preview · <a href="https://bigsoxstudios.com">Visit the studio</a></span></div></footer></body></html>`;
}

const securityHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const audience = AUDIENCES[url.hostname];
    if (!audience || url.protocol !== 'https:') return new Response('Not found', { status: 404, headers: securityHeaders });
    let identity;
    try {
      identity = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), audience);
    } catch {
      return new Response('Access verification required', { status: 403, headers: securityHeaders });
    }
    if (url.pathname !== '/') return new Response('Not found', { status: 404, headers: securityHeaders });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...securityHeaders, Allow: 'GET, HEAD' } });
    return new Response(request.method === 'HEAD' ? null : render(identity.email), {
      headers: { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
