# Production first-Owner enrollment — source-only candidate

November 24, 2026. This change implements a production-specific composition of
the existing staging browser enrollment flow. No deployment, push, Git commit,
secret inspection, account change, live enrollment, provider send or remote D1
operation is part of this task. Existing schema/migrations are unchanged.

`members-portal-production/production-owner-enrollment-entry.mjs` mounts only
`/owner/enroll` in addition to the existing production Member worker. The
original `production-otp-release-entry.mjs` still has no enrollment route. The
Wrangler example still selects that original entrypoint, has no public route,
and keeps production and enrollment disabled. Nothing in this candidate
establishes release approval or browser acceptance.

## Configuration contract

`portal/production-boundary.mjs` shares the existing production Member binding
guard without changing its behavior. Enrollment additionally pins the exact
non-secret values already present in the production example:

| Boundary | Required value |
| --- | --- |
| Origin / forwarded Host | `https://members.bigsoxstudios.com` / `members.bigsoxstudios.com` |
| Issuer | `https://old-hill-995d.cloudflareaccess.com` |
| Exclusive Members audience | `3bb9e98e55d2950a5f6630460f9f9b4e558eab58582497be3e806bf129a9c6c4` |
| Members DB identifiers | `613c9c18-69f9-4cf4-b7b1-afb0de49bd6d` for both `APPROVED_MEMBER_DB_ID` and `BOOTSTRAP_DATABASE_ID` |
| Requests DB identifier | `21e13fa1-0ab3-4573-8d20-983c847ba0e9`; distinct binding object, never queried by enrollment |
| Source revision label | `task12-production-first-owner-20261124-v1` |

The production binding guard still requires the separate Owner audience,
single custom hostname, both distinct D1 binding objects, and all reviewed
Member assembly/UI flags. Enrollment requires all of:

- `PORTAL_PRODUCTION_MODE=reviewed-production-12` (existing release gate).
- `PORTAL_MODE=production-enrollment-source` (production-only bootstrap mode).
- `PORTAL_OWNER_ENROLLMENT=reviewed-production-first-owner-12` (separate gate).
- Server-provisioned `OWNER_ENROLLMENT_EMAIL`: the exact separately approved OTP
  subject; no recipient default, normalization, inference from login, or browser
  input. A diagnostic email binding cannot substitute for this target.
- `OWNER_ENROLLMENT_HMAC_KEY`: canonical base64url encoding of exactly 32 bytes,
  imported as a nonextractable HMAC SHA-256 key; distinct from Access keys.
- `OWNER_ENROLLMENT_NONCE`: stable, unique 32–128 character URL-safe value for
  this reviewed enrollment context. No generated fallback.

No actual email/key/nonce is included. Provisioning is future, separately
authorized work through encrypted bindings. Declaration checks cannot prove
the physical D1 binding; independent release readback remains required.
Missing/wrong configuration returns private no-store 503 before database access;
wrong origins, hosts and unknown paths return 404. Authentication and browser
validation failures return 403 without an enrollment write. Staging/offline
bootstrap modes explicitly refuse the production origin.

## Browser and database behavior

GET authenticates the signed Access JWT, exclusive production audience, exact
signed/runtime/target email and trusted `ctx.access` with `onetimepin` provider.
It requires JWT issuance within the preceding 300 seconds and an unexpired
session. It reads only and issues the existing five-minute, session/context-bound
HMAC ticket plus random Secure HttpOnly SameSite Strict `__Host-` cookie.
The form uses `Referrer-Policy: same-origin` so a normal browser confirmation
can send its exact Origin. Cloudflare continues to manage MFA; JWT issuance age
and OTP verification do not independently attest an MFA challenge or policy.

POST requires the explicit confirmation decision, exact production Origin
(absent/null/foreign Origin denied), no explicit cross-site metadata, bounded
URL-encoded form, valid HMAC ticket and a single matching cookie. It repeats
authentication, exact identity, context, freshness and pristine checks. Staging
retains its existing missing-Origin compatibility and signed session lifetime.

The Members schema plus bootstrap migration 0001 and migrations 0003–0007
must already exist; 0002 is represented in the base schema. Enrollment runs
no migration or schema repair. Every application table must be empty, including
nonce, onboarding, welcome, reconciliation and withdrawal-hold tables. Missing
tables or query errors deny enrollment. Extra-table emptiness is repeated inside
the receipt INSERT, while the existing bootstrap trigger repeats core-table
emptiness under the same SQLite write lock. The existing triggers atomically
create one singleton receipt, active Owner, exact OTP binding and immutable
audit; failure rolls the statement back. No service grants, invitations,
welcome records or Requests writes are created. Receipt expiry is bounded by
JWT expiry, JWT issue time plus 300 seconds, and browser-ticket expiry.
The production INSERT checks SQLite's execution-time clock against the receipt
start/deadline as well, denying expired proof delayed in transit and a database
clock earlier than the prepared receipt time. These refusals require inspection.

Receipt digests retain the existing
[bootstrap contract](TASK12_FIRST_OWNER_BOOTSTRAP.md). Revision, nonce, signed
session and all production boundaries are bound to the ticket context. After
the write, receipt/Owner/identity/audit readback is mandatory. Any commit-stage
error returns 503 with “operator inspection” and “Do not retry”; there is no
automatic retry. Existing people, revoked Owners, concurrent confirmations and
replays cannot bootstrap another Owner. Enrollment gates/key can be retired
without affecting the separately gated dashboard; D1 revocation still denies
each subsequent login.

## Local validation

The production suite uses synthetic signed JWTs, synthetic HMAC values and
`:memory:` SQLite with the actual schema/triggers. Public signing-key fetches
are stubbed; Requests DB methods throw if touched. It creates no D1 instance or
persistent database. Tests cover read-only GET/login, disabled/mismatched
configuration, identity/provider/host/audience/freshness rejection, strict CSRF,
changed context/session/key, exact enrollment, immutable receipt/audit/binding,
zero grants, replay/restart/revocation, missing/nonpristine schema, a post-check
nonce-table race, trigger rollback, concurrent confirmations and lost readback.
Deadline tests advance a deterministic database clock after the application's
last check and also verify successful enrollment with SQLite's native clock.

Commands use the already installed Node 24.22.0 binary at
`/tmp/bss-step4-tools/node_modules/node/bin/node`:

```sh
node --test --experimental-test-isolation=none members-portal-production/*.test.mjs
node --test --experimental-test-isolation=none portal/first-owner-bootstrap.test.mjs portal/first-owner-enrollment.test.mjs members-portal-staging/owner-staging-release.test.mjs
node node_modules/eslint/bin/eslint.js .
git diff --check
```

Production tests: **20/20 passed**. Focused shared/staging regressions:
**31/31 passed**. Repository ESLint passed. Existing staging tests need local
loopback sockets for disposable Miniflare fixtures; they passed after rerunning
outside the socket-restricted sandbox. No remote D1 is involved.

Future production work still requires independent review, exact Owner/database
approval, effective Access OTP/MFA policy verification, real binding/schema
readback, preserved Worker rollback version, protected routing, authorized
browser confirmation and immutable receipt readback. This source change clears
the missing implementation only; it does not clear those operational gates.
