# Task 12.1 — Owner invitation controls candidate (SOURCE ONLY)

Status: draft implementation, not deployed or Owner accepted. Retain existing Task #11 request queue, Task 12.0 Owner OTP+MFA sign-in, and Task 12.UI design. Do not touch production.

## Scope

- The existing protected `/app/manage` is unchanged unless `PORTAL_OWNER_CONTROLS=enabled-12-1` is explicitly provisioned on the approved Members Staging Worker.
- With the flag on and Phase 2 D1 migration applied, the D1-authorized Owner may create a **pending** member record for an already approved recipient; issue/reissue a **blocked invitation draft**; cancel a pending invitation; and review members and immutable audit activity.
- A draft invitation is **not claimable or deliverable**. A generated secret is deliberately not sent or shown; secure one-use claims/owner-copyable links are Task 12.2. No provider identity is bound, account activated, service grant issued, or email sent by these controls.
- The existing Task #11 membership-request queue continues to be accessed through the Owner Launchpad link; no duplicate queue or automatic approval.
- Cancellation uses existing invitation transition/audit triggers. Reissue uses existing repository revision and supersession guards.
- POST actions use the verified current OTP session and live Owner D1 role; exact same-origin POST and Fetch Metadata, HttpOnly Secure SameSite cookie + double-submit, and a single-use SHA-256 D1 nonce bound to the signed Access JWT and Owner ID. CSRF records are automatically purged after expiry; immutable membership/audit history remains intact. No new services or paid infrastructure.

## Release gates — DO NOT run without Owner approval

1. Validate source and local isolated D1 tests plus independent security review; resolve all blocking issues.
2. Back up the existing Phase 2 D1 and demonstrate restoration. Verify live schema, effective staging Worker/version, Access OTP+MFA, settings/secrets, and one active Owner.
3. Apply **only** `portal/migrations/0002-owner-action-nonces.sql` to the existing dedicated Phase 2 staging D1 after authorization. Never apply this to Task #11 request queue, owner launchpad, or production D1.
4. Deploy reviewed version to existing protected Members Staging Worker, initially with flag **off**. Verify `/app` and read-only `/app/manage` behave as before; no D1 member/invite/grant changes.
5. Enable `PORTAL_OWNER_CONTROLS=enabled-12-1` only after explicitly approved rollout. Test role-denial and CSRF with synthetic test data first. Do **not** issue real invitations or create real members without additional Owner action.
6. Owner confirms desktop and mobile portal behavior and explicitly accepts Task 12.1 before marking complete. Tasks 12.2–12.5 remain future.

Rollback: disable `PORTAL_OWNER_CONTROLS` to restore read-only controls without a rollback migration. Prior Worker version remains available. Do not delete persisted membership/audit history.

Open acceptance: independent source review, CI/local tests, controlled staging release, on-device verification, and Owner acceptance.
