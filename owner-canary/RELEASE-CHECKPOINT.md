# Task 10 release checkpoint — October 16, 2026

## Status
Disabled and undeployed. Task 10 remains in progress. No Resend key was provisioned, no real email submitted and no PR merged during this recovery.

## D1 recovery
ChatGPT via Work/Remote Desktop Commander used existing authenticated Wrangler OAuth to apply the unchanged reviewed migrations/0001_canary.sql to bss-owner-canary (605da28d-d69b-4a97-8775-36fe7e4835e1) using remote whole-file execution.
Migration SHA-256: e7b65901d9dbeab7075ff379ce127dd82f5ef09f21639d0b0993e7171afef438.
Remote sqlite_master exactly matched the original migration parsed in local SQLite: canary_campaign and canary_no_delete, canary_insert, canary_immutable, canary_transition.
Remote campaign count: zero. Existing Mail Desk schema: all 24 objects unchanged before/after, no mutation targeted it.
Remote PRAGMA integrity_check is unavailable; only local SQLite integrity was checked. Full binding inventory and remote concurrency remain unverified.

## Independent review of original candidate
An independent Codex session directly reviewed tree 876aee0780631cb2dfa735846573f0ffe6a65008, reran 180 canary, 481 Mail Desk and 58 launchpad tests, and passed syntax/lint checks.
Local Miniflare/workerd D1 probes passed 23 ledger assertions. Across 32 contenders per stage exactly one initialization, transition and terminal update succeeded. The actual coordinator with signed synthetic Access JWTs and local D1 made exactly one stub provider call across 32 concurrent dispatches, with submitted state persisted first; replay and a second preview were denied.
These prove local runtime behavior, not real authentication or inbox delivery.

## Authorization-content correction
The original fixed subject/body did not match Greg's October 16 authorization. This change replaces them with the exact authorized subject and four-paragraph plain text. The immutable-preview expectation and two literal authorization/submission tests cover that change.
Sender remains support@bigsoxstudios.com. Recipient remains secure operator configuration, never browser input; production configuration must be exactly the owner-approved mailbox. Synthetic tests send nothing.
The hardcoded default dispatchAuthorized:false remains intact.

## Blocking authentication dependency
Cloudflare independent MFA policy settings do not establish that the application JWT contains signed amr:[mfa].
Actual exact app audience, owner subject, JWT signature/claims and effective policies have not been independently inspected.
Keep current denial intact until real behavior is established. A policy-backed alternative requires a separately reviewed exact-app signed-token verifier plus independently verified effective owner-only MFA policy, all overrides/bypasses, freshness/session revocation and exposure boundaries. Removing amr or setting an operator boolean is insufficient.
The available Wrangler session has D1/Workers scopes, not Access policy administration. TinyFish currently records GitHub sign-in only; owner is unsure whether Cloudflare/Resend sessions remain saved.

## Other boundaries and rollback
Existing production Mail Desk deployment was inspected: mock mode, ALLOW_REAL_SEND=false, live Notion sync, separate existing D1 and no Resend key binding. Website returns HTTP 200; anonymous Mail Desk returns Access redirect HTTP 302.
Original owner-canary Worker name does not exist in the account. No new Worker, hostname or key was attached by this run.
Customer replies remain blocked independently with verified_ingress_unavailable; owner-canary success cannot unlock them. Owner launchpad remains draft/undeployed.
If isolated deployment later fails, disable only its route/Worker, revoke only its sending key, and preserve its D1 singleton/tombstones. Never reset the ledger to retry an uncertain outcome. No service rollback is necessary for this schema-only recovery.

## Review and approval semantics
Original review is DIRECT and release-blocking. The exact final content correction needs a new independent delta review and GitHub CI.
Greg's current instruction authorizes gated deployment and one exact test; it does not establish a technical PASS. Do not request the same already-granted sending permission again.
