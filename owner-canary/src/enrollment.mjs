import { authenticateOwnerIdentity } from './auth.mjs';
import { enrollmentAssets } from './enrollment-assets.mjs';
import { site, exact, input, session, context, sha256, stepupStore, fresh, registration,
 fingerprint, assertion, authenticationOptions, reply, stepupHeaders } from './stepup.mjs';

const deny = value => { if (!value) throw new Error('denied'); };
// Offline signed-key/clock seams only. Production fixes these dependencies below.
export function createEnrollment({ verify = authenticateOwnerIdentity, now = () => Math.floor(Date.now() / 1000) } = {}) {
 return { async fetch(request, env) {
  try {
   const identity = await verify(request, env), settings = site(env, identity);
   deny(identity.expires > now());
   const url = new URL(request.url);
   deny(url.origin === settings.origin && !url.search && !url.hash);
   if (request.method === 'GET' && Object.hasOwn(enrollmentAssets, url.pathname)) {
    deny(!request.headers.has('Origin') || request.headers.get('Origin') === settings.origin);
    // Access/OAuth can return a cross-site top-level document navigation.
    // Only the static root document gets this exception, after owner/origin checks.
    const ownerNavigation = url.pathname === '/' && request.headers.get('Sec-Fetch-Site') === 'cross-site'
     && request.headers.get('Sec-Fetch-Mode') === 'navigate' && request.headers.get('Sec-Fetch-Dest') === 'document';
    deny(!request.headers.has('Sec-Fetch-Site') || ['none', 'same-origin'].includes(request.headers.get('Sec-Fetch-Site')) || ownerNavigation);
    const asset = enrollmentAssets[url.pathname];
    return new Response(asset.body, { headers: { ...stepupHeaders, 'Content-Type': asset.type } });
   }
   if (url.pathname === '/stepup/session') return await session(request, env, identity, now);
   const path = url.pathname;
   deny(['/enroll/register/options', '/enroll/register/verify', '/enroll/prove/options', '/enroll/prove/verify'].includes(path));
   const body = await input(request, env, path), store = stepupStore(env.CANARY_DB);
   const config = await sha256(JSON.stringify({ ...settings, issuer: env.ACCESS_TEAM_HOST, audience: env.ACCESS_AUD }));
   const base = await context(request, env, identity, 'register', config, {}, now);
   if (path === '/enroll/register/options') {
    exact(body, []);
    const row = await store.issue(base, now());
    return reply({ id: row.id, publicKey: { challenge: row.challenge, rp: { id: settings.rpID, name: 'Owner canary enrollment only' },
     user: { id: row.id, name: settings.email, displayName: 'Owner' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
     timeout: 120000, attestation: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } });
   }
   if (path === '/enroll/register/verify') {
    exact(body, ['id', 'response']);
    const row = await store.get(body.id); fresh(row, base, identity, now());
    const record = await registration(body.response, row, settings), fp = await fingerprint(record);
    fresh(row, base, identity, now());
    deny(await store.verify(row, now()));
    deny(identity.expires > now() && await store.consume(row.id, base, now()));
    deny(await store.addCandidate(row, record, fp, base, now()));
    // Opaque continuation handle only; public ID is generated after possession.
    return reply({ candidateHandle: row.id, trusted: false, possessionVerified: false });
   }
   exact(body, path.endsWith('options') ? ['candidate'] : ['candidate', 'id', 'response']);
   const candidate = await store.candidate(body.candidate);
   deny(candidate && candidate.context === base && candidate.created <= now() && candidate.expires > now() && candidate.proof === null);
   const record = JSON.parse(candidate.record);
   const ctx = await context(request, env, identity, 'possession', config, { candidate: candidate.id, fingerprint: candidate.fingerprint }, now);
   if (path.endsWith('options')) {
    const row = await store.issue(ctx, now());
    return reply({ id: row.id, publicKey: authenticationOptions(row, record) });
   }
   const row = await store.get(body.id); fresh(row, ctx, identity, now());
   await assertion(body.response, row, record);
   fresh(row, ctx, identity, now());
   deny(await store.verify(row, now()));
   deny(identity.expires > now() && await store.consume(row.id, ctx, now()));
   const proven = await store.proveCandidate(candidate.id, base, row.id, now()); deny(proven);
   return reply({ candidateID: proven.public_id, fingerprint: proven.fingerprint, record, trusted: false,
    possessionVerified: true, sendAuthority: false,
    instruction: 'Confirm this exact full fingerprint in owner chat for a separately reviewed code pin. This does NOT confirm or authorize any email.' });
  } catch { return reply({ error: 'enrollment_unavailable' }, 503); }
 } };
}
// No sender, transport, provider key, or campaign ledger dependency in this graph.
export default createEnrollment();
