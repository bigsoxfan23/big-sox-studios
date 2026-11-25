# Task12 private staging acceptance — SOURCE and OFFLINE tests only

Based on the exact staged PR82 tree `5856bb275999999530df8a296fb4b8bde7ad2f4a`. The starting index matched that tree (`git diff --cached <tree>` was empty). This change is limited to `acceptance/`; the two dedicated staging wrappers continue to import its factory. Pre-existing staged production/doc changes belong to the base tree and were not edited. Nothing was staged, committed, pushed, deployed or activated. No Cloudflare, Notion, Resend or GitHub API was called; no actual email, ticket, resource or migration was created. All signatures, identities, evidence, credentials and provider responses in tests are synthetic. They do not prove live acceptance, MFA, scope, quota, inbox delivery or production readiness.

## CURRENT operator-controlled rolling preflight (Nov 25, 2026): SOURCE ONLY

The previous static 300-second Worker environment attestation is SUPERSEDED. The default trusted-runtime reader now reads the latest HMAC-signed role-specific, at-most-300-second authorization lease from the existing isolated TEST Requests D1. A separately trusted operator can renew each role after a NEW independent live Access/MFA, physical Worker-to-D1 binding, Notion destination-only and Resend scope/free-quota readback; no Worker signing endpoint or renewal credential is provided. New migration-0003-requests-preflight.sql is ADDITIVE SOURCE ONLY and NOT APPLIED. It defines exactly two renewable role rows and append-only history in the already-existing isolated Requests D1, not a new resource.

A renewal advances one role-specific monotonically increasing generation, keeps the original run/nonce, and only updates preflight authorization evidence. The operator-only Node code lives under acceptance/operator/, is NOT imported by any Worker, uses no network and has no real secret. A scoped operator D1 writer can renew only after independently verified fresh evidence; no new Worker version/binding update is required for each renewal. The protected Worker re-reads the current lease for every request and fails closed on expiry/revocation, while retaining all existing requests, immutable send attempts and UNKNOWN locks. If evidence cannot be refreshed, the step pauses safely and can resume on the same approved run after an independently signed new lease, provided the current real Access JWT/session is still valid. Greg does not have to finish the whole acceptance in five minutes. No unattended scheduler, live token or cloud migration has been installed by this work. See operator/PREFLIGHT_RENEWAL_RUNBOOK.md.

Free quota is action-specific: at least TWO verified no-overage messages before the test request; at least ONE before the Owner-approved welcome; ZERO permitted after sends are consumed for Member Active/removal, while all non-spending scope and authentication checks remain mandatory. The existing sender configuration is an intended source pin, NOT proof Resend verified it.

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

Notion is restricted to the pinned private parent `423013a6-47c5-81f8-8bea-cb3730ca4d88`. After durable reservation it GETs exactly `https://api.notion.com/v1/pages/<pinned-parent>` with `Notion-Version: 2022-06-28`; the response must be that page, unarchived, not in trash and without a public URL. It POSTs exactly `/v1/pages` to create a TEST child under that parent with fixed title `Task12 Acceptance — TEST Ticket` and a TEST paragraph identifying run/request/intent. It then GETs only the returned child ID to corroborate its parent, private/unarchived state and exact title. Receipt operations are read-only. There is no search, arbitrary page input, PATCH, sharing, workspace enumeration or parent fallback. GET access/public URL alone cannot prove the private parent or destination-only integration scope: independent preflight must establish both.

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

- Run, nonce digest, revision, explicit `revoked=false`, oldest `observedAt` no more than 300 seconds ago, and expiry covering the attestation. The oldest observation must cover **all** enclosed readbacks; fresh signing cannot refresh old evidence.
- `access`: pinned issuer/hosts/audiences/two identities, independent MFA, exact two-identity allowlist, Member OTP and independent readback digest.
- Exactly two `bindings` entries, ordered Requests/Members: exact binding name/physical UUID, both staging hosts, isolated/zero-grants proof and distinct independent physical readback digests. These must attest the actual wiring of **both entrypoint deployments**, not configured UUID strings or SQL marker rows alone.
- `notion`: pinned parent, private/destination-only/staging-only scope, SHA-256 of the dedicated credential and independent scope readback digest.
- `resend`: exact sender/domain, domain-limited/sending-only/staging-only key, verified sender, exact recipient pins, credential/readback digests, zero spend, no paid fallback and nonnegative integer free quota on each current readback, with two-before-request / one-before-welcome action gates.

See the explicit validation in `attestation.mjs` and the entirely synthetic shape in `test/attestation-fixture.mjs`. A digest does not prove its underlying observation; the operator signer and trusted evidence reader must independently establish it. Never implement the reader by echoing the token, copying env flags or trusting applicant input.

The default verifyTrustedStagingPolicy checks actual Access signed JWT, trusted Access runtime identity, and signed scope readback. Greg still must verify independent MFA in his browser. It must establish the effective unchanged Access policy, MFA **for this current session**, two-identity allowlist and both physical binding readbacks. Its returned flags and exact hosts/IDs/subject/audience/run/expiry are checked. The original RS256 JWT/JWKS signature verification and trusted `ctx.access` identity/OTP checks always run first; neither an HMAC signature nor this hook substitutes for them. Env MFA flags or JWT `amr` assertions alone are insufficient.

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
5. Dedicated Resend domain-limited sending-only key, independent verified sender/domain and scope readbacks, fresh free quota for both messages and no spend/paid fallback. Sending-only credentials cannot introspect their own complete scope; no full-access fallback is allowed. The pinned sender is required source intent, not a claim of existing verification.
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
