# Task 10 isolated owner canary candidate — offline, no deployment

See [WEBAUTHN.md](WEBAUTHN.md) for the additive enrollment/stepup implementation, verification results and remaining owner/release gates. Production dispatch remains false; the credential pin and exact final-message chat confirmation are null. Enrollment does not authorize email. The historical sections below describe the preceding UI/policy candidates.

This UI continuation is isolated on branch
`feature/studio-mail-desk-task10-owner-canary-ui`, at exact draft PR #26 base
`2f72f54709d3c5053befe77162838012591bb4ec`. The underlying candidate preserves
its original PR #25 baseline manifest. It implements one direct owner message,
with code, an unapplied isolated schema and adversarial offline tests. It has no
inbound evidence dependency and cannot unlock customer replies. The legacy Mail Desk and production reply 503 gate remain unchanged.

**Live dispatch is hard-disabled in the default Worker entrypoint.** No environment
value overrides `dispatchAuthorized: false`. The committed Wrangler config also
sets `workers_dev = false`, `preview_urls = false`, `routes = []`, stage `offline`,
send enabled `false`, and MFA `unverified`. It contains no account, hostname,
D1 binding or credentials. The release block must remain until a separate source
review and explicit deployment/recipient/MFA authorization. This is not a
production-ready release or Task 10 completion.

The owner reports the sending domain is verified. This task has not inspected
that account or domain, any real JWT, Access policy, secret or personal mailbox.
No send, account/key creation, deployment, migration application, Git commit,
push, branch update or merge occurred. Public documentation and package downloads
were the only intended external reads. Existing Cloudflare ingress/routing,
Notion sync, DNS, website and staging service are outside this implementation.

The local policy-backed alternative is implemented but has **no release authority**:
`PRODUCTION_POLICY_RELEASE` is `null`. See [POLICY-AUTH.md](POLICY-AUTH.md) for the
exact contract, missing independent evidence and session-cutover gates. The
currently deployed diagnostic source/config are unchanged by this implementation.

## Implementation and authority

The runtime modules are:

- `auth.mjs`: pinned-account JWKS verification using exact lockfile-pinned
  `jose` 6.2.12. RS256 only; pinned issuer/audience, nonempty `kid`, required
  integer `exp`/`iat`/`nbf`, exact `sub` and email, `type:app`, signed `amr` containing
  `mfa`. Authentication must be at most ten minutes old and have at most a
  ten-minute lifetime. No clock tolerance. Service-token headers/claims, remote
  key references in JWT headers, missing claims or unsigned MFA flags fail.
  JWKS comes only from operator-configured
  `https://<ACCESS_TEAM_HOST>/cdn-cgi/access/certs`, never a request or JWT URL.
  jose rejects redirects, enforces key suitability and caches keys for five minutes.
- `policy-release.mjs`: bounded code-owned reviewed release schema and canonical
  binding for the distinct `reviewed-policy-release-v1` assurance. Null denies;
  no environment boolean or API token supplies evidence. Policy identities expire
  at the earlier of token expiry and the reviewed evidence deadline.
- `worker.mjs`: JSON protocol and private static UI with fresh authentication for every request.
  The singleton preview binds the exact Access token hash, principal and random
  HttpOnly session cookie; a changed JWT requires stopping, never adopting the
  old intention. Stage capabilities are server-signed HS256 JWTs with purpose,
  campaign, stage, payload/config digest, session binding, random JTI and expiry.
  Durable capability hashes rotate at each transition. The signing secret is
  separate from the provider key and is never returned. No client envelope,
  content, approval boolean or MFA flag supplies authority.
- `ui-assets.mjs`: generated literal bundle of the three reviewed files in
  `public/`. Every asset is returned through the Worker verifier; there is no
  platform static-assets binding or independently public file route.
- `ledger.mjs` and `migrations/0001_canary.sql`: the only slot has `CHECK(id=1)`.
  Its campaign, full snapshot, digest, binding and expiry are immutable. Triggers
  enforce ordered transitions, immutable audit timestamps and no delete, replace,
  reset or terminal edits. Each transition uses a single `UPDATE ... WHERE ...
  RETURNING`; dispatch additionally requires `status='approved'`. No SQL transaction
  crosses a network request. A permanent slot, not provider deduplication, prevents
  any second campaign, including after rollout/rollback or an expired review.
- `resend.mjs`: POST only to `https://api.resend.com/emails`, after the durable
  submitted claim. Fixed sender, one exact configured recipient and static
  plain-text subject/body; no custom email headers, HTML, attachments, CC/BCC or
  threading. Stable idempotency key contains campaign UUID and immutable snapshot
  digest. Redirects forbidden; five-second request/body timeout, bounded 4096-byte
  JSON response. A strict returned UUID indicates API acceptance only. Known
  validation/auth refusals become `refused`; ambiguous errors, 429/5xx, malformed
  responses, timeout and mixed success become `UNKNOWN`. Neither is retryable.

`createCandidate` is an explicitly controlled dependency-injection factory for
local tests. Tests inject a local JWKS resolver, clock and stub transport and
exercise the dispatch logic. This is not production authority: the actual default
export fixes the genuine Access verifier, native fetch and false release gate;
there is no request/environment injection hook or alternate HTTP sending route.
No test code is imported into the production bundle.

## Owner protocol and permanent slot

The private UI is available only at authenticated `GET /`, `/app.js` and
`/styles.css`, behind exactly the same signed Access/owner/MFA and configuration
checks as JSON. The committed offline configuration denies **all** these routes;
opening `public/index.html` directly is not a functional login or authority path.
No public navigation or launchpad is added. See [UI-ACCEPTANCE.md](UI-ACCEPTANCE.md)
for offline coverage, manual acceptance and the next owner gate.

The UI loads status without mutation. It keeps capabilities only in page memory,
requires separate preview → review → approve clicks, then an exact-message modal
and a separate irreversible send click. Approval never sends. The default false
`sendAuthority` disables all UI mutation controls; it cannot be overridden from
the browser. An existing campaign, failed request, expired preview or changed
session halts the UI. Reloading cannot recover a capability or create a new slot.
No retry or reset control exists. The server remains the authority if browser
controls are modified. Synthetic dispatch-enabled factories are used only by tests.

| Request | Required JSON | Result |
| --- | --- | --- |
| `POST /preview` | `{}` | Immutable full snapshot, campaign, expiry and signed preview token; random session cookie |
| `POST /review` | `{"token":"<preview capability>"}` | Signed reviewed capability; preview capability consumed |
| `POST /approve` | `{"token":"<review capability>"}` | Signed approved capability; review capability consumed; zero sends |
| `POST /dispatch` | `{"token":"<approved capability>"}` | Default entrypoint blocks; controlled tests exercise a single durable claim and transport |
| `GET /status` | none | Authenticated status, delivery `unverified`; no database write |

Every POST requires the exact configured HTTPS origin, `Sec-Fetch-Site:
same-origin`, `Content-Type: application/json`, and `X-Canary-Action` matching the
path. Later stages also require the exact `__Host-canary` Secure/HttpOnly/
SameSite=Strict/Path=/ cookie and signed capability. No CORS, OPTIONS, DELETE,
reset, query-string override or service-token route exists. GET never creates
sessions, intentions or cookies. JSON and asset responses use no-store/private cache,
no-referrer, nosniff and frame-blocking CSP. All failures are generic and no runtime
module logs credentials, tokens, raw provider responses or mailbox content.

Expiry is the earlier of five minutes after preview and Access JWT expiration.
Review and approval never extend it. A changed configuration, message source,
recipient, owner, session epoch, signed token or approval key invalidates pending
work. The singleton is intentionally **burned even if preview expires**. There is
no re-review or second campaign endpoint. A stale version cannot be revised into
a sendable message. Do not remove a row or create another database to try again.

Lifecycle:
`previewed → reviewed → approved → submitted → accepted | refused | UNKNOWN`.
Audit times and provider acceptance ID are retained in the same row. No raw JWT,
session cookie, capability or credential is stored. The snapshot contains the
recipient and needs restricted audit access/retention. GET reports `submitted`
explicitly after a crash: its outcome is unknown and dispatch is permanently
forbidden. Failure to persist an outcome returns UNKNOWN and leaves submitted.
No scheduled recovery, queue, cron, background send, auto retry or resend exists.

## Future runtime contract — nothing provisioned here

These operator inputs are all absent from committed config. Supplying them does
not override the hard release block.

| Input | Required value/purpose |
| --- | --- |
| `DEPLOYMENT_STAGE` | literal `production` |
| `CANARY_SEND_ENABLED` | literal `owner-canary-v1-approved`; every other value denies |
| `MFA_CONTRACT` | `signed-amr-mfa-v1` with reviewed signed evidence, or `reviewed-policy-release-v1` with matching code-owned evidence (currently null; denies) |
| `ACCESS_TEAM_HOST`, `ACCESS_AUD` | one reviewed account host ending exactly `.cloudflareaccess.com` and private app audience |
| `OWNER_PRINCIPAL`, `OWNER_ACCESS_EMAIL` | exact signed subject and exact signed owner email; no case folding or alias inference |
| `APP_ORIGIN` | one exact HTTPS origin with no path, credentials or trailing slash |
| `CANARY_OWNER_MAILBOX` | securely configured singleton allowlist; one exact owner mailbox, never supplied by HTTP |
| `CANARY_CAMPAIGN_ID` | one operator-reviewed UUIDv4, preserved permanently through releases |
| `SESSION_EPOCH` | operator-reviewed unpredictable session revocation generation (at least 16 allowed ASCII characters) |
| `APPROVAL_SIGNING_KEY` | independent securely generated random secret, base64url characters, at least 64 characters |
| `RESEND_API_KEY` | separately authorized production-only sending key, restricted to the approved apex domain |
| `CANARY_DB` | dedicated new D1 binding, never the ticket DB or staging binding |

The mailbox grammar deliberately accepts only lowercase ASCII dot/underscore/
hyphen local parts and ordinary dotted domains; it rejects aliases with plus,
display names, comma lists, controls, Unicode and arrays. Do not normalize a rejected
address to something else. Confirm the exact supported address with the owner
under later recipient authorization. The sender is always the inert source
constant `support@bigsoxstudios.com`; tests use only invented `.test` recipients.
The static message is visible in `resend.mjs`.

The key shape check cannot prove scope, account ownership, domain verification,
or production provenance. Those are separate operator review requirements; a
sending-only/domain restriction does not restrict recipients. Never place real
keys/mailboxes in this repository, browser, fixture, logs or existing mail-desk.
The signing secret and `SESSION_EPOCH` must have independently generated entropy;
synthetic repeated-character test strings are not provisioning examples.

Initialize only a separately approved **new** dedicated D1 database using this
schema, then pin its identity before any exposure. The migration creates an empty
singleton table; the first verified explicit preview inserts the configured
campaign and immutable snapshot atomically. No request chooses the UUID. Review
this first-preview initialization policy before any deployment. Back up and retain
the permanent row across Worker rollouts, rollback, key revocation and route
removal. Never reapply by dropping tables or swapping to an empty database.
Database administrators can bypass application controls; deployment permissions,
backup/restore and retention need separate review. Real D1 behavior is not
established by local SQLite tests or a Wrangler bundle dry-run.

## Access/MFA blockers and later owner action

The intended private Access app has one exact owner allow rule, no bypass,
service-token or broad organization rule, and an enforced MFA requirement at
Access or a reviewed IdP. Disable workers.dev/preview exposure and protect the
only custom origin. Review fresh-auth duration, revocation and edge rate limits
before any route is authorized. None of these policies was created or inspected.

[Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
requires origin-side signature/audience verification and documents the account
JWKS endpoint. The code follows that trust source and verifies additional claims.
[Cloudflare MFA requirements](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)
describe Access/IdP MFA enforcement, but do not establish that this owner's actual
app JWT supplies an independently verifiable `amr`. That has **not been demonstrated**.
A configuration label or browser header is never proof. Missing signed `amr`,
missing `nbf`, or incompatible lifetime blocks signed-AMR authentication. Do not
relax checks to make a synthetic fixture resemble real assurance.

If the real assertion cannot supply signed `amr:mfa`, the distinct policy-source
contract can be considered only after the full evidence in [POLICY-AUTH.md](POLICY-AUTH.md)
is independently established and reviewed. It does not attest to a particular MFA
event or its timestamp. The code-owned production release is null, so this path
denies today. No operator boolean, environment snapshot or request can enable it.
Independent IdP-signed step-up remains a possible separate design, not implemented here.

Every mutation verifies its assertion again, and epoch changes invalidate pending
sessions. Signature checks alone cannot discover an IdP logout or revoked but
still-valid Access JWT immediately; no real-time revocation lookup is implemented.
Short lifetimes bound that window. Immediate incident response requires disabling
the isolated route/service and revoking its sending key, retaining the ledger.
A reviewed policy/revocation mechanism is required before claiming stronger
session invalidation. Synthetic verifier-revocation tests prove rechecking only.

Further separate authorization remains necessary for key/account actions, secret
bindings, dedicated D1 migration, private Access/policy deployment, release-code
change, exact recipient and actual MFA verification, and the final one-message
review/approve/dispatch. General engineering approval grants none of those actions.
After provider acceptance the owner must inspect the actual inbox/spam, count,
and full SPF/DKIM/DMARC headers; delivery stays unverified in this service. A
successful canary does not authorize customer tickets or relax ingress proof.

## Public documentation and offline validation

Read-only official documentation checked 2026-10-16:

- [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/):
  atomic statements are used here; no cross-request transaction assumption.
- [Resend send API](https://resend.com/docs/api-reference/emails/send-email) and
  [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys): provider
  idempotency expires after 24 hours. The permanent local slot never expires.
- [Resend key permissions](https://resend.com/docs/dashboard/api-keys/introduction):
  sending-only/domain restriction availability, not any actual account/key state.

Run from the repository root with Node 22.22.1:

```sh
npm ci --prefix owner-canary --ignore-scripts --no-audit --no-fund
npm test --prefix owner-canary
npm run check --prefix owner-canary
npm test --prefix mail-desk
npm run check --prefix mail-desk
```

Tests globally reject network fetches, use locally generated RSA public keys,
local SQLite files and injected provider stubs. They exercise actual jose
signature verification and shared durable SQL, not provider or account access.
The test-isolation flag matches mail-desk because this execution environment
otherwise reports file wrappers instead of individual Node test cases.
`tests/baseline.json` records exact Git blob IDs of **all** tracked base files;
static tests hash those bytes and separately assert disabled config/import bounds.
Never regenerate this manifest to conceal a protected-file modification.

See [UI-ACCEPTANCE.md](UI-ACCEPTANCE.md) for this continuation's results and
[VALIDATION.md](VALIDATION.md) for the prior candidate's commands, counts, bundle results
and explicit limits. A later reviewer must independently verify the hard block
and deployment boundaries. This continuation remains uncommitted; the prior candidate is part of the requested base.
