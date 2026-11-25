# Task #12 — Member email-OTP staging release gates (proposal, NOT approved)

**Status:** Source-only planning evidence, November 1, 2026. No Access/Worker settings have been changed. Do **not** run this as a deployment script or treat a preflight result as authorization. Task #12 is still IN PROGRESS.

## Current verified systems (read-only Cloudflare/API snapshot)

- Access application: `42fd6150-5f0e-4a1c-a0ba-952148b73b18` for `members-staging.bigsoxstudios.com`, with a 24h session.
- Independent MFA at the **application** level remains **enabled**: biometrics, security key or TOTP. Existing policies: exact-Owner `b3cf1b27-c1ac-4a7a-adb7-f31c344b47a0` and controlled staging recipient `9c7c5212-f937-49b8-9e8b-38bd025ab8e9`. **No approved-Member allow policy exists.**
- The app offers One-time PIN IdP `60daf8e5-5b08-4fb3-9746-76f8ac5046b7` and Google IdP `aa4bb6f4-7d18-4bf8-a5ee-074e073dbb1b`. Offering Google as an IdP does **not** establish a verified, authorized Member Google identity contract.
- The deployed `big-sox-studios-members-staging` Worker is still version `4010b907-c453-4867-b0c9-f300cf115095`, with D1 `DB=43a8a15b-e195-4712-9198-1dcc9f0152af`. It has **no** `APPROVED_REQUESTS_DB`, `PORTAL_APPROVED_MEMBERS`, `PORTAL_SIMPLIFIED_MEMBER_UI`, or explicit OTP custom-host/approved-request bindings. It continues the prior controlled-invitation staging behavior.
- The existing Owner staging Worker, Owner Access app/policy, all real Members and both production services are out of scope for this release preparation.

## Minimum proposed Access change (requires Greg's separate approval)

1. Add a **separate** Member allow policy attached only to the existing Members staging application. Its **Include** rules must consist solely of the exact email addresses Greg has approved for this controlled release. No `Everyone`, `email_domain`, IP/country-only, broad group, or OTP-login-method-only Include selector.
2. Require `login_method` for the **existing One-time PIN IdP** `60daf8e5-5b08-4fb3-9746-76f8ac5046b7` on the Member policy. Verify login with Google fails this particular Member policy even when the same email is supplied.
3. To deliver the approved simple **email-code-only** experience without App Launcher MFA enrollment, review an optional **policy-level** independent-MFA exemption limited to that exact Member policy. Cloudflare documents policy-over-application MFA precedence. **Never** turn off app-wide MFA or alter the exact-Owner policy/MFA. Require Greg's explicit consent to this Member-specific exception and test its precedence and policy overlap with Owner and controlled test recipient before enabling it.
4. Re-read the complete Access policy/app inventory after any future approved change and again after the browser test, including other applications/host-routing conflicts. Unapproved policy drift, subject overlap, wrong Login Method or audience, and unexpected additional allow policies block release. Owner and Member policies must be disjoint.
5. Any production equivalent is a **new, separate approval**, not inherited from staging consent.

References: [Cloudflare Access login method restrictions](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/); [Cloudflare independent MFA policy precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/).

## Minimum proposed Worker/readiness change (also requires separate approval where applicable)

- Review an immutable PR72→PR75 source candidate and deploy only the separately approved Members staging release after CI, independent security review, current backups, rollback, and source-to-active-Worker readback. Source code is **not** a deployed release.
- Preserve the current Members D1 `43a8a15b-e195-4712-9198-1dcc9f0152af`; add a **separate, verified D1 binding** `APPROVED_REQUESTS_DB` to the existing isolated requests database `48b0a0cc-40ad-4495-8883-a42b4a938b71`, without crossing production or duplicating datasets. The approved request/source ID `APPROVED_REQUESTS_ID` must equal that latter UUID; `APPROVED_MEMBER_DB_ID` must equal the former.
- Pin `APP_ORIGIN=https://members-staging.bigsoxstudios.com`, trusted `ACCESS_ISSUER` and the **distinct Member** `ACCESS_AUDIENCE` to the actual application readback; configure an exact `OTP_CUSTOM_HOSTS` list containing that one custom host (never a direct `workers.dev` host), and verify runtime `ctx.access.getIdentity()` works for the **direct Access-authenticated Worker invocation**. Do not trust spoofable forwarded email/identity headers or the old invite claim as approved-Member authority.
- `PORTAL_APPROVED_MEMBERS=enabled-12-approved` and `PORTAL_SIMPLIFIED_MEMBER_UI=enabled-12` must remain **OFF** pending independently verified, Greg-approved staging release. A simulated welcome can never activate access.
- First OTP login must match an exact approved request and Member email, manual Jellyfin readiness, a **real live accepted** welcome-intent receipt, one-use identity binding and fresh signed JWT. Recheck D1 authorization on every request. A Jellyfin link requires readiness **and** an explicit service grant; neither login nor provider acceptance creates a Jellyfin account or grant.
- Google remains out of scope until its actual signed upstream subject and email-claim contract is independently established and owner-approved. Avoid account linking by email alone.

## Preflight and acceptance matrix

New `portal/approved-member-staging-readiness.mjs` is a **pure, snapshot-only, always-BLOCKED evaluator**. It does not authenticate, grant membership, mutate D1, create a deployment receipt or call external services. A synthetically consistent snapshot is still `status=BLOCKED` with mandatory live-evidence and separate approval blockers. Every member/Owner/browser action must independently enforce its live checks. Do not promote a snapshot result to an Access authorization or an approval.

Before an approved future staging switch, require independent tests for exact Owner preservation; empty/malformed/partial or stale snapshots; broad policy rejection; OTP-vs-Google discrimination; application vs Member-policy MFA precedence; separate D1 IDs/source revision; wrong host/audience; Member request withdrawal/PII retention; no Jellyfin readiness; simulated/failed/UNKNOWN welcome; concurrent first login/ID binding and revocation; missing grant; expired sessions; direct Worker/preview-host bypass; and iPhone Safari email-code sign-in. Verify original Owner/Member counts, audit append-only, no real sends or grants without Greg's explicit approval, and previous Worker rollback.

**Release blockers now:** No approved Member Access allow policy, Member app still requires independent MFA, necessary approved-request D1 Worker binding/flags absent, no real accepted welcome intent, no real Member grants, and no authenticated Owner staging removal browser acceptance. These are deliberate stops—not failed production changes.

**Owner approval required before** Access permission expansion or Member-specific MFA waiver, new credentials, real Member activation/grant, real email, production merge/deploy, any new spending, or final Task12 acceptance.
