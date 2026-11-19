# Task12 Step 4 source repair — November 19, 2026

Implementer report for independent re-review, based on PR82 candidate
`f055857e`. All changes are local and uncommitted. No push, PR creation, merge,
deployment, credential access, external account creation, provider send, remote
D1 edit, Cloudflare/Notion update or spending was performed. Local tests use
synthetic identities, in-memory SQLite and isolated local workerd/D1 only.

## Dispatch and withdrawal serialization

`portal/welcome-live-delivery.mjs` now checks `member_approval_holds` in both
the durable claim INSERT and final dispatch eligibility SELECT. Both predicates
use the intent/onboarding's exact source database and request ID. Missing schema
or SQL errors fail closed. Review, cross-database preflight, current Owner,
Member, revision, recipient, readiness and deadline checks remain in place.

A final SELECT cannot atomically cover a later network invocation. Instead,
the existing durable live `dispatching` claim reserves dispatch against the
Owner withdrawal path. `portal/request-onboarding.mjs:holdAdmission` now refuses
both a new hold and an existing-hold retry when the same source/request has a
live `dispatching` or `UNKNOWN` intent. The conditional claim and hold INSERTs
execute in the **same Members D1** and serialize as writes:

- Hold commits first: the claim's NOT NULL member subquery cannot succeed; no
  live intent or transport call starts. The hold and its audit stay immutable.
- Claim commits first: withdrawal cannot commit its hold, so the existing Owner
  route fails before changing Requests D1, its revision or withdrawal audit.
  This covers the gap after the final SELECT and the entire in-flight send.
- Definite accepted/refused completion: its existing durable outcome write
  releases the withdrawal exclusion. A pre-dispatch failure also allows a later
  hold. Accepted mail can already be queued; withdrawal does not recall it.
- Timeout, abort after claim, provider uncertainty or lost completion/readback:
  `UNKNOWN`/`dispatching` retains both the existing resend lock and the new
  withdrawal exclusion indefinitely. No lease expiry or automatic clearing is
  introduced. Read-only reconciliation evidence cannot unlock either operation.
- Lost hold readback or failed Requests CAS: existing immutable hold/recovery
  behavior remains; uncertainty is never converted into permission to send.

No database transaction is held across network I/O. This is a conservative
refusal policy for the cooperating Owner withdrawal path; it relies on the
reviewed adapter treating definite outcomes as terminal and making one call.
Separate Owner/member revocation, arbitrary direct Requests D1 writes and old
sender code do not acquire this reservation. Any future authorized release must
use both repaired paths against the same Members D1. Existing uncertain live
intents may therefore prevent withdrawal until a separately reviewed operational
resolution; this repair deliberately provides no unlock procedure.

The synthetic regression suite includes the reported sequence (review and
post-claim preflight succeed, then a legacy/out-of-band hold and Requests
revocation commit before final SQL), plus hold-before-claim, real
`holdAdmission` attempts after claim and before/after final SQL, different
Owners, in-flight acceptance/refusal, timeout with late acceptance, lost writes,
abort, missing tables at both boundaries, legacy hold retry, simulated intent
compatibility, immutable holds/receipts/audits, and actual local workerd/D1
execution of both write orderings. The authenticated Owner route regression
also verifies that dispatching/UNKNOWN leaves the Requests row unchanged.

## Other findings

- Root minimatch override is pinned to **11.0.9**. npm **10.9.4** regenerated
  the lockfile; the only additional dependency update is its required
  `@isaacs/nonrecursive-glob-match` 1.0.3 → 1.1.0. Installed dependency readback
  confirms minimatch 11.0.9. Both npm audits returned zero vulnerabilities.
  The maintainer's [compile-time advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-cf2h-pxjq-68xw)
  includes the old 11.0.1 pin; later [escape](https://github.com/isaacs/minimatch/security/advisories/GHSA-c859-jr93-m5j4)
  and [cache](https://github.com/isaacs/minimatch/security/advisories/GHSA-hqmv-qgp3-jx75)
  advisories are also below the new pin. Audit results describe this execution's
  registry data, rather than a permanent guarantee.
- Validate's existing source-test command now includes
  `members-portal-production/*.test.mjs`. Workflow triggers, permissions,
  deployment gates and user-facing design are unchanged. Live-send flags stay off.
- **Production bootstrap remains a separate gated operational blocker.** The
  bootstrap helper allows only offline/staging modes; enrollment explicitly
  selects staging mode; the production entrypoint mounts no enrollment route.
  A new empty production Members D1 has no secure browser path to its first
  authorized Owner in this candidate. Authentication was not relaxed and no
  production bootstrap code or arbitrary Owner was added. The required separate
  reviewed procedure and exact-Owner approval are documented in
  [production release preparation](task12-production-release-prep.md#release-gates-before-any-production-mutation).

## Files changed

1. `portal/welcome-live-delivery.mjs` — hold checks and reservation explanation.
2. `portal/request-onboarding.mjs` — atomic withdrawal exclusion and retry guard.
3. `portal/welcome-live-withdrawal.test.mjs` — new synthetic race/failure tests.
4. `owner-launchpad/test/onboarding-route.test.mjs` — load existing welcome
   migration in the fixture; verify withdrawal refusal through the Owner route.
5. `package.json` — patched override.
6. `package-lock.json` — npm 10.9.4 lock regeneration.
7. `.github/workflows/validate.yml` — production source-test coverage.
8. `docs/task12-production-release-prep.md` — explicit bootstrap blocker.
9. `docs/task12-step4-source-repair.md` — this report.

## Commands and results

Working directory: `/tmp/bss-task12-step4-fix-20261119`. Commands below omit
only log redirection and repeated environment prefixes. Tests/build used
`PATH=/tmp/bss-step4-tools/node_modules/node/bin:$PATH`,
`ASTRO_TELEMETRY_DISABLED=1`, and `WRANGLER_SEND_METRICS=false`.
Node is **24.22.0**, matching `.nvmrc`. The explicit npm CLI below is **10.9.4**;
the environment's existing npm script runner is 9.2.0.

Tool installation (local `/tmp` only):

```sh
npm --userconfig=/dev/null --cache=/tmp/bss-step4-npm-cache --fetch-retries=0 --fetch-timeout=15000 install --prefix /tmp/bss-step4-tools --no-audit --no-fund npm@10.9.4 node@24.22.0
```

Lock generation, clean install, audits and installed-version verification:

```sh
node /tmp/bss-step4-tools/node_modules/npm/bin/npm-cli.js --userconfig=/dev/null --cache=/tmp/bss-step4-npm-cache --fetch-retries=0 --fetch-timeout=15000 install --package-lock-only --ignore-scripts --no-audit --no-fund
node /tmp/bss-step4-tools/node_modules/npm/bin/npm-cli.js --userconfig=/dev/null --cache=/tmp/bss-step4-npm-cache --fetch-retries=0 --fetch-timeout=15000 ci --include=dev --include=optional --no-audit --no-fund
node /tmp/bss-step4-tools/node_modules/npm/bin/npm-cli.js --userconfig=/dev/null --cache=/tmp/bss-step4-npm-cache --fetch-retries=0 --fetch-timeout=15000 audit --include=dev
node /tmp/bss-step4-tools/node_modules/npm/bin/npm-cli.js --userconfig=/dev/null --cache=/tmp/bss-step4-npm-cache --fetch-retries=0 --fetch-timeout=15000 audit --omit=dev
node /tmp/bss-step4-tools/node_modules/npm/bin/npm-cli.js --userconfig=/dev/null --cache=/tmp/bss-step4-npm-cache ls minimatch --include=dev
```

All exited 0: clean install added 397 packages; each audit reported
`found 0 vulnerabilities`; installed minimatch is 11.0.9, overridden/deduplicated.
The lockfile change is limited to the two packages described above.

| Exact check command | Result |
| --- | --- |
| `node --test --experimental-test-isolation=none portal/welcome-live-delivery.test.mjs portal/welcome-live-withdrawal.test.mjs portal/welcome-reconciliation.test.mjs portal/welcome-resend-transport.test.mjs owner-launchpad/test/onboarding-route.test.mjs owner-launchpad/test/approved-member-admission.test.mjs` | 78/78 PASS |
| `node --test --test-concurrency=1 portal/*.test.mjs members-portal-staging/*.test.mjs members-portal-production/*.test.mjs` | 374/374 PASS |
| `npm test --prefix owner-launchpad` | 247/247 PASS |
| `npm run check --prefix owner-launchpad` | PASS |
| `npm run lint` | PASS, including final added regressions |
| `npm run validate` | PASS: ESLint, Astro check and 15-page static build; check reports 0 errors, 0 warnings, 86 hints; build logs existing empty-content-directory notices |
| `npm run test:membership` | 99/99 PASS |
| `npm run test:public` | 16/16 PASS |
| `npm run test:notify` | 130/130 PASS |
| `git diff --check` | PASS |

Local logs are `/tmp/bss-step4-{focused,portal-suite,owner-suite,owner-check,validate,membership,public,notify}.log`.
Initial sandbox-only runs hit `EAI_AGAIN` for npm registry access and `EPERM`
binding local workerd loopback sockets. Narrowly scoped escalated reruns
succeeded; there is no remaining infrastructure test failure. Initial new
fixture failures (missing welcome schema in an old Owner fixture, mismatched
synthetic recipient and duplicate synthetic contact) were corrected and the
affected suites rerun.

**Disposition:** source repair is ready for independent re-review. This
implementer report is not an independent
approval or production release authorization. Production bootstrap and the
existing external release/acceptance gates remain unresolved.
