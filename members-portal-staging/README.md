# Big Sox Studios Members Portal — staging Worker

This directory contains the Phase 1 dashboard for the existing, isolated Cloudflare Worker `big-sox-studios-members-staging`. It is independent of the production Astro website and `big-sox-studios` Worker. Do not add this directory to the production website build or change the root `wrangler.toml` to deploy it.

## Current deployment topology

- Custom hostname: `https://members-staging.bigsoxstudios.com`
- Worker URL: `https://big-sox-studios-members-staging.fridman-greg.workers.dev`
- Both URLs already have owner-only Cloudflare Access protection. The hostname app and Worker app have separate audience tags.
- Deploy `worker.mjs` only into the existing staging Worker's `worker.js` editor or via a deployment command explicitly naming `big-sox-studios-members-staging`. Leave Access, MFA, DNS, production website, and CMS configuration unchanged.

## Security

Every request verifies the `Cf-Access-Jwt-Assertion` JWT server-side using Cloudflare Access public signing keys and Web Crypto RS256. Verification checks the signature, exact issuer, per-hostname audience, issue and expiry times, and email claim. Unknown hosts, missing or invalid tokens, and unavailable signing keys fail closed. There is no public API or public data route. HTML carries the signed-in email only after verification, with HTML escaping and no-store response headers. No database, service connections, secrets, status polling, or member grants exist in Phase 1.

The dashboard labels Jellyfin, Palworld, and other services as unconnected or planned. It does not claim service entitlement, live uptime, or a role. Future membership data and role or grant enforcement must come from a separate private, server-side store keyed to verified provider identity, with explicit owner approval.

## Local checks

Run `node --check members-portal-staging/worker.mjs` and `node --test members-portal-staging/worker.test.mjs` from the repository root. The tests create an RSA signing key and mock Cloudflare's JWKS response; they do not access member accounts or private services.

## Staging acceptance

After deployment, use a fresh session to test the custom hostname and Worker URL, Google and email-code sign-in, independent MFA, unapproved identity denial, mobile and desktop layout, and direct requests to unknown paths and methods. Browser session reuse can hide an MFA prompt, so a prior successful MFA test should be recorded separately rather than inferred from a warm session. Do not promote to production without owner approval and a separate rollout plan.
