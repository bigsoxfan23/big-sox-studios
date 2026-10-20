# Private review UI — offline acceptance, 2026-10-16

Worktree: `/home/greg/codex-projects/big-sox-mail-desk-task10-owner-canary-ui`.
Branch: `feature/studio-mail-desk-task10-owner-canary-ui`.
Exact starting HEAD: `2f72f54709d3c5053befe77162838012591bb4ec` (draft PR #26).
The preexisting untracked `.codex-task10-ui.txt` was left untouched.

This is an uncommitted, unmerged, **undeployed** engineering continuation. No real
Access identity, MFA assertion, account, mailbox, API key or provider was tested.
No network API, provisioning, deployment, schema application, email, Git commit,
push, merge or GitHub action was performed. Package dependencies and validation
tools were installed from the existing offline npm cache, with scripts disabled.

## Serving and trust boundary

`public/index.html`, `app.js` and `styles.css` contain no external resources,
inline scripts/styles, analytics, editable message inputs or public navigation.
The HTML is constant; snapshot and status values use `.textContent`. A generated
`src/ui-assets.mjs` embeds exactly these three files. Run `npm run bundle-ui
--prefix owner-canary` after editing assets; `npm run check --prefix owner-canary`
and tests reject a stale bundle. Bundling avoids a platform static-assets route
that could bypass Worker authentication. Do not add an ASSETS binding or a public
root assets mapping. No Worker config change was necessary.

The same signature, exact owner, signed MFA, fresh assertion and configuration
checks execute before every GET/POST, including every asset. Asset requests also
reject foreign Origin and cross-site/same-site fetch metadata. Direct top-level
navigation (`Sec-Fetch-Site: none`) is allowed only after authentication. Asset
responses have private/no-store caching, no-cache pragma, token/cookie Vary,
nosniff, no-referrer, same-origin resource policy, DENY framing and restrictive
permissions. CSP is `default-src 'none'`, scripts/styles/connect only `'self'`,
with images/objects/base/form actions/ancestors denied. There is no CORS.

The committed `CANARY_SEND_ENABLED=false`, `DEPLOYMENT_STAGE=offline`,
`MFA_CONTRACT=unverified`, empty routes and disabled workers.dev/preview URLs are
unchanged. The default entrypoint still explicitly fixes `dispatchAuthorized:
false`; complete runtime flags alone cannot enable send. Offline config denies
the UI entirely. Even in a fully configured protected test environment, a false
`sendAuthority` disables UI actions. No release override or alternate route exists.

## Acceptance coverage

The real browser script runs in an offline Node VM with a minimal DOM whose HTML
sink throws. Fetch connects directly to the actual Worker with local signed RSA
Access assertions and a temporary SQLite ledger. Provider transport is stubbed;
global network fetch throws. Tests cover:

- Private assets, absent/forged/expired assertions, wrong signed owner, missing
  signed MFA, service tokens, reauthentication, disabled config and foreign origins.
- Exact bytes/MIME, per-asset CSP and cache/security headers, no credentials in
  assets, no cookies/ledger mutation on GET, no alternative asset/public paths.
- Literal hostile markup in preview and confirmation via text sinks. No storage,
  URL/session persistence, HTML sinks, injected envelope fields or remote resources.
- Initial status as the only automatic request; preview/review/approval cause no
  provider send; a separate open dialog, cancel action and explicit send click.
- Same-origin credentials, JSON/action headers, POST bodies containing only `{}`
  or a capability; message fields never originate in browser POSTs.
- Double clicks, expiry with an open dialog, replay from a second actor, revoked
  identity, refresh into any existing campaign, back-forward restoration and
  failed transitions halt without a second preview/campaign.
- Accepted vs delivery unverified, provider rejection, UNKNOWN on ambiguous
  transport, and a network failure during dispatch. All attempts permanently lock
  UI controls, including when no response arrives. Server error content is hidden.

These are protocol and DOM behavior tests, **not a real-browser layout, assistive
technology, real D1, actual Access/IdP or live provider certification**. The layout
uses a bounded reading width, mobile wrapping, visible focus, semantic headings,
status live region, native modal dialog and a complete plain-text message.

Before any later approved exposure, manually inspect desktop/mobile layout and
keyboard/screen-reader behavior in an isolated protected environment. Confirm all
three asset requests challenge unauthenticated users, show the exact snapshot,
cancel the dialog without a POST, verify approval causes zero sends, and inspect
CSP/cache headers. Do not click real send as a UI smoke test. An offline mock can
exercise the full path without creating an actual campaign. Reload/expiry must
halt; never reset the permanent slot to repeat acceptance.

## Validation results

| Command/check | Result |
| --- | --- |
| `npm test --prefix owner-canary` | 180/180 passed (112 existing + 68 UI/integration), zero skipped |
| `npm test --prefix mail-desk` | 481/481 passed, zero skipped |
| `npm run check --prefix owner-canary` | Passed, runtime/browser syntax and asset freshness |
| `npm run check --prefix mail-desk` | Passed |
| Repository ESLint 9.39.1 configuration | Passed with isolated tools and NODE_PATH |
| `git diff --check` and new-file whitespace | Passed |
| Original exact-base Git blob manifest | Passed unchanged |
| Wrangler 4.151.0 candidate dry-run | Passed, 66.90 KiB / gzip 18.92 KiB; offline vars only |
| Wrangler 4.151.0 staging dry-run | Passed, 182.60 KiB / gzip 47.64 KiB; unchanged size |

Existing `.github/workflows/owner-canary-validate.yml` already runs the wildcard
`tests/*.test.mjs` and the updated syntax/check script, so it covers this UI and
bundle-freshness check without workflow changes. No CI run is claimed here.

Tools were installed under ignored `node_modules/.task10-tools` from the offline
`/tmp/task10-owner-npm-cache`. Lint used a byte-identical copy of the root config:

```sh
NODE_PATH="$PWD/node_modules/.task10-tools/node_modules" node node_modules/.task10-tools/node_modules/eslint/bin/eslint.js --config node_modules/.task10-tools/eslint.config.mjs .
```

Both Wrangler invocations used `deploy --dry-run` with isolated empty environment,
temporary HOME/config/log/output paths, metrics off and CI mode; both ended
`--dry-run: exiting now`. The existing missing `astro/tsconfigs/strict` warning
was nonfatal. No website build is claimed. Exact commands:

```sh
env -i PATH="$PATH" HOME=/tmp/task10-ui-tool-home XDG_CONFIG_HOME=/tmp/task10-ui-tool-config WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/task10-ui-logs/candidate.log CI=true node node_modules/.task10-tools/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config owner-canary/wrangler.candidate.toml --outdir /tmp/task10-ui-candidate-bundle
env -i PATH="$PATH" HOME=/tmp/task10-ui-tool-home XDG_CONFIG_HOME=/tmp/task10-ui-tool-config WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/task10-ui-logs/staging.log CI=true node node_modules/.task10-tools/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config mail-desk/wrangler.staging.toml --outdir /tmp/task10-ui-staging-bundle
```

## Exact next gated owner action

The next action is owner/operator verification of the **actual independently
signed MFA evidence** from the intended Cloudflare Access login and exact signed
owner identity. Verify issuer, signature, audience, subject, email, `amr` MFA,
`iat`/`nbf`/`exp` and fresh-auth lifetime against the existing verifier. A policy
checkbox, browser assertion or synthetic fixture is insufficient. Confirm the
exact supported owner mailbox after protected login. Do not paste raw assertions,
keys or personal mailbox data into chat, source control, URLs or browser storage.
Missing actual signed MFA evidence leaves the release blocked; independent IdP
step-up requires a separately reviewed verifier, not relaxation of this one.

Subsequent separately gated operator work must provision a narrowly scoped,
sending-only approved-domain key and independent approval secret/session epoch;
configure an isolated Access application with only the exact owner, enforced MFA
and no bypass/service-token rules; provision and pin dedicated D1 with the reviewed
schema and permanent-row retention; and review a staged **disabled** deployment
with no public workers.dev/preview exposure. This task authorizes none of those
live actions. Real D1, policy, revocation and sender scope need verification.

Only after these checks and a separate reviewed release change may the owner
create and approve **one exact immutable runtime preview** and deliberately
confirm its separate one-send POST. No such preview or send has been approved.
An expired/consumed intention remains permanently halted, never a reason to open
a second campaign. After API acceptance, the owner must inspect inbox/spam, count
and SPF/DKIM/DMARC headers; this service always reports delivery unverified.
