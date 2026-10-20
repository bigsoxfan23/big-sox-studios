# Local validation · 2026-10-14

Executed on Node **v22.22.1**. Only synthetic fixtures and in-memory SQLite were used. Tests execute the actual Worker handler, Web Crypto RSA verification and actual migration/SQL through a D1-shaped adapter. Provider and JWKS fetches are local stubs; all future Resend adapter tests inject a stub. No real mail, Notion data access, Cloudflare resource, DNS or deployment was involved.

Command, exit **0**:

```text
npm test --prefix mail-desk

> test
> node --test --experimental-test-isolation=none test/*.test.mjs

1..80
# tests 80
# suites 0
# pass 80
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 544.114257
```

The complete, unabridged TAP output is saved in [test-results.tap](test-results.tap). Experimental warnings for SQLite/test mock timers are expected from Node 22. In-process test isolation is explicit: this environment's default process-isolated invocation reported only the test file, concealing its individual counts. The explicit final invocation reports all 80 checks.

Command, exit **0** (full output also in [check-results.txt](check-results.txt)):

```text
npm run check --prefix mail-desk

> check
> node --check src/worker.mjs && node --check public/app.js
```

Python's standard-library `tomllib.load` also parsed `mail-desk/wrangler.staging.toml`, with the `run_worker_first` assertion true:

```text
TOML parse: PASS
```

`git diff --check` returned exit 0 with no output. Scope inspection found only the new `mail-desk/` tree added by this task. The already-untracked root `TASK9_BUILD_BRIEF.md` and `TASK9_CODEX_RUN.log` were present before work and were left untouched. No workflow was added or modified.

## Coverage and limitations

| Boundary | Executed evidence |
| --- | --- |
| JWT | All static/API paths require assertion; malformed/forged signatures, wrong issuer/audience/owner, case mismatch, missing/future/expired temporal claims, wrong algorithm/key/critical header denied; empty config fails closed; JWKS cache verified |
| CSRF/Origin | Missing/wrong/null Origin, cross-site metadata, missing/forged cookie/proof and another JWT session denied; secure cookie and security headers inspected |
| Inputs | Forged To/From/recipient/sender/CC/BCC/HTML rejected at draft/review/send; streamed/declared length, invalid JSON, content type and unknown fields checked |
| Delivery | 12 overlapping Send requests plus replay produce one provider call and one outbound message; revision edits, case/session mismatch, snapshot tampering, signed approval expiry checked |
| Failure safety | Actual watchdog exercised using Node mock timers; exception/ambiguous results UNKNOWN, no retries/new drafts; definite failure terminal per revision; crash recovery never reclaims; forced finalization transaction failure rolls back sent effects and preserves dispatching |
| Notion isolation | Sent remains sent after mock sync failures; independent five-attempt bounded backoff/dead state; case-created job before sending; stale lease recovery and stale callback isolation; all three initial mappings verified with sole source and no Reference/Sequence |
| Staging lock | Non-mock modes rejected despite injected production flags; staging import graph contains no live adapter/API key/provider URL; future adapter's independent gates prevent fetch; official idempotency headers and uncertainty behavior verified through stubs |
| Inbound | Ten concurrent duplicate synthetic inputs create one UUID case, inbound message and case-created sync job; real-address/non-synthetic fixtures rejected; no HTTP intake route |
| UI | DOM harness drives hostile subject/name/body through queue/thread/review/send; HTML sinks throw if used; editing/cancel cannot send; static CSP/no-store allowlist; responsive CSS contracts cover 390px width, wrapping, single-column layout, viewport and touch target rules |
| Config | Exact staging name, provisioned dedicated Free-tier D1 database binding, empty auth defaults, mock mode, Notion off, real-send false, protected static assets, disabled public previews and no routes/triggers verified |

Earlier expanded validation had **three failed assertions** (one per Notion channel): the test incorrectly expected 14 mapped properties; the requested mapping contains 13. Corrected the assertion after checking every requested field. All current checks pass; no failures, skipped tests or cancellations remain.

This environment has no browser installed. DOM/CSS contract tests **do not constitute a rendered 390px browser inspection**. Wrangler bundling, Cloudflare's actual D1/asset runtime, real Access/MFA, cookie behavior through Access and owner review remain manual gates. No dependency download or remote staging acceptance was attempted. See [OPERATIONS.md](OPERATIONS.md) for those gates and retention/rollback procedures. Notion property types and lifecycle must be audited under OWNER PRIVACY PERMISSION AUDIT before any live sync implementation.
