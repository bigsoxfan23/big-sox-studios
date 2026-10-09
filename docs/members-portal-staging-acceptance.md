# Members Portal — Staging acceptance checklist

This checklist must be completed before enabling any real member data or service access.

## Identity and MFA
- [ ] Confirm Google sign-in through selected identity broker.
- [ ] Confirm Apple sign-in through selected identity broker (not assumed from dashboard sign-in support).
- [ ] Prove independently enforced MFA for **both** providers, including fresh enrollment and repeat sign-in.
- [ ] Block accounts that skip, cancel, or fail MFA.
- [ ] Verify identity linking cannot be hijacked using the same email across providers.
- [ ] Verify recovery/reset procedures do not silently bypass MFA.

## Authorization
- [ ] Unknown identities denied, even with valid provider login and MFA.
- [ ] Approved member sees only explicitly granted services.
- [ ] Suspended member loses access to existing sessions promptly.
- [ ] All protected endpoints verify authorization on the server.
- [ ] Owner actions require reauthentication or step-up for high-risk changes.
- [ ] Never expose CMS authoring or infrastructure administrative access to members.

## Browser/session
- [ ] Cookies Secure, HttpOnly, appropriately SameSite, narrowly scoped.
- [ ] Test CSRF, token issuer/audience/expiry, replay and redirect validation.
- [ ] No member data in static HTML, static JSON, client bundles, caches, previews or logs.
- [ ] Test mobile Safari and Chrome; logout and session expiration.
- [ ] Private responses use Cache-Control: no-store.

## Infrastructure
- [ ] Separate preview/staging and production credentials and allowlists.
- [ ] Restrict any protected hostname at the edge **and** verify authorization in backend.
- [ ] Status API exposes only approved, minimal health data; no internal hostnames, ports, IPs, metrics, or secrets.
- [ ] Confirm Cloudflare streaming terms and Jellyfin compatibility before changing public routing.
- [ ] Keep current Jellyfin route intact until replacement verified.
- [ ] Rollback plan documented and tested.

## Manual account-level setup needed later
1. Identity-provider application registrations and callback URLs.
2. Access/MFA policies, private credentials and optional D1 binding.
3. Owner identity enrollment and MFA test.
4. Approval of production hostname, DNS, security policy and routing changes.

Never paste secrets into issues, pull requests, chat or the public repository.
