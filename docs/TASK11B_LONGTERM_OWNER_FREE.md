# Task 11b long-term owner-only free mode — candidate, disabled

This branch is source/tests/docs only. No push, merge, deployment, production D1 change, secret change, Notion write or email is authorized here. The current live expiry remains in force. **Fresh owner explanation and approval are required before bypassing/removing the live expiry.** This document is not approval.

## Two separate policies

The existing temporary policy is unchanged when `PERMANENT_OWNER_FREE_MODE` is absent or exactly `false`: email must be enabled, fixed sender/owner must match, credentials must pass format validation, original cutover must be valid and reached, the provider attestation must be unexpired and no more than 24 hours ahead, and the temporary daily allowance must be 1–10. A six-hour window remains supported. Invalid permanent flag values fail closed, including empty, uppercase and numeric values.

The candidate permanent policy is entered **only** with literal `PERMANENT_OWNER_FREE_MODE="true"`. All these additional invariants are required:

| Setting | Required value |
| --- | --- |
| `EMAIL_ENABLED` | `true` (processing and Notion must also be enabled to run jobs) |
| `OWNER_EMAIL`, `SENDER_EMAIL` | Compiled fixed owner recipient and support sender |
| `NOTIFY_START_MS` | Preserve original approved cutover, valid nonzero epoch milliseconds, at or before now |
| `RESEND_API_KEY` | Existing purpose-limited sending-only secret, valid format; never Full Access |
| `PROVIDER_VERIFIED_UNTIL_MS` | Literal `0`, separates this policy from temporary approval |
| `PROVIDER_DAILY_LIMIT` | Literal `0`, prevents mixed policies |
| `PERMANENT_OWNER_FREE_DAILY_LIMIT` | Literal `1` |
| `PERMANENT_OWNER_FREE_MONTHLY_LIMIT` | Literal `15` |
| `PERMANENT_OWNER_FREE_ATTESTATION` | Literal `resend-free-sending-only-no-overages-v1` |
| `PERMANENT_OWNER_FREE_ATTESTED_AT_MS` | Release attestation timestamp, at/after original cutover and at/before now |

Strings with whitespace, alternate formatting, larger caps or missing settings cannot enable permanent sends. A true permanent flag with invalid settings cannot fall back to the temporary policy. The checked-in configuration has all activation flags false, both permanent caps 0, empty attestation and timestamp 0. Existing temporary defaults remain 0. Permanent settings do not activate anything while the mode is false.

The attestation is an operator assertion, not proof derived from the key. Key syntax cannot establish sending-only scope, sender authorization, account plan or billing settings. No API key is created, read from a secret store, copied or widened by this implementation. Before any future release, retain a private, nonsecret release record identifying the reviewed source tree, approval, original cutover, attestation time, confirmed Free plan/no paid subscription or fee upgrades, authorized support sender, fixed owner recipient, restricted sending-only key scope, and shared-account budget allocation. Do not record secret values or applicant data. If plan, sender authorization, scope or budget assumptions change, disable email pending review; this code cannot detect such external changes. No automatic renewal or plan upgrade exists.

## Durable attempt budgets and concurrency

No migration is added. Existing `membership_notify_send_attempts(application_id PRIMARY KEY, utc_day)` and `membership_notify_send_day(utc_day)` provide durable per-application attempt tombstones and indexed UTC budgets. The Worker only inserts reservations; it never updates or deletes them. Existing historical reservations from either policy and every outcome count, including refusal, timeout, UNKNOWN and interrupted dispatch. Administrative database tampering/restoration is outside the Worker guard; never erase or rewrite reservations or intent state.

In permanent mode, a single INSERT/SELECT checks absence of any reservation for the UTC day and counts at most 15 indexed rows in the half-open UTC month range. UTC day numbers derive from epoch milliseconds; UTC month start and next-month start use `Date.UTC`, including December/January and leap February. There is no applicant/event-history scan and no unbounded monthly COUNT. Work is bounded by one day-index lookup and at most 15 month-index entries, rather than total retained history. This is bounded indexed work, not a measured production CPU claim.

D1 atomically commits the quota reservation and the case's NEW → UNKNOWN intent in one batch. `changes()=1` on the intent statement requires that this transaction actually inserted a fresh reservation; an older application reservation cannot become permission to send. D1 serializes competing writes; budget checks occur inside the write statement, with no read/check/write race. Existing provider-check CAS, per-application leases and schema validation remain intact. A failed transaction rolls back both operations. A lost commit acknowledgement cannot dispatch after restart because intent is UNKNOWN. After the batch, permanent dispatch rechecks policy and the reserved UTC day synchronously before calling the sending adapter. Crossing midnight or losing policy eligibility consumes the reservation and leaves UNKNOWN for manual review. Caps apply to Worker dispatch attempts by UTC reservation day; provider acceptance/delivery can finish later across a boundary.

After reservation, UNKNOWN and REFUSED never authorize automatic retries. Explicit provider refusals including 429 consume capacity and remain REFUSED; timeouts, 5xx, malformed responses and uncertain acknowledgements remain UNKNOWN. The original stable per-application Resend idempotency key is preserved, but is never treated as permission to retry after its provider window. Completed-event pruning does not erase case/attempt tombstones. No automatic UNKNOWN reset, reservation reset, refund or rollover deletion exists.

## Status sync and exclusion

Notion reconciliation and current-status PATCH happen before the email gate. Disabled/invalid email and quota waits leave email NEW with one-hour deferred submitted work, consume no event failure attempts, and let independent status events proceed. Rejection, revocation and expiration can still close Notion tickets. The existing Notion provider-check CAS/backoff is unchanged. Manual adoption and legacy suppression remain permanent; applications before the original cutover become SUPPRESSED, never historical sends. No applicant email, member account, invitation or applicant PII copy is introduced. Payload and recipients remain compiled constants.

## $0 scope and remaining release risks

Owner-supplied October 2026 pricing facts for this offline task: Resend Free allows 100/day and 3,000/month, and paid overages are available only with paid subscriptions. This candidate allocates at most 1/day and 15/month to this Worker. It does **not** establish shared-account remaining capacity or guarantee provider delivery; other senders may exhaust the shared Free account and cause refusal. Remain on Free, do not authorize unattended paid subscriptions/upgrades, and do not claim an account-wide spend guard from a local counter.

Resend GET /usage requires Full Access. There is no usage API request or credential introspection in the Worker; the restricted sending-only credential remains mandatory. No new keys or permissions are part of this branch. Usage/plan verification belongs to a separately approved release review, using authorized account information without placing unrestricted credentials on this Worker.

Workers Free has a 10 ms cron CPU cap. Existing attempts to read usage GraphQL lacked read-only Analytics authorization and returned 401 (owner-supplied context). This branch does not change that authorization or claim observed production CPU headroom. Indexed query plans and local workerd correctness are not production CPU telemetry. Keep the candidate disabled until the owner explicitly accepts the documented uncertainty and separately authorizes the release. There is no release action in this task.

## Offline checks and future approval

Tests use synthetic data, node:sqlite and workerd/Miniflare with in-memory D1 and mocked outbound services. They cover both policies, exact invalid configs, daily/monthly caps, year/leap/UTC boundaries, overlapping invocations, atomic intent rollback, lost acknowledgement, refusal/exhaustion, UNKNOWN/idempotency, post-reservation midnight/config changes, cutover/manual suppression, and independent status closure. Real D1 runtime tests exercise `changes()` and monthly rollover. Query-plan assertions require the existing UTC-day covering index with no temporary sort. No real Resend/Notion calls or Wrangler deployment are needed.

A future owner question must explain the security change before asking: “Do you approve replacing the live expiring manual email attestation with the reviewed permanent owner-only Free mode, capped at 1 attempt/day and 15/month, relying on release-time Free-plan/sending-only-key attestations without independent shared-account usage visibility, while accepting unverified production CPU headroom? Any merge/deploy/activation needs separately explicit authorization.”

Approval has **not** been obtained here. Do not change the live `2026-10-23T07:48:48.931Z` expiry on this branch's authority. Preserve the original cutover and all reservations, UNKNOWN/REFUSED and suppression state. Future rollback should disable email first; resetting the permanent flag alone does not enable the zeroed temporary policy. Restoring temporary mode requires a fresh short attestation/allotment approval; never clear durable state to restore sending. Existing effects may finish after a disable operation.
