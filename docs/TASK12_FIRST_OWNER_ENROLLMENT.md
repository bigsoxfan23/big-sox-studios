# First Owner confirmation page — staging source only

This change implements `GET` and `POST /owner/enroll` in
`portal/first-owner-enrollment.mjs`, with a proposed custom-host composition in
`members-portal-staging/owner-enrollment-assembly.mjs`. No deployment config
selects that composition. The existing staging Worker, dashboard default, public
website and Cloudflare configuration remain unchanged. No deployment, push,
remote database write, migration or settings change was performed.

Both new default exports return 404 for enrollment. Activation requires explicit
reviewed server source wiring of an exact target, two independent evidence
verifiers and an HMAC SHA-256 CryptoKey of at least 256 bits with sign/verify
usages, plus `PORTAL_MODE=staging-enrollment-source`, the approved `DB` binding and
matching `BOOTSTRAP_DATABASE_ID`. A flag, binding, allowlisted email, browser
claim or diagnostic boolean alone cannot enable enrollment. The composition pins
the staging custom host, issuer and exclusive members audience to the existing
source constants; environment values cannot retarget them. The separate owner
Access audience required by the existing authenticator must also be reviewed.

The page reuses `createOtpAuthenticator` through `createFirstOwnerBootstrap`.
Every GET and POST requires the signed Access JWT and matching trusted runtime
`ctx.access` audience, exact JWT/runtime email agreement and
`idp.type === 'onetimepin'`. The exact OTP subject must match the approved
recipient. Google or Apple identity with the same email cannot enroll; there is
no normalization, linking, promotion or upsert. Requests to HTTP, workers.dev,
alias hosts, nonstandard ports, wrong issuer/audience, mismatched Origin/Host,
queries, HEAD and other methods fail closed.

A successful GET performs only the existing read-only bootstrap preflight,
including fresh external policy and Owner approval verification and pristine D1
checks. It returns a plain accessible HTML form, without scripts, identity text,
raw JWT, approval record or auto-submit. A random 256-bit cookie is Secure,
HttpOnly, SameSite=Strict, host-only (`__Host-`), Path=/ and expires in 300 seconds.
The hidden HMAC-signed ticket binds its hash, issue/expiry time and an opaque
digest of the exact Access session, target recipient/role, database, host,
issuer/audience, source revision, bootstrap nonce, policy digest, approval digest
and approval audit reference. A new GET replaces the browser cookie, invalidating
older forms in that browser. All responses are private/no-store and noindex,
with no framing, external resources, scripts, referrer disclosure or CORS grant.
The CSP permits only same-origin form submission.

POST requires the ticket, matching single cookie, explicit confirm button value,
exact same-origin Origin, `Sec-Fetch-Site: same-origin`,
`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` and
`Sec-Fetch-User: ?1`. Missing metadata fails closed. This requires a browser form
navigation after GET and a user activation in supported browsers. These headers
are CSRF defenses, not cryptographic evidence of a person: an authenticated
non-browser client can emulate headers. No request header is treated as MFA or
independent approval. The form body is limited to 2 KiB while streaming; extra
or duplicate fields, invalid signatures, mismatched cookies, stale tickets and
changed sessions/targets/evidence are denied. Browser back, reload and API fetch
must not cause a successful write without that confirmation contract.

POST redoes authentication, evidence verification and D1 preflight. Immediately
before write dispatch the bootstrap rechecks the same confirmation digest,
ticket deadline, JWT expiry and both independent attestations, including after
D1 awaits. It then reuses the existing singleton SQL receipt and triggers from
`portal/migrations/0001-first-owner-bootstrap.sql`: one statement creates a fresh
active Owner, exact OTP binding, immutable audit and receipt, or rolls back all
four. Concurrent attempts can have only one winner. Successful replay, new
cookies/tickets, process restarts, new sessions, new nonces and later revocation
cannot reopen bootstrap. Failed precommit attempts do not consume a separate
server challenge record; the permanent successful-use boundary is the existing
D1 singleton. No additional migration or schema change is introduced.

Success follows exact binding/Owner/audit readback. Every commit-stage error is
reported as requiring operator inspection with “Do not retry,” since a commit
may have succeeded despite a lost response or failed readback. There is no
automatic retry or success redirect that could repeat a POST. The confirmation
cookie is cleared after any POST outcome. No raw requests, subjects, tickets,
cookies, JWTs or verifier evidence are logged by this implementation.

The existing factory still defaults to read-only and supports its original
`offline-test` mode. The only added mode is `staging-enrollment-source`, requiring
the exact corresponding runtime mode and explicit source dependencies. The new
optional confirmation digest/deadline constrain its commit invocation; they do
not bypass its evidence requirements. Neither verifier is implemented here.
Synthetic local callbacks establish no real OTP identity, independent MFA,
effective policy or Owner approval.

## Remaining approval and deployment prerequisites

1. Independently review the exact source revision and security contract, including
   the mode extension, confirmation key custody, browser behavior, expiry at
   write dispatch and conservative ambiguous-outcome handling. Resolve findings
   before any release. Source review is not deployment or bootstrap approval.
2. Obtain separately authorized real OTP runtime field evidence on the exact final
   protected custom host without changing existing Google login or weakening
   policy. Verify actual `ctx.access` identity and exclusive audience behavior;
   absence or mismatch remains a denial. OTP is not independent MFA.
3. Implement and review trusted server adapters that actually verify effective
   Access policy readback, all overrides/bypasses, independent MFA enforcement
   for this OTP route, and external signed/audited Owner approval. Verify signer,
   algorithm, audience, signature, expiry, revocation, provenance and outages;
   never mint evidence on demand or convert config/browser booleans to proof.
   Evidence must satisfy the existing context/policy binding contract.
4. Obtain one independent explicit audited Owner decision for the exact private
   recipient, role `owner`, database, host, reviewed revision, bootstrap nonce,
   verified Access session and effective policy digest. General development
   authorization and the browser confirm click do not replace this decision.
5. Independently verify the actual identity and approved schema of the existing
   dedicated Task12 Phase2 D1 binding, its pristine state across all portal
   tables, singleton/audit guards and binding metadata. The source database ID
   label is not independent binding attestation. Do not create another database,
   reuse Task11/public membership D1 or infer readiness from a name. Separately
   authorize any needed migration, retention, backup, recovery and local-D1
   rehearsal; this task authorizes none remotely.
6. Arrange a separate sanitized read-only bootstrap dry-run against the exact
   authorized target. Review its opaque context/confirmation digests, counts,
   evidence freshness and expected atomic effects before explicitly authorizing
   the first remote write. The page's GET does not itself authorize that write.
7. Prepare a reviewed shared confirmation key through approved secret custody,
   separate from Access signing keys, with a scoped lifecycle and rotation plan.
   Supply a non-extractable CryptoKey through reviewed server composition; do
   not hardcode, log or commit key bytes. Multiple isolates must use the same
   approved key; missing/rotated keys fail closed. Decide the supported browser
   matrix, including Fetch Metadata and SameSite behavior across Access login.
8. Independently approve the future entrypoint/config wiring, exact DB binding,
   source target and evidence adapters. Inventory and protect every route,
   workers.dev/preview alias and direct path, pin issuer/audiences, verify edge
   cache restrictions and fixed logout interception. The example dashboard
   config and current staging config do not activate this module. Obtain
   separate authorization for upload, deployment and any settings changes;
   record the prior version and an approved rollback procedure.
9. Run real-browser acceptance on an approved synthetic local setup, then the
   separately authorized protected staging target: GET writes nothing; clicking
   the button issues the expected POST; cancel/back/reload and direct API posts
   do not enroll; cross-site submission, missing headers, stale/copied/tampered
   forms, wrong identity/session, changed evidence, concurrent confirmations,
   D1 outages and ambiguous readback fail closed. Check mobile/keyboard layout
   and no sensitive data in logs, cache or screenshots. No browser/MFA live
   acceptance is claimed by these local handler tests.
10. After separately approved success, inspect exact receipt, Owner binding and
    immutable audit, then remove/disable write capability and retire the key.
    Never delete the singleton receipt to retry. An uncertain outcome requires
    inspection before any further action. Complete the broader production MF6
    acceptance, live role/revocation/grant checks, independent service-session
    cleanup and the launch gates in `TASK12_OTP_OWNER_FOUNDATION.md` before any
    production or service launch.

## Local validation

Use existing Node 24 and installed dependencies, with no package installation:

```sh
node --test --experimental-test-isolation=none portal/*.test.mjs members-portal-staging/*.test.mjs
npm run lint
npm run build
```

Miniflare needs local loopback socket permission. Tests use ephemeral local D1,
synthetic RSA-signed JWTs, mocked signing-key fetches, synthetic runtime OTP and
injected synthetic policy/approval evidence; the new fixtures prohibit outbound
network traffic. They cover no-write GET/denials, disabled defaults, exact target
and identity checks, CSRF, form/cookie/ticket tampering, duplicate fields, expiry,
policy/approval changes even between POST preflight and commit, pinned staging
composition, single successful concurrent commit, rollback, restart replay and
ambiguous readback. The existing bootstrap tests additionally cover every
existing member state, preflight/write races and immutable receipt/audit history.

A local Playwright/Chromium launch was attempted on 2026-10-26 but could not start:
its runtime lacks `libatk-1.0.so.0`. No browser dependencies or system packages
were installed. The handler tests emulate the browser headers; actual browser
acceptance remains explicitly required above.

Validation results on 2026-10-26: the portal/staging regression run passed all
171 tests. After adding two further cases, the final enrollment-focused run
passed all eight tests. Repository lint, Astro check/build and `git diff --check`
passed. Temporary local dependency reuse required no package or lockfile change.
Local logs: `/tmp/bss-owner-enrollment-regression.log`,
`/tmp/bss-owner-enrollment-focused-final.log`,
`/tmp/bss-owner-enrollment-lint-final.log` and
`/tmp/bss-owner-enrollment-build.log`.
