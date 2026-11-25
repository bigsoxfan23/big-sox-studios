# Task12 private staging acceptance — SOURCE and OFFLINE tests only

Based on the exact staged PR82 tree `5856bb275999999530df8a296fb4b8bde7ad2f4a`. The starting index matched that tree (`git diff --cached <tree>` was empty). This change is limited to `acceptance/`; the two dedicated staging wrappers continue to import its factory. Pre-existing staged production/doc changes belong to the base tree and were not edited. Nothing was staged, committed, pushed, deployed or activated. No Cloudflare, Notion, Resend or GitHub API was called; no actual email, ticket, resource or migration was created. All signatures, identities, evidence, credentials and provider responses in tests are synthetic. They do not prove live acceptance, MFA, scope, quota, inbox delivery or production readiness.

## Follow-up source corrections to the independent NO-GO on 36fd5eb9 (Nov 25)

A fresh separately run, read-only Codex defensive review of parent commit 36fd5eb9 returned SOURCE NO-GO (HIGH one, MEDIUM two), not approval. This later unreleased source delta addresses the specific boundaries: (1) each irreversible outbound email/Notion POST/PATCH re-checks its original current HMAC-signed lease generation and permanent revocation directly in the exact isolated Requests D1, including after preliminary external GETs; prior authenticated lease objects alone are insufficient, (2) a revoked Notion decision is only dispatched after the prior approved decision PATCH has become a terminal accepted D1 receipt, so concurrent writes cannot be reordered; unresolved/UNKNOWN predecessor blocks any later PATCH while Request-first revocation still immediately denies Member access, and (3) signed Owner session expiration bounds the decision reservation in D1 SQL time and the adapter's final outbound I/O gate. If a competing Request-first revoke races the approval PATCH, the local approval sync is marked UNKNOWN rather than falsely accepted, and manual reconciliation is required; no speculative compensating PATCH or retry is allowed. These source-only corrections require NEW exact-commit independent security review before any staging activation. The single completed earlier review remains NO-GO for its exact 36fd5eb9 source.

## CURRENT Nov 25 staging-only source amendment — Greg's bounded two-send risk choice

Greg approved accepting residual shared-Resend-quota uncertainty for one private TEST only. He did NOT authorize paid overages, broad/full-access keys, actual builder sends, additional resources, production use or staged activation before all other gates. The Account Usage API requires Full access and is not used. Before ANY request, a separately authorized operator must independently verify actual Free transactional plan, disabled paid overages, correct verified sender/domain, a domain-restricted Sending-access key, and a reasonable remaining allowance of at least TWO permitted sends. The operator records ONLY an opaque credential digest and historical quota snapshot in the immutable acceptance_send_budget table in the EXISTING isolated TEST Requests D1 using prepareStartBudget/applyStartBudget. This is source-only and the table/migration is NOT deployed. The baseline is immutable and cannot be replaced, upgraded or refreshed by the Worker. The first signed request must begin within 300 seconds of the actual observed baseline.

At subsequent role-lease renewals, the historical Resend start allowance is referenced by exact original signed fingerprint (NOT represented as a fresh usage read). The operator must still reverify actual current Access/MFA policy, exact staging physical D1 bindings, isolate/grant zero and private TEST Notion scope and the correct source/rollback evidence before publishing each 300-second signed role lease. Resend usage is never fetched with full access; no cron or live signer is installed. If anyone learns of a billing-plan/overages/key/domain/sender-scope change, halt and irrevocably revoke operator lease(s) before another provider action. A plan change cannot be detected automatically with a sending-only key: this residual risk is explicitly bounded to Greg's two-send TEST acceptance, not a guarantee of zero billing. Any rejected, ambiguous or timed-out provider attempt is permanently locked without retry.

One run may reserve at most exactly ONE Gmail Owner notice and ONE explicitly approved Outlook TEST welcome; immutable DB effect locks and a two-send SQL trigger count even uncertain/reserved attempts. The Notion intake ticket is a separate single immutable effect. Its title is prefixed TEST · Task12 Acceptance; the original TEST paragraph contains an opaque request ID, pending status and timestamp. After Owner approval/revocation, the Worker may perform EXACTLY ONE audited, pre-reserved PATCH of that already-created private TEST child per decision, followed by a read-only receipt; uncertain sync blocks welcome (revocation always denies the original session). This narrowly scoped PATCH matches the private TEST parent requirements, without search, workspace-wide queries, arbitrary page input, tickets, grants or new identities. The Owner queue displays authoritative D1 status and permanent Notion sync results.

## CURRENT operator-controlled rolling preflight (Nov 25, 2026): SOURCE ONLY

The static 300-second Worker preflight was superseded by the existing isolated Requests D1 operator lease. Each lease refreshes current independent Access/MFA policy, physical database bindings, private Notion scope, current source/rollback. The actual Resend usage evidence is a distinct immutable ONCE-AT-START snapshot, not a purported refreshed quota read.

A renewal advances one role-specific monotonically increasing generation, keeps the original run/nonce, and only updates preflight authorization evidence. The operator-only Node code lives under acceptance/operator/, is NOT imported by any Worker, uses no network and has no real secret. A scoped operator D1 writer can renew only after independently verified fresh evidence; no new Worker version/binding update is required for each renewal. The protected Worker re-reads the current lease for every request and fails closed on expiry/revocation, while retaining all existing requests, immutable send attempts and UNKNOWN locks. If evidence cannot be refreshed, the step pauses safely and can resume on the same approved run after an independently signed new lease, provided the current real Access JWT/session is still valid. Greg does not have to finish the whole acceptance in five minutes. No unattended scheduler, live token or cloud migration has been installed by this work. See operator/PREFLIGHT_RENEWAL_RUNBOOK.md.

Free/no-overage account evidence and at least TWO permitted messages are established ONCE at initial test start, before the first request. The immutable test ledger then enforces exactly the one Gmail notice and one Outlook welcome attempts (including refused/UNKNOWN), without retry or fallback. No fresh Resend usage read is possible with the allowed domain-restricted Sending key.

Cloudflare official Nov 2026 docs support ctx.access.aud and ctx.access.getIdentity() for DIRECT Access-authenticated Worker fetches, and explicitly exclude service bindings/static assets. Read-only readback of both currently active exact staging scripts confirmed neither kind of binding and the matching exact protected hosts/audiences. Existing policy MFA-enabled status is not proof that a PARTICULAR login completed an MFA challenge; the actual signed-in Owner/Outlook browser sessions and OTP identity shape remain Greg's later acceptance gate.

## Entrypoints and flow

`members-portal-staging/private-acceptance-entry.mjs` and `owner-launchpad/src/private-acceptance-entry.mjs` wrap the original assemblies. Only `/acceptance` and `/acceptance/*` enter this code; every other route retains its original Request, env and context. Production import graphs exclude acceptance. No Wrangler, Access, route, production code or deployment configuration was changed.

The Member host is `members-staging.bigsoxstudios.com`; the Owner host is `bss-owner-launchpad-staging.fridman-greg.workers.dev`. The source pins their existing exclusive Access audiences, issuer, exact Outlook/Gmail identities, two isolated database IDs, Notion parent and sender. Other origins, previews, methods, query strings, cross-origin POSTs and recipient input fail closed.

1. GET `/acceptance/request` discloses the private TEST Notion ticket and Gmail notice. It performs no provider I/O. The exact Outlook identity must pass the signed Access JWT verifier, runtime `ctx.access` audience/identity and `onetimepin` check, independent MFA/policy verification, genuine operator attestation and fresh trusted preflight. OTP alone is insufficient MFA. There is no anonymous intake.
2. Its same-origin POST requires a JWT/session-bound HMAC CSRF cookie/form, exact source revision and TEST confirmation. Scope/credential checks precede writes. One Requests D1 batch atomically inserts the singleton run, immutable TEST request, **locked** outbox and both immutable consumed intents: one Notion ticket and one Gmail Owner notice. Constraint failure rolls back everything. Only the successful submitter dispatches; duplicates cannot reserve or send. The ticket must have a corroborated, durably recorded acceptance before the notice is attempted. A successful POST returns 201; ambiguous or partial provider outcomes return 409 with consumed evidence retained.
3. The old Owner `.../{request}/dispatch` returns 410 for authenticated GET/POST and has no form, reservation, recovery or retry behavior. A stranded historical outbox is not dispatched by this source. Owner approval remains a separate protected POST `.../{request}/decision`, requiring current request/source revision, fresh Owner session, SQL-time expiry and accepted ticket/notice evidence. It inserts one pending TEST Member in Members D1.
4. Owner GET/POST `.../{request}/send-welcome` explicitly reviews and confirms ONE TEST welcome to the pinned Outlook address. It reserves the immutable welcome intent before I/O. Approval alone does not send a welcome or admit the Member.
5. GET `/acceptance/app` requires the same fresh authenticated Outlook identity, current approved request and accepted welcome. It binds only the isolated TEST identity and activates only the isolated TEST Member. Every real service route denies. No accounts, grants, Jellyfin readiness or production session is created.
6. Owner POST `/acceptance/members/{member}/remove` first revokes the authoritative request, then the isolated Member. The original JWT/session loses admission. Audits, identity binding and all attempt evidence remain. Every app request checks Requests again after awaited Members writes.

`reserved` already consumes the only attempt (DISPATCHING). `accepted`, `refused` and `unknown` are terminal. **Never retry UNKNOWN**, including timeouts, redirects, 429, malformed receipts, crashes and failed outcome persistence. A failed or unattempted second effect remains permanently reserved. The 5-second provider/receipt deadline aborts transport and ignores late completion. No requeue, reset, automatic retry, background queue, alternate provider or attempt-budget increase exists. A timeout may mean the provider already accepted the POST; even idempotency headers do not authorize a retry. A new run/nonce cannot reuse these databases.

Cross-D1 operations are fail closed, not distributed transactions. Approval can remain without a pending Member after a crash; this cannot welcome/admit anyone. Requests revocation denies admission even if the Members write fails. Such partial states require separately reviewed reconciliation, with no repair endpoint. The unchanged migration's reserve-audit trigger has the historical actor label `owner` even for Member-triggered reservations; this static label does not establish the actor's authentication. The request audit records `tester`; authenticated Member POST is the only initial dispatch path.

## Staging provider adapters

`adapters.mjs` contains actual wire-format adapters; every transport in tests is mocked. The default factory includes a trusted signed-snapshot preflight reader and Access policy verifier. It still fails closed without an independently observed and signed fresh snapshot, dedicated scoped credentials, and edge-enforced MFA. Configuration flags alone cannot activate it. Those dependencies are server-owned functions, never request-selected or read from an env readiness flag. There is no shipped operator signer/evidence collector in the runtime import graph.

Notion is restricted to the exact existing private TEST parent. It GETs that parent, POSTs exactly one child titled TEST · Task12 Acceptance — pending with opaque run/request/intent ID, pending status and timestamp, and GETs the child for private-parent corroboration. Owner review or revocation permits one additional pre-locked PATCH of only the same verified private TEST child title to include the audited decision and timestamp, followed by GET. A distinct append-only local decision sync ledger records accepted/UNKNOWN/refused, no retry. No Notion search, second ticket, arbitrary destination, sharing, workspace enumeration or fallback; a failed approval sync blocks the TEST welcome.

Resend makes only HTTPS POST `https://api.resend.com/emails`, with a domain-limited **sending-only** runtime credential and sender exactly `support@bigsoxstudios.com` on `bigsoxstudios.com`. Sender verification is independently required, not inferred from an env string. The only JSON fields are `from`, `to` (one exact address), `subject`, `text`:

| Effect | Exact recipient | Exact subject |
| --- | --- | --- |
| Owner notice | `fridman.greg@gmail.com` | `TEST request awaiting review` |
| Confirmed welcome | `greg.fridman@outlook.com` | `TEST welcome — no service access` |

Text is reconstructed from source pins; incoming text, CC/BCC, reply-to, headers and sender changes are refused. The idempotency key is the already-consumed intent UUID. Receipt evidence is the successful HTTPS POST 200 JSON UUID response, retained by object identity inside the adapter. Sending-only keys cannot GET emails: this implementation never asks for broader permissions to retrieve receipts. Acceptance does not establish inbox delivery. Both adapters reject redirects, non-200 responses, malformed/oversized JSON and uncorroborated IDs; errors contain no provider body/credential and nothing is logged.

## Operator attestation and independent preflight

All secret values exist only in runtime `env`. Source pins and runtime checks require:

- `ACCEPTANCE_MODE=private-staging-source`, `ACCEPTANCE_REVISION=task12-private-acceptance-v1`.
- `ACCEPTANCE_REQUESTS` / `ACCEPTANCE_MEMBERS` bindings and respective `_ID` values exactly matching the two UUIDs below. Distinct objects, installed markers, zero grants, legacy alias rejection and immutable run/nonce are checked after independent binding proof.
- Runtime `ACCEPTANCE_OWNER_RECIPIENT` / `ACCEPTANCE_TEST_RECIPIENT` exactly matching the pins.
- Independent 32-byte random canonical base64url `ACCEPTANCE_CSRF_KEY`, `ACCEPTANCE_RUN_NONCE` and **separate** `ACCEPTANCE_ATTESTATION_KEY`; fixed 16–64 character `ACCEPTANCE_RUN_ID`.
- `ACCEPTANCE_NOTION_PARENT` equal to the pin, dedicated runtime `ACCEPTANCE_NOTION_CREDENTIAL`, dedicated `ACCEPTANCE_SENDER_CREDENTIAL`, `ACCEPTANCE_VERIFIED_SENDER=support@bigsoxstudios.com` and `ACCEPTANCE_DISPATCH_GATE=greg-one-run:<run ID>`. Length, sender string and gate alone prove nothing.
- Static Worker environment attestation and preflight JSON are NO LONGER used by the default staging entrypoint. The current signed role lease is read fresh from the exact isolated Requests D1 on every protected request. See the operator runbook.

The HMAC token still has an at-most-300-second lifetime, signed for one run, nonce, exact role/audience, source revision, lease generation and SHA-256 of an independently read scope snapshot. Only a separately privileged offline operator can issue the next generation. The runtime validates the current genuine signed Access JWT and ctx.access identity independently. No live key/signer was installed.

The default readSignedPreflight now selects the latest role-specific signed lease and JSON evidence from isolated Requests D1, not static Worker env. HMAC verification binds the exact UTF-8 JSON and lease generation; every action independently checks session, actual two database markers and the original run. A supplied environment boolean or attacker request cannot override it.

- Each 300-second operator lease has fresh run/nonce/revision/revocation and independently observed Access/MFA, physical D1/isolation, private Notion and rollback evidence. The separately time-stamped Resend quota baseline is explicitly historical, bound by the original signed hash in immutable D1, not refreshed on lease renewal.
- `access`: pinned issuer/hosts/audiences/two identities, independent MFA, exact two-identity allowlist, Member OTP and independent readback digest.
- Exactly two `bindings` entries, ordered Requests/Members: exact binding name/physical UUID, both staging hosts, isolated/zero-grants proof and distinct independent physical readback digests. These must attest the actual wiring of **both entrypoint deployments**, not configured UUID strings or SQL marker rows alone.
- `notion`: pinned parent, private/destination-only/staging-only scope, SHA-256 of the dedicated credential and independent scope readback digest.
- Resend: exact sender/domain, domain-limited Sending-only staging key, verified sender, pinned two recipients, credential digest and private scope. An immutable once-at-start signed Free/no-overage, two-send headroom snapshot is checked against isolated Requests D1. On lease renewal this historical quota is NOT represented as a new live read; current Access, MFA policy, D1 isolation and private Notion evidence remain independently refreshed.

See the explicit validation in `attestation.mjs` and the entirely synthetic shape in `test/attestation-fixture.mjs`. A digest does not prove its underlying observation; the operator signer and trusted evidence reader must independently establish it. Never implement the reader by echoing the token, copying env flags or trusting applicant input.

The default verifyTrustedStagingPolicy checks the signed Access JWT and trusted Cloudflare Access runtime identity against current independently verified Access MFA-ENFORCED app/policy scope. It DOES NOT prove that a particular live browser completed an interactive MFA challenge. Greg's separate Owner/tester browser acceptance must establish session-specific factor completion. The signed role lease, exclusive aud/issuer, OTP identity type, D1 markers, exact host, CSRF and current session are never bypassed.

## Existing schema and exact activation blockers

The prior README reported the following separate deltas already applied and read back under earlier staging authorization. This source-only session did **not** verify those live claims or apply/reapply anything:

| Previously reported isolated D1 | Existing unchanged schema and delta |
| --- | --- |
| Requests `5f333c95-de64-4a37-8467-8a0bbba7dd9b` | `requests.sql`, `migration-0002-requests.sql` |
| Members `adf83cdc-e8df-4cc4-acd5-3f89ce6f34ea` | `members.sql`, `migration-0002-members.sql` |

All four SQL files remain byte-for-byte unchanged. Non-idempotent deltas must not be blindly reapplied. SQL markers are secondary checks; D1 objects expose no trustworthy physical UUID. No historical staging or production database is an allowed target.

**Activation is blocked.** No genuine independent evidence, signer integration, credential or configuration was supplied or inspected here. Specifically outstanding:

1. Independent effective Cloudflare Access application/policy readback for the exact two identities, Member Outlook OTP and independently enforced/session-verified MFA. A working trusted `ctx.access` runtime and reviewed `verifyAccessPolicy` implementation are required; no manufactured MFA is acceptable.
2. Fresh independent physical wiring readbacks for both exact isolated D1s on both staging deployments, plus installed schema/run/nonce and zero-grant evidence. Local fixtures and SQL markers do not establish cloud isolation.
3. Externally verified current MFA/policy and physical D1 readbacks, approved scoped writer/signer custody, and explicit source-only migration 0003 review are required before operator renewal. The signed role lease does not need a FUTURE browser JWT, but every incoming request requires its own current verified JWT.
4. Dedicated destination-only Notion integration with only the private pinned TEST parent and its TEST descendants shared. Actual private state, integration permissions and API response compatibility are unproved; a successful page GET cannot inventory the key's complete access.
5. Dedicated exact-domain Sending-access Resend key and independently verified sender + actual Free/no-overage settings and two permitted sends ONCE immediately before the TEST run, with Greg's acknowledged shared-quota uncertainty. Sending-only credentials cannot check later account usage: no broad key or fresh renewal claim.
6. Separately authorized protected staging configuration/run and actual read-only ticket receipt/inbox evidence. This task authorizes **none** of that activation work. Production remains outside scope.

If any required dependency cannot be genuinely proved, keep acceptance closed. Credentials or signed operator assertions without independent evidence do not remove these blockers.

## Offline verification

Use installed Node **24.22.0** and existing local dependencies; no installation or remote Wrangler operation is needed:

```sh
node --test --experimental-test-isolation=none acceptance/test/flow.test.mjs acceptance/test/adapters.test.mjs
node --test --experimental-test-isolation=none acceptance/test/workerd.test.mjs
node_modules/.bin/eslint acceptance members-portal-staging/private-acceptance-entry.mjs owner-launchpad/src/private-acceptance-entry.mjs
git diff --check
```

The original **22 regression cases** remain, with setup/expectations updated for Member-triggered dispatch and retired Owner dispatch. The added adapter/security suite exercises the real source adapter paths with fully mocked HTTPS, synthetic RS256 JWT/JWKS, HMAC operator signatures and independent evidence. A global network guard rejects any uninjected fetch. Tests cover MFA/auth/attestation tampering, stale/revoked proofs, binding/scope/credential/sender/quota failures, Notion restrictions, exact sending, concurrent duplicates, atomic rollback, SQL-time expiry, UNKNOWN, receipt deadlines/late completion, persistence crashes, zero grants and original-session revocation.

The Miniflare suite uses **local** workerd/D1 emulation with both actual staging wrapper factories running in Node, synthetic auth/evidence and mocked providers. It checks transactional batches, SQL triggers, trigger-inclusive change counts, full approval/welcome/revocation and actual adapter wire paths through terminal UNKNOWN. It requires permission for loopback listeners only, never Cloudflare access. This is local D1 execution, not deployed-worker or live Access validation.
