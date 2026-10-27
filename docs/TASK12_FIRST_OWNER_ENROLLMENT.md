# Task #12: Cloudflare MFA reliance and first Owner confirmation

Approved source-only change, 2026-10-26. Big Sox Studios relies on the already
configured Cloudflare Access MFA. This replaces the earlier custom policy
attestation and separate Owner approval callbacks. It does not change or disable
Cloudflare MFA. JWT/OTP checks establish the Access session and identity; they
are not an independent MFA attestation or a live policy readback.

`members-portal-staging/owner-enrollment-assembly.mjs` reuses the portal enrollment
and dashboard modules. No deployment config selects it. The existing staging
`worker.mjs` stays safe-off for `/app`, and its config has no D1 binding. There
is no feature flag to bypass authentication or authorization.

A reviewed source composition must supply `target` (exact allowed Owner email,
`role: 'owner'`, existing approved `databaseId`, reviewed source `revision`, and
unique 32–128 character URL-safe `nonce`) and a shared HMAC SHA-256 CryptoKey of
at least 256 bits with sign/verify usages. No recipient or key defaults exist.
Do not obtain the target from browser input or infer it from a login. Bind only
the existing dedicated Phase2 DB; `BOOTSTRAP_DATABASE_ID` must match the reviewed
target. `PORTAL_MODE` must be `staging-enrollment-source`; it is a restriction,
not an authentication bypass. Missing key returns 404; missing target/DB or any
identity ambiguity denies access.

The assembly pins issuer, exact custom host and exclusive members audience in
source. It rejects direct workers.dev, wrong Host/Origin, wrong issuer/audience,
invalid signature/time, absent runtime Access context, a non-`onetimepin` runtime
provider, and any mismatch between signed JWT email, runtime email and the
reviewed target. No normalization, auto-linking or automatic JIT occurs.

1. GET `/owner/enroll` authenticates a JWT issued less than five minutes ago and
   checks that all membership tables and the receipt table are pristine. It
   performs SELECTs only and shows a confirmation form. It sets a random
   `__Host-first-owner-confirm` cookie (Secure, HttpOnly, Path=/, SameSite=Strict,
   five minutes, no Domain) and a signed five-minute HMAC ticket bound to that
   cookie, exact signed session and reviewed enrollment context.
2. The user's confirm click submits POST. The handler checks exact Origin,
   same-origin navigation/document/user Fetch Metadata, URL-encoded form shape,
   bounded body, HMAC, single cookie, expiry and unchanged context. It repeats
   authentication, fresh-session and pristine-state checks before writing.
3. One INSERT into `first_owner_bootstrap` uses the already-applied triggers to
   create the singleton receipt, active Owner, exact OTP binding and immutable
   audit together. The user click is the sole Owner enrollment approval. GET,
   ordinary login and dashboard requests never create a member.
4. A readback verifies the created rows. Commit errors, including ambiguous
   readback failures, return 503 with an inspection instruction. Never retry an
   ambiguous write automatically. Replays, concurrent confirmations, existing
   members and revoked Owners cannot bootstrap again.

The existing schema is unchanged. See [receipt meanings](TASK12_FIRST_OWNER_BOOTSTRAP.md).
Private no-store/noindex responses do not display JWTs, tickets outside the form,
or the Owner's email. Tickets and cookies must not be logged.

## Separately authorized staging work still required

Review the exact target email, existing Phase2 binding, source revision, nonce,
shared secret provisioning and entrypoint wiring. The DB is reported pristine
with the migration already applied: do not reapply it or create another DB.
Review the existing protected Access route and MFA configuration without
changing/disabling MFA. A real authorized staging deployment and actual browser
session are still needed to verify runtime `ctx.access`, cookie/Fetch Metadata
behavior (including Safari), and the Owner's explicit confirmation click.
Afterward verify the singleton receipt/identity/audit and dashboard; test denied
uninvited, wrong-provider and revoked sessions and the rollback procedure.
These are future authorized actions, not actions performed by this source task.
No push, merge, deployment, remote DB write or actual enrollment occurred here.
## Ready-to-review staging release candidate — October 26, 2026

This **source-only** candidate keeps the existing Big Sox Studios Members staging
Worker and exact already-existing Phase 2 D1 binding, with no additional
Cloudflare account, identity provider, database or paid service.

- New entrypoint: `members-portal-staging/owner-staging-release.mjs`
- Candidate only config: `members-portal-staging/wrangler.owner-release.toml`
- Existing Worker: `big-sox-studios-members-staging`
- Custom host: `members-staging.bigsoxstudios.com`
- D1 binding: `DB`, existing `bss-members-portal-phase2` only.
- Source revision label: `task12-cloudflare-mfa-20261026-v1`.

The entrypoint leaves every existing Phase 1 and owner diagnostic route to the
unchanged safe Worker. Protected `/app` requires the pinned D1 binding and signed OTP identity;
`/owner/enroll` additionally requires the reviewed target and the nonextractable
imported HMAC key. Retiring enrollment-only secrets must not affect `/app`. There is no user creation
until the actual owner's browser POST. Both custom and direct worker routes
still enforce origin, audience and runtime Access context. Unknown or missing
secret/binding returns no-store 503. Normal dashboard access checks D1 every
request, so revoked members immediately lose access.

**Do not deploy this config until the Owner explicitly approves deployment.**
When authorized, first review the final PRs/source tree and the existing
Cloudflare app MFA setting (already observed by the Owner), confirm the exact
Worker and live D1, and provision `OWNER_ENROLLMENT_HMAC_KEY` (32 random bytes
encoded base64url) plus stable `OWNER_ENROLLMENT_NONCE` (32 random bytes
encoded base64url) as Worker secrets, never in files/logs. Reuse the existing
`DIAGNOSTIC_OWNER_EMAIL` secret, do not expose it in logs. Preserve the current
staging Worker version for rollback. Review upload bindings and ensure secret
preservation, then deploy the reviewed source. No remote D1 seed/insert by CLI.

After approved deployment, the Owner starts a fresh Cloudflare OTP + MFA session,
opens `https://members-staging.bigsoxstudios.com/owner/enroll`, and clicks
**Confirm first Owner enrollment**. Do not ask the Owner to paste any token,
cookie, email code or secret into ChatGPT. GET should create zero database rows.
After the click, query only receipt counts and status, confirm the immutable
binding and audit, then check `/app` in Safari. If POST outcome is ambiguous,
never retry automatically; inspect the singleton receipt first. Remove the
temporary enrollment route/key after acceptance while retaining the D1 audit.
Unauthorized, direct service, wrong-provider, stale-session and revoked tests
are mandatory before a production rollout.

No deployment, Owner account insertion or browser acceptance is claimed here.

**Configuration verifier correction (Oct 26, 2026):** The signed-JWT verifier also requires the *separate* `OWNER_ACCESS_AUDIENCE` value, distinct from the Members application. The candidate config pins the exact non-secret audience from the existing deployed Owner Launchpad `wrangler.production.toml`. Do not substitute the Members audience or an arbitrary placeholder. A focused release-config regression test compares the two files.

**October 27 staging sign-in correction:** Greg saw the generic enrollment-unavailable page on the initial GET. The previous bootstrap required Cloudflare Access JWT issuance within five minutes, despite the application's 24-hour MFA session policy. It now accepts an unexpired, properly signed Access JWT during Cloudflare's allowed session duration, while still checking exact OTP provider, user identity and audience. The browser confirmation ticket/POST remains limited to 300 seconds from the GET, and no account is created before the Owner's explicit click. This addresses a likely cause of the observed failure; recheck in the owner's actual browser before claiming resolution.

**Safe cross-site navigation correction:** The enrollment GET is a read-only, Access-protected browser page and may legitimately be reached from a cross-site link or an Access sign-in redirect. It no longer rejects such top-level GETs solely due to Sec-Fetch-Site. The first Owner can be created **only** by the separately validated same-origin, user-initiated POST with the HMAC ticket and cookie; cross-site POST remains denied and is regression-tested.
