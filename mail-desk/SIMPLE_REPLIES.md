# Task 10: one Mail Desk reply flow

Customer-policy increment against HEAD `5d25d2af803ded4916b5e39512bda2bc691bc4c7`
(tree `f071893e04fc8d6ef3529096311bfefb11aac535`).
The earlier owner release notes below describe the preserved owner flow; the final
customer section describes this local, unactivated increment.
No deployment, live D1 migration, Cloudflare session, provider call, email, Notion write,
Access/DNS edit, commit, push, or PR change was performed. PR #27 and the historical
Owner Canary campaign (including terminal UNKNOWN) remain untouched.

Use the existing protected Mail Desk: open a case, type, **Review reply**, inspect
exact From/To/subject/body, **Send reply**, confirm once in the browser. No passkey
setup or second approval endpoint. Review expires after ten minutes. Editing needs
a fresh review. Simulation buttons explicitly say “simulated”; genuine inbound
mail is no longer called synthetic. “Pending activation” means sending is disabled.

Owner Canary is retired as the proposed sending workflow. Its code, data, draft PR,
and dormant outbound experiments are preserved as historical evidence; none is
imported by the Mail Desk worker. This release does not activate their AMR/provenance
contracts. Existing Cloudflare Access Google+MFA policy remains the authentication
boundary; the Worker independently verifies its signed owner JWT. No new MFA claim
contract is invented here.

## Safety and state

The preserved `owner-self-v1` adapter policy permits only
support@bigsoxstudios.com → fridman.greg@gmail.com.
It requires a support case with forwarded inbound receipt/message linkage and no
synthetic intake marker. Linkage is not proof of sender authentication: this is safe
only for the fixed owner canary destination. Customer replies use the separately gated policy documented below. Other aliases,
production deployment stage, broader owner recipient lists, Reply-To, CC/BCC,
attachments, HTML and threading headers remain unsupported. Customer activation
needs a separate owner decision and independent recipient/provenance review.

Session-bound CSRF, signed exact snapshot (including mode), database rate limits,
unique case/revision and atomic compare-and-set remain. Migration 0005 adds only a
mode table and protective triggers; it changes no historical rows or existing
triggers. Old reviews without a mode row are simulated. Switching flags cannot turn
a signed mock review into a real send. A new deployment invalidates old review
signatures; refresh and review again. No secret is put in the browser.

All payload/config/key-shape validation happens before claiming dispatch. The
adapter also independently checks activation and a frozen preparation capability.
One POST is attempted, with an eight-second abort deadline spanning fetch and body,
a 45,000-byte request ceiling, a 4,096-byte response ceiling, manual redirects and
an ASCII idempotency key stable per intent, under 256 bytes. Raw exceptions,
provider bodies, headers, payloads and credentials never enter diagnostics.

| Stored/API state | UI meaning |
| --- | --- |
| reserved | ready |
| sent, real mode | accepted by provider; not delivery confirmation |
| sent, mock mode | simulated; no email sent |
| failed | refused/no send; terminal for that revision |
| dispatching or UNKNOWN | unknown outcome (never retry); case locked |

HTTP 400/401/403/404/413/422/429 are explicit refusals. Fetch rejection, abort,
redirect, 408/409/5xx, unexpected status, invalid/oversized/non-JSON acceptance body
or missing safe provider ID are UNKNOWN. No automatic retries, even for 429/5xx.
Provider acceptance plus a failed database commit returns UNKNOWN, never success;
the durable dispatch claim remains locked. Recovery can only advance an abandoned
dispatch to UNKNOWN. Never reset it or make a replacement intent for that uncertain
reply. A lost browser response consumes the displayed review and instructs refresh,
not another send. Database messages, sync job, terminal state and delivery audit
still commit together. Existing live Notion ingress scheduling/hooks are unchanged;
this task does not add outbound Notion writes or claim delivery tracking.

Fixed audit stages are `reply_config_approved`, `reply_preflight_rejected`,
`reply_fetch_started`, `reply_fetch_rejected`, `reply_response_http_NNN`,
`reply_response_invalid`, `reply_provider_accepted`, `reply_provider_refused` and
`reply_dispatch_interrupted`. They contain no PII. Private case/send API returns
bounded stage codes. `storage_unconfirmed` is a response-only fallback if durable
completion cannot be verified. A stage is diagnostic, never an alternative send
permission. Ordinary audit case/intent IDs remain as before.

Protocol reference checked against official [send API](https://resend.com/docs/api-reference/emails/send-email),
[idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys) and
[error documentation](https://resend.com/docs/api-reference/errors). Provider
idempotency retention is limited; the permanent D1 claim provides our no-retry rule.

## Non-sending UI preview, after independent review

1. Review the diff and offline evidence below before any commit/push/deploy. No
   commit or deployment is part of this work. Preserve PR #27 unchanged.
2. Use the existing Worker `bss-mail-desk-staging`, existing protected hostname,
   assets and D1 binding `6595c7ed-cbdb-4d8d-8f89-fc8b87f68860`. Preserve the actual
   deployed Access/owner/origin/CSRF/inbound/forwarding/Notion variables, bindings,
   secrets and five-minute trigger. The repository config has blank auth values
   and Notion off placeholders: do **not** deploy it verbatim over working config.
   Prepare a reviewed local release config outside Git from the existing deployment
   settings, never from secret values. Include this entry point and public assets.
3. Explicitly retain `DEPLOYMENT_STAGE="staging"`, `SEND_MODE="mock"`,
   `ALLOW_REAL_SEND="false"`, `MAILDESK_REPLY_ACTIVATION="off"`, and
   `MAILDESK_RECIPIENT_ALLOWLIST='["fridman.greg@gmail.com"]'`.
   No Resend secret is necessary for this preview. UI and API deployment is safe
   without 0005 in mock mode (compatible with the existing 0001–0004 schemas).
4. On the same Access-protected desk verify labels, normal inbox loading, review
   and cancellation with an owner test case. Sending in this preview is simulated
   and changes only normal mock intent/message/audit/sync records; do not simulate
   sends on customer cases merely to test the UI. Inbound and Notion continue as
   before. No public preview hostname or new sender application is needed.

## Later owner-only activation, separately reviewed

1. Stay at $0: use existing free resources only. Do not upgrade, enable paid
   overages, add billing or buy a domain. If existing free capacity/domain sending
   is unavailable, leave activation off. Confirm in the provider dashboard that
   **bigsoxstudios.com** is already verified for sending. Do not change DNS here.
2. Independently review the prepared deployment and validate that the owner controls
   fridman.greg@gmail.com and the protected Access session is owner-only with MFA.
   This task does not establish control of that real mailbox through offline tests.
3. Take the normal owner-held D1 backup/snapshot and inspect pending migrations.
   Apply **only** additive `0005_simple_replies.sql` to the existing Mail Desk DB
   after review. It depends on `outbound_intents` from 0001; the real path also
   requires the existing 0002/0003 receipt linkage. Leave 0004 tables/triggers intact
   if already present. Do not bulk-apply a pending experimental 0004 just to enable
   this flow; use an explicitly reviewed single-file migration when necessary.
   Never migrate the separate Owner Canary DB.
4. The owner installs `RESEND_API_KEY` as an encrypted Cloudflare Secret on
   **bss-mail-desk-staging**, using Cloudflare's dashboard or Wrangler's interactive
   secret prompt. Never paste it into chat, config, command arguments, logs, curl,
   Notion or GitHub. Do not retrieve/print it to verify it; the Worker checks only
   its basic shape. Keep all sending flags closed during installation. An already
   present valid Secret requires no reinstall; its existence alone enables nothing.
5. Review and deploy the same worker with exactly `SEND_MODE="live"`,
   `ALLOW_REAL_SEND="true"`, `MAILDESK_REPLY_ACTIVATION="owner-self-v1"`, staging
   stage, the exact one-entry recipient list above and owner email equal to that
   Gmail address. Preserve all other working configuration and resources. This
   owner activation cannot enable customer recipients or a production stage.
6. The **owner** sends a legitimate inbound test email from that Gmail to support,
   opens its resulting support case on the existing desk, types the test reply,
   reviews the displayed recipient/subject/body, clicks Send reply and confirms.
   No agent-generated campaign, session or API send. Inspect provider acceptance
   separately from receipt in Gmail. On UNKNOWN stop permanently for that attempt.
   Any later human test must not recreate or retry the historical UNKNOWN campaign.

## Rollback without touching data

Keep this worker and set `ALLOW_REAL_SEND="false"`, `MAILDESK_REPLY_ACTIVATION="off"`
and `SEND_MODE="disabled"` for pending-activation read/compose mode, or `mock` for
explicit simulation. A reviewed live snapshot cannot be dispatched as mock. Leave
0005, all audit/intent/receipt/message/Notion records, provider IDs and UNKNOWN locks
in place. Never reverse migrations, drop tables, reset attempts or restore a backup
over current data. A request already started may still have reached the provider;
turning flags off cannot revoke it. Reconcile read-only and never retry uncertainty.
Before the first live activation only, a code-only rollback to the known previous
non-sending Mail Desk version is also possible while preserving the database.
After any live review/attempt, prefer disabling flags on this version to an old
worker that does not understand durable review modes. Access, routing, DNS,
forwarding, Notion and public website are not rollback targets.

## Changed files and local verification

Only `mail-desk/` changes:

- `src/worker.mjs`: existing API integration, confirmation, mode binding, preflight,
  diagnostics and conservative durable-completion response.
- `src/reply.resend.mjs`: isolated, explicitly gated, bounded single-attempt adapter.
- `src/store.mjs`: durable review-mode binding/readback and safe stage lookup.
- `src/providers.mjs`: abortable historical simulator; no transport injection.
- `migrations/0005_simple_replies.sql`: additive review modes and immutable real
  snapshots/terminal transitions; no historical backfill.
- `public/app.js`, `public/index.html`: same desk, exact review, one confirmation,
  accurate mode/state/history and text-only rendering.
- `wrangler.staging.toml`: explicit closed activation and owner-only allowlist.
- `package.json`: syntax-check the new adapter; no root wrapper/dependency changes.
- `test/helpers.mjs`, `test/ui.test.mjs`, `test/outbound.test.mjs`,
  `test/simple-replies.test.mjs`: offline integration, transport, UI and isolation
  regression coverage. Historical “no Resend URL anywhere” assertions now allow
  only the new adapter while continuing to prohibit dormant experiment imports.
- `README.md`, `TASK10_OWNER_CANARY_PLAN.md`, this document: current entry point and
  historical workflow retirement, rollout and rollback instructions.

Node **22.22.1**; dependencies installed from local npm cache with scripts disabled.
Commands, from repository root:

```sh
npm --prefix mail-desk test
npm --prefix mail-desk run check
npm --prefix owner-canary test
npm --prefix owner-canary run check
node --check mail-desk/test/simple-replies.test.mjs
git diff --check
```

Results are recorded after the final local run below. Owner-canary's historical
baseline-manifest test deliberately requires old Mail Desk bytes and will fail
when this task's Mail Desk files change; do not rewrite that historical manifest
to make the new task green. Its remaining behavior tests can run with that single
manifest test excluded by name, preserving the original regression files.

Final local results: **541/541 Mail Desk tests passed**; Mail Desk syntax checks,
explicit new-test syntax check and `git diff --check` passed. The complete historical
Owner Canary run passed **709/710**, with only the expected baseline-byte manifest
failure. Running the unchanged behavioral suite with
`--test-skip-pattern='all tracked baseline files match exact base Git blob manifest'`
passed **709/709**; Owner Canary syntax and UI bundle checks passed. No historical
manifest or Owner Canary file was modified. Independent review is still pending;
these results are offline evidence, not live-send acceptance.

## Mobile inbox and legacy subject polish

On narrow screens the Mail Desk initially shows the Inbox; selecting a case switches
to a focused thread/reply view with a Back to inbox control. This is a client-side
view change, not a new route/session or permission. Unsent text remains in the
open case until another case is selected; drafts are persisted only by Review reply.
Desktop continues the two-pane inbox/thread layout. The reviewed exact recipient,
subject and body remain the final authority before Send.

Old imported subject lines containing RFC 2047 encoded words are decoded only
for display on authenticated list/detail reads. Stored originals, Notion IDs,
email threading, approval digests and outbound subject values are unchanged.
For historical cases, the final Review reply subject may retain encoded words;
never silently replace the signed outbound subject. No database backfill was run.

## Customer replies: local implementation, activation OFF

The owner-self-v1 path and its exact Gmail allowlist are preserved. Existing live
settings cannot activate customer recipients. This increment makes no deployment,
D1/schema change, migration, secret read, live HTTP call, email, commit or push.
Inbound forwarding, scheduled Notion sync and Access remain unchanged.

The separate policy requires **all** of the following exact settings:

- `MAILDESK_CUSTOMER_REPLIES="enabled"`
- `MAILDESK_REPLY_ACTIVATION="owner-reviewed-customers-v1"`
- `MAILDESK_CUSTOMER_RECIPIENT_POLICY="exact-forwarded-requester-v1"`
- Existing base gates: staging, SEND_MODE live, ALLOW_REAL_SEND true, exact owner
  email, valid-shaped Resend key and the unchanged one-entry owner Gmail allowlist.

Repository customer flags are explicitly `off`. Do not expand the owner allowlist.
Do not deploy the repository placeholder configuration over working live settings.
Any later source-only deployment must retain owner-self-v1 and customer flags OFF.
Customer activation remains a separate owner-directed action after independent
review of code, offline evidence and the actual release configuration. No such
activation or deployment is authorized by this local increment. Existing free
resources only; $0 spend.

At review and immediately before dispatch, the case must be support, its current
requester must equal the immutable intent recipient exactly, and it must have no
synthetic marker. Every incoming message must have receipt linkage. Every receipt
associated with the case or its messages must link to an inbound message in that
same case, target support@bigsoxstudios.com exactly, have forward_state forwarded,
and have envelope_from equal to that one exact requester. Missing, ambiguous,
cross-case, unforwarded and UNKNOWN evidence fails closed. The same evidence
predicate is inside the durable atomic dispatch claim, closing the gap between
preflight reads and the claim. There is no new D1 schema.

Envelope From CAN BE SPOOFED. Forwarding and receipt linkage do not authenticate
a sender or prove mailbox control. Header From and Reply-To cannot redirect the
reply. The owner must inspect the exact displayed To/subject/body and confirm the
To mailbox. The UI warns about spoofing and uses one normal confirmation containing
the exact destination. It uses textContent for untrusted text. Owner mode retains
the owner Gmail-only notice. Obvious postmaster, mailer-daemon, no-reply and own
studio-domain loop destinations, malformed mailboxes and header injection fail.

Customer reviews use a separate signed approval context; an owner review cannot
become a customer send when settings change, and vice versa. Existing immutable
mock/live mode rows and triggers are unchanged. The frozen transport capability is
also bound to the policy. Each reply retains the same exact immutable snapshot,
ten-minute expiry, CSRF/session binding, one durable CAS, bounded single provider
attempt and permanent no-retry UNKNOWN handling. Provider acceptance does not
prove delivery. Disabling customer gates closes new sends; it cannot recall an
already started request. Never reset or retry an uncertain attempt.

Local evidence: dependencies installed with
`npm ci --prefix mail-desk --offline --ignore-scripts`; all network/provider
exchanges in tests are mocked. Final `npm test --prefix mail-desk`: **600/600
passed** (59 added security/UI tests, existing owner regression suite included).
`npm run check --prefix mail-desk`, explicit customer-test syntax check and
`git diff --check` passed. The suite also checks evidence changes after preflight,
immutable mock modes, policy signature separation, multiple consistent receipts,
concurrency and terminal UNKNOWN. No implementation blocker remains. Independent
review and any future owner-directed activation remain pending. These results do
not establish real delivery or sender authentication.

## Owner-approved controlled customer-routing test (October 19)

The current customer policy is additionally restricted to the *single*
pre-existing Outlook test address greg.fridman@outlook.com, with two separate
required variables: MAILDESK_CUSTOMER_TEST_RECIPIENT exact match and
MAILDESK_CUSTOMER_TEST_EXPIRES_AT strict epoch seconds expiring in <=48 hours.
Use a roughly 24-hour test window. Missing, expired or wrong values fail closed;
the immutable intent recipient must exactly match the allowed Outlook address.
This temporary test gate does not authorize sending to arbitrary customer
mailboxes. An atomic D1 claim additionally denies a second successful,
dispatching or UNKNOWN send to the same recipient (including another case),
so the controlled rollout has a one-send ceiling without retry risk. Existing owner-self-v1 Gmail mode remains available on rollback.

Never submit a send automatically. Owner must receive the controlled test email
from the Outlook account, confirm they own the recipient, and manually review
and confirm the exact To/subject/body in the protected Mail Desk. Do not retry
UNKNOWN. After the single acceptance test, restore owner-self-v1,
MAILDESK_CUSTOMER_REPLIES=off and MAIlDESK_CUSTOMER_RECIPIENT_POLICY=off via
a new versioned Cloudflare deployment; preserve existing D1/Access/Notion/secrets.
