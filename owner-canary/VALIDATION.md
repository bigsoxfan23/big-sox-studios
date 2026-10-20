# Offline validation — 2026-10-16

Base and branch verified locally:
`ceb08a8351349f66d0fbe92ca1c4adc00d7d6e6e`,
`feature/studio-mail-desk-task10-owner-canary-candidate`.
No commit, push, merge, deployment, live send or migration application.

| Check | Result |
| --- | --- |
| `npm test --prefix owner-canary` | **112/112 passed**, zero failures/skips/cancellations |
| `npm test --prefix mail-desk` | **481/481 passed**, zero failures/skips/cancellations |
| `npm run check --prefix owner-canary` | Passed, all four runtime modules |
| `npm run check --prefix mail-desk` | Passed, existing full syntax script |
| Repository ESLint 9.39.1 recommended configuration | Passed |
| `git diff --check`, including separate new-file whitespace scan | Passed |
| Git diff of all tracked baseline paths | Empty |
| Exact-base Git blob manifest test | All tracked baseline bytes unchanged |
| Wrangler 4.151.0 candidate `deploy --dry-run` | Passed, **55.48 KiB / gzip 14.92 KiB**, offline vars only |
| Wrangler 4.151.0 staging `deploy --dry-run` | Passed, **182.60 KiB / gzip 47.64 KiB**, matching baseline |

Both dry-runs explicitly ended with `--dry-run: exiting now`. They emitted a
nonfatal missing `astro/tsconfigs/strict` warning because the root Astro dependency
is absent. No website build is claimed. Source/file checks and unchanged staging
bundle establish isolation, not deployed equivalence or authorization.

Validation environment: Node 22.22.1, `jose` 6.2.12 pinned with lockfile integrity.
The Node SQLite API emitted its expected experimental warning. Test networking is
replaced with a throwing global fetch and local RSA JWKS verification; provider
behavior uses only injected stubs. Tests use invented `.test` owner addresses,
synthetic tokens/secrets and temporary SQLite files removed on completion.
Two connections to a shared on-disk SQLite database exercise actual SQL and CAS
races across distinct coordinator instances. This is not a real D1 concurrency
or durability certification.

Coverage includes missing/forged/expired Access assertions, wrong issuer/audience/
principal/signature/algorithm, unsigned or missing signed MFA, service tokens,
untrusted JWT key URLs, per-mutation session rechecks, exact token/cookie binding,
CSRF/origin and method denial, client envelope/content injection, stale configuration,
modified capabilities, expired approval, concurrent preview/approval/dispatch,
expiry during claim, durable claim before provider I/O, post-claim crash, failed
outcome persistence, response uncertainty, permanent no-retry and database trigger
protection against snapshot edits/reset/delete/replacement. Static tests preserve
all baseline Git blobs and assert the disabled release/config and import boundary.

Isolated lint command, using a byte-identical copy of the repository ESLint config:

```sh
NODE_PATH="$PWD/node_modules/.task10-tools/node_modules" node node_modules/.task10-tools/node_modules/eslint/bin/eslint.js --config node_modules/.task10-tools/eslint.config.mjs .
```

Tooling was installed under ignored `node_modules/.task10-tools` in this worktree,
with pinned Wrangler/lint versions and lifecycle scripts disabled. Existing
postal-mime was installed from the unchanged mail-desk lockfile, with scripts
disabled. The candidate's only runtime dependency is independently pinned jose.
Downloads used an isolated `/tmp/task10-owner-npm-cache`; no account credentials
were read. Tool/package installs changed no existing tracked manifests/locks.

Dry-runs used an empty environment plus explicit PATH, isolated HOME/config/log
paths under `/tmp`, CI mode and metrics disabled. No real account/secret was
configured. Their exact commands were equivalent to:

```sh
env -i PATH="$PATH" HOME=/tmp/task10-owner-tool-home XDG_CONFIG_HOME=/tmp/task10-owner-tool-config WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/task10-owner-logs/candidate.log CI=true node node_modules/.task10-tools/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config owner-canary/wrangler.candidate.toml --outdir /tmp/task10-owner-candidate-bundle
env -i PATH="$PATH" HOME=/tmp/task10-owner-tool-home XDG_CONFIG_HOME=/tmp/task10-owner-tool-config WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/task10-owner-logs/staging.log CI=true node node_modules/.task10-tools/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config mail-desk/wrangler.staging.toml --outdir /tmp/task10-owner-staging-bundle
```

Only `owner-canary/` is newly authored. The preexisting untracked
`.codex-task10-owner-canary-candidate.txt` remains untouched. All tracked existing
sources, migrations, public assets, locks, staging config and handoffs are intact.
The existing staging bundle contains no new owner-canary runtime code.

Remaining unverified: real Access/IdP MFA assertions and enforced policy, live
revocation behavior, owner mailbox possession/authorization, sender verification,
production credential scope, real D1 behavior/persistence, provider API acceptance,
actual delivery and SPF/DKIM/DMARC headers. A same-origin owner UI, edge policy/rate
limits and release/operational review are future work. The default entrypoint
cannot send even with all configuration gates present. See [README.md](README.md)
for the required independent MFA proof and later approval gates.
