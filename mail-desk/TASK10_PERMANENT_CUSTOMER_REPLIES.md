# Task 10 permanent customer replies: review and operator handoff

This is the unactivated permanent-mode increment in branch
`feature/studio-mail-desk-task10-permanent-customer-replies`, isolated in
`/home/greg/codex-projects/big-sox-mail-desk-task10-permanent-customer-replies`.
It supersedes the customer activation proposal in SIMPLE_REPLIES.md; that file
retains the predecessor owner and temporary Outlook history. The owner explicitly
approved real customer replies through Mail Desk, with manual Review & Send
confirmation for **each** message. That approval does not authorize this task to
send mail, deploy, change external services or activate customer replies.

## Behavior and policy boundaries

| Policy | Permitted destination | Extra restriction |
| --- | --- | --- |
| owner-self-v1 | Fixed owner Gmail | Existing forwarded support intake check |
| owner-reviewed-customers-v1 | Exact owner-controlled Outlook test mailbox | Existing deadline and global recipient one-send cap |
| owner-reviewed-customers-v2 | Literal valid requester from consistent forwarded support receipt evidence | Fresh owner review and explicit confirmation for every message |

V2 does not expire as an activation mode. Each review still expires after ten
minutes. A successful send permits another independently drafted/reviewed revision
or a different case for the same recipient. V2 bypasses **only** the global
recipient cap in the dispatch SQL. Per-case revision uniqueness, immutable live
snapshots, reserved-to-dispatching atomic CAS and case-level dispatching/UNKNOWN
locks remain. V1 still enforces its global cap, even across different cases.
No retry of an UNKNOWN or dispatching attempt is permitted, including after a
browser/network error or database completion failure. A separate case for the
same recipient remains eligible in V2; never create a replacement case to repeat
an uncertain reply.

The API accepts no arbitrary destination, From, Reply-To, CC, BCC, HTML, attachment
or threading-header fields. It derives To from the case and freezes it in the
signed review. At review and send, all receipt/message links must agree on that
literal mailbox, the support channel and `support@bigsoxstudios.com`, and all
receipts must be forwarded. Synthetic intake markers, missing/orphaned/cross-case
links, conflicting requesters, claimed/UNKNOWN forwarding or malformed recipients
fail closed. The identical evidence predicate runs inside the D1 CAS, closing the
preflight-to-claim race. SQL NUL checks avoid drivers truncating corrupted stored
text before validation. No normalization, trimming or case-folding changes To.
Normal ingestion has no requester-edit endpoint; later case/receipt changes must
still match the immutable review and consistent evidence before dispatch.

“Verified forwarded” means persisted, consistent routing/forward-completion
linkage. **It does not authenticate the customer or prove mailbox ownership.**
The envelope itself can be spoofed. Header From and Reply-To are not reply-target
authority. The UI displays the owner-reviewed customer policy, exact envelope and
body, warns about spoofing, and asks `Send this exact reviewed reply to <To> now?`.
The owner must inspect the exact To mailbox and the contents before confirming.
Provider acceptance does not prove delivery.

V2 uses approval namespace `maildesk-customer-reply-v2`, separate from both
`maildesk-reply-v1` and `maildesk-customer-reply-v1`. Switching between policies
rejects the old signature; obtain a new review. Session MAC, signed owner Access
JWT, CSRF/origin checks, rate limits, live/mock mode binding, 10-minute expiry,
pre-claim payload/subject validation, bounded provider request/response and frozen
transport policy capability remain. Disabling/misconfiguring a required gate
fails closed. Existing mode-table migration 0005 and its protective triggers are
required; no new schema or backfill is introduced.

## Exact future activation requirements — not applied

All values below must be reviewed together in a later release:

```text
MAILDESK_REPLY_ACTIVATION=owner-reviewed-customers-v2
MAILDESK_CUSTOMER_REPLIES=enabled
MAILDESK_CUSTOMER_RECIPIENT_POLICY=exact-forwarded-requester-v2
MAILDESK_CUSTOMER_TEST_RECIPIENT=
MAILDESK_CUSTOMER_TEST_EXPIRES_AT=
MAILDESK_RECIPIENT_ALLOWLIST=["fridman.greg@gmail.com"]
DEPLOYMENT_STAGE=staging
SEND_MODE=live
ALLOW_REAL_SEND=true
OWNER_EMAIL=fridman.greg@gmail.com
```

Both temporary-test fields must be explicitly empty strings; missing, whitespace,
old Outlook address or deadline values reject V2. The owner allowlist must remain
that exact one-entry JSON serialization. It is a fixed safety prerequisite, not a
customer address book; do not add customers to it. `DEPLOYMENT_STAGE=production`
is deliberately unsupported by the preserved base gate.

Preserve the existing protected HTTPS origin, owner-only Cloudflare Access policy
and JWT issuer/audience, session CSRF secret (at least 32 characters), existing
D1 binding/migrations, assets, inbound forwarding and Notion settings/cron. Keep
CSRF_SECRET and RESEND_API_KEY as encrypted Cloudflare secret bindings; never copy
secret values to source, logs, review notes or the browser. The Worker checks
presence/key shape and authentication; only an operator can verify that deployed
bindings use Cloudflare's encrypted storage. This task did not inspect them.

The repository wrangler staging configuration remains unchanged: activation and
customer policies off, SEND_MODE mock, ALLOW_REAL_SEND false, temporary fields
empty. Its blank auth/Notion placeholders are **not** a release configuration.
Never deploy it verbatim over the working owner-only service.

## Safe release sequence and rollback

1. Independently review this diff, the offline tests and actual intended release
   configuration. Commit/push/PR/deployment remain outside this task.
2. In a separately authorized release, preserve actual live bindings, encrypted
   secrets, owner Access, ingress, forwarding and scheduled Notion configuration.
   Confirm migration 0005 already exists or handle it through reviewed migration
   procedures. Do not modify historical rows, UNKNOWN locks or campaign records.
3. A source/UI release can retain owner-self-v1 with customers off while review
   completes. Existing live owner-only Mail Desk stays unchanged until deployment.
4. Only after release review, use the exact V2 activation values above and check
   the authenticated session/UI shows the owner-reviewed customer policy. Refresh
   and review again after any policy change; historical approvals are not reusable
   across policies. Do not interpret an offline mock as live acceptance evidence.
5. Any later live acceptance must be separately directed and manually performed by
   the owner through Review & Send for every message. Inspect exact To, subject and
   body; reconcile state after a lost response and never retry uncertainty.

For a stop, disable ALLOW_REAL_SEND and activation and use SEND_MODE disabled for
read/draft-only pending activation, or mock for explicit simulation. To return to
owner-only sending, use the existing owner-self-v1 settings and turn customer
flags off; existing V2 signatures cannot authorize owner-mode sends. A request
already started cannot be recalled by changing configuration. Keep migrations,
audit, receipt/message links and intent/provider state intact. Prefer disabling
on code that understands durable live modes rather than reverting to older code
that could misinterpret historical intents. Do not reset status, delete intents,
reverse migrations or retry UNKNOWN. No DNS, Access, Notion, routing or website
change is needed for this increment.

## Local verification and pending work

Use Node 22.13–22.x (this run: 22.22.1). Dependencies were installed only in this
worktree with `npm ci --ignore-scripts --no-audit --no-fund` in mail-desk.

```sh
npm --prefix mail-desk test
npm --prefix mail-desk run check
git diff --check
```

Tests use in-memory SQLite D1, generated offline Access JWTs and injected mocked
Resend transport; no real provider request, mail, paid resource or external
service operation is performed. Coverage includes all three policy namespaces,
missing/mixed configuration, unsafe addresses/payloads, exact mixed-case targets,
spoofed headers, synthetic/corrupt/ambiguous/unforwarded evidence at review and
send, evidence changing after preflight, authentication/CSRF, expiration, mock/live
binding, multiple cases/revisions/recipients, concurrent confirmations, UNKNOWN
locks, replay refusal and the unchanged Outlook v1 one-send cap. UI coverage checks
exact destination confirmation and consumes the review on a lost response.

Final command results are recorded below after the completed run. Offline SQLite
is not a live D1 or provider delivery test. Pending: independent code/release
review, commit/push/PR if requested, reviewed deployment configuration, authorized
deployment/activation and any owner-performed live acceptance. No credentials,
external access or live acceptance is required to complete this local change.

Completed local results: **745/745 tests PASS, 0 failures**;
`npm --prefix mail-desk run check` **PASS**; explicit syntax check of
`test/permanent-customer-replies.test.mjs` **PASS**; `git diff --check` **PASS**.
The final suite includes new V2/security regressions and V2 UI coverage alongside
the preserved predecessor tests. No implementation blocker remains. No commit, push,
deployment, customer activation, secret read, real provider call, email or external
service write was performed; the owner-only live service remains unchanged.
