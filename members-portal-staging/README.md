# Big Sox Studios Members Portal — staging Worker

This directory contains the Phase 1 dashboard for the existing, isolated Cloudflare Worker `big-sox-studios-members-staging`. It is independent of the production Astro website and `big-sox-studios` Worker. Do not add this directory to the production website build or change the root `wrangler.toml` to deploy it.

## Current deployment topology

- Custom hostname: `https://members-staging.bigsoxstudios.com`
- Worker URL: `https://big-sox-studios-members-staging.fridman-greg.workers.dev`
- Both URLs already have owner-only Cloudflare Access protection. The hostname app and Worker app have separate audience tags.
- Release only through the separately reviewed version upload/deploy procedure below, explicitly naming `big-sox-studios-members-staging`. Leave Access, MFA, DNS, production website, and CMS configuration unchanged.

## Security

Every request verifies the `Cf-Access-Jwt-Assertion` JWT server-side using Cloudflare Access public signing keys and Web Crypto RS256. Verification checks the signature, exact issuer, per-hostname audience, issue and expiry times, and email claim. Unknown hosts, missing or invalid tokens, and unavailable signing keys fail closed. There is no public API or public data route. HTML carries the signed-in email only after verification, with HTML escaping and no-store response headers. No database, service connections, secrets, status polling, or member grants exist in Phase 1.

The dashboard labels Jellyfin, Palworld, and other services as unconnected or planned. It does not claim service entitlement, live uptime, or a role. Future membership data and role or grant enforcement must come from a separate private, server-side store keyed to verified provider identity, with explicit owner approval.

## Local checks

Run `node --check members-portal-staging/worker.mjs` and `node --test members-portal-staging/worker.test.mjs` from the repository root. The tests create an RSA signing key and mock Cloudflare's JWKS response; they do not access member accounts or private services.

## Staging acceptance

After deployment, use a fresh session to test the custom hostname and Worker URL, Google and email-code sign-in, independent MFA, unapproved identity denial, mobile and desktop layout, and direct requests to unknown paths and methods. Browser session reuse can hide an MFA prompt, so a prior successful MFA test should be recorded separately rather than inferred from a warm session. Do not promote to production without owner approval and a separate rollout plan.

## Task12 owner identity field diagnostic (review only; not deployed)

The only diagnostic URL is `https://members-staging.bigsoxstudios.com/owner/identity-check` (GET without a query). It rejects workers.dev, unknown or mismatched Host, HTTP, nonstandard ports, queries and other methods. It requires the original RS256 verification plus an exact single-element custom-host audience, exact issuer and current timestamps without the homepage's clock allowance. The original homepage renderer and authentication behavior are preserved.

`DIAGNOSTIC_OWNER_EMAIL` has **no default**. Absent/empty configuration returns 404. A signed JWT email must exactly match this separately configured owner allowlist. If Access context exists, `ctx.access.aud` must match the custom audience and `getIdentity()` must return the same owner email. This is a diagnostic allowlist only, never membership authorization, provisioning, D1 bootstrap, permission assignment or MFA evidence.

Only boolean values appear for `accessContextAvailable`, `idpTypePresent` (`identity.idp.type` is a nonempty string), `oidcSubjectPresent` (`identity.oidc_fields.sub` is a nonempty string), `amrArrayPresent` (`identity.amr` is an array, possibly empty), and `mfaEvidenceEstablished` (always false). These exact field probes are not claims of provider identity or MFA. Missing context or a thrown identity read returns HTTP 503 with “unavailable” and sanitized booleans; invalid context audience or mismatched/missing identity returns generic 403. No visitor cookie forwarding, manual get-identity request, external resources, scripts, identity logging or identity values are used on this path. Responses are no-store and noindex, including denials. The existing homepage still renders its original signed-in email, so only the diagnostic page is suitable for a privacy-safe screenshot.

Current Cloudflare documentation supports this context API: [Access on Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). Absence of a field does not establish that the provider lacks it; this narrowly reports these paths only. Do not change Access settings to make a missing context appear.

## Independent release procedure — existing staging Worker only

Nothing has been uploaded or deployed by this implementation task. Independent review must pass before the separate release operator proceeds. Never use the root Wrangler config, `wrangler deploy`, `triggers deploy`, preview aliases or a new script name for this release.

Read-only Wrangler inspection on 2026-10-24 found deployment `802af83b-fc71-4fe5-805b-7830120bbf0c` serving version `2eef3d26-4e1d-4b44-892a-b3640e2fb757` at 100%, compatibility date `2026-10-09`, no bindings. Read-only routing inspection found workers.dev enabled, preview URLs disabled, no zone routes, and the existing custom domain `members-staging.bigsoxstudios.com` attached to `big-sox-studios-members-staging`. `wrangler.staging.toml` records this topology; version upload/deploy must retain the existing triggers, DNS and both distinct Access applications unchanged. Re-read live metadata before release and stop if it differs until reviewed.

1. Review the commit and run the local checks below. Confirm the exact existing staging Worker, current version/runtime/bindings and routing with read-only inspection. Record the current version for rollback.
2. Securely prepare a mode-0600 JSON secrets file **outside the repository**, containing only `DIAGNOSTIC_OWNER_EMAIL` with the confirmed owner value. Do not print it, include it in command arguments, commit it, log it or put it in screenshots. The source config intentionally leaves this binding unset. Supplying the file with version upload associates the allowlist with the candidate version without activating it; do not use a live `wrangler secret put` as a prerequisite.
3. Upload the candidate only, with the staging config and the private file path (the following variable holds a path, never an email):
   ```sh
   wrangler versions upload --config members-portal-staging/wrangler.staging.toml --keep-vars --secrets-file "$STAGING_DIAGNOSTIC_SECRETS_FILE"
   ```
   This is an upload, not permission to deploy. Record the candidate version ID, verify the binding **name/type only**, unchanged runtime and routing, and remove the temporary private secrets file. Do not open or share a version preview URL.
4. The separately authorized release operator activates only the reviewed candidate:
   ```sh
   wrangler versions deploy <reviewed-candidate-version-id>@100% --config members-portal-staging/wrangler.staging.toml
   ```
   Re-read routing and runtime metadata. Stop if the release tool proposes route, DNS, Access, paid-resource or script changes. Rollback uses `versions deploy <recorded-previous-version-id>@100%` with this same config and separate release authorization.
5. Owner smoke check: sign in normally through the custom hostname, visit the diagnostic path without a query, and inspect/screenshot only that page. Confirm only booleans, with MFA false; HTTP 503/unavailable is an acceptable closed result requiring investigation, not an instruction to bypass Access. Confirm the original homepage, workers.dev homepage, direct diagnostic denial and unknown identity denial without copying credentials. Never share browser cookies/JWTs or screenshots of the original homepage's identity panel.

Release blockers: independent review, secure owner configuration on the candidate, live metadata recheck and owner smoke acceptance. Missing Access context remains a closed/unavailable result; do not add cookie forwarding or change policy to work around it. No production Task12 or owner D1 work is authorized.

Local verification (Node 24; use an existing local Wrangler installation, no package installation):

```sh
node --test members-portal-staging/worker.test.mjs
node --test --experimental-test-isolation=none members-portal-staging/worker.test.mjs
node --test --experimental-test-isolation=none portal/*.test.mjs
node --test --experimental-test-isolation=none tests/*.test.mjs membership-notify/test/*.test.mjs owner-launchpad/test/*.test.mjs
npm run validate
wrangler versions upload --config members-portal-staging/wrangler.staging.toml --dry-run --outdir /tmp/bss-task12-staging-dry-run
```

The tests use synthetic signed identities and mocked signing keys only. The homepage fixture hash was calculated from the exact upstream PR #15 renderer using the synthetic email. No live identity or token is needed for unit tests.
