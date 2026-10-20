# Task 10 — routing observation feasibility, offline only

2026-10-16. Continuation from draft PR #23, base `bff193f`, in
`feature/studio-mail-desk-task10-routing-evidence`. **Task 10 remains incomplete;
production sending remains blocked.** Public documentation was read for design
context. No authenticated provider access, real event retrieval, credential,
email, deployment, migration, commit, push or GitHub operation occurred.

## Published interface and the missing binding

Cloudflare's [Email Routing GraphQL tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-email-routing/)
documents zone-scoped `emailRoutingAdaptive`, ordered by `datetime_DESC`, with
`datetime_geq` / `datetime_leq` filters and a row limit. This proposal selects
exactly `datetime`, `sessionId`, `messageId`, `from`, `to`, `subject`, `status`,
`action`, `spf`, `dkim`, `dmarc`, `arc`, `errorDetail`, `isSpam`. The tutorial
aliases `sessionId` as `id`; this query uses its original name. Additional
published fields, omitted here, are `isNDR`, `spamThreshold`, `spamScore`.
Its example uses `delivered` / `forward`, numeric `isSpam`, and display-name
`from` strings. Those examples are not a complete enum or identity contract.

The [Activity log documentation](https://developers.cloudflare.com/email-service/observability/logs/)
describes provider-maintained per-event routing authentication details, including
SPF, DKIM and DMARC, also accessible through analytics. This establishes that a
provider observation source is documented. It does not establish access to this
zone, complete retrieval, signed portable evidence, or a binding to stored mail.

Cloudflare's [Event Subscriptions reference](https://developers.cloudflare.com/email-service/reference/event-subscriptions/) explicitly says its Email Sending event subscriptions do **not** publish inbound Email Routing events, including Worker-handled routes or forwarded messages. Do not propose those outbound events as an alternate trusted per-message correlation feed for existing support@ intake. This leaves provider Analytics as a read-only corroboration source and the missing ingress-to-session bridge unresolved.

The [Worker interface](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
exposes envelope `from`/`to`, normalized `headers`, `raw`, `rawSize`, and actions;
it also documents `canBeForwarded`. It exposes **no corresponding trusted
`sessionId`**. Neither a raw header purporting to contain a session identifier nor
a value reported by an exposed Worker supplies that missing guarantee.

Security inference: even an independently retrieved DMARC-pass analytics row
cannot currently be securely joined to a stored receipt using RFC Message-ID,
subject, display name, addresses and approximate time. Message-ID and subject
are attacker-controlled, can collide or be replayed; a narrow time interval does
not make them unique authenticated identifiers. Two different messages can
produce the same observed matching values. A single visible row does not prove
the other event does not exist, especially with sampling, delay or retention
gaps. Provider-side session uniqueness alone does not authenticate a local
mapping. **An Analytics row must never be treated as cryptographic proof or
end-to-end message provenance.**

The [forwarding authentication announcement](https://developers.cloudflare.com/changelog/post/2025-06-30-mail-authentication/)
requires SPF **or** DKIM for forwarding and separately recommends DMARC. Successful
forwarding therefore cannot substitute for an aligned per-message DMARC verdict.
Even DMARC authenticates domains, not exact address local parts or content
legitimacy ([RFC 7489 §4.2](https://www.rfc-editor.org/rfc/rfc7489.html#section-4.2)).
For example, domain authentication cannot distinguish possession of
`owner@sender.test` from another principal authorized to send for `sender.test`.
Exact-mailbox access needs the separate authenticated challenge required by
[the ingress proposal](TASK10_INGRESS_OFFLINE.md): independently deliver a
high-entropy, purpose-bound, expiring challenge to that exact registered mailbox,
verify completion, bind it to the ingress digest and consume it durably once.
That proves access at completion time, not authorship or absence of compromise.
No challenge is implemented or sent here.

## Small offline contract

`offline/routing-observation.mjs` has no imports, I/O, keys, endpoint, fetch,
signer, storage or production constructor. Both exported functions accept only
bounded canonical `JSON.stringify` text (32,768 UTF-16 code units maximum);
duplicate JSON members and noncanonical encodings fail closed. Exact schemas
reject additional fields at every object level, including `trustPassed`,
`approved`, `authenticatedMailbox`, unknown pagination or sampling metadata.

`buildRoutingObservationQuery` takes `{scope:{accountTag,zoneTag},start,end,now}`.
Only invented `fixture-account-a` / `fixture-account-b` and 32-character invented
zone IDs ending in `1` / `2` with all preceding digits zero are supported. Dates
must be canonical UTC seconds, start < end ≤ now, and start at most five minutes
old. It returns a static parameterized query and bounded time variables with a
fixed **three-row limit**. Account context stays outside the zone-scoped query;
it is not an invented provider field or account-ownership check. No Message-ID,
subject or address filtering can hide competing rows.

`observeRoutingResponse` takes `{config,responseScope,expected:{from,to},response}`.
`response` rehearses `{data:{viewer:{zones:[{emailRoutingAdaptive:[row]}]}},errors:null}`.
The wrapper and clock are synthetic caller inputs, not authenticated provenance.
Matching account/zone context checks consistency only; a future retriever must
independently pin the correct account-to-zone relationship and response origin.
Both expected and row addresses must be narrow bare lowercase `.test` fixtures.
Display names are rejected; exact string comparison rejects mismatches without
claiming address authentication, alignment reconstruction or alias equivalence.

Only a single structurally valid row, with nonempty provider session identifier,
in-window time, `dmarc:pass`, SPF or DKIM pass, supported auth values,
`delivered` / `forward`, empty error detail and numeric `isSpam:0`, returns
`routing-analytics-corroboration-only`. This intentionally narrow tutorial subset
does not support all legitimate provider formats or Worker-handled statuses.
Message-ID and subject are bounded strings, never selectors or identity proof.

DMARC failure/absence/unknown or no SPF/DKIM pass returns `deny`; other unsupported
or malformed inputs return `indeterminate`. Missing sessions, multiple events,
identical duplicates, Message-ID collisions, no rows, unavailable dataset,
partial/error responses, stale/future times and rows at or above the maximum
all fail to corroborate. There is no pagination, retry, deduplication, row
selection or fallback. Every result carries `authority:'none'`,
`receiptBinding:'unavailable'`, `mailboxProof:'unavailable'`, `sendAuthority:false`;
no result includes reusable event IDs, copied mail data or a `verified` kind.

Even fewer than three rows and `errors:null` cannot establish completeness or
exclude unseen collisions. The helper cannot detect unreported truncation,
sampling, delayed ingestion, or a fabricated synthetic response. Its success
means only that a supplied fixture fits a conservative observation shape.
It must never be adapted into `maildesk-ingress-v1` or ingress acceptance.
Production modules do not import it. The unconditional
`503 verified_ingress_unavailable` guard and production false verifier/throwing
send stub remain intact, with existing dynamic hard-stop tests still passing.

## Defensible next steps and separate approval gates

1. **Recommended next offline work:** specify and review the independent ingress
   source/registrar contract before seeking credentials. Require an authenticated
   provider session-identifier bridge to original bytes, envelope and local
   receipt/content digests, delivered through a trusted independent source.
   Establish immutable identifiers, authenticated retrieval, timing and durable
   replay rules. No such bridge is documented in the Worker interface or
   implemented here. A signer accepting exposed Worker claims cannot create it.
2. **Alternative:** independently verify upstream SMTP/source facts with original
   source IP, envelope, original bytes and appropriate DNS/key evidence at receipt
   time; evaluate SPF, signature coverage and aligned DKIM/DMARC independently.
   Arbitrary Received/Authentication-Results headers cannot supply source truth.
   Audit that independent verifier and exact-mailbox challenge separately.
3. **Policy alternative:** accepting analytics corroboration with a challenge
   while tolerating unresolved message provenance is a revised risk policy.
   Only a separate, explicit owner approval and security review could choose it.
   It would not transform analytics into cryptographic message provenance and
   would require a distinct reviewed implementation and release approval.

Any future read-only analytics experiment requires separate owner approval for
**one specified zone in its specified account**, permission review, token custody,
short expiry, revocation and access logging. The [token guide](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)
currently illustrates Account / Account Analytics / Read and resource scoping;
do not blindly copy its broad example. Confirm the minimum supported effective
permissions and zone restriction before creation; if that boundary cannot be
enforced, return for approval rather than broadening access. Keep credentials
outside exposed Workers, the browser, fixtures and repository. **No token or key
creation, retrieval or use is authorized now.**

Before any real query, approve privacy minimization for addresses, subjects,
Message-IDs and linkable session IDs; restricted encrypted storage, access,
logging/redaction, retention/deletion and audit policy. Prefer minimum metadata
and no bodies. Establish a query budget and failure behavior. Cloudflare's
[limits documentation](https://developers.cloudflare.com/analytics/graphql-api/limits/)
describes plan/resource-specific dataset availability, history, interval,
field/row and request limits. The general default request quota is 300 queries
per five minutes; it is not a guaranteed dataset entitlement. Inspect authorized
dataset settings later rather than assuming routing retention from another
adaptive dataset. Sampling, truncation, missing data and quota outages must
remain indeterminate. A token experiment, if separately approved, would establish
availability and schema only; it would not authorize ingress integration, real
sends or deployment.

## Local validation

- Added 41 focused synthetic tests; full Mail Desk suite: **434/434 passed**, zero
  failures, skips or cancellations (393 parent + 41 new). Command:
  `npm test --prefix mail-desk`. Tests include isolation checks and preserve the
  existing dynamic production hard-stop coverage.
- `npm run check --prefix mail-desk` passed; package change only appends syntax
  checks for the new module/test. Full repository lint passed using local
  ESLint 9.39.1 and the byte-identical repository config:
  `NODE_PATH="$PWD/node_modules/.task10-lint/node_modules" node node_modules/.task10-lint/node_modules/eslint/bin/eslint.js --config node_modules/.task10-lint/eslint.config.mjs .`.
- Wrangler 4.151.0 staging `deploy --dry-run` passed, explicitly exiting in dry-run
  mode: **182.60 KiB / gzip 47.64 KiB**, matching the parent bundle size. Its emitted
  Worker bundle contains no routing helper. Metrics disabled, environment cleared,
  config/log/output paths confined to ignored local `node_modules`. Nonfatal
  warning: missing `astro/tsconfigs/strict` because root Astro dependencies are
  absent. No deployment or D1 operation occurred.
- Validation dependencies (postal-mime and lint) and cached Wrangler were copied
  into ignored paths in this worktree; no package install, lockfile change or
  command execution in another worktree. No hosted CI was triggered. Local tests
  prove fixture behavior, not deployed Access/MFA, provider source integrity,
  mailbox possession, analytics completeness, real account permissions or live
  durable replay. No production integration exists.
- Whitespace and protected-file diff checks pass. Only this note, the new module,
  its test and the package syntax script are proposed changes. The preexisting
  untracked `.codex-task10-routing.txt` is untouched. No existing src/, inbound,
  public, migrations 0001–0004, staged Wrangler config or lockfile was edited.

This is a reviewable offline feasibility proposal, not Task 10 completion.
