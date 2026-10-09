# Big Sox Studios Members Portal — Authentication design

**Status:** Development-only. The current `/account` page is static, unauthenticated, and **must not** contain member data or imply login is working.

## Approved member sign-in experience (Oct 9, 2026)

1. **Continue with Google:** Cloudflare Access's personal Google IdP, subject to invite allowlist and MFA.
2. **Continue with Apple:** Sign in with Apple via a vetted OpenID Connect (OIDC) broker compatible with Cloudflare Access. This is **not** configured; Apple's developer-registration requirements and potential paid membership are a separate approval dependency.
3. **Email me a login code:** Cloudflare Access One-time PIN (OTP) IdP. No portal password or password reset. OTP is a *first* factor; Cloudflare independent MFA is still mandatory.

**Do not display these as functional login buttons until tested.**

Cloudflare Access supports multiple IdPs (Google, One-time PIN, and OIDC) on an application and independent MFA scoped to that application. Use an application-specific IdP list rather than exposing the default Cloudflare account IdP to family or friends.

References:
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/
- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/
- https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web

## Non-negotiable authorization and MFA guarantees

- **Invite-only / default-deny.** Only exact, approved identities may pass an Access Allow policy; no domain-wide allow rule, everyone rule, or public signup.
- **Independent MFA for every method, including email code.** Enable at org level, then configure the Members Portal app to require allowed authenticator(s) with an appropriately short MFA duration. Explicitly confirm no policy-level MFA override disables this. For initial tests use TOTP/security key/biometrics. Do not enable 'Use identity provider MFA' until AMR behavior is tested across all three methods.
- **Email verification and linked identities.** An email address shown by Google or Apple's private-email relay is not sufficient to link to an existing account. Explicitly map verified provider identities to members and require owner-approved linking. An OTP address must itself be invited and verified. The same person signing in by Google, Apple, or OTP should not automatically gain all of another account's grants.
- **Minimize PII.** Passwords reside with Google/Apple, or no password exists for OTP. The private membership store holds only minimal roles, identities, email aliases and audit records. Do not put real member emails or OAuth client secrets in public GitHub, Astro assets, CMS or static JSON.
- **Application vs service authorization.** Edge Access protects the portal, but a server-side authenticated API must separately validate Access JWT signature, expiry, issuer/audience and lookup *active* membership, and only return individually permitted services.
- **Sessions.** Short-lived tokens, server-side revocation checks, `Secure`/`HttpOnly`/`SameSite` cookies where the application owns cookies, safe redirects, CSRF protection for modifications, and `Cache-Control: no-store` on private data.
- **Separate privileges.** Members cannot access Sveltia CMS, server control plane, HA, OTTO/PORTER/TRACE endpoints, Caddy admin, or Cloudflare administration.
- **Jellyfin** still enforces its own accounts/library privileges; portal login never bypasses Jellyfin authentication.

## Safe deployment topology

- Public site: existing Astro static website on Cloudflare; stays unchanged during staging.
- Protected staging: dedicated `members-staging.bigsoxstudios.com` hostname with **no public member data** until Access + server-side verification are proven.
- Production target: protected `bigsoxstudios.com/account` and an authenticated backend; verify Cloudflare application path coverage for subpaths and direct API URLs.
- Private membership storage: D1 (or equivalent), no automatic migration/deployment. The schema in `portal/schema.sql` is a *proposal*, not a configured DB.
- Never route Jellyfin video traffic through a standard Cloudflare proxy/Tunnel without verifying applicable service terms. Preserve existing Caddy/DuckDNS until separately tested.

## Dependency and acceptance sequence

1. Cloudflare Access account setup: confirm existing account, login methods, and member-specific application settings. Keep public website, CMS and Cloudflare account members unaffected.
2. **Low-friction first:** configure the One-time PIN provider, then personal Google OAuth provider. Both may be enabled simultaneously but **not** broad-access deployed.
3. At Access controls > Access settings, enable independent MFA at organization level; explicitly configure member application MFA; test OTP+MFA and Google+MFA. Owner identity enrollment is required.
4. Apple: verify Apple Developer registration prerequisites and a compatible OIDC broker, costs, privacy relay behavior, and production callback requirements. Ask owner before any paid enrollment or payment.
5. Create private API/D1, enforce server-side role grants and audit, validate identities across methods.
6. Run full staging acceptance suite in `docs/members-portal-staging-acceptance.md`, including direct request bypasses and revoked sessions.
7. Only after owner's production approval, protect intended routes and roll out to invited members.

**Deployment gate:** No Access policy, DNS, routing, OIDC secret, service connection, or live membership can be claimed as configured from this repository alone.
