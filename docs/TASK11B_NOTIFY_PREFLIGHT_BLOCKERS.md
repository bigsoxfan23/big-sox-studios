# Task 11b notification extension — implementation blocked at preflight

Prepared by Codex on 2026-10-22. Status: STOPPED before application implementation, migration, or configuration edits, as explicitly required for unknown credential/sender/access/cost risks. No notification feature has been implemented or validated. This report is not deployment acceptance.

## Isolation and baseline

- Fetched origin/main; exact baseline ccaa20c981772f0147a6477662fad7f908643b52, merge of Task 11b Turnstile Siteverify hotfix. Parent hotfix 7c3291a. This is the current fetched upstream main requested as the PR37 baseline; a separate pull-ref lookup failed DNS and PR number was not independently confirmed.
- Created /tmp/bss11b-notify-worktree on local branch codex/task11b-membership-notifications, tracking origin/main. All task-authored files are in /tmp or this new worktree. Original checkout has no task-authored changes. Shared Git metadata was updated only to fetch upstream and establish the requested local worktree/branch.
- /tmp/BSS11B_NOTIFY_ARCHITECTURE.md does not exist. The historical architecture-run log is present; inspected relevant evidence, without treating an unfinished log as an approved design.
- No subagents or Claude used.

## Current authenticated nonsecret evidence

Read-only Cloudflare GET inventory saved to /tmp/BSS11B_NOTIFY_NONSECRET_METADATA.txt. Script /tmp/bss11b-notify-metadata.py reads the existing Cloudflare OAuth credential in memory and emits binding names/types plus an explicit allowlist of nonsecret values. No provider token was read or extracted. No response containing credentials was printed or saved.

Public Worker:
- Actual name big-sox-studios; bss-big-sox-studios settings returns 404. Avoid deploying a new Worker under the presumed name.
- Active version 7a88a7ba-b119-41e1-857f-c8994fb5138d at 100%, deployment 2026-10-22T17:27:13.707188Z.
- Only provider-independent secrets EMAIL_HMAC_KEY, RATE_HMAC_KEY, TURNSTILE_SECRET_KEY; ASSETS and REQUEST_LIMITER bindings.
- Membership D1 21e13fa1-0ab3-4573-8d20-983c847ba0e9; daily cron 17 4 * * *.
- No service binding, notification HMAC secret, Notion secret, or Resend secret.

Mail Desk:
- bss-mail-desk-staging active version 0eee04f5-a3b3-47e1-a2f0-75fd440779e9 at 100%, deployment 2026-10-21T03:11:20.74457Z.
- NOTION_API_TOKEN and RESEND_API_KEY are secret_text bindings. Presence does not establish current provider validity, scope, balance, sender verification, or remaining quota.
- NOTION_SYNC_MODE=live; NOTION_SYNC_START_UNIX=1792109774; existing cron */5 * * * *.
- DEPLOYMENT_STAGE=staging; SEND_MODE=live; ALLOW_REAL_SEND=true.
- MAILDESK_REPLY_ACTIVATION=owner-reviewed-customers-v2; MAILDESK_CUSTOMER_REPLIES=enabled; MAILDESK_CUSTOMER_RECIPIENT_POLICY=exact-forwarded-requester-v2.
- MAILDESK_RECIPIENT_ALLOWLIST=["fridman.greg@gmail.com"]. Existing policy is NOT restricted to an owner canary: reply.resend.mjs intentionally permits reviewed customer recipients under the active policy. Do not reuse replyEnabled as membership owner-only authorization.
- Existing DB binding remains separate: 6595c7ed-cbdb-4d8d-8f89-fc8b87f68860. No D1 queries or mutations performed in this session.
- Repository mail-desk/wrangler.staging.toml instead specifies mock sends and Notion off, omits deployed settings, and is not a safe replacement for live configuration. Do not deploy it over live settings.

Owner:
- bss-owner-launchpad uses the same membership D1, existing membership CSRF secret and owner identity secret; no owner configuration changed.
- APP_ORIGIN=https://owner.bigsoxstudios.com. Source queue is /membership/requests/.

## Stop conditions

1. Current Resend domain/sender authorization, key restrictions, account plan and quota/headroom have not been established by nonsecret provider evidence. Mail Desk bindings and historical sends are not proof. No Resend credential is available to this task as an authorized local read-only provider credential; do not extract Worker secrets or invent one.
2. Cloudflare account subscriptions GET returned 403. Account-wide headroom and enforcement of $0 additional spend are not verified by this inventory. Historical Free-plan evidence does not establish current headroom, and no quota/cost guarantee follows from bounded code alone.
3. The supplied premise of owner-canary-only active Resend permissions is contradicted by current Mail Desk activation settings. Automatically reusing its current reply library would inherit a broader recipient policy and its existing approval workflow. A separate capability is required.
4. No new internal authentication secret is provisioned. This is expected future gated configuration, but no secret may be inferred from EMAIL_HMAC_KEY, RATE_HMAC_KEY, CSRF_SECRET, a service binding, or a provider key. A service binding does not itself provision or transmit an HMAC secret.

These are evidence gaps and design constraints, not a claim that the proposed feature is inherently unsafe. The user's explicit STOP instruction takes precedence over continuing with assumed sender permissions or cost readiness. No implementation commits, failure-injection tests, migration tests, full validation, or Wrangler dry-runs are claimed. Running baseline checks would not resolve these blockers.

## Source inspection and proposed safe continuation

- Membership inserts use ON CONFLICT(email_hash) DO NOTHING; audit triggers provide atomic request/audit behavior. Add a new migration with an AFTER INSERT trigger to create one unique notification outbox record per genuinely new request. Anonymous duplicates must never enqueue or alter decisions. Public response must continue to depend only on committed local intake, never on notification transport.
- Existing retention sweep is bounded and implements pending expiry at 90 days, terminal PII removal at 30 days, audit deletion at 365 days. Preserve it, run it independently of notification outcomes, and append a separately bounded daily outbox service. Define side-effect claim retention explicitly so audit TTL never deletes the suppression needed to prevent duplicate mail/create.
- Existing LiveNotion is deliberately support-only. It rejects membership channel and permits only folder PATCH. Do not relax it or use the generic mapper, which includes requester PII and members@ rather than Website. Add a separate membership adapter with fixed minimal schema, no applicant details, fixed provider host, manual redirects, bounded streamed JSON and a deadline covering both fetch and body parsing.
- Existing sendReply accepts broader customers under the live policy and expects a durable stage callback. It must not become the automatic membership sender. Add a separately gated transport with fixed sender support@bigsoxstudios.com only after provider verification, fixed verified owner recipient, fixed generic subject/body and protected owner queue URL. No caller-supplied recipient, sender, message text or URL.
- Prefer a dedicated named Mail Desk service entrypoint that has no public HTTP action route. Bind only the membership Worker to it, and additionally verify a purpose-specific HMAC over version, method, fixed destination, timestamp, nonce and canonical payload. Provision a fresh high-entropy secret independently to both Workers at a later gate. Reject stale/replayed/malformed messages before all effects. Keep durable claims/replay protection in membership storage, not existing Mail Desk support tables. Any new DB binding must be additive and reviewed separately; preserve existing bindings and roles.
- Service authentication alone is insufficient for replay/concurrency safety. Establish durable membership D1 compare-and-swap claims before starting either provider effect. Define handling of caller timeout and server continuation: an in-flight/UNKNOWN claim must never be automatically reclaimed for a new side effect. Query-only reconciliation is safe; blind create/resend is not.
- Find Notion pages by exact External Case ID before create; multiple or incomplete results fail closed. UNKNOWN creation may reconcile a found page but must never recreate on an empty/eventually consistent query. Updates may only set approved membership decision fields on the linked, validated page; never reset an existing support ticket, ownership, Reference or Sequence.
- c3250338-3691-4fae-a7ae-35ed66a31a23 is the supplied External Case ID, not an assumed Notion page ID. Reconcile it by External Case ID, verify the matching page, record the link, and permanently suppress retroactive email. Historical architecture output reports one matching page; this session made no Notion queries or changes and does not certify the current match.
- Use a stable per-request provider idempotency key. Transport timeout, ambiguous status/body, or persistence failure after dispatch leaves UNKNOWN and no blind resend, including after provider idempotency windows expire. Backoff only operations known not to have been accepted and safe reads; use bounded retries and explicit reconciliation for ambiguity.
- Keep separate membership Notion and email toggles off in both sides, regardless of existing support live flags. Preserve the existing retention cron and support cron. Use a production candidate config reconstructed from current nonsecret settings rather than replacing live settings with the stale checked-in Mail Desk mock config. No secrets in repository.

## Independent reviewer handoff / prerequisites

Obtain a sanitized owner/provider attestation or read-only provider metadata establishing current verified sending domain/sender, permitted fixed owner recipient, key scope, current free quota, shared usage and no-spend limits. Do not paste credentials or use a send as verification. Obtain current account usage/headroom evidence and clarify acceptable behavior when quotas are exhausted. Keep scope to existing providers; Cloudflare Email Routing is not a substitute for the explicitly required Resend delivery.

After blockers are resolved, implement in this isolated branch. Review actual source/diff independently, with no additional coder unless the owner separately authorizes one. Required tests: outbox atomic rollback and duplicate/concurrent intake; public success despite disabled/broken notification bindings; signature/body/timestamp/replay rejection and public route denial; fixed recipient/PII exclusion; concurrent/restarted durable claims; Notion lookup pagination/conflicts/timeout/create ambiguity/link-write failure; manual-ID no-email reconciliation; Resend refusal/timeout/malformed body/persistence uncertainty/no blind resend; owner revision/decision races; bounded backoff and retention independence; old/new migration compatibility. Preserve full existing membership, public, owner, Mail Desk and canary security suites. Use supported Node 24.22.x (default shell here is Node 22.22.1), run full validate and appropriate package tests, then dry-run every candidate config without deployment or provider calls.

Future deployment remains a separate gate even after code passes. No deployment, remote migration, secret provisioning, emails, Notion writes, Access/MFA/DNS changes, immutable receipt changes, GitHub main changes, push or PR creation occurred in this session. Local documentation commit only, attributed to Codex, records the stopped preflight; it contains no implementation.
