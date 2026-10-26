# First Owner receipt contract

The approved 2026-10-26 simplification replaces custom MFA attestation and
independent approval callbacks with Cloudflare-managed MFA reliance and one
browser confirmation. Follow [the enrollment flow and staging prerequisites](TASK12_FIRST_OWNER_ENROLLMENT.md).

`portal/first-owner-bootstrap.mjs` remains a trusted internal source helper.
Its default operation is read-only. Only the enrollment POST handler supplies
commit arguments after validating the browser ticket, cookie and CSRF checks.
Do not expose the helper as a request endpoint or fabricate browser evidence.
The helper rechecks exact OTP identity, target, DB identifier, JWT freshness,
confirmation context/deadline and pristine state. The existing single INSERT
and triggers preserve atomicity and singleton/immutable receipt semantics.
No schema or migration change is needed.

Digest encodings are lowercase SHA-256 hex over UTF-8. Structured input uses
`JSON.stringify` in the field order shown in source:

- `session_digest`: the actual signed Access JWT (raw JWT is never persisted).
- `context_digest`: the exact provider/subject/runtime type/role, issuer,
  audience, origin, DB ID, reviewed revision, nonce and session digest.
- Legacy column `policy_digest`: `{source:'cloudflare-managed-mfa-reliance',
  contextDigest}`. This records reliance on the configured Access MFA. It does
  not claim an independently verified policy, independent MFA evidence, API
  readback or policy enforcement attestation.
- Legacy column `approval_digest`: `{source:'browser-confirmation',
  decision:'confirm-first-owner',contextDigest,policyDigest,browserTicketDigest}`.
  `browserTicketDigest` hashes the exact HMAC ticket accepted on POST. No Owner
  approval receipt is inserted on GET.
- `approval_audit_id`: `browser-` followed by that ticket digest, identifying the
  same browser decision in the existing immutable audit trigger.
- `at`/`expires_at`: commit preparation time and the earliest of JWT expiry,
  JWT issue time plus five minutes, and ticket expiry.

These digests are integrity/context records, not synthetic proofs presented as
real checks. Receipt readback is required after the write. Any ambiguous commit
outcome requires operator inspection, not an automatic retry. Existing people,
including revoked Owners, cannot be promoted through bootstrap.

Local tests use signed synthetic JWTs and ephemeral Miniflare D1 only. They cover
read-only GET/login, confirmation POST, trigger rollback and singleton races,
replay across restart, missing key/target/DB, wrong host/issuer/audience/provider,
exact email binding, CSRF, session/ticket expiry across awaits, receipt meanings,
and live dashboard roles/grants/revocation. They do not establish real Access
MFA enforcement or constitute an actual Owner enrollment.
