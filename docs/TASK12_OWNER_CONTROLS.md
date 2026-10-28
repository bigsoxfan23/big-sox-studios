# Task 12.1 — Owner Controls (IN PROGRESS)

This increment is a safe, read-only Owner management page at /app/manage.

- Reuses live signed Cloudflare Access OTP+MFA and Phase2 D1 authorization on every request.
- Lists members, latest invitation status and recent audit history, bounded with explicit size limits; no email/PII to logs.
- Links to the existing Task #11 membership request queue in the protected Owner Launchpad rather than copying data from a second database.
- Owner-only; revoked/non-owner identities denied. No forms, POST actions, automatic invites or grants. No new paid services or schema.
- Next: reviewed CSRF-safe invite create/reissue/cancel actions and claim links; permissions and revocation remain Tasks 12.2–12.4.
- Keep Task 12.1 OPEN until full controls and real Owner acceptance.
