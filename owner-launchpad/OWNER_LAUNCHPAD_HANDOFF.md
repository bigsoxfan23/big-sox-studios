# Owner Launchpad — offline design and code handoff

**Published offline for review:** Separate [draft PR #22](https://github.com/bigsoxfan23/big-sox-studios/pull/22), branch `feature/studio-mail-desk-owner-launchpad`, review commit `6b350a34acfb0bddda58a29146c16e9d3364bad0` based on `f085940`. 58/58 security tests, syntax and Wrangler dry-run PASS; GitHub Validate PASS. **No deployment**, Cloudflare/DNS/Access/website changes, Mail Desk changes or merge occurred. All additions live in `owner-launchpad/`. No production records or credentials were used.

## What this is

A private launchpad, **not a true owner-only Sveltia menu**. The inspected website is Astro static output with a root asset-only Worker; `public/admin/index.html` loads Sveltia from unpkg and public YAML configuration. The production YAML overrides the publishing branch to main. Static Sveltia assets cannot guarantee owner-only roles for a menu link; hiding a link with JavaScript would still expose it. No public/admin link was added.

After future approval and deployment, bookmark the new private launchpad root in the owner's browser as “Big Sox — Owner desk.” Open that bookmark, complete Cloudflare Access authentication, and choose Content editor or Mail Desk. The cream/navy/terracotta page has two responsive keyboard-accessible cards. Each destination retains its own login and authorization. The launchpad never proxies mail, grants CMS privileges, shares cookies, or passes tokens in URLs.

CMS destination: `https://bigsoxstudios.com/admin/`, based on the inspected public CMS configuration. **The exact existing protected Mail Desk URL is confirmed:** `https://bss-mail-desk-staging.fridman-greg.workers.dev/`. `MAIL_DESK_URL` is now pinned to this nonsecret destination in the offline launchpad configuration. Test fixtures still use `example.test`. The Access issuer, audience, launchpad origin and owner secret remain unset, so this proposed Worker still fails closed; no separate launchpad service, Access app, route or domain has been provisioned.

## Security implementation

`src/security.mjs` locally adapts the RS256/Web Crypto verification design from `mail-desk/src/security.mjs` at `f085940`. It does not import from or alter Mail Desk. Mail Desk's session/CSRF helpers and secret requirements are intentionally omitted because this Worker has no state-changing actions, sessions or forms.

Every resource requires a correctly signed `Cf-Access-Jwt-Assertion`; cookies, an email header and public asset paths cannot bypass verification. Exact HTTPS team issuer, audience membership and case-sensitive owner email are required. `exp`, `nbf`, and `iat` must be nonnegative safe-integer seconds with strict expiry, activation and issuance checks, without clock leeway. Only RS256 with a named key is supported; algorithm overrides, unsigned tokens, critical extensions and token-specified key URLs/keys are rejected.

JWKS comes only from the configured issuer's `/cdn-cgi/access/certs`, with manual redirects and status 200 required. Both transport and streamed body reading share a five-second deadline; size is bounded to 64 KiB and 1–20 keys. The entire key set is validated, not merely the matching entry: unique bounded key IDs, RSA signing purpose/algorithm/operations, canonical base64url public components, 2048–8192-bit modulus, odd public exponent, no private key material, and successful Web Crypto key import. Optional certificate metadata is not a trust anchor; trust comes from the pinned issuer HTTPS endpoint and the verified RSA signature. All fetch calls are unbound standalone calls for workerd compatibility.

Keys cache for five minutes per issuer. An unknown key ID triggers a fresh JWKS lookup, throttled to once per 30 seconds per verifier after rotation refresh. Refresh failures replace cached keys with a 30-second negative cache; stale keys are never used after a refresh failure. Consequently a newly rotated key may be temporarily denied during an outage or refresh cooldown; retry later. Cached keys can remain accepted until expiry or a refresh, so immediate revocation requires Access enforcement as well. This is availability sacrificed to fail closed, not a live revocation service.

Request URL origin must match exact configured HTTPS `APP_ORIGIN`; a supplied Origin header must match too. Authenticated requests accept only GET/HEAD at `/` without a query. Unknown paths return 404, unsupported methods 405, and unauthenticated paths/methods disclose no navigation. HEAD responses have no body. No assets binding, public files, external scripts, forms, redirect handler or catch-all application route exists. Responses include no-store, HSTS, no-referrer, nosniff, frame denial, robots restrictions and a restrictive CSP permitting only the exact bundled CSS hash. HTML does not interpolate request/token/identity values. The destination is validated, HTML-escaped and rendered only after authentication; no automatic redirect exists.

No runtime dependencies, paid dependencies, storage, service bindings, outbound mail or production data access are introduced. Runtime network use is limited to issuer JWKS. Diagnostics never log tokens, identities, upstream bodies or exception details.

## Exact future approvals and setup gates

These are future actions, **not authorized or performed by this offline task**:

1. Owner reviews the final page, the fixed CMS destination, and the **already confirmed protected Mail Desk HTTPS URL** (including its path), now stored as `MAIL_DESK_URL`. The Mail Desk still independently enforces Access/MFA; this task does not change it. The target URL contains no credentials, query or fragment. A future destination change needs explicit owner review.
2. Owner approves a separate Worker name/account and a new dedicated launchpad hostname. Approve any required DNS/custom-domain binding specifically for that hostname; do not reuse or alter the website or Mail Desk routes. Set `APP_ORIGIN` to its exact HTTPS origin with no trailing slash.
3. Owner approves creation of a distinct Cloudflare Access self-hosted application covering **the entire launchpad hostname and every path**, with an allow policy for the exact owner identity only. No bypass, Everyone, editor-group or service-token policy. Review session length and identity/MFA policy. Obtain this application's audience and the exact team issuer from approved Access settings; a Mail Desk audience must not be reused accidentally.
4. Owner approves supplying `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and `APP_ORIGIN` for this separate Worker, reviews the pinned `MAIL_DESK_URL`, and provisions `OWNER_EMAIL` privately as a Worker secret binding. Never put the real owner email, an Access JWT, a signing secret or credentials in source, plaintext config, fixtures, logs or HTML. Access signs tokens; this verifier needs only public JWKS, no JWT secret. Local private bindings, if needed later, belong in ignored `.dev.vars`.
5. Review the concrete final config and independently approve deployment of **this Worker only**, with Access in place before its hostname is reachable. Keep `workers_dev = false` and `preview_urls = false`; do not enable Git integration/preview builds or attach static assets. No routes or domains are currently configured. Account-specific routing, Access, secrets, DNS and deployment need separate explicit approvals; no root project command should be used to deploy this folder.
6. Approve a post-deployment acceptance check using the real owner and a nonowner test identity: owner GET/HEAD succeeds, logged-out/editor/wrong-app JWT fails, every asset/unknown path remains protected, both existing destination logins work, no alternate preview/workers.dev route exists, and no cache serves private HTML. Unit tests and dry-run bundling do not prove live Access policy, hostname routing, destination correctness or workerd operation. On any failure, disable only the launchpad route/Worker under an approved rollback; leave the site and Mail Desk unchanged.

## Offline validation evidence

Node `v22.22.1`, Wrangler `4.151.0`. All 58 synthetic Node subtests passed with generated local RSA keys, fixed synthetic clocks/identities and injected JWKS fetch only. Coverage includes valid owner GET/HEAD, string/array audience, invalid/unsigned/tampered/forged tokens, issuer/audience/email mismatches, mandatory temporal claims, key rotation, malformed and incompatible whole JWKS sets, duplicate keys, weak keys, HTTP/redirect/network/JSON/size/deadline failures, stale-key denial, rotation retry throttling, asset/unknown paths, origin/method restrictions, absent/unsafe config, reflected-XSS attempts, safe HTML destinations and exact CSS/CSP hash consistency.

Commands from the repository root:

```sh
npm test --prefix owner-launchpad
npm run check --prefix owner-launchpad
(cd owner-launchpad && \
  WRANGLER_LOG_PATH=/tmp/bss-owner-launchpad-wrangler.log CLOUDFLARE_SEND_METRICS=false \
  /home/greg/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler deploy \
  --dry-run --config wrangler.toml --outdir /tmp/bss-owner-launchpad-dryrun)
git diff --check
```

The absolute Wrangler path uses an already cached local executable; it does not install dependencies. In another environment use an approved locally installed Wrangler 4 executable with the same **dry-run** flags. The final dry-run passed without warnings: 10.72 KiB upload / 4.11 KiB gzip, four empty placeholder variable bindings, and `--dry-run: exiting now`. Invoke Wrangler from this folder as shown to resolve its standalone TypeScript config correctly. Syntax checks cover both modules and the test file. Tests explicitly disable Node process isolation so individual assertions are reported in this environment. The standalone TypeScript config prevents the dry-run bundle from inheriting Astro configuration. Wrangler's log path is redirected to writable `/tmp`; no account action is needed. Local TAP evidence is `/tmp/bss-owner-launchpad-tests.tap`. No normal deploy command was run.

Official references reviewed: [Cloudflare Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), and [preview URL opt-in behavior](https://developers.cloudflare.com/changelog/post/2025-09-17-update-preview-url-setting/). No owner service was contacted.
