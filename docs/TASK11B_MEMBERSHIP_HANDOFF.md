# Task 11b: membership request design and operator handoff

Implementation date: 2026-10-21. Phase 2 BUILD only. No deployment is authorized by this document.

Pre-deployment follow-up: see [dependency review](TASK11B_DEPENDENCY_REVIEW.md) for the resolved five development audit findings, compatible pinned lint stack, new root lockfile and Node/npm/CI verification. That report supersedes the historical dependency/no-lockfile caveats below. See [production deployment plan](TASK11B_PRODUCTION_DEPLOYMENT_PLAN.md) for exact-head approval gates, future configuration, costs, smoke tests and isolated recovery/rollback instructions. No resources or production configuration were changed by the follow-up.

## What visitors will see

The existing Members page now links to **Request membership** at `/members/request/`. It retains the future invite-only positioning, planned benefits, disabled member sign-in, and existing studio branding. The new page uses the same cream, ink, accent, logo, navigation, and theme controls. A two-column form and explanation stack into one column below 48rem. Inputs have visible labels, useful autocomplete, keyboard focus outlines, large controls, and an announced result that receives focus.

The form asks for name, email, and the approved prompt: “How do you know the studio, and what interests you about membership?” The answer is required, limited to 500 characters, and must be a single paragraph. A short privacy notice, support removal address, email proofreading warning, and explicit required acknowledgement precede the security check. Control characters, including newlines and invisible direction controls, are rejected server-side. Name is limited to 100 UTF-16 code units and email to 254; browser maxlength uses the same convention.

The confirmation is identical for a new request and an existing normalized email. It says Greg personally reviews requests, no account or email was created/sent, the visitor may only hear back if eventually invited, and the portal is not open. It provides no status, applicant ID, or duplicate indicator. Failures say the request could not be confirmed and offer retry. The form preserves input on failure, resets Turnstile, clears fields only on a confirmed successful response, and prevents overlapping submissions. It does not persist applicant data or use localStorage. The shared theme preference is intentionally not read or saved on this page; the theme button still works for the current page.

Without an operator-supplied, non-test Turnstile site key at build time, the page explicitly reports that requests are temporarily unavailable and disables submission. There is no public test-key fallback. The native form fallback uses POST, so a script failure cannot put personal fields in a GET query string; its non-JSON submission is rejected truthfully by the API. JavaScript and a functioning security check are required; noscript explains this. No real applicant data was used in development.

## What Greg will see

The existing private owner home retains its CMS and Mail Desk destinations and adds **Membership requests**, including a pending-count badge. Missing membership configuration displays “unavailable” on that card without breaking the existing home.

`/membership/requests/` shows 20 requests per page, newest first, with stable timestamp/UUID keyset pagination. It shows the applicant’s unverified details, private owner note, current application status, and received date. Closed records whose personal details were cleared show a tombstone. A private disclosure shows the latest 20 deidentified audit events; it contains random request IDs, timestamps, revision numbers and status/event labels, never applicant text or owner notes.

Status labels and permitted decisions:

| Stored status | Owner label | Permitted new status |
| --- | --- | --- |
| pending | Pending | approved or rejected |
| approved | Invite-ready | revoked |
| rejected | Rejected | none |
| revoked | Approval withdrawn | none |
| expired | Expired | none |

An owner can also save a note without changing the current status while personal details remain. Notes are at most 500 characters, with no control characters. Closed states never reopen through this UI or through public resubmission. Invite-ready applications at least 365 days old carry an annual review flag; the flag persists until the owner closes the application. There is no automated approval expiry and no automatic invitation.

**These are application decisions only.** Saving never authorizes access, creates an account, sends an invitation, or sends mail. Approval withdrawn does not revoke an existing member account. Later invitation/account handling requires a separate authorized process. The current UI permits manual withdrawal/closure; it does not implement a member lifecycle.

A revision conflict instructs Greg to reload the queue. Two concurrent decisions cannot both succeed. A decision and its audit event are atomic; an audit failure rolls the decision back. A guessed nonexistent ID and a stale version have the same private conflict response.

## Security boundaries

Public submission uses only `POST /api/membership/requests` on `https://bigsoxstudios.com`. All other methods return 405, and unknown membership API paths or query variants return 404. No public list, status, search-by-email, or per-ID database lookup exists. No CORS headers are emitted. A POST must have the exact Origin and a matching URL origin. Sec-Fetch-Site, when present, must be `same-origin`; absent Fetch Metadata is allowed only with the exact Origin. JSON media type is required; body bytes are bounded to 8192, including streamed bodies that lie about Content-Length.

The server accepts only a valid CF-Connecting-IP header for the edge limiter, never X-Forwarded-For or similar forwarding headers. Operator must keep direct Workers origins disabled and traffic on the Cloudflare-controlled host. Native rate limiting checks an HMAC of the IP before parsing the body, then an independent namespaced HMAC of normalized email after field validation and before Siteverify. Keys contain no clear-text IP/email, and use a secret independent of the dedupe key. Proposed configuration: six attempts per 60 seconds per key. Native limits are approximate, eventually consistent and separate per Cloudflare location; they are neither a strict global cap nor an hourly/day limit. Shared networks may share an IP bucket, and distributed attackers may exceed it. No rate-limit or rejected-request D1 writes occur.

Every admissible submission, including duplicates, calls Turnstile Siteverify. It must return literal `success === true`, hostname `bigsoxstudios.com`, action `membership_request`, and a challenge timestamp less than 300 seconds old and not in the future. Missing/malformed tokens are rejected. Expired or replayed tokens rely on mandatory single-use Siteverify validation and are rejected; no client result is trusted. The transport has a five-second abort timeout, rejects redirects and non-200 replies, and bounds the reply to 16 KiB. The IP is not sent to Siteverify. Missing secrets/bindings and provider/database failures fail closed; an unsuccessful D1 result cannot generate confirmation. Only dependency-injected offline tests replace the network dependency; no request parameter or runtime environment flag enables a mock.

Email is NFC-normalized, trimmed, ASCII-validated and lowercased in full. The local part is at most 64 characters. Internationalized addresses must use an accepted ASCII representation; quoted local parts are not supported. Provider-specific aliases, dots, and plus tags are not merged. A unique HMAC-SHA256 normalized-email key enforces dedupe under concurrent writes. Conflict does nothing, retaining all existing identity, notes and decisions. Submitted identity remains unverified and cannot change an application. Do not rotate the dedupe key casually: a new key would defeat tombstone matching unless a migration is designed first.

All SQL input is bound. All owner HTML including names, addresses, reasons, notes and audit text is escaped. Public confirmation is assigned with textContent. No body, email, reason, JWT, or raw IP is logged by application code. Do not enable body logging or use PII in monitoring during launch.

Owner routes use the existing exact JWT signature, issuer, audience, expiry and owner-email verifier, including its JWKS rotation protections. The verifier was left unchanged. Existing Cloudflare Access MFA enforcement remains an operator-controlled Access policy, not a new application-level MFA claim check. Do not expose the owner Worker directly, share tokens, weaken Access policy, or replace owner identity with an unsigned email header.

The existing root GET/HEAD behavior, fixed query redirects, security headers, and method denials are preserved. New routes authenticate before method/path handling. Owner POST requires exact Origin and same-origin Fetch Metadata policy, plus a signed 15-minute token matched against a Secure, HttpOnly, SameSite=Strict, Path=/ `__Host-` cookie. The signature binds token expiry and nonce to the full verified owner JWT/session. A GET token alone is insufficient without the cookie; a forged matching cookie/token still fails signature verification. A refreshed owner JWT or expired token requires reloading the queue. Reusing a valid token within that session is safe against repeat mutation because the revision must also match; this is CSRF protection, not a one-time transaction token. Opening another queue tab may replace the cookie and require a reload in an older tab.

The owner queue allows only self-targeted forms and no script, with hashed CSS. The existing root CSP remains unchanged. The public request page has a scoped `_headers` policy allowing the Turnstile script/frame origins and same-origin API. An Astro build hook hashes all final emitted inline scripts because Astro may inline small modules. Never publish source `_headers` in place of the built file. The page also has no-referrer, nosniff, frame denial, and restricted permissions headers. Shared CSS may use inline styles; script policy has no unsafe-inline.

## Proposed deployment resources and placeholders

Nothing in this section was provisioned. A later operator must obtain explicit deployment authorization first.

| Resource/configuration | Future value/purpose |
| --- | --- |
| New D1 database | `bss-membership-requests`; never an existing studio/Mail Desk database |
| D1 binding in both Workers | `MEMBERSHIP_DB`, same NEW database ID: `REPLACE_WITH_NEW_DATABASE_ID` |
| D1 migrations | `membership/migrations/0001_membership.sql`, version 1 |
| Native rate limiter | `REQUEST_LIMITER`; proposed namespace `110011`, confirm account uniqueness before use; 6/60s |
| Public secret | `EMAIL_HMAC_KEY`: independent cryptographically random >=32-character secret, stable for dedupe |
| Public secret | `RATE_HMAC_KEY`: separate random >=32-character secret |
| Public secret | `TURNSTILE_SECRET_KEY`: real non-test widget secret |
| Build environment | `PUBLIC_TURNSTILE_SITE_KEY`: public site key for the real production-only widget |
| Owner secret | `MEMBERSHIP_CSRF_KEY`: separate random >=32-character secret |
| Existing owner settings | Preserve issuer, audience, APP_ORIGIN, private owner identity, Mail Desk URL, Access and MFA settings |
| Cron | Proposed `17 4 * * *` UTC, only after separate explicit operator approval |

Root Wrangler keeps `not_found_handling = "404-page"` and `html_handling = "auto-trailing-slash"`. It adds an ASSETS binding and Worker-first matching only `/api/membership/*`. Other Worker invocations delegate the original request to ASSETS. D1 blocks are commented templates, and no active cron is configured. Owner offline configuration has a matching commented D1 example. Owner production configuration was not changed. Missing runtime setup intentionally prevents submissions/review rather than pretending success.

Official references checked during implementation:

- [Static Assets binding and route-pattern Worker-first configuration](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Native rate limiting syntax, approximate limits and locality](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Turnstile server validation and single-use/expiry behavior](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

Wrangler 4.151.3 accepted both configurations and bundled both Workers in `deploy --dry-run` mode. The package minimum now specifies Wrangler >=4.36 via `^4.36.0`, matching native rate binding support. Dry runs do not validate real resource IDs, secret availability, Access policy, or a production widget.

## Retention, removal and recovery

The public Worker exports a scheduled handler, with an injected clock for tests. No production trigger was enabled. Each invocation executes a transactional, idempotent bounded batch:

1. Expire up to 100 pending applications at or past 90 days, setting a closure timestamp and audit event.
2. Clear name, email, reason and owner note on up to 100 rejected/withdrawn/expired applications whose closure is at least 30 days old. Mark a clearing timestamp and audit it.
3. Delete up to 500 deidentified audit events at least 365 days old (the implementation’s 12-month TTL convention).

These limits deliberately permit a backlog. Daily scheduling provides approximate retention, not a precise instant guarantee. Repeat jobs until caught up after an outage. Pending expiration uses the sweep’s actual closure time, so delayed jobs begin the 30-day clearing interval when expiration is recorded. Invite-ready personal details are never touched by automated expiry/clearing. The annual review flag is computed at display time and creates no scheduled database write.

Minimal random-ID/status/revision/email-HMAC tombstones remain to prevent duplicate applications and automatic reopening. A keyed fingerprint is pseudonymous data, not anonymized personal text, and its continued retention is disclosed. The audit has no applicant text, raw email, owner notes, IP, JWT, or dedupe HMAC. Audit IDs are retained only within the TTL; database backup retention is a separate operator obligation.

Removal requests go to `support@bigsoxstudios.com`. There is intentionally no public deletion-by-email or deletion-by-ID endpoint. After human verification through a trusted independent channel, the operator should identify the record privately, manually close a pending/approved application if appropriate, and clear the four personal fields with a revision increment, updated timestamp and pii_cleared_at in one parameterized statement. The existing trigger records only the clearing event. Preserve the dedupe tombstone unless the owner explicitly approves a separate reapplication/reset policy. Never accept unverified submitted email/name as permission to remove or change a decision. This implementation neither reads nor sends support mail.

Before any production launch, rehearse on a separate nonproduction copy with synthetic data: apply migration, confirm version/indexes/unique constraints and audit rollback; take an export or approved D1 recovery checkpoint; create synthetic pending/terminal/invite-ready records at boundary dates; run the sweep twice; restore to an isolated replacement database; verify row counts, revisions, preserved invite-ready details, cleared personal fields and audit TTL. Do not restore an older backup over production without replaying subsequent verified removals and retention actions. Protect and age out backups consistently with the privacy notice. No production backup, export, restore, or rehearsal was performed in this build phase.

## Local validation and operating cost

Use Node 24 (or a version satisfying the installed Astro engine) and include dev and optional dependencies. This workspace initially supplied Node 22.22.1 and omitted dev tools; a compatible Node 24 binary and build tools were installed only inside ignored node_modules. No Node package was added to the manifest. No lockfile existed at the approved base and none was added.

```sh
ASTRO_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME=/tmp/bss-task11b-config npm run validate
npm run test:membership
npm run test:public
npm test --prefix owner-launchpad
npm run check --prefix owner-launchpad
```

Build first: the asset and public regression tests inspect final `dist` HTML and headers. Validation passed: 74 membership tests (submission, SQL, retention, UI state, built assets/CSP), 100 owner tests, and 16 public sign-in/CMS tests. The original public regression test file is unchanged; the extra page adds one test. SQLite tests use Node’s experimental built-in node:sqlite, executing the real migration and SQL statements. Existing owner JWT tests remain, with the expected third home destination updated. An additional ephemeral Miniflare/D1 integration check executed the real migration, concurrent public duplicate requests, an owner decision with its audit trigger, and the invite-ready retention exemption against a real local D1 binding. Local Wrangler HTTP checks verified page 200/CSP, 307 trailing-slash redirect, CMS serving, unknown-asset 404, API GET 405, and no public status endpoint.

Tests do not call real Siteverify, Access, D1, email, or account providers. No real browser/screen-reader/mobile-device walkthrough or live widget/MFA test was performed. DOM-style offline tests cover input retention, confirmation, retry and focus, and emitted HTML checks cover semantics/CSP. A deployment-phase operator must complete the real browser/keyboard/screen-reader, Turnstile, Access/MFA, resource isolation and backup rehearsals using an authorized private test procedure.

The npm advisory query including dev dependencies reported five high findings in the existing Astro lint dependency chain (`eslint-plugin-astro`, `astro-eslint-parser`, `fast-glob`, `micromatch`, `braces`); the underlying issue is deep-pattern stack exhaustion in braces. The production-only advisory query reported zero findings. This build did not apply a broad unrelated dependency upgrade or claim that the toolchain findings were fixed. Review these development-tool findings separately before running untrusted lint inputs.

No money was spent and no paid operation was performed. Static paths stay asset-first. An accepted API attempt does two native limit checks, bounded parsing, three HMACs, one Siteverify call and one indexed D1 insert attempt; a new row also creates one audit row and index updates. A duplicate consumes Siteverify but does not mutate the application or create another audit event. Owner root adds one indexed count; a queue page adds one bounded request query and one bounded audit query. Decisions have a read and conditional UPDATE RETURNING plus atomic audit; they do not assume D1 meta.changes excludes trigger writes. A daily sweep has three bounded mutation queries. The sweeper can process at most 100 expirations, 100 PII clearings, and 500 audit deletions per run, plus audit/index effects. SQLite/D1 scanned-row billing and index writes must be assessed against the operator’s actual plan. No free-tier entitlement, global abuse cap, or zero future bill is promised; confirm plan limits and keep usage within the owner’s no-spend authorization before launch. No benchmark was run; Siteverify network latency is expected to dominate submissions.

## Later deployment and rollback checklist (operator only)

1. Obtain explicit Phase 3/deployment authorization. Review the local commit; coordinator handles publishing. This build did not push, open a PR, merge or deploy.
2. Address/review the toolchain advisory caveat; pin an operator-approved reproducible dependency set and compatible Node version for deployment.
3. Provision only the new D1 and production Turnstile widget restricted to `bigsoxstudios.com`; retain action `membership_request`. Confirm rate namespace uniqueness and plan/no-spend constraints.
4. Bind both Workers to that same new DB, apply only the new migration, supply independent secrets privately, and build with the real public widget site key. Keep direct Worker URLs disabled and preserve the existing owner Access/MFA perimeter. Do not use another service’s D1 or secrets.
5. Rehearse backup/recovery and run authorized private production checks. Inspect final built headers, not source alone. Confirm anonymous/wrong-owner denial, no public list/status, duplicate generic confirmation and state/audit race behavior. No mail or invitations should be sent by any test.
6. Obtain explicit cron approval before configuring the proposed daily trigger. Monitor aggregate status/latency/backlog without applicant bodies or raw IP/email logging. Do not enable cron merely because the handler exists.
7. To roll back, restore the last approved static-site/owner Worker code and configuration, remove the request link or replace the form with a truthful unavailable notice, and disable any subsequently authorized cron. Preserve the separate database and removal/retention history; do not delete it or restore stale personal details as a rollback shortcut. Restore the previous site asset behavior if rolling back the new script. Database destruction and reapplication resets require separate owner authorization.

Mail Desk source/data, owner-canary, Task 10/Cleanup A behavior, existing Members Portal PRs, Cloudflare resources, DNS, Access/MFA, email providers and production deployment remain outside this implementation’s changes.
