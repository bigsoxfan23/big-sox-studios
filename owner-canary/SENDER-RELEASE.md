# Task 10 sender release candidate — 2026-10-17

Code, tests and documentation only, based on PR27 commit
`536ae171b524ca3acfb7f18df902bd2468354abd`, in isolated branch
`feature/studio-mail-desk-task10-owner-canary-sender-release`.
No deployment, secret lookup, remote D1 mutation, live POST, email, commit or push
was performed. Existing incoming mail, Notion, Mail Desk and launchpad are untouched.
This document supersedes older disabled-sender/null-confirmation status notes.

## Exact consent and release gate

The owner's chat approval supplies exact message consent. It is **not** a new
passkey proof. The prior public pin and canonical field order are unchanged;
its fingerprint is
`sha256:798d9a0ac8aefeb35ac0f64c29341c4962539e051d396fd82a41bcb29c973584`.

`src/stepup-release.mjs` now has a frozen `FINAL_OWNER_CONFIRMATION` with exactly:

```json
{"envelopeDigest":"7ec49e8c8316385f3923f92380277d956ad847c20de5e6181fbbf455793d9880","configDigest":"c5be1b5e09368b115cd7bc65ba5108577efc5bb9c2996aac7d68eaef4a21a4df","epoch":"owner-canary-webauthn-v1-20261016"}
```

The envelope digest is SHA256(JSON.stringify(JSON.parse(snapshot).payload)); the
configuration digest is SHA256(snapshot). Snapshot order is purpose, version,
campaign, origin, owner, ownerEmail, team, audience, epoch, mfa,
credentialContract, payload. Credential contract order is contract, record,
fingerprint. Record order is credentialID, publicKey, algorithm, rpID, origin,
owner, email, epoch. Payload order is from, subject, text, to. No normalization,
trailing newline, HTML, aliases, additional recipient or arbitrary HTTP content
is permitted. Tests independently reconstruct every byte, compare the actual
coordinator snapshot, compute both digests with Node crypto and reject mutations.

Exact immutable envelope (body has LF paragraph separators and no final LF):

- From: `support@bigsoxstudios.com`
- To: `fridman.greg@gmail.com`
- Subject: `Big Sox Studios — Outbound Email Verification`

```text
This is a one-time test of the Big Sox Studios outbound email system.

The message verifies that support@bigsoxstudios.com can securely send email through Resend.

No customer tickets or customer messages are involved.

— Big Sox Studios
```

The default production entrypoint fixes the real strict signed-owner verifier,
native transport, source-owned `OWNER_CONFIRMED_RELEASE`, production pin and
confirmation, and `enforceRelease:true`. The enforcer checks exact consent on
**every request before proof issuance or preview**, plus explicit source campaign
and recipient checks. Changing any confirmed setting or message fails closed.
The adapter rechecks real-recipient campaign/config digest immediately before
transport. The offline `createCandidate()` factory still defaults to
`dispatchAuthorized:false`; test dependency injection is not runtime authority.

All runtime gates remain: production stage/enable marker, exact signed Access
owner/issuer/audience/type and 600-second JWT lifetime/freshness, valid signer
and provider key format, exact WebAuthn pin/origin/RP ID/epoch, same-origin JSON
POSTs with action headers, two distinct fresh native UP+UV assertions, cookie
and exact JWT binding, expiring stage capabilities, durable proof consumption,
permanent singleton ledger and submitted CAS before transport. A changed or
refreshed Access JWT cannot resume an intention. Missing signed AMR is accepted
only as identity under the application WebAuthn contract, never as MFA evidence.

## Safari and lifetime fixes

Only a signed exact-owner **GET /** may use the OAuth return combination
`Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`,
`Sec-Fetch-Dest: document`. The exact request URL and Origin checks remain.
Script/style assets, API paths, other methods and other fetch metadata receive
no exception. `/status` now also checks Origin and fetch site.

The actual browser path is `/status`, `/stepup/session`, `/stepup/challenge`
(preview), native `navigator.credentials.get`, `/stepup/verify`, `/preview`,
`/review`, `/approve`, confirmation dialog, then a separate session/challenge/
native assertion/verify for dispatch and `/dispatch`. Both cookies survive in
the browser; proofs are never accepted in place of a native signature.

Before the first ceremony the UI requires at least 420 seconds of remaining
signed session time (120-second prompt plus 300-second review). The server
independently requires 300 seconds left at preview, before proof consumption,
and creates a full 300-second intention after binding work. It checks the
session covers that intention and at least 295 seconds remain immediately
before insertion, allowing up to five seconds for signing/processing. D1 or
response latency still consumes review time; no timer can guarantee human
completion or successful delivery. No JWT age, WebAuthn or ledger expiry was
relaxed. Dispatch's native timeout is capped by identity and intention expiry.
The UI rechecks expiry after the native ceremony and before the dispatch POST.

A cancelled/expired first ceremony leaves no campaign row. Once the first
preview is stored, expiry, page reload, JWT refresh, abandoned review or a lost
response permanently exhausts the slot. Dispatch locks before its ceremony;
cancellation/failure offers no retry in that page. A submitted/UNKNOWN outcome
is final. Do not recover capabilities, delete/reset the ledger, change campaign
UUID, swap databases or start a second campaign.

## Independent security review preparation

Review the delta against PR27, the independent literal digest test and the
unchanged migration triggers/ledger. Review the production entrypoint and
adapter together, ensuring source consent is checked before preview and that
environment/request overrides cannot replace verifier, pin or confirmation.
Check the navigation exception's narrow metadata/path/method/origin constraints.
Review native UP+UV verification, challenge CAS and both cookie/JWT bindings,
including clock rollover, long prompts, replay/concurrency and expiry during
crypto/CAS. Review the 403 scope refusal and ambiguous transport cases: provider
acceptance is never represented as delivered, and there is no post-submit retry.

Local evidence does not independently establish live Access configuration,
Safari possession, Resend domain scope or inbox delivery. The owner reports an
installed `secret_text` RESEND_API_KEY and dedicated D1; this run did not inspect
any deployed secret or remote binding. Key format checks cannot establish
Resend domain scope. Review non-secret key metadata and domain authorization
through the operator's authenticated provider UI before the first preview;
**never retrieve the value**, even through a Worker proxy. An insufficient key
may cause a permanent provider refusal after the slot is spent.

## Rollout recipe for the existing Worker (operator only; not executed)

1. Complete independent code/security review and checks. Identify the **existing**
   Worker and authenticated deployment configuration; preserve its identity,
   custom hostname, Cloudflare Access protection and encrypted RESEND_API_KEY.
   Never deploy either committed offline Wrangler config to production. Do not
   create another Worker or expose workers.dev/preview URLs. Keep both disabled.
2. Compare non-secret configuration with this exact table. Retain dedicated D1
   `605da28d-d69b-4a97-8775-36fe7e4835e1` as CANARY_DB. Confirm both existing
   migration schemas/triggers without applying resets or querying mail content.
   Read-only campaign count/status must be empty for a first preview; if occupied,
   stop. Verify the Access app issues JWTs with an actual lifetime of at most
   600 seconds; a fresh login with a longer-lived JWT still fails the verifier.
   Inspect only necessary claim metadata locally, without publishing tokens.
   Never substitute Mail Desk's database or consume the campaign as a probe.
3. Provision **only** APPROVAL_SIGNING_KEY via authenticated CLI. Generate at least
   64 base64url characters of cryptographic randomness inside an operator-only
   pipeline; disable shell tracing and pipe directly into `wrangler secret put
   APPROVAL_SIGNING_KEY` targeting the reviewed existing Worker/config. For example,
   the generating side can be `node -e 'process.stdout.write(require("node:crypto").randomBytes(64).toString("base64url"))'`.
   Its stdout must go directly to the CLI's stdin, never a terminal, file, log,
   clipboard, model tool, chat or command argument. Preserve RESEND_API_KEY;
   do not read, replace, export or echo it. Do not add either secret to vars/files.
4. Deploy the reviewed sender bundle to that existing Worker only through the
   operator's release process. Preserve all existing bindings/variables, adding
   only the approved sender variables/signer as needed. Review Wrangler's planned
   variable/secret retention; do not let a partial offline config replace them.
   Keep customer sends and all Mail Desk/Notion/incoming configuration unchanged.
5. Read-only exposure checks: anonymous custom-domain requests must remain Access
   protected; workers.dev and preview exposure must be disabled. Inspect non-secret
   binding metadata only. No scripted authenticated browser, live test POST,
   provider API call or automated send is part of rollout verification.
6. Owner opens the exact HTTPS custom hostname in **native Safari on the owner's
   local device** with a fresh Access login and correct device clock. A signed
   `/status` read is safe; preview is irreversible. Before clicking preview,
   verify the exact one-message intent and complete review within five minutes.
   Use the existing pinned passkey with fresh UP+UV separately for preview and
   final dispatch. Do not attempt enrollment as an alternative send proof.
7. After one dispatch, preserve the ledger regardless of accepted/refused/UNKNOWN.
   An accepted provider UUID is acceptance only. The owner can separately inspect
   the personal inbox/spam and message authentication headers; do not claim delivery
   from the API response. No customer ticket/message is involved.

| Variable | Exact value |
| --- | --- |
| APP_ORIGIN | `https://canary.bigsoxstudios.com` |
| ACCESS_TEAM_HOST | `old-hill-995d.cloudflareaccess.com` |
| ACCESS_AUD | `9d60254aaedad88d7176ba1c455881da09177143ab7dba2070896bfafd209401` |
| OWNER_PRINCIPAL | `19e39702-51ab-52dc-9172-91bcb059ec5d` |
| OWNER_ACCESS_EMAIL | `fridman.greg@gmail.com` |
| SESSION_EPOCH | `owner-canary-webauthn-v1-20261016` |
| DEPLOYMENT_STAGE | `production` |
| MFA_CONTRACT | `application-webauthn-stepup-v1` |
| CANARY_OWNER_MAILBOX | `fridman.greg@gmail.com` |
| CANARY_CAMPAIGN_ID | `3ed38bbd-997c-4ce5-abad-e131b115ede4` |
| CANARY_SEND_ENABLED | `owner-canary-v1-approved` |

## Rollback recipe

Disable sending on the existing isolated Worker (set CANARY_SEND_ENABLED to a
non-approved value or deploy the reviewed prior sender-disabled version).
Keep Access protection, workers.dev/preview restrictions and all secrets/bindings
intact. If exposure is uncertain, disable only the canary route/Worker through
the operator process; never change customer mail or Notion. Preserve dedicated
D1 and every permanent campaign/tombstone. If compromise requires key revocation,
the operator revokes only the canary key through authenticated provider controls,
without revealing it. A rollback cannot undo a preview or submission and must
never enable another attempt, new UUID, replacement database or second send.

## Local validation

Node 22.22.1; pinned jose 6.2.12 and SimpleWebAuthn 14.0.3. Package dependencies
were copied locally from the matching prior worktree installation after an
uncached offline npm install failed; lockfiles/package manifests were unchanged.
Root tool dependencies were reused read-only. No secret files were used.

- Canary: **710/710**, including 73 additional release/timing/browser cases over
  the 637-test PR27 suite. Mail Desk: **481/481**. No skipped/cancelled tests.
- Both package checks and UI byte-consistency check pass; repository ESLint 9.39.1
  passes across 75 files with zero errors/warnings. The local distro eslint-scope `main` metadata
  required an in-memory version correction in a temporary lint wrapper; no tool
  source or repository lint rules were modified.
- Local Miniflare/workerd D1: PASS, real ES256 registration/authentication in
  workerd, 32 contenders per transition, one winner, one stub provider call,
  zero enrollment campaign rows, immutable bindings/caps and expiry pruning.
  Loopback binding needed sandbox escalation; external I/O remained blocked.
- Sender and enrollment Wrangler 4.151.0 dry-runs pass with no live bindings,
  auth environment variables removed, isolated config/cache/log/output paths,
  telemetry disabled, and `--dry-run: exiting now`. The existing missing
  `astro/tsconfigs/strict` warning remains; no website build is claimed. Sender:
  740.20 KiB (gzip 142.24); enrollment: 749.53 KiB (gzip 141.70).
- Syntax checks and `git diff --check` pass. Exact paths and final validation
  totals are reported in the handoff; no commit or push was made.

## Exact changed paths

All changes are inside `owner-canary/`; migration, ledger, authentication, package
manifests/locks and Wrangler configs are unchanged from PR27.

```text
owner-canary/README.md
owner-canary/RELEASE-CHECKPOINT.md
owner-canary/SENDER-RELEASE.md
owner-canary/VALIDATION.md
owner-canary/WEBAUTHN.md
owner-canary/public/app.js
owner-canary/public/index.html
owner-canary/src/resend.mjs
owner-canary/src/stepup-release.mjs
owner-canary/src/stepup.mjs
owner-canary/src/ui-assets.mjs
owner-canary/src/worker.mjs
owner-canary/tests/boundaries.test.mjs
owner-canary/tests/production-stepup.test.mjs
owner-canary/tests/sender-release.test.mjs
owner-canary/tests/stepup.test.mjs
owner-canary/tests/ui.test.mjs
```
