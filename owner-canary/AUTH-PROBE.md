# Task10 Access claim diagnostic — disabled, offline

Greg authorized this Access/MFA investigation. This adds a temporary diagnostic
entrypoint inside the existing isolated `owner-canary` directory. It is a stage
of the **same isolated Worker**, not another application. It must never be used
as a sending verifier, imported into the sending path, or treated as approval or
MFA evidence sufficient to authorize sending. Existing `auth.mjs`, `worker.mjs`,
`resend.mjs`, ledger, SQL and customer code are unchanged.

The purpose is to establish compatibility of actual provider-signed Access
claims before any sending key, approval secret or D1 binding exists. No real
assertion or account settings were inspected here. No network/API/credential
access, deployment, hostname attachment, migration or email is authorized or
performed by this change. Offline tests use generated RSA keys and mocked JWKS
responses only. A successful response always says `sendAuthority:false`,
`mfaVerified:false`, `diagnosticOnly:true`, including when signed `amr` says `mfa`.

`wrangler.auth-probe.toml` selects only `src/auth-probe.mjs` and retains the
existing candidate Worker name. Its configuration is intentionally unusable:
`workers_dev=false`, `preview_urls=false`, `routes=[]`, with blank enable flag,
origin, team host, audience and owner email. There are no bindings, secrets,
assets, schedules or routes. The enable value is
`owner-auth-diagnostic-v1`; it is an operator deployment setting, never an HTTP
parameter. Do not set it or populate the blanks as part of this offline change.

Before any separately authorized hostname attachment, independently inspect the
**current** Worker identity, deployed entrypoint, routes, workers.dev/preview
settings and bindings, plus the actual Access application and IdP/MFA policy.
The repository configuration and prior notes do not establish their live state.
Preprotect the exact isolated hostname with the intended Access application,
exact owner allow rule and reviewed MFA policy, excluding bypass, broad allow
and service-token paths, before it can reach this diagnostic stage. Confirm
exact team issuer, application audience, owner email, HTTPS origin and suitably
short session/token lifetime independently. Keep workers.dev and previews off
and verify no alternate exposure. Do not attach a hostname first and add Access
later. This source does not establish edge policy enforcement or actual MFA.
No operational steps are executed here; these are prerequisites for later
separately authorized review and deployment of this same isolated Worker.

The only accepted request is `GET /` at the exact configured HTTPS origin, with
no query (including a bare `?`), other path or mismatched `Origin` header. Absent
`Origin` permits browser navigation. Service-token credential headers are
rejected even when empty. The assertion comes only from
`Cf-Access-Jwt-Assertion`; cookies and unsigned identity/MFA headers confer no
authority. Configuration cannot be selected by request headers or token claims.

Verification uses lockfile-pinned `jose` (the sole external runtime import),
RS256, and only the configured team HTTPS `/cdn-cgi/access/certs` JWKS URL.
Redirects fail. The JWT header must contain a bounded ASCII `kid`, `alg:RS256`
and optionally `typ:JWT`, with no other header fields or embedded/remote key
references. Issuer must match exactly. Audience must be either the exact configured
string or an array of exactly one string equal to that configured audience. Empty,
multiple-element, mixed-type and wrong-value arrays are rejected.
The signed payload must have `type:app`, exact owner email and nonempty bounded
subject/email. Presence of `common_name` or `service_token_id` fails even for
empty/null values. All reported facts come from the verified payload, never a
decoded-but-unverified assertion.

`iat` and `exp` must be safe integer seconds, `iat` nonnegative, with no future
issuance, strictly future expiry, positive lifetime at most 600 seconds and age
at most 600 seconds. There is no clock tolerance. Optional `nbf` must be a
nonnegative safe integer, no later than now and before expiry. It may precede
`iat`; absence is explicitly reported. Optional `amr` must be an array of at
most 16 nonempty strings of at most 128 characters each, without whitespace or
control characters. Unknown method strings and an empty array are reported as
signed facts. Neither `amr` nor a previously known `sub` is required: learning
these facts is the reason for this diagnostic. Malformed present claims fail.

Success JSON contains only `sub`, `email`, `iss`, `aud`, `iat`, `nbf` (null if
absent), `exp`, `nbfPresent`, `amrPresent`, optional signed `amr`, and the three
fixed authority flags. `aud` preserves the actual signed scalar or singleton-array
shape. The subject is for subsequent independently reviewed
configuration pinning; the diagnostic never sets that configuration. Responses
are private/no-store with strict CSP, frame blocking, nosniff and no-referrer;
no cookies or CORS are emitted. Every failure returns only 503
`{"error":"auth_unavailable"}` with the same privacy headers. Raw JWTs, cookies,
keys and unselected claims are never returned or logged. Treat even the limited
successful identity response as private; do not commit real output to fixtures.

There are no outbound-email, approval, state-write, D1, customer-data or arbitrary
fetch paths. The only possible runtime network operation is pinned JWKS retrieval.
`createAuthProbe` accepts local resolver/clock seams exclusively for offline
tests; the deployed default fixes both, and never reads dependencies from
environment or HTTP. No test fixture is imported into the runtime.

This probe deliberately differs from the sending verifier's subject, mandatory
`nbf` and signed MFA contract. It does not relax that verifier. If actual claims
are incompatible, record the blocker privately and design/review appropriate
assurance separately; never promote this diagnostic to a sending verifier.
Independent MFA verification, subject pinning, recipient authorization and all
existing release gates remain prerequisites for later sending work. No sending
key or D1 should be bound to this diagnostic, including during later rollout.

Offline checks (no installation or network required with existing dependencies):

```sh
node --check owner-canary/src/auth-probe.mjs
node --check owner-canary/tests/auth-probe.test.mjs
npm test --prefix owner-canary
npm run check --prefix owner-canary
npm test --prefix mail-desk
npm run check --prefix mail-desk
npm run validate
```

The existing owner-canary test glob includes the new adversarial suite. The
existing `check` script is unchanged; the two explicit syntax checks cover the
new files. Tests exercise actual RSA signatures, tampering, wrong keys, exact
issuer/audience/owner/type restrictions, time bounds, optional claim shapes,
preflight rejection before key resolution, pinned JWKS retrieval with fake fetch,
redirect refusal, privacy headers and disabled configuration. These offline
results do not establish real provider claim compatibility or current settings.

## Recorded offline evidence (2026-10-16)

Inspected parent commit: `544fb93dcdb3e093af9c53c377f237be4563dc6c`, tree
`0ebb1a3779cd7c07c8514a824a313c36dca83504`. No repository or ancestor
`AGENTS.md` was present. Node was `v22.22.1`.

- Owner-canary full suite: 303 passed, zero failed/skipped, including the existing
  baseline blob-preservation tests and the new probe adversarial tests.
- Mail Desk full suite: 481 passed, zero failed/skipped.
- Both package `check` scripts and both new module syntax checks passed.
- Root `npm run validate` was attempted and stopped at lint: root dependencies
  are absent and only incompatible system ESLint 6.4.0 was available. Separate
  root `npm run build` and `npm run check` attempts both reported `astro: not found`.
  Root lint/build/type-check success is therefore **not established**. No packages
  were downloaded or installed to overcome this limitation.
- Only the four new diagnostic files are included in this change. Existing
  tracked files remain byte-identical to the parent. The two preexisting
  untracked `node_modules` symlinks are excluded from the commit.

No real network/API/credential access, deployment or GitHub push occurred.
