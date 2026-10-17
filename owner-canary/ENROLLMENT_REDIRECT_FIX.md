# Enrollment document return from Access

The previous static asset guard rejected every explicit `Sec-Fetch-Site: cross-site`
request, including an authenticated `GET /` with `Sec-Fetch-Mode: navigate` and
`Sec-Fetch-Dest: document`. The generic catch then returned HTTP 503 with
`{"error":"enrollment_unavailable"}` instead of HTML. A local comparison using a
synthetic RSA-signed owner JWT reproduces 503 under the original guard and 200
HTML under the corrected guard with identical request metadata.

This is a strong explanation for the reported live symptom, not proof of its
live cause: no authenticated owner browser trace was available or obtained.
No additional bounded code defect was identified in the inspected path.

The [Fetch Metadata specification](https://www.w3.org/TR/fetch-metadata/#redirects)
considers the full redirect URL chain, so a cross-site hop can leave the final
request marked `cross-site`. It also preserves `none` for navigations with no
requester, such as some address-bar redirect chains. Thus the presence of an
Access hop alone does not establish what Safari sent. Safari added Fetch
Metadata support in [Safari 16.4](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes).
Older clients or requests without Fetch Metadata retain the previous behavior.
An explicit cross-site request missing either mode or destination remains denied.

The exception applies only to the static root document under authenticated
`GET`, with all three exact header values above. It identifies a navigation
shape, not a trusted OAuth provider; no Referer/provider allowlist or new login
authority is introduced. Signed owner identity, expiry, exact application URL
origin, and any supplied Origin header must still pass. Cross-site scripts,
images, frames, fetches and script-asset navigations remain denied. The response
keeps private/no-store caching, CSP, frame denial and same-origin resource policy;
it creates no cookie, redirect, CORS allowance, candidate or campaign state.
All enrollment POST origin, Fetch Metadata, action, JSON, cookie/session and
CSRF checks are unchanged.

The first-factor Email OTP “account has no access” result may reflect a different
mapped Cloudflare Access identity/provider. It is not necessarily related to this
asset rejection. No Access policy or allowed-provider change is proposed; the
owner can continue using Google + Cloudflare MFA.

## Local validation

- Owner-canary: **627/627** tests; Mail Desk: **481/481** tests. All original
  **1,077** remain; **31** focused tests were added to the existing browser suite
  (now **33/33**). No existing assertions were removed.
- Both package `npm run check` commands and `git diff --check` pass.
- Repository ESLint: **74 files, zero errors/warnings**. Reused local tool copies
  with the existing flat Astro config adapter and an in-memory correction for
  the distro eslint-scope `main` version string; no external files edited.
- Wrangler **4.151.0** enrollment-only `deploy --dry-run`, using the committed
  offline `wrangler.enrollment.toml`, empty process environment, isolated temporary
  home/config/log/output directories: **PASS**, **748.35 KiB**, gzip **141.18 KiB**.
  Only offline stage/unverified contract variables; no live bindings or routes.
  Existing warning: root `astro/tsconfigs/strict` is absent from this local tool
  installation. Enrollment bundling still succeeds.
- Tests forbid network fetch; synthetic signing/authenticator keys are local test
  fixtures. Document GET succeeds without D1 or provider/signing keys, with zero
  SQLite changes, zero candidate/campaign rows, and zero transport calls. Existing
  dependency-graph and production-authority security tests pass: no enrollment
  sender/transport/provider-key dependency; production `dispatchAuthorized: false`,
  `PRODUCTION_CREDENTIAL_PIN = null`, and `FINAL_OWNER_CONFIRMATION = null` remain
  unchanged. No production sending, ingress/Notion, migration or Access code/config
  changes; no live API, email, deployment, commit or push.

## Owner verification after independently reviewed safe deployment

Reload `https://canary.bigsoxstudios.com/` in Safari. If prompted, sign in using
Google + Cloudflare MFA. Confirm enrollment HTML loads instead of JSON. Loading
the document does not create a WebAuthn candidate or authorize sending; no
registration click is required to verify this fix. If it still fails, the live
cause remains unresolved and needs a sanitized observation of the final request's
URL/status and Fetch Metadata/Origin headers, without sharing JWTs or cookies.
