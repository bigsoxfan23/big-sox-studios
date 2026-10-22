# Task 11b production deployment plan

Prepared 2026-10-21 by Codex for ChatGPT coordinator/owner review. **Preparation only: no deployment, provisioning, merge, push, account creation, email, Access/MFA/DNS change or cron activation is authorized or performed.** All commands below that change remote state are future operator instructions conditional on Gate 2. Task 12 invitations, accounts and member access are excluded.

## Verified topology and limits of evidence

| Component | Existing evidence | Intended Task 11b change |
| --- | --- | --- |
| Public `https://bigsoxstudios.com` | README describes GitHub main → Workers Builds → Worker `big-sox-studios` with Static Assets. Current root wrangler.toml names that Worker. Anonymous HEAD returned 200 on October 21. | Same Worker adds membership API script, ASSETS, one rate binding and a NEW D1; retain existing hostname routing. |
| Owner `https://owner.bigsoxstudios.com` | owner-launchpad/wrangler.production.toml names `bss-owner-launchpad`, disables workers.dev/previews, pins issuer/AUD/origin/Mail Desk. OWNER_LAUNCHPAD_HANDOFF.md records actual deployment and hostname attachment behind full-host Access with owner-only policy/MFA. Anonymous HEAD returned 302 on October 21. | Update existing owner code only after approval, add same NEW D1 plus separate CSRF secret; preserve all existing settings and OWNER_EMAIL. |
| CMS | Owner source links to `https://bigsoxstudios.com/admin/`; public static CMS assets remain. | No CMS auth/content/provider changes. |
| Mail Desk | Existing owner production variable links to `https://bss-mail-desk-staging.fridman-greg.workers.dev/`. | No Mail Desk Worker, D1, credentials, URL, sends or Access changes. |

These are repository/deployment-history evidence plus two anonymous HEAD checks, not a current authenticated account inventory. No Cloudflare credentials, secret values, production records or applicant data were read. Account ID, current deployed version IDs, actual build settings, current plan/headroom, native namespace inventory and live Access/MFA acceptance remain **unverified**. Historical version IDs in the handoff are not a rollback baseline. A 302 alone does not prove correct Access/MFA. The production owner config has no membership D1 today; the review config is deliberately a different Worker name and must never be deployed as production.

Before approval, independently inspect read-only account metadata/settings (not database contents or secret values): verify correct account owns both Workers/zone, existing custom domains/routes, direct URLs/previews disabled, exact active versions, build branch/commands, binding names/types, Access application/audience/full-host policy/MFA and plan. Stop on any mismatch. Keep a private nonsecret release ledger with account ID, active code/config versions, config hashes, route attachment, build settings and intended resource IDs. Do not paste identity/secret contents into PRs or logs.

## Gate 1 — exact PR head and build approval

1. Coordinator independently updates draft PR #36 later. Base reviewed locally was `e2b700187d9424d8ce10789d62ca1ee5fb2e0284`, branch `feature/membership-request-task11b`; its supplied matching remote tree `42361e7d...` is historical, not the new release head. Record the **full new PR head SHA and tree** after coordinator publication, compare it to reviewed local source/lockfile, inspect the entire diff, and require checks on that SHA. Any change invalidates approval until reviewed. This document cannot self-pin its own enclosing commit; the ledger is the authoritative exact-head record. No merge is implied.
2. Follow [dependency review](TASK11B_DEPENDENCY_REVIEW.md). Node `.nvmrc` = 24.22.0, npm 10.9.4; `npm ci --include=dev --include=optional`, both audit modes, `npm run validate`, `npm run test:membership`, `npm run test:public`, `npm test --prefix owner-launchpad`, `npm run check --prefix owner-launchpad`. Astro check/build must run before tests inspecting dist. Do not omit dev/optional build tools.
3. Lock resolves Astro 7.4.2, ESLint 10.13.0/plugin 2.1.1/parser 2.1.0, Wrangler 4.151.3. Native rate bindings require Wrangler >=4.36.0; use the locked local executable, not an unpinned npx download. Keep compatibility dates public 2026-09-29 and owner 2026-10-14; runtime dates are independent of Node build engines.
4. Local dry runs: root `node_modules/.bin/wrangler deploy --dry-run`; inside owner-launchpad `../node_modules/.bin/wrangler deploy --config wrangler.toml --dry-run`. Production candidate dry-run must use its separately reviewed production config, from that same directory. Dry-run does not validate real IDs/secrets/Access. No automatic deployment credentials belong in validation CI.
5. Resolve the pre-existing `astro.config.mjs` site value `https://example.com`: inspect generated canonical/sitemap/absolute links, approve the real production origin in a separate reviewed diff if needed, rebuild/retest. Do not silently ship placeholder metadata or make unrelated changes as part of provisioning. This preparation leaves it untouched.
6. Owner signs head/tree, clean audit evidence, topology ledger, cost ceiling, migration/recovery protocol and planned config diff. Gate 1 is code approval only. **Gate 2 requires a separate explicit deployment/provisioning authorization**, including resources, targets, budget and rollback authority. Never merge main to trigger Workers Builds before that approval; current Builds integration may deploy on merge.

## Concrete future configuration

Do not apply these snippets now. Substitute IDs only from newly authorized resource creation in the verified account. Keep production config edits as a reviewable diff against captured live settings, never overwrite dashboard-managed routing blindly.

Public root wrangler.toml already has this configuration; activate only the new D1 template after Gate 2:

```toml
name = "big-sox-studios"
main = "membership/worker.mjs"
compatibility_date = "2026-09-29"
workers_dev = false
preview_urls = false

[assets]
directory = "./dist"
binding = "ASSETS"
run_worker_first = ["/api/membership/*"]
not_found_handling = "404-page"
html_handling = "auto-trailing-slash"

[previews]

[[ratelimits]]
name = "REQUEST_LIMITER"
namespace_id = "110011" # proposal ONLY: verify unused account-wide integer first
simple = { limit = 6, period = 60 }

[[d1_databases]]
binding = "MEMBERSHIP_DB"
database_name = "bss-membership-requests"
database_id = "<NEW_MEMBERSHIP_D1_UUID>"
migrations_dir = "membership/migrations"
```

Use exactly one short Worker-first rule (17 characters), not `true` or `/*`. Locked Wrangler validates at most 100 rules and a maximum length of 100 characters per rule; keep this well below both. Only one asset collection is supported. ASSETS serves ordinary pages/CMS and the fallback preserves original request semantics. Membership routes cannot bypass API checks via a matching static asset. Retain existing domain/route attachment: no new route or DNS is needed if the metadata matches.

For **owner-launchpad/wrangler.production.toml**, preserve its existing complete contents and add only:

```toml
[[d1_databases]]
binding = "MEMBERSHIP_DB"
database_name = "bss-membership-requests"
database_id = "<SAME_NEW_MEMBERSHIP_D1_UUID>"
migrations_dir = "../membership/migrations"
```

That production config must retain name `bss-owner-launchpad`, main `src/worker.mjs`, tsconfig `tsconfig.json`, compatibility date 2026-10-14, workers_dev=false, preview_urls=false. Preserve exact existing `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `APP_ORIGIN=https://owner.bigsoxstudios.com`, `MAIL_DESK_URL` and encrypted OWNER_EMAIL. Compare issuer/AUD against approved existing Access metadata; do not create a new application or weaken MFA. No owner assets, rate limiter or cron is needed. **The existing production file is untouched in this preparation.**

Native binding name is `REQUEST_LIMITER`; namespace `110011` is only proposed. Inventory all account rate namespaces/configurations first; if used, stop and select/review a fresh integer. Sharing a namespace can couple unrelated traffic. Binding names must be unique within each Worker. Expected public bindings: ASSETS, REQUEST_LIMITER, MEMBERSHIP_DB and three secrets; owner adds MEMBERSHIP_DB and one secret to existing bindings. Verify no name collision or accidental foreign binding. One D1 per Worker is far below documented binding/query limits, but count actual existing resources before provisioning.

## Gate 2 — separate explicit owner deployment approval

The operator records approval naming both existing Workers, new database/widget, isolated rehearsal resources, cost limit, config diff and rollback authority. No account subscription/upgrade is implied. First capture current code/assets/config versions and ensure a rollback artifact or recorded deployment is actually available. Inspect Workers Builds so it cannot race a manual rollout; any change to its settings also needs approval. Do not deploy from the stale PR base or from an unreviewed working tree.

1. Provision a **new** D1 named `bss-membership-requests` in the verified same account, never reuse Mail Desk/Cleanup/canary/other studio databases. Future root command: `node_modules/.bin/wrangler d1 create bss-membership-requests`. Record returned UUID privately in the release ledger and reviewed configs. Abort if name already exists until ownership/purpose is established; do not adopt it by guesswork. Allocate separate isolated rehearsal and restore-target databases only if explicitly authorized; no production bindings may point at them.
2. Rehearse recovery below before production activation. Review migration hash; public config is the single migration authority. Future root command: `node_modules/.bin/wrangler d1 migrations apply bss-membership-requests --remote --config wrangler.toml`. Only run after confirming new UUID and config; do not run migration from both Workers. Migration `membership/migrations/0001_membership.sql` creates schema_versions row 1, membership_requests/audit_events, unique email_hash, five named indexes and two atomic audit triggers (plus SQLite autoindexes). Verify migration bookkeeping and schema on the NEW database. Stop on nonempty/unexpected schema, partial failure or wrong UUID; do not rerun raw CREATE statements against an existing schema.
3. Create a production Turnstile managed widget restricted to `bigsoxstudios.com`, no wildcard, test key, localhost, owner hostname or unrelated hostname. Name suggestion `bss-membership-requests-production`. Client action remains `membership_request` in source; action is passed by the widget and checked by Siteverify, not a substitute for hostname restriction. Keep pre-clearance unnecessary. The server requires success=true, hostname exact, action exact, age <300s/not future, mandatory single-use verification. Test widget setup independently in the authorized browser procedure.
4. Supply secrets privately to the **correct existing Workers** using dashboard encrypted secret bindings or interactive `wrangler secret put`; never command-line literal values, tracked env files, logs or PR text. Root: `node_modules/.bin/wrangler secret put EMAIL_HMAC_KEY --config wrangler.toml`, repeat for RATE_HMAC_KEY and TURNSTILE_SECRET_KEY. From owner-launchpad: `../node_modules/.bin/wrangler secret put MEMBERSHIP_CSRF_KEY --config wrangler.production.toml`. Secret put can alter the active Worker deployment: treat it as a gated production mutation, preserve all existing secrets and record resulting versions. Verify names/presence only. Generate independent high-entropy >=32-character HMAC/CSRF keys with a trusted local secret manager; widget secret comes from Turnstile. Never rotate EMAIL_HMAC_KEY casually: it controls stable dedupe/tombstones, and rotation needs a data migration. Retain a secure recoverable copy with the database recovery plan.
5. Set **public** `PUBLIC_TURNSTILE_SITE_KEY=<REAL_PRODUCTION_PUBLIC_SITE_KEY>` in the approved production build environment (Workers Builds build variables if using Builds). It must be present during `npm run build`; setting a Worker runtime variable afterward cannot change static HTML. No secret key enters the build. Inspect dist/members/request/index.html and dist/_headers: real public key/action, emitted CSP script hashes, challenges.cloudflare.com script/frame permissions, same-origin API, no secret values. Missing sitekey intentionally disables submission. Never upload source public/_headers instead of built dist/_headers. Rebuild from exact approved source after setting the key; record artifact hash and runtime config diff.
6. Dry-run both concrete candidate configs, verify intended account/UUID/bindings/secrets and preserved owner settings. Then, only within approved window and release method, update the existing owner first, verify it can privately review the new empty/synthetic queue, and deploy public code+assets with its real sitekey and bindings. Owner deploy command runs **inside owner-launchpad** with `../node_modules/.bin/wrangler deploy --config wrangler.production.toml`; public from root uses `node_modules/.bin/wrangler deploy --config wrangler.toml`. These are instructions, not commands executed in preparation. Existing build automation must not independently overwrite either approved release. Do not deploy offline review Worker or enable previews/direct URLs.
7. Cron remains absent. If separately explicitly approved, add `[triggers] crons = ["17 4 * * *"]` to the public Worker only (04:17 UTC daily) and redeploy the reviewed config. Otherwise establish an explicitly authorized manual retention schedule before accepting applicants; do not claim retention runs automatically. Pending expires at 90 days; terminal PII clears 30 days after actual closure; deidentified audit expires at 365 days. Batches: 100 expirations, 100 clearings, 500 audit deletions/run; monitor backlog/catch up safely. Approved/invite-ready PII is exempt and flagged for annual manual review after 365 days.

## Isolated backup and recovery rehearsal

This preparation ran synthetic offline tests, not an actual remote backup/recovery rehearsal. Before live collection, authorize separate rehearsal resources with distinct IDs and configs, no public routes, only synthetic data. Local alternatives use isolated `--local --persist-to <REHEARSAL_DIRECTORY>` storage, never production config IDs for remote mutation.

1. Apply the exact migration once to the rehearsal DB. Verify schema_versions=1, migration record, indexes, email_hash uniqueness and creation/change triggers. Seed synthetic pending ages 89/90/91 days, rejected/revoked/expired closures 29/30/31 days, invite-ready >365 days, and audit ages 364/365/366 days. Include >100 eligible applications and >500 eligible audits to exercise bounded backlog.
2. Exercise concurrent normalized-email inserts (one row), owner revision conflict (one winning update), forced audit failure (whole decision rolls back), and preservation of existing closed tombstones on resubmission. Use the production code's `sweep` with an injected clock and actual local D1 adapter; no runtime bypass or remote test endpoint. Run twice, check exact expected revisions/audit events/batch limits, PII nulling, preserved invite-ready details and eventual catch-up. Existing Node/SQLite tests document the expectations; they do not substitute for D1 recovery testing.
3. Export before/after to owner-controlled protected storage: `wrangler d1 export <REHEARSAL_DB> --remote --output <PRIVATE_EXPORT_PATH>` with the isolated config. Record synthetic counts and a recovery bookmark if testing Time Travel. Restore SQL into a **different empty isolated target** using `wrangler d1 execute <RESTORE_DB> --remote --file <PRIVATE_EXPORT_PATH>` and its distinct config. Do not apply migration again to a schema-containing export. Validate tables/triggers/unique constraint/schema version, counts, revisions, sweep behavior and owner rendering against the restored target. Record pass/fail and destroy only explicitly authorized rehearsal resources later.
4. Time Travel restores a database in place, not an isolated fork. If rehearsed, use only the rehearsal source and a recorded bookmark, never production. D1 currently documents 7-day Free/30-day Paid recovery windows. Establish an owner-approved encrypted export/recovery schedule, access controls and backup expiry consistent with removal policy before launch.
5. A real recovery must restore to an isolated replacement first, reconcile all removals/retention/decisions since the checkpoint before exposure, and preserve the matching stable EMAIL_HMAC_KEY. Verify restored data privately, then separately approve switching BOTH bindings together. Restoring stale personal data over production can undo removals; neither rollback nor Time Travel authorizes that.

## Gate 3 — independent smoke tests and owner acceptance

Record version IDs, artifact/config hashes, timestamps and sanitized outcomes; use only owner-approved synthetic identities, never real applicant content in logs. No tests send emails/create accounts. Verify API and owner access independently: owner UI success cannot prove public API security, and public success cannot prove Access/MFA.

- Public browser: desktop/mobile/Safari, keyboard and screen reader; request link/form, required acknowledgement, one-paragraph/length validation, correct widget host/action, successful submission and same generic duplicate confirmation with fresh token each time. Retry after failure preserves fields/resets challenge, success clears fields/focuses result, no overlapping submissions/localStorage. Test missing/expired/replayed token and provider failure without false confirmation. Check real network CSP and no console violation, no PII in URLs/referrers/logs.
- API separately: exact POST `/api/membership/requests`; GET/HEAD 405/Allow POST; unknown/per-ID/list/status/query paths 404; foreign/missing Origin denied; wrong Fetch Metadata denied; no CORS, no public enumeration. Oversize/non-JSON/malformed rejected. Missing bindings/secrets fail closed in isolated rehearsal, not by removing live secrets. Exercise 429/Retry-After carefully with synthetic requests; do not assert an exact global seventh-request cutoff. Verify direct workers.dev/version/preview bypass unavailable.
- Owner separately: logged out → Access; exact owner completes existing MFA and sees queue; nonowner, wrong-app/expired/forged JWT denied, including unknown paths/methods. No token capture/shared sessions. Confirm private no-store headers, escaping, notes/status labels, stale revision conflict, CSRF/cookie/session refresh denial, pagination and audit. Approval means invite-ready only, no account/mail/access grant. Independent CMS/Mail Desk login still required. Live nonowner/MFA checks and owner Safari acceptance were not proved by offline tests.
- Regression: public home/projects/info pages, `/members/` future portal/disabled sign-in, existing navigation/theme, `/admin/` CMS, static 404/trailing slash/security headers; owner home CMS/Mail Desk shortcuts work and both independent authorizations remain intact. Compare unchanged Mail Desk/Cleanup A/owner-canary configs and binding metadata to baseline. No Cleanup A execution, production queries, outbound mail or Task 12 workflow is part of this rollout.
- Owner explicitly accepts observed UI/security/privacy and monitoring/retention operation on exact deployed versions. Any required browser/MFA/recovery test left unverified keeps Gate 3 open; do not declare production accepted from HTTP status alone.

## Rate limits, capacity and cost approval

As checked October 21, [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) lists Free 100,000 dynamic requests/day, 10ms CPU/invocation; Paid minimum $5/month, 10m requests and 30m CPU-ms/month included, then $0.30/million requests and $0.02/million CPU-ms. Static asset delivery is free/unmetered; Worker-first invocations are dynamic even if rejected. [Native rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are approximate/eventually consistent per Cloudflare location, not a hard global/day/spend cap; the linked runtime/pricing docs publish no separate per-binding-call price, so confirm entitlement/cost in the actual account before approval. IP and email each use separate HMAC namespaces at 6/60s, two checks on an admissible attempt. Shared IPs can throttle legitimate users and distributed abuse can exceed limits.

[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): Free 5m rows read/day, 100k written/day, 5GB account storage; Paid includes 25bn reads/50m writes/month and 5GB, then $0.001/million reads, $1/million writes, $0.75/GB-month. Scanned rows, triggers and indexes affect billing; application query count is not billed row count. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) include Free 10 databases, 500MB/database, 50 queries/invocation; Paid 50,000 databases, 10GB/database, 1,000 queries/invocation; 100 parameters/query. Check actual remaining account capacity, including rehearsal databases. [Turnstile Free](https://developers.cloudflare.com/turnstile/plans/) includes 20 widgets, 10 hostnames/widget and unlimited challenges; no Enterprise purchase is proposed.

One admissible API call: bounded parsing, HMACs, native checks, Siteverify and indexed insert attempt; new records also create audit/index writes. Duplicates still verify the challenge but do not write application/audit rows. Owner home adds a count, queue uses bounded reads, mutations audit atomically; cron performs three bounded mutation queries. No measured CPU/traffic estimate or current subscription inventory is available. Require account-wide usage/headroom and no-spend budget approval before Gate 2; do not upgrade plan or assume this feature is free because quotas exist. Recheck prices at approval. Monitor aggregate API statuses/latency/429/5xx, Worker CPU, D1 scans/writes/storage and retention backlog; never bodies, raw email/IP, notes or JWTs. Alerts are not hard billing caps. Stop collection on unexpected spend/quota pressure; any new WAF/budget setting requires separate authorization.

## Stop conditions and rollback

Stop before a mutation if exact-head approval is stale, account/target/UUID/namespace is uncertain, plan exceeds authorization, schema differs, backup rehearsal fails, build/sitekey/CSP is wrong, production Access differs, direct origins are reachable, or rollback artifacts are missing. Stop rollout on API false confirmation, enumeration, auth/MFA/CSRF failure, real applicant logging, broken CMS/Mail Desk/static routes, failing checks or unexplained usage. Do not repair these by loosening validation, changing existing Access/DNS/MFA, sharing secrets or creating test accounts.

Within separately approved rollback authority, stop new intake by restoring the last known-good public Worker **and its matching static assets/config** (or a reviewed truthful unavailable form), restore the previous owner code/config while retaining its original bindings/secrets, and disable only an authorized membership cron. A Worker version rollback alone may not restore secrets, triggers, bindings or build settings: compare each to the captured ledger and verify service routing after rollback. Prevent Builds from redeploying the bad version through the separately authorized release process. Keep public API closed if protection cannot be verified; preserve the original owner Access perimeter and route.

Preserve the membership database, dedupe key, tombstones and removal/retention history; no database deletion, stale restore or reapplication reset is authorized. Continue authorized privacy/retention handling while intake is paused. Confirm public static/old Members/info/CMS and private owner/Mail Desk behavior independently after rollback. Database recovery follows the isolated reconciliation procedure above and requires separate owner approval. No Task 12, invitations, emails or account provisioning follows from any gate in this plan.
