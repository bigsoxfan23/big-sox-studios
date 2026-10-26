# Disconnected first-Owner bootstrap source

`portal/first-owner-bootstrap.mjs` is a source-only factory, with no default export,
CLI, deployment configuration, or production evidence adapter. The default mode
remains offline. A separately disabled source-only browser confirmation wrapper
now uses its explicit `staging-enrollment-source` mode; see
[the enrollment page and approval gates](TASK12_FIRST_OWNER_ENROLLMENT.md).
No deployed entrypoint imports it. Existing login, invitations, linking, service grants, and
revocation behavior are unchanged. Development authorization does not approve
production bootstrap, migration, integration, or deployment.

The factory reuses `createOtpAuthenticator`: signature, exact issuer, exclusive
members audience, custom host, token expiry, exact JWT/runtime email agreement,
and trusted runtime `idp.type === 'onetimepin'` are required on this request.
Recipient comparison preserves the exact OTP email namespace; there is no email
lookup, normalization, promotion, upsert, or Google/Apple binding fallback.

The caller supplies a trusted immutable target containing the explicit recipient,
role `owner`, database ID, reviewed source revision, and random nonce of at least
32 URL-safe characters. The bound DB identifier must match configuration. This
label is an offline assertion; a future production adapter must independently
verify the actual binding/database identity and approved schema, rather than
trust a label supplied by the browser or an environment flag.

Two separate trusted server callbacks are mandatory:

- `verifyPolicy(challenge)` verifies real effective policy readback, independent
  MFA enforcement on this OTP route, and the runtime OTP identity shape.
- `verifyOwnerApproval(challenge)` verifies exactly one independent explicit
  decision to approve this first Owner, including the exact policy digest.

Both attestations must bind `contextDigest`, the SHA-256 digest of the fixed JSON
challenge. That challenge includes the exact verified OTP identity and runtime
type, role, issuer, exclusive audience, host origin, database, source revision,
nonce, and SHA-256 digest of this exact verified Access JWT. A different session,
target, revision, nonce, or policy invalidates approval. Email OTP itself is never
independent MFA. Source labels and booleans are callback output contracts, not
cryptographic verification. No live verifier is implemented or implied here.
Production callbacks must verify external signatures, allowed signers/algorithms,
audience, expiry and revocation, independent approval provenance and effective
policy evidence; they must never manufacture approval by signing a challenge on
demand. Browser input, general development permission, an existing Google login,
and a purported `mfaVerified` claim cannot supply either attestation.

Evidence is copied and frozen across awaits. Both attestations have at most
300 seconds of validity, reject future dates, and must remain fresh with the
same JWT after the D1 preflight, immediately before dispatching the write.
Expiry is checked at dispatch; this is not a database wall-clock enforcement
guarantee during an arbitrarily delayed write. A production design must review
and bound that interval and revalidate live evidence immediately before commit.

The default invocation is read-only. An explicit `{commit:true}` is required for
the offline write. Dry-run returns only readiness and an opaque context digest;
it does not return contact, session tokens or raw attestations. Never log raw
requests, callback inputs, evidence or private approval details.

`portal/migrations/0001-first-owner-bootstrap.sql` extends `portal/schema.sql`.
Apply both only to synthetic ephemeral D1 during development. The migration adds
a singleton permanent receipt and triggers. One INSERT checks every existing
portal data table is empty, then creates the active Owner, exact OTP identity,
and immutable audit event in the same SQLite statement. Any failure rolls back
all four records. The receipt retains session/context/policy/approval digests,
approval audit reference, target database/revision, nonce and timestamps. The
member and identity retain the exact OTP subject as normal private identity data.
No raw JWT or attestation is persisted. Receipt and audit cannot be updated or
deleted; INSERT OR REPLACE cannot reset the receipt. Revocation, fresh nonces,
new sessions and process restarts do not reopen bootstrap. This guarantees one
successful first-Owner bootstrap, without changing later role management.

Concurrent attempts are serialized by D1 and the SQL pristine-state guard; the
read-only preflight is advisory, never the concurrency boundary. Commit reads
back the intended Owner, identity and audit. Readback failure may follow a
successful commit: stop and inspect the receipt, never retry blindly. D1 outages
fail closed. This factory does not defend against an administrator dropping its
tables/triggers or writing arbitrary SQL with privileged database credentials.

## Production approval gate

Production remains blocked pending independent security review of the exact
revision, separately authorized runtime OTP field proof on the final custom host,
real effective policy readback including overrides/bypasses and independent MFA
enforcement, and reviewed external attestation/approval verifiers. Verify exact
bindings, fresh schema, backups, retention, rollback/rehearsal, all routes and
preview restrictions, then conduct a sanitized dry-run against the specifically
authorized fresh database. A separate explicit Owner decision must name the
recipient, Owner role, database, host, source revision, nonce, same verified
session and exact policy digest. Present the concrete dry-run for approval before
any production migration or write. No approval is inferred from this task.

After separately approved execution, verify retained receipt and audit, remove
write capability, and complete final production acceptance tests. Integration,
live imports, database access and deployment require separate authorization.
The broader launch gate in `TASK12_OTP_OWNER_FOUNDATION.md` still applies.

## Local validation

Use Node 24.22.x and the repository dependencies:

```sh
node --test --experimental-test-isolation=none portal/*.test.mjs
npm run lint
```

Tests use synthetic signatures and ephemeral Miniflare D1. They cover independent
evidence failures, wrong identities and sessions, expiry across awaits, dry-run,
immutable history, replay after revocation, rollback, eight concurrent writers,
preflight/write races and ambiguous readback. These are offline guarantees only.

Validation on 2026-10-25: all 144 portal tests passed, including seven bootstrap
tests; lint and the local Astro build passed. The broader regression run passed
1,898 of 1,900 tests. Both failures reproduced unchanged in an untouched archive
of HEAD `20dd8cc64e1b953395e59315cad8222d24c1d9d3`: Mail Desk's
`customer review rejects stored subject NUL suffix` and Owner Canary's
`all tracked baseline files match exact base Git blob manifest` (the existing
`.github/workflows/validate.yml` hash differs from its historical manifest).
No unrelated source was changed to accommodate those baseline failures.
