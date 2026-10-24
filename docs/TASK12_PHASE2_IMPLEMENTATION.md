# Task #12 Phase 2 — offline secure foundation

Status: development foundation only; activation and production MF6 acceptance BLOCKED.
Implemented on `feature/task12-secure-foundation-20261024`, based on main
`cc58985028ea298c7483e0a37a806b360b92e699`. The current explicit owner instruction
permits this isolated engineering work; older planning-only Notion banners do not
cancel that instruction. It does not authorize resource creation or rollout.

Contract read on October 24, 2026:
- [Owner-approved architecture and MF1–MF6](https://app.notion.com/p/3f4013a647c58191b858ddcd3079d056)
- [Implementation plan and gates](https://app.notion.com/p/3ff013a647c58135a8d2e99f116d7646)

## Reconciliation with draft PR #13 and #15

Read `origin/feature/members-portal-auth-foundation` schema, authorization, tests
and authentication design directly with `git show`. Retained provider/subject
identity boundaries, D1 roles, explicit service grants and server-side denial.
Adapted the proposal into an isolated new schema with invitations, audited
transitions, unique contact/bindings, projection receipts, links and revocation.
No branch merge and no historical files copied over current main.

Read `origin/feature/members-portal-phase1-staging` Worker, tests and README.
Retained strict host and signature verification and private response headers.
Did not carry over its real hostnames/audiences, signed-email-only identity,
owner-only staging assumptions, rendered dashboard or deployment instructions.
Historical Phase 1 success does not establish member authorization.

The current owner verifier is `owner-launchpad/src/security.mjs`, used from
`owner-launchpad/src/worker.mjs` (the requested top-level Worker path is absent).
`portal/access.mjs` is a deliberately local adaptation: bounded JWKS reads,
RS256, key validation, refresh serialization, rotation/outage denial and strict
times are retained. Owner-email equality is removed. Members require an exclusive
single audience and exact configured issuer/origin. The current owner Worker is
unchanged and is exercised in the reverse-audience offline denial test.

## Implemented security contract

| Must-fix | Offline implementation | Remaining launch dependency |
| --- | --- | --- |
| MF1 | Separate D1 schema is sole authority. Pending membership is explicitly owner-created. Random opaque invitation ID and 256-bit claim secret; SHA-256 digest only stored. Blocked → projected → owner-delivered → claimed. In-memory projection adapter, complete snapshot reconciliation, sanitized attempt receipts. | Reviewed real effective-Access inventory/adapter and owner private-delivery procedure. No actual projection or delivery occurred. |
| MF2 | Fixed 604800-second UTC TTL, boundary denial and persisted expiry audit/history. Partial unique live-invite index includes blocked/projected/delivered. One SQL issue statement atomically supersedes/expires predecessor and inserts/audits successor, with revision/predecessor CAS. Revoked/active members cannot be reissued. | Reviewed migration rehearsal against a separately approved fresh DB and final production concurrency acceptance. |
| MF3 | Claims require branded verified identity plus delivered invitation, exact target email and digest. One SQL update and triggers bind identity, activate pending membership and consume token atomically. Global provider/subject uniqueness; one identity per provider per member. No JIT. Separately verified current/candidate identities, owner approval, expiring link request and collision-safe commit. | Actual provider/broker proof mapping, owner review/recovery UI, nonce/session binding and final Google/OTP/Apple evidence. |
| MF4 | Every Worker path/method reads binding, status, role and grants together from live D1; errors deny; no membership/grant cache. Each service requires an explicit grant, including for owners. Revocation is one audited atomic D1 operation, removes grants/invites and creates six owner cleanup tasks. | Owner executes and verifies external cleanup, including independent Jellyfin disable/session invalidation. No service calls implemented. |
| MF5 | HTTPS exact configured origin and Host/Origin validation before data access. Exclusive members audience, distinct owner audience configuration, D1-only role. Development example disables workers.dev and previews and configures no routes/bindings. | Full real hostname/alias/preview/service-route inventory and final app/MFA/issuer/audience configuration. |
| MF6 | Synthetic signed-JWT P1–P6 OFFLINE PROXIES; local workerd D1 concurrency, rollback, provider/link, projection failure, host, role, outage and direct-route tests. | ALL final-production acceptance cases remain blocked. No offline result is a final production pass. |

`portal/schema.sql` is not in any migration directory and is not loaded by any
existing Worker. It is a new-database schema, deliberately without `IF NOT EXISTS`
so accidental repeat application fails rather than silently accepting old shapes.
No membership-request, notifier, owner, Mail Desk or production schema changed.

## Invitation and projection protocol

1. A trusted future owner backend authenticates the owner and resolves active D1
   Owner role. Repository mutation actor IDs are **internal trusted parameters**,
   never browser-submitted authorization. SQL checks the owner again at mutation.
2. Explicitly create one approved pending person. Contact comparison preserves
   local-part case/dots/plus tags and lowercases only the ASCII DNS domain. A
   conservative unique `lower(recipient)` index additionally rejects case variants.
   Unsupported Unicode/quoted addresses fail closed for owner review. There is no
   Gmail/Apple alias inference. An owner must verify person/contact uniqueness;
   software cannot establish that distinct aliases belong to different people.
   A shared inbox cannot back two member records.
3. `issue` returns the raw secret once to an internal operator in volatile custody.
   Do not print it, put it in query strings, logs, Notion or reports, or disclose it
   yet. Only its SHA-256 digest enters D1. JS digest comparison uses fixed-work
   comparison over 64 hex characters; JS timing guarantees are not claimed.
4. D1 commit precedes the separate projection adapter. Reconcile the **complete
   effective policy**, including dashboard/manual allow entries, aliases and
   duplicate entries, against all desired active/unexpired-invited members.
   Adapter entry recipient data is private; diff output contains counts, kinds
   and opaque IDs only. A future Access adapter must assign opaque identifiers to
   unknown manual entries instead of exposing an email as an identifier.
5. Read back D1 and projection. The offline adapter issues in-process branded,
   invitation-scoped receipts valid for at most 60 seconds. Forged/stale receipts
   cannot confirm projection through the repository. `reconcileInvitation`
   persists sanitized failure/confirmation attempts. A failed write or readback
   leaves the invitation blocked. Retry idempotently; after revoke/expiry/reissue,
   remove stale projections and recheck. This is a local protocol model, not a
   cryptographic attestation from Cloudflare or a substitute for a live adapter.
6. Only then Greg privately conveys the proof to its intended person through a
   separately verified channel and confirms `owner-private-channel` delivery in
   D1 within 60 seconds of projection verification (otherwise explicitly reissue
   and recheck). No applicant email, Task #11 notifier reuse or automatic send exists. If
   volatile secret custody is lost, explicitly reissue rather than recover a raw
   secret from storage. A stale confirmation or failed receipt write is blocked
   for operator review; never promise delivery from a partial success.
7. Claim validates live server time again; at expiry it persists an expiry event.
   Invalid, replayed, unprojected, undelivered and superseded proofs deny. Subject
   collisions roll back token consumption and activation. Expiry/history survive.

The D1 binding is trusted server-only storage. Arbitrary administrator SQL can
create roles or bypass repository policy and is outside the request threat model.
Bootstrap of the first real Owner is intentionally not automated: a separately
reviewed identity proof and explicit owner-approved initialization are required.
No raw secret persistence, live migration, seeds or real member rows were created.

## Identity proof limitation — activation is intentionally blocked

Cloudflare Access JWT authentication does **not**, by itself, establish the
upstream Google/Apple/OTP provider-stable identity and verified-email/MFA facts
required by this contract. `sub`, email equality, IdP labels, browser JSON and
user-selected login buttons are insufficient. No claim is made that all real
provider JWTs include the synthetic fields used by tests.

`createIdentityAuthenticator` first verifies the signed app-specific Access JWT,
then requires a server-owned `resolveVerifiedIdentity` implementation. Its reviewed
contract must independently validate upstream/broker signature, exact issuer and
audience, stable subject, verified email, expected provider/connection, nonce,
session binding to the verified Access subject, freshness and independent MFA
requirements. An OTP subject must have a verified stable namespace; an email-like
subject cannot be treated as a Google identity. Unavailable evidence blocks login.
The test-only resolver translates deliberately signed `syntheticIdentity` fixtures;
it is **not** wired into the default Worker and is not a production adapter.

First Apple relay/email mismatch fails closed. Owner must verify/correct the
intended target with explicit reissue or approve a separate binding through the
manual link process; never infer relay ownership. Matching email alone never
links an alternate provider. The foundation supports a verified already-bound
identity plus separately verified candidate, 15-minute link review and atomic
owner-approved commit. Explicit secure owner recovery, review screens and an
operational correction workflow are still unimplemented and launch-blocking.

## Worker boundary and intentionally missing surfaces

Default export cannot activate through environment flags: no provider resolver
is supplied. `createWorker` permits only `PORTAL_MODE=offline-test` with explicit
synthetic dependencies, DB and invite-service marker; this marker is not a real
invite service. Production mode is refused. The example has no variables,
account/database IDs, service bindings, secrets, custom domains, routes or Cron.
Use a distinct members static origin when eventually approved; do not reuse the
actual owner origin or add routes to the public website.

The offline harness exposes read-only `/`, `/api/owner` and
`/api/services/{jellyfin,palworld,status}` authorization probes. No service is
connected, no redirects/credentials/stream proxy are provided. All routes including
unknown/direct paths authenticate and perform the live D1 lookup. Responses are
private/no-store; unknown paths return no private resource. No mutation HTTP
endpoints, enrollment/claim UI, owner actions, CSRF/session layer, real invite
service, recovery flow, retention policy/job, email delivery or provider adapter
are advertised as complete. Repository functions are internal building blocks.
Before exposing mutations, implement body limits, same-origin/CSRF/replay controls,
verified actor derivation, rate controls and safe token transport, then review.

## Production gate and integration plan

Before any deployment, independent review must assess this exact source and its
schema/transaction behavior. Obtain separately authorized fresh portal D1 binding,
backup/rehearsal, first-owner bootstrap and provider configuration. Review data
retention for identity/link/projection audit; do not borrow Task #11 applicant
retention implicitly. Implement missing operational interfaces and adapters while
preserving the disabled default. Record exact members and owner audiences, trusted
issuer, MFA controls, every reachable hostname/route and actual upstream subjects.
Disable all direct/preview URLs and prove unknown Hosts fail closed.

Then owner-approved controlled accounts must exercise final production code,
Access policy, hostname and DB for each case:

| Case | Required production observation; currently BLOCKED |
| --- | --- |
| P1 | Uninvited Google may authenticate; portal/direct routes deny; zero JIT rows. |
| P2 | Uninvited OTP may authenticate; portal/direct routes deny; zero JIT rows. |
| P3 | Expired invited proof denies claim and member access; history retained. |
| P4 | Revoked member with already live JWT loses next portal and service request. |
| P5 | Active member without grant cannot reach direct service endpoint. |
| P6 | Owner JWT → members and members JWT → owner both deny wrong audience. |

Also verify projection write/readback partial failures and full reconciliation,
concurrent reissue/claim, provider first claims and approved links, Apple relay,
unknown/direct hosts, D1 errors, role sourcing and independent service revocation.
Record Access outcome separately from app/resource outcome. Any inconclusive
case blocks launch. Historical Phase 1 or local proxies cannot substitute.

Revocation owner checklist, persisted per member: (1) D1 revoked/audited first and
grants removed; (2) Access projection removed and absence read back; (3) Access
sessions revoked where supported; (4) Jellyfin account disabled, independent
sessions/streams invalidated and verified; (5) Palworld/status credentials and
routes independently revoked and verified; (6) live-session and direct-route
retests. `revocation_tasks` starts all external actions as owner-action-required;
there is no automated completion endpoint. Failures remain tracked without
restoring app access. Portal revocation does not itself disable Jellyfin.

## Migration review, rollback, and costs

Schema review covers STRICT tables, FK constraints, immutable identity/invite/audit
history, unique subject/contact/live invitation, trigger atomic rollback and
explicit terminal states. Local workerd D1 tests apply it only to ephemeral
synthetic databases with no persistence, credentials or live subrequests.
A real migration review/rehearsal remains required. Never run this SQL against
Task #11 membership requests, notifier, Mail Desk or any existing D1.

Current rollback: discard/revert the isolated local commit; there is no deployed
state or live database to undo. Future approved rollout must retain prior Worker
version/config and fresh-DB backup, disable the portal first on failure, revoke
D1 first for affected users, remove projections and complete external service
cleanup. Do not roll back a DB to resurrect revoked identities/invitations and
do not drop audit/history tables as a routine rollback.

No new packages, paid services, resources, secrets, live invitations, emails,
member/service grants, PRs, pushes, merges or deployments were performed. Tests
use synthetic `.test` addresses, random local signing keys and opaque fixture IDs.
No Task #28 work. Task #11 and unrelated services remain untouched.

## Local verification

Use existing dependencies and Node 24.22:

```sh
PATH=/tmp/bss-task11b-evidence:$PATH node --test --experimental-test-isolation=none portal/*.test.mjs
PATH=/tmp/bss-task11b-evidence:$PATH npm run validate
PATH=/tmp/bss-task11b-evidence:$PATH node --test --experimental-test-isolation=none tests/*.test.mjs membership-notify/test/*.test.mjs owner-launchpad/test/*.test.mjs
```

Miniflare needs local loopback sockets; a filesystem/network sandbox may require
permission for this local runtime. Runtime tests prohibit real outbound requests.
The workerd integration harness reconstructs the synthetic edge Host from its
preserved URL because Miniflare's dispatch transport uses a loopback Host; separate
tests explicitly reject spoofed Host headers. Test errors are not suppressed.
Existing `node_modules` was absent in this checkout, so an existing dependency tree
was temporarily reused; no installation or lockfile change. Exact final counts,
commit/tree, limitations and logs are recorded in the sanitized external report
`/tmp/BSS_TASK12_PHASE2_IMPL_REPORT_20261024.md`.

Initial local results: 42/42 portal tests and 365/365 existing public/membership/
notifier/owner regression tests passed (407 total, zero failures/skips).
`npm run validate` passed: lint plus Astro check/build, zero errors/warnings and
84 existing hints outside portal; 15 static pages built. Initial local socket
restriction was resolved by allowing the fixture-only loopback runtime. An early
combined regression/build run raced on `dist/` (349 pass, 1 file-load failure);
the final 365-test regression run was executed after the successful build and
passed. Development failures in D1 affected-row detection and the Miniflare Host
harness were corrected before these final checks. No unresolved local test failure.

## Independent review Medium finding resolution — October 24, 2026

The independent review of `ffa05047a7616c51312cd3ea134f7e91cd31b02c`
(tree `c5ae47ccb50257f01f812b7be7b25be81e2cf0c6`) blocked merge because
`confirmProjection` stored confirmation time instead of the branded receipt's
original `verifiedAt`. Readback at T+0, confirmation at T+59, then owner delivery
at T+118 could succeed. This extended the policy-drift exposure beyond the
contract's 60-second verification-to-delivery limit.

The fix persists `projected_at = receipt.verifiedAt`, while `changed_at` remains
the actual confirmation time. Delivery's SQL predicate requires
`at-60 <= projected_at <= at`. New-schema CHECK constraints require readback
between invitation creation and confirmation, and delivery between readback and
readback+60. Transition triggers reject confirmation more than 60 seconds after
readback, require delivery time to equal its transition time, and freeze the
receipt ID/readback time after confirmation, including supersession. These guards
execute atomically with the invitation transition and audit insertion. The branded
receipt-to-timestamp association is validated in trusted repository code; SQL does
not independently authenticate the in-process receipt or any live Access policy.

Six additional synthetic workerd D1 tests prove T+0 readback/T+59 confirmation
allows T+60 delivery and denies T+61 and T+118 delivery. They also cover late
T+61 confirmation, future receipts/clock rollback, ordinary immediate success,
replacement receipts, invitation-scoped reissue, and direct SQL attempts to bypass
freshness or backdate delivery. Rejected transitions leave complete invitation
rows and audit rows unchanged. Reissue requires a new invitation-scoped full
readback; it cannot refresh or resurrect the old invitation.

This is a compatible tightening of the new/offline schema with no column or API
shape changes. No deployed database uses it, and no migration is performed or
claimed: old disposable fixtures must be recreated with this schema. Any future
persisted database requires a separately reviewed migration/rehearsal. Worker
activation and all existing production gates remain blocked. The source fix
addresses the reported Medium issue; a fresh independent review is still required.

Fix verification: 48/48 portal tests, root `npm run validate` (lint and build;
zero errors/warnings, 84 existing hints; 15 pages), and 365/365 existing regressions
after build passed (413 tests total, zero failures/skips). Node 24.22.0 used the
existing dependency tree via a transient untracked `node_modules` symlink, removed
before commit; no install or lockfile change. The initial sandbox run could not
open loopback sockets; the successful offline suites used permitted local sockets.
Logs: `/tmp/task12-medium-portal.tap`, `/tmp/task12-medium-validate.log`, and
`/tmp/task12-medium-regressions.tap`. The sanitized fix report with exact final
commit/tree is `/tmp/BSS_TASK12_MEDIUM_FIX_REPORT_20261024.md`.

## Offline Access policy preflight increment — October 24, 2026

`portal/access-preflight.mjs` exports the pure synchronous
`preflightAccessProjection(input)` boundary. It receives explicit synthetic JSON
in memory; it has no fetcher, credentials, account identifier, DB handle, CLI,
mutation, receipt issuance or Worker integration. The existing `projection.mjs`
contracts, schema, disabled Worker and owner decisions MF1–MF6 are preserved.
This is the deliberately narrow policy-parser increment, not a live effective
policy collector or a production reconciliation adapter.

The input contract is demonstrated entirely with synthetic `.test` contacts in
`portal/access-preflight.test.mjs` and disposable local D1 rows in
`portal/access-preflight-d1.test.mjs`:

- `now` is an explicit integer UTC second. `expectedHosts` lists exact DNS hosts;
  `expectedIdps` lists opaque synthetic login-method IDs, never provider proof.
- `access` has `capturedAt`, `complete: true`, `applications`, `groups`, and
  `policies: [{applicationId, response}]`. Applications/groups/responses use
  Cloudflare-style `success`, `errors`, `messages`, `result`, `result_info`
  envelopes. Only an explicitly complete single page with matching counts is
  supported. Missing/error/partial/multiple pages are inconclusive. A future
  collector must independently implement and review pagination and coverage;
  setting `complete` is only a synthetic fixture assertion.
- Each application uses `id`, `type: self_hosted`, `domain`, `allowed_idps`, and
  optional `name`/`auto_redirect_to_identity`. Each attached policy has `id`,
  `decision`, `precedence`, `include`, `require`, `exclude`, and optional `name`.
  Group objects have `id`, the three rule arrays, and optional `name`. These are
  intentionally strict subsets of the official APIs. Additional API fields,
  reusable-policy references without full rules, path/wildcard/destination
  variants and other application types require review and block analysis.
- `hosts` supplies a same-window synthetic manifest: `capturedAt`, `complete`,
  `hosts`, `workersDev: false`, `previewUrls: false`. Missing/extra aliases,
  enabled or unspecified direct/preview exposure and direct workers.dev
  applications block. This cannot discover unlisted DNS, origin IPs, routes,
  service bindings, tunnels, preview or alternate accounts. Live completeness
  is always unproven.
- `d1Before` and `d1After` contain `capturedAt`, `complete`, and **all** `members`
  (active, pending and revoked). Each row has `id`, `recipient`, `status`, and
  nullable `invitationId`, `invitationStatus`, `expiresAt` for its latest invite.
  The D1 test shows a server-side query shape for the existing schema. Both
  reads must match exactly, including row order; reordered reads conservatively
  block. All four snapshots must be at most 60 seconds old and never future;
  the second D1 read cannot precede the first. The function cannot attest the
  caller's clock, transaction, complete rows or capture claims.

The parser inventories each supplied application's policy decision and all
Include/Require/Exclude selectors, referenced groups and even unreferenced
groups. Include is OR, Require is AND, Exclude narrows the set; a group contains
rules, not a literal list of actual users. The supported contact subset is flat
explicit email Include rules, optionally through a single flat group, plus one
explicit supported login-method Require per allow policy. Application IdPs must
exactly match the expected set. Arbitrary labels do not establish Google, Apple
or OTP subject provenance. Output distinguishes IdPs and hosts by generated
ordinals only.

Deny, bypass, non-identity/service decisions, unknown decisions, Everyone,
email domains/wildcards, service tokens, dynamic/provider groups, external
selectors, multiple/unknown/nested selectors, nested/cyclic groups, missing
group references, ambiguous precedence, constrained email/group sets and
unknown semantic fields all block. Deny/Exclude precedence is inventoried but
not evaluated; unsupported input never yields an effective-user claim.
Traversal is bounded to 1 MB serialized input, 16 group levels and 10,000 rule
visits; exhaustion is explicitly inconclusive, never a truncated success.

For the supported subset, compare the per-host union of explicit contact
candidates against active D1 members and pending members with an unexpired live
invitation, using the same eligibility predicate as `desiredProjection`.
Diagnostics distinguish missing, duplicate and extra-or-ineligible contact
candidates, including stale entries for expired, superseded or revoked rows.
Case-variant D1 contact collisions also block. Changed/reissued/revoked D1
readbacks are inconclusive. Contacts never authorize a person or enumerate
actual IdP users; no alias or provider-subject inference occurs.

Every result is `status: BLOCKED` with unconditional provider-subject and live
inventory blockers and `NOT_A_PROJECTION_RECEIPT`. `CONTACTS_MATCH_ONLY` means
only the synthetic explicit-contact comparison matched. `DRIFT` reports a
supported contact mismatch; `INCONCLUSIVE` indicates unsafe/unknown semantics or
snapshot evidence. Differences remain provisional when inconclusive. Duplicate
contacts yield DRIFT, never success. Output contains only fixed codes, counts,
selector/decision categories and generated opaque ordinals; it never echoes
input IDs, names, contact details or hostnames. It returns no private input or
member mapping and does not log. Ordinals are per-run references, not persistent
identifiers or hashes. Do not send real identity data to this offline boundary.

P1/P2 synthetic D1 tests demonstrate that a manual Access contact cannot create
or authorize an uninvited Google/OTP member. Expiry at the exact boundary and
revoked-member authorization denial remain D1-authoritative. The existing
Worker tests still exercise unknown/direct-host denial and P1–P6 OFFLINE PROXIES.
An existing rollback test compared D1 query timing metadata as well as audit
rows, producing a nondeterministic failure. Those assertions now compare all
audit row contents, retaining the rollback check without comparing timings.

Official shape/semantics references consulted read-only on October 24, 2026:
[application policies API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/methods/create/),
[applications API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/),
[groups API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/groups/methods/list/),
and [policy semantics](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
Documentation reads do not establish any deployed configuration or external
provider claim. No authenticated provider/API requests were made.

### Provider stable-subject research and intentionally absent implementation

Cloudflare documents the Access application JWT `sub` as account-local and tied
to email; removal/readdition can change it. The identity response describes
`user_uuid` as its user ID and `idp` as provider data, without a universal upstream
Google/Apple subject schema. Neither field is proof of the required upstream
subject. Custom OIDC/SAML claims depend on the provider and configuration;
provider support cannot be assumed. See the official
[application token and identity response reference](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

Cloudflare distinguishes IdP-reported MFA from independent Access MFA. A signed
Access JWT alone does not prove independent MFA occurred in the required
session. Exact enforcement, AMR provenance, reauthentication and session age
need separately reviewed evidence. See
[MFA requirements](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)
and [independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/).

No upstream proof adapter is added in this increment: inventing a signed payload
schema would not establish actual provider provenance. The existing server-owned
resolver boundary remains mandatory and the default Worker has none. Missing
evidence is the precise issuer, audience, algorithm/key lifecycle, provider and
connection, stable upstream subject namespace, verified-contact provenance,
nonce/replay store, session binding to this verified Access subject/token,
freshness and independent MFA attestation. Email, client JSON, arbitrary IdP
labels and unverified MFA/subject flags cannot supply these facts.

Safe options for a separately authorized design review are (1) a server-owned
upstream OIDC authorization-code flow validating signature, issuer, audience,
nonce and provider subject, bound to the authenticated Access session, or (2) a
reviewed broker that verifies upstream evidence and signs an audience-restricted,
short-lived, nonce-bound attestation tying upstream subject and MFA evidence to
that Access session. Both require actual protocol/configuration evidence and
replay/session design before implementation, including Apple relay, subject
collisions and an explicitly stable OTP namespace. A get-identity result alone
must never be promoted to either proof. These are integration options, not claims
that a configured provider or production-ready implementation exists.

All final-production MF6 P1–P6 remain BLOCKED. Independent review of this exact
increment, the broader live collector, provider proof and operational gates is
still required. This implementation's own checks are not independent security
review. Exact final counts, commit/tree and review commands are in
`/tmp/BSS_TASK12_OVERNIGHT_INCREMENT_REPORT_20261024.md`.
