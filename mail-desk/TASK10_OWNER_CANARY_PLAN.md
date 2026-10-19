> Historical proposal, retired by the owner for the sending workflow. Use [Simple replies](SIMPLE_REPLIES.md) on the existing protected Mail Desk. Preserve the old campaign and its UNKNOWN state; never retry it. PR #27 remains unchanged.

# Task 10 — owner-only direct canary preparation, offline

2026-10-16; base `20c4eb747ab1e856e3243651a1eaedfb556946c2`, continuation of
#21 → #23 → #24. **Task 10 remains incomplete. No real email is authorized or
sent.** This proposal prepares one future non-reply transactional plain-text
message from support@bigsoxstudios.com to exactly the registered owner's personal
mailbox. The real recipient is intentionally absent from this repository.

This is a distinct test of an isolated outbound service. It must not read inbound
messages, historical tickets, requester addresses, Reply-To, thread headers or
message-origin evidence to authorize this direct message. The existing
[TASK10_OUTBOUND_HANDOFF.md](TASK10_OUTBOUND_HANDOFF.md) describes the separate
reply candidate and its ingress-dependent canary; this proposal does not relax
that candidate. Its production factory, false verifier, throwing transport and
`503 verified_ingress_unavailable` block remain byte-for-byte unchanged. Later
customer replies still require independent ingress proof and all separate review
and release approvals in the [ingress plan](TASK10_INGRESS_OFFLINE.md) and
[routing research](TASK10_ROUTING_EVIDENCE_RESEARCH.md). Analytics observations,
fixture signatures and a successful direct canary cannot unlock replies.

## Implemented local rehearsal

`offline/owner-canary-rehearsal.mjs` has zero imports, I/O, transport, provider
adapter, credentials, runtime configuration or route wiring. It accepts no
constructor arguments or callback. Its only sender and recipient are invented
`support@studio.test` and `owner@personal.test`, matched byte-for-byte without
case folding, plus removal, dot normalization or alias inference. It copies
exact-schema input to a frozen preview, permits a subject of 1–200 characters
and a body of 1–10,000 characters (both nonblank), and restricts content to
printable ASCII with LF additionally allowed in the body. CR, hidden controls,
Unicode separators, extra/symbol/accessor properties, CC/BCC/HTML, multiple
recipients, attachments, thread fields and custom headers are denied. Plain text
is never rendered as HTML. Body text resembling a header is only body text;
there is no serializer or transport to turn it into headers.

Lifecycle: `openSession → preview → review → approve → simulateOnce`. The entire
snapshot and its message are frozen. Separate stage-specific object-identity
handles explicitly carry a local-simulation purpose; copied/serialized handles,
approval booleans and other sessions/instances cannot advance it. The preview,
session and handles are bound together with a ten-minute expiry. `advance`
controls a monotonic logical fixture clock; there is no claim of real-time
expiry enforcement. A synchronous claim before the simulation's microtask gives
one winner across concurrent invocations. Only literal scripted `accepted` and
`rejected` produce their named simulated terminal states; timeout, mixed or
malformed scripts produce UNKNOWN. Expiry during the microtask also produces
UNKNOWN. Every terminal outcome forbids another attempt or another preview.

These are ephemeral local handles, **not cryptographic approval tokens** and
not an imitation of PR #21's authoritative HMAC protocol. Creating another
instance resets replay state. There is no durable ledger, authenticated session,
Cloudflare Access/MFA verification, real sending eligibility, real acceptance or
delivery proof. `sendAuthority:false`, `delivery:unverified` and
`durableReplayProtection:false` remain explicit. The caller controls fixture
content, session creation, clock and scripted outcome. Simulation success proves
only local state transitions. Never deploy, import into src, or adapt its handles
into live approval authority. The future service requires a separate reviewed
implementation; this module is not a selectable sending mode.

## Future isolated deployment design — not implemented

1. **Private app and identity.** Create a distinct owner-canary app/route and
   isolated Worker artifact, with no public exposure, public site entrypoint,
   ticket integration or reuse of the active staging Worker. Disable alternate
   workers.dev and preview access. Enforce owner-only Cloudflare Access at the
   edge and verify the signed assertion in the service: pinned issuer/audience,
   trusted signature/key policy, expiry, exact registered owner principal and
   independently verified MFA assurance. Review actual signed deployed claims
   and actual Access policy under separate approval; synthetic `amr` fixtures
   prove nothing about deployed MFA. If the deployed assertion does not supply
   sufficient authenticated assurance, remain disabled until a reviewed
   enforcement mechanism exists. Reject browser-provided identity/MFA flags.
   Use bound server sessions, same-origin checks, CSRF protection and rate limits.

2. **Fixed envelope and message.** Configure exactly one sender,
   support@bigsoxstudios.com, and a singleton owner mailbox allowlist from secure
   operator configuration, separate from request payload and inbound data. Pin
   the exact registered personal mailbox; never infer it from a request, ticket,
   alias or case-insensitive comparison. A changed owner/envelope/configuration
   invalidates every prior intention and requires a new reviewed approval.
   Server code fixes the subject to “Big Sox Studios owner canary” and body to
   “This is the single owner-approved Big Sox Studios transactional email test.
   No reply is required.” Use plain text only, no templating, inbound text,
   CC/BCC, additional recipients, HTML, attachments, Reply-To, In-Reply-To,
   References or arbitrary custom headers. Show sender, exact recipient,
   subject, complete body, intention ID and expiry in the immutable owner preview.

3. **Sending domain and key.** The owner reports the real Resend sending domain
   is already approved and verified; this offline task neither inspects nor
   changes that status. Before any authorized deployment, confirm that exact
   domain remains verified and its SPF/DKIM/DMARC alignment is suitable. Do not
   alter DNS, MX, support intake or Gmail forwarding here. After separate explicit
   approval, create a sending-only Resend API key restricted to that single
   sending domain and bind it as a Worker secret only to the isolated service.
   Domain scope limits domains, not the recipient set: the application must
   independently enforce the singleton owner recipient and fixed sender. Never
   put the key in config vars, tests, browser, logs or staging. No key exists or
   is requested by this change. No paid enrollment, upgrade or overage is assumed;
   review then-current free-plan fit before proceeding or stop for a decision.

4. **Durable one-message intention.** Use a separate approved D1 binding and a
   separately reviewed additive schema, never migrations 0001–0004 or existing
   ticket/job tables. Store one immutable envelope/content/configuration
   snapshot, owner/session binding, purpose, expiry and globally unique intention
   and idempotency IDs. A unique campaign/one-message slot must prevent a second
   intention from bypassing UNKNOWN or acceptance, including across sessions,
   revisions, deployments and instances. Record review, then explicit one-time
   send approval, as separate authenticated transitions. Protect stage-specific
   unguessable capabilities with server verification, session/snapshot/purpose
   binding, expiry and durable single consumption; do not reuse simulation
   objects. A consumer boolean never supplies authority. Revalidate identity,
   MFA, configuration, expiry and exact snapshot at each stage and at the atomic
   dispatch claim. Deploy disabled first; expiry or configuration mismatch before
   dispatch makes the intention unusable without silently replacing it.

5. **Single dispatch and uncertain outcomes.** In a durable atomic transaction,
   claim the approved intention as dispatching before invoking a separately
   reviewed private sending implementation. One winner only across instances.
   Use the intention's unique stable Resend idempotency key; do not generate a
   new one on a repeated click. Persist a returned acceptance ID and terminal
   outcome atomically with audit metadata. Distinguish provider-accepted,
   definitively-rejected and UNKNOWN; none permits another dispatch of this
   campaign. A crash after claim, timeout, malformed/mixed response, uncertain
   acceptance or failed outcome persistence stays dispatching/UNKNOWN and blocks
   all automatic resend. Recovery may mark dispatching UNKNOWN, never approved.
   No cron, queue, reset, delete, revision change or new intention may retry it.
   Reconcile privately under separate authorization without sending again.
   Preserve tombstones durably beyond provider retention and across rollback.
   Test actual D1 transaction/concurrency/crash behavior before launch; the
   in-memory rehearsal establishes none of this.

6. **Owner action and acceptance criteria.** The owner first reviews the entire
   immutable preview, then explicitly authorizes this one real send in a separate
   action after fresh verified MFA. Configuration approval is not send approval.
   A single provider acceptance establishes only isolated API acceptance, **not
   actual inbox delivery**, sender authenticity, reply eligibility or launch
   readiness. The owner manually checks the exact mailbox, inbox/spam placement,
   one-message count and full received headers for expected From/To, SPF, DKIM
   signing domain and DMARC alignment/pass. Record the acceptance ID and manual
   delivery/header verdict separately; missing or failing delivery/header evidence
   halts the experiment with no resend. Avoid storing mailbox contents or raw
   credentials in logs; approve restricted audit retention and access first.

7. **Abort and rollback.** On any mismatch, missing MFA assurance, duplicate,
   uncertainty or failed header check, disable the isolated canary first. Revoke
   its sending key (and rotate if needed), disable its route/access and return to
   a reviewed disabled artifact while retaining immutable intentions, idempotency
   tombstones and audit outcomes. Do not roll back by deleting uncertain records.
   Do not disturb live support intake, Gmail forwarding, existing tickets or the
   five-minute Notion sync. An owner launchpad is a separately gated later project;
   this milestone grants no permission for it or customer replies.

## Public documentation checked; no API operations

Read-only public documentation reviewed on 2026-10-16:

- Resend's [New API Key Permissions](https://resend.com/changelog/new-api-key-permissions)
  (April 12, 2023) documents sending-only permission and selecting a specific
  domain restriction for a sending key. This establishes documented availability,
  not the permissions or state of an actual account/key.
- Resend's [Idempotency Keys](https://resend.com/changelog/idempotency-keys)
  (May 1, 2025) states keys are retained for **24 hours**. Therefore provider
  deduplication cannot supply permanent one-message protection. The proposed D1
  ledger must forbid retry after uncertain outcomes even after that window.
  Although provider documentation discusses retry scenarios, this canary's
  stricter policy never retries dispatch. Documentation cannot prove an actual
  provider acceptance or delivery.

No authenticated provider API, account lookup, credential query or key operation
was performed. Public documentation reads were the only network activity.

## Separate owner approval gates — NONE granted

Explicit approval is required separately for (1) exact sending-only,
single-domain key creation, (2) secret binding to the isolated Worker, (3) the
reviewed artifact, private Access app/policy/actual-MFA validation, D1 schema and
deployment, and (4) the first real test after its complete immutable preview and
review. Any future account, DNS or policy change needs its own concrete approval.
The already approved/verified sending domain does not grant these permissions.
No implementation, key provisioning, secret installation, deployment, migration,
payment, real send, merge, commit or push is performed in this task.

## Local validation

- `npm test --prefix mail-desk`: **481/481 passed**, zero failures, skips or
  cancellations: 434 baseline plus **47 new adversarial tests**. Existing dynamic
  tests continue to prove the production candidate denies valid fixture evidence,
  all flags, stored approval and injected transport with zero dispatches. New
  tests pin both production module hashes and assert the unconditional block,
  fixture mailbox restrictions, lifecycle races, expiry, UNKNOWN, replay and
  import separation.
- `npm run check --prefix mail-desk`: passed, including both new `.mjs` files.
- Full repository lint: passed with local isolated ESLint 9.39.1 and a
  byte-identical copy of `eslint.config.js`, using
  `NODE_PATH="$PWD/node_modules/.task10-lint/node_modules" node node_modules/.task10-lint/node_modules/eslint/bin/eslint.js --config node_modules/.task10-lint/eslint.config.mjs .`.
- Wrangler 4.151.0 staging `deploy --dry-run`: passed and explicitly exited in
  dry-run mode, **182.60 KiB / gzip 47.64 KiB**, matching the parent bundle.
  The output contains no owner-canary rehearsal. Environment was cleared,
  metrics/update checks disabled and HOME/config/log/output isolated to ignored
  local paths. No deployment, migration or remote D1 operation occurred.
  Nonfatal warning: `astro/tsconfigs/strict` is unavailable because root Astro
  dependencies are absent; the staging bundle still built successfully.
- Validation used local copies of existing postal-mime and isolated lint/Wrangler
  tooling in ignored paths of this worktree. No installation, package download,
  lifecycle script or execution/modification in another worktree occurred.
- `git diff --check` and new-file whitespace checks passed. Protected paths were
  compared against the exact base; `mail-desk/src`, public assets, website,
  migrations 0001–0004, staging config and package lock are byte-for-byte unchanged.
  The production candidate SHA256 remains
  `7623ff57f08348e0d0d1f3d2307e19147d5ca38b93bc7021251824f75147e1d2`;
  the Resend future module remains
  `c6ee94b26fe39157e58a265c805fb3cf1b300138dcb1d03ba3ead5e293410839`.

Only this plan, one offline module, one test file and the narrow package syntax
script are proposed changes. The preexisting `.codex-owner-canary-task.txt` is
untouched; no other unexpected untracked files remain. Nothing is committed or
pushed. These checks establish offline behavior and preserved source boundaries,
not real sender verification, deployed Access MFA, durable D1 concurrency,
provider acceptance, delivery or production security. Task 10 remains incomplete.
