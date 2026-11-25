# Task #12 — one-pass private staging acceptance design
SOURCE ONLY · DRAFT / NOT AUTHORIZED FOR DEPLOYMENT · 2026-11-24 Central

## Contract and hard stops

Greg's ONE real, private full-flow test must PASS before ANY public push or production cutover approval request. Use the existing exact Owner identity (Owner Gmail) and one preapproved controlled Outlook test identity. No new identity, broader Access policy, new service grants or Jellyfin account, imported test members, fake Jellyfin readiness, historical UNKNOWN reset, production D1 write, public route, provider test send by the builder or spend. PR #82 remains open draft/unmerged; the original inactive production versions and old active staging versions remain unchanged.

This document proposes a source-only future staging implementation. Its endpoints do not exist. Test delivery is restricted to the exact existing Owner inbox (encrypted staging binding) (one request notification) and the one existing approved Outlook test mailbox (encrypted staging binding) (one welcome); no CC, BCC, reply-to or caller-supplied recipient. Actual inbox delivery and effective Access identity/MFA must be verified before declaring PASS. No builder-initiated provider calls.

## Concrete zero-cost isolated resources (approval required before creation)

Read-only Cloudflare inventory Nov 24: 8 existing D1 databases. Official Nov 20 Cloudflare D1 Free limit: 10 databases per account (https://developers.cloudflare.com/d1/platform/limits/). Proposed TWO new empty D1s: bss-task12-acceptance-requests and bss-task12-acceptance-members. Do NOT reuse existing staging Requests (48b0a0cc-40ad-4495-8883-a42b4a938b71), staging Members (43a8a15b-e195-4712-9198-1dcc9f0152af), production Requests (21e13fa1-0ab3-4573-8d20-983c847ba0e9) or production Members (613c9c18-69f9-4cf4-b7b1-afb0de49bd6d). Hard-fail on any D1 binding equal to one of these IDs or on shared physical D1 identity. Do not copy historical data, pending member, any UNKNOWN welcome or audit. Run-scoped Owner record is created only from the existing signed Owner identity in the NEW test D1, not a new Cloudflare login/account. One fresh test request, Member and auditable send ledger per run.

Preflight must verify exact current Cloudflare plan, storage, Free quotas, database count and no overages/new spend immediately BEFORE creation; abort instead of buying, upgrading or deleting legacy databases. Additional D1 IDs must be read back and explicitly hard-pinned after Owner-authorized creation. Use Wrangler as already configured, no new CLI framework. No new Worker, public DNS or Access app required: extend only existing protected staging Workers with private paths after separately authorized staging activation. Keep both original staging DB bindings and all old paths intact.

## Proposed private paths (NOT DEPLOYED)

Existing protected host members-staging.bigsoxstudios.com:
- GET /acceptance/request: one-time private request form with visible TEST banner. Existing member staging Access must authenticate exact controlled Outlook identity via signed JWT, correct audience, effective OTP/MFA. Never trust submitted email; compare to trusted Access identity and encrypted recipient pin.
- POST /acceptance/request: validated Turnstile for exact staging hostname or equally strong reviewed anti-bot guard; CSRF/Origin/Fetch-Site, strict schema, run nonce and one fresh request insert + one outbox insert atomic on acceptance Requests D1. No production API and no live Notion/Resend worker.
- GET /acceptance/app: only new acceptance Members D1, run-bound approved/accepted welcome proof, exact OTP identity and fresh D1 Active authorization, never service grants. Show Membership — Active and TEST banner; every actual service endpoint denied, even on a forged or old cookie. Removal must immediately deny original session.

Existing protected Owner host bss-owner-launchpad-staging.fridman-greg.workers.dev:
- GET /acceptance/requests/: Owner-only private TEST queue from NEW acceptance Requests D1, not the real live/staging request queue.
- POST /acceptance/requests/{id}/decision: existing signed Owner JWT + MFA + strict CSRF + source revision; fresh expiry check after awaited reads and SQL database-time expiry CAS; test-only audit and member pending association.
- GET /acceptance/members/: show test-only status and removal; never imply Jellyfin readiness.
- POST /acceptance/requests/{id}/send-welcome: Greg's authenticated explicit confirmation of exact Outlook recipient and TEST message, only ONE attempt after reviewed state/receipt.
- POST /acceptance/members/{id}/remove: audited revoke, retained identity and historical evidence, original session denial. No service/Cloudflare policy mutation.

Both existing Access applications, policies and original routes must remain unchanged. Refuse workers.dev, preview URL, wrong Host, non-HTTPS, wrong audience, unexpected query/method, direct old staging DB, public site/production Workers. Paths are not live; never invite Greg to test until actual protected version routing verified.

## Notion TEST ticket and recipient-isolated real messaging

Propose exactly one private restricted Notion destination named Task12 Acceptance — TEST Tickets, under the existing Big Sox Studios private workspace, separate from real ticket data source and AI Contribution Log. One TEST-labeled ticket (opaque run/request ID, pending/decision status, minimal timestamps, no raw applicant text/password), one TEST Owner inbox notification containing only staged queue/ticket link, and one separate TEST welcome with the exact acceptance Member link. Ticket integration scope: only this private destination, create/read/update; never use production ticket datasource or Mail Desk. Avoid duplicative writes: durable intent and external ID, reconcile on uncertain Notion acknowledgment; no blind retry.

Recipient policy must be verified in the actual preflight: precisely the exact existing Owner inbox (encrypted staging binding) for notification, precisely the one existing approved Outlook test mailbox (encrypted staging binding) for welcome, no dynamic To/CC/BCC/reply-to/header injection. Enforce independently by server-side sealed encrypted constants, actual Cloudflare Access effective allowlist readback, exact run/recipient confirmation rendered to Greg, and pre-dispatch transactional checks. No builder provider test sends. Resend credentials must be sending-only, encrypted staging-only, bound to reviewed Owner/notification sender path only and limited to verified sending domain; if Resend does not enforce recipient-scoped API keys, source MUST enforce recipients and a one-shot provider budget. Verify current free-tier provider usage/limits and spend-free setting; stop if not provable.

One immutable send intent per (run_id,event_kind,recipient_digest) for EACH of two messages, reserved before network I/O. Persist terminal DISPATCHING/UNKNOWN/ACCEPTED/REFUSED and a one-attempt-total durable counter. Timeout, crash, provider refusal, malformed outcome or uncorroborated delivery locks intent and STOPS, never resets or retries even if provider idempotency expires. Notion ticket creation has its own one-attempt/UNKNOWN ledger. All actual provider messages must be initiated during Greg's single Owner-led run after approval, not by builder dry-run.

## Truthful test-only admission without service grants

The existing production Member admission requires a real accepted live welcome and recorded Jellyfin readiness. Do NOT synthesize live receipts, set jellyfin_ready_at, create a Jellyfin account or grant any service to satisfy the test. Instead, design distinct staging-only TEST_ACCEPTANCE records and a separate acceptance admission function in the new test D1: it requires an existing Owner decision, exact run/recipient identity, committed ACTUAL accepted test provider outcome, immutable audit and fresh signed Access identity. A mocked provider response, client flag, environment flag alone, or pending/UNKNOWN send cannot confer Active. Require schema check/trigger enforcing ZERO rows in service_grants at every step. TEST code must NOT be imported by either production entrypoint and must hard-refuse production origins, production D1s, original staging D1s and non-test paths. The test welcome must not contain a fabricated Jellyfin username or password. Revocation must leave immutable evidence and immediately deny original Member session.

This is a genuine staging limitation: it proves protected request→ticket→Owner email→Owner approval→test welcome→Member login→revocation user experience, not a live Jellyfin dependency, anonymous public intake host, actual production first-Owner bootstrap, public routing or production deliverability. Disclose those boundaries in the acceptance checklist rather than representing staging as bit-for-bit production.

## Exact least-privilege change request for Mac to obtain from Greg

Only request permission to CREATE the two specifically named free D1s, one private TEST-only Notion ticket destination and staged credentials scoped to that destination and sender; to add test-only path handling inside the two EXISTING staging Workers; and (after independent source/CI verification, isolation and rollback rehearsal) to activate reviewed STAGING versions at those existing protected hostnames only. No other resource, test identity, policy edit, public Worker, DNS change, production migration, general permissions, paid plan or provider send permission.

Credential types (never values):
- Cloudflare scoped API token: D1 Edit for two new acceptance DBs only and Workers Scripts Edit for two existing staging Worker scripts only, if Cloudflare supports that granularity; Access and DNS read-only for preflight, no production script edits, zero main deployment permission. If unsupported, a temporary single-operation owner-controlled token, revoke after use.
- Existing Owner/Member Access signed JWT verification and MFA kept as-is; no new broad Access allowlist, no new login IdP or waiver. One staging-only run nonce plus independent HMAC/CSRF secret, both encrypted 32-byte random values.
- Notion API integration: restricted to one TEST destination with read/create/update only, no general workspace, live tickets or public logging.
- Resend API token(s): sending-only, not Full Access, encrypted, sender/domain verified; exact two recipient allowlists in source; no builder sends. Explicit approval for the TWO Greg-initiated real test emails must come separately before execution.
- Turnstile token/secret: use an already approved staging-host-bound configuration if possible; otherwise separate narrow credential permission, never silently bind public Turnstile secret.

## Required tests and independent acceptance readiness review

Before any staging activation: verify PR82 exact new head, exact-tree GitHub CI PASS, independent security GO for Owner expiry, Member status and new design. Verify current D1 count Free capacity and real $0 plan, new empty DB IDs, exact origin/bindings, original staging unchanged, current Access/MFA, sole recipient restrictions, Notion destination privacy, provider plan/sending-only scope, original Worker 100% version IDs and backed-up/restore-tested staging data. No new script should have production D1/Notion/Resend binding. Synthetic workerd/SQLite end-to-end tests with fake external providers: good single run; bad Owner email, wrong Outlook, concurrent same event, duplicate receipt, wrong Host, expiry during D1 await, expired inside SQL, UNKNOWN permanently locked, forged acceptance, zero grants, original same-session removal denial, bot/CSRF, wrong request/version, D1 cross-wiring. Candidate versions from previous PR82 head 3a9ed859 are STALE once new source is committed; rebuilding new inactive staging candidates and activating requires additional permission, not implied by this design review.

Stop if one external message is UNKNOWN, one real ticket already exists, a route policy has drifted or free capacity is not proven. Greg alone performs ONE full run after a staging-only approval. Greg's PASS and separate explicit production cutover approval remain two independent gates. No Friends outreach.

Rollback: capture prior 100% active Owner staging and Member staging version IDs, Access, routes, DB export and private integrity-verified copies; revert ONLY new protected test routing/Worker versions and disable TEST send gates, preserving all original staging D1 rows, historical UNKNOWN, TEST immutable audit/sends and original production untouched. External emails/ticket cannot be rolled back; preserve evidence. Do not restore over live D1 or delete rows without separate Owner authorization.

## Status (source-only, not a permission grant)

Previously reviewed source 3a9ed859bcd059fc9121e978c4855915f10263e1, source tree 798d5d9813eff567e9e4a1ccc892b8624e4e8344. Earlier independent Codex source review returned staging acceptance NO-GO, three HIGH and three MED including expiry/Active, test recipient and send budgets. This design must receive a separate independent reviewer verdict. Staging candidate versions tied to older source cannot be called approved for newer PR82 source.
