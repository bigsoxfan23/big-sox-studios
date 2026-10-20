# Big Sox Studios Members Portal — Staging acceptance

Not deployed. Mark these complete **only after real staging evidence**, not on design or simulated tests.

## Login methods / MFA

- [ ] Personal Google login works and uninvited Google identities are denied.
- [ ] Email One-time PIN works and uninvited recipient addresses receive no access.
- [ ] Independent MFA is mandatory **after both Google login and email-code login**.
- [ ] Cancelled/failed/skipped MFA is denied; users cannot bypass MFA via another Access policy, existing session or provider.
- [ ] Apple login is integrated via compatible OIDC provider; Apple developer registration and costs approved.
- [ ] Apple MFA is mandatory; test Hide My Email/private relay and repeat sign-in.
- [ ] First-time enrollment is secure, including recovery and stolen-credential scenarios.
- [ ] Nonmember Cloudflare accounts do not receive portal access.
- [ ] Only member-approved IdPs appear for this application; no unexpected Cloudflare default login.

## Account ownership / authorization

- [ ] Only owner can approve/suspend identities and grant services.
- [ ] All members start denied; no service access until granted.
- [ ] An approved Google account cannot automatically claim another person's Apple/OTP member account via a shared email or display name.
- [ ] Identity linking requires explicit owner approval and verified provider identity.
- [ ] Suspended/deleted users lose edge and backend access promptly, including sessions.
- [ ] Backend independently validates Access JWT signature, issuer, audience, expiry, and active member role.
- [ ] Direct API access and forged auth headers fail; client side / static HTML never contains member data.
- [ ] Invalid services and unauthorized admin actions return no protected data.

## Browser / infrastructure

- [ ] Private responses no-store; token/session cookie, CSRF, redirect, and error handling verified.
- [ ] iOS Safari, desktop Chrome, logout and session expiry pass.
- [ ] Public website, Sveltia CMS and existing auth unchanged.
- [ ] Status response has no internal addresses, ports, logs, or other members' personal data.
- [ ] Member portal traffic does not expose private infrastructure management interfaces.
- [ ] Jellyfin's own accounts continue to protect libraries; video delivery reviewed separately.
- [ ] Rollback and audit logging verified.

## Account-level steps that require owner access or approval

1. Google OAuth setup: project, credentials and Cloudflare callback; save client secret **only** in the authorized provider's secure settings.
2. Add Cloudflare **One-time PIN** identity provider.
3. Turn on independent MFA in Access settings and enroll owner's authenticator.
4. Apple: identify Apple Developer account eligibility and vet an OIDC identity broker before registering any paid capability.
5. Approve protected staging hostname and Access application policy before introducing real identities.
6. Approve final production policy and domain routing only after all tests pass.

Never paste secrets or member email addresses into chat, public GitHub, or screenshots.
