# Members Portal — Authentication foundation

Status: **prototype branch only; NOT AUTHENTICATED and NOT READY TO DEPLOY**.

## Security boundary

The existing Astro site is statically generated and publicly served. Static HTML, client-side role checks, or hiding navigation **cannot** protect member data. Do not publish real member information or status feeds to this site until an authenticated server-side gateway is in place.

## Required identity behavior

- Invite-only: deny all identities by default; owner explicitly approves a stable provider identity, not merely a display name.
- Google and Apple sign-in must both be tested end-to-end with the chosen broker. Do not assume Apple is natively supported by Cloudflare Access; validate supported provider configuration first.
- Enforce MFA independently at the gateway (or verify an authoritative MFA assurance claim) for **every** login. Google/Apple login alone does not prove MFA.
- No application passwords. Identity provider stores credentials; portal stores minimal approved user identity, role, permissions and audit events in a private server-side store.
- Do not trust email alone when linking identities across providers; require explicit verified account linking and owner approval.
- Server-side authentication and authorization on every protected request. Validate identity tokens (issuer, audience, signature, expiry), sessions and revocation. Use Secure, HttpOnly, SameSite cookies and CSRF protection where applicable.
- No user PII, tokens, API keys or allowlists in this public repository, static build, client JavaScript or public CMS.
- CMS OAuth remains separate; a portal account must never imply editor privileges.

## Deployment gate

1. Select and verify a provider/broker supporting Google, Apple and independently enforced MFA; document pricing and availability.
2. Set up separate staging hostname protected by default-deny policy; do not expose a public member dashboard while unfinished.
3. Test authorized owner, uninvited identity, wrong provider, missing MFA, expired session, suspended account, direct URL bypass, and revocation.
4. Add authenticated server-side portal backend and private membership storage. Only then connect status snapshots.
5. Keep Jellyfin authentication separate; evaluate streaming hostname and Cloudflare terms separately, preserving the existing DuckDNS/Caddy route until acceptance.
6. Require owner approval before any production security policy, DNS, tunnel or server firewall changes.

The /account page on this branch is intentionally a noninteractive placeholder. **Do not describe it as a working login.**
