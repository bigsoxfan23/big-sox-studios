# Task #12 — Member dashboard staging slice (source-only)

> Updated 2026-10-26: the additional custom MFA policy attestation and separate
> approval adapter requirements below are superseded by the approved
> [Cloudflare MFA reliance and browser confirmation flow](TASK12_FIRST_OWNER_ENROLLMENT.md).
> Cloudflare MFA remains configured; the source-only dashboard uses signed
> Access OTP identity and live D1. Historical implementation details follow.


**Status: implemented offline; not deployed or activated.** The existing approved Phase 1 staging homepage (`/`) and protected owner diagnostic (`/owner/identity-check`) remain unchanged. Source reserves the private `/app` path for the existing D1-backed `createMemberDashboard` with `mountPath:'/app'`. `members-portal-staging/dashboard-assembly.mjs` now supplies a source-only composition pinned to the existing custom host, issuer and members audience. Its default also lacks an activation verifier. The documented `wrangler.dashboard.example.toml` keeps the disabled entrypoint and placeholder metadata for the already-existing Phase2 D1; it is not a release config or permission to create a database.

The deployed default `createStagingWorker()` has no member application adapter. It responds 503 to `/app` while prohibiting direct workers.dev, unrecognized hosts and insecure protocols; environmental feature flags cannot activate the route. No invitation issue/claim, Owner bootstrap or D1 write routes are exposed.

**Local synthetic test proof:** a trusted (source-injected) member app with signed Access JWT verification, exact verified Cloudflare OTP context, explicit independent policy/Owner approval adapter and ephemeral D1 shows `/app` with the fresh D1 Owner role. Google same-email sessions, wrong audience/host, uninvited or revoked members, missing D1, a missing activation verifier, ungranted direct service URLs and incorrect Owner roles deny. No default login auto-creates an account. This is source testing only; synthetic policy inputs are not accepted as production MFA proof.

**Remaining vertical-slice work before real login:** after explicit Greg approval, (1) back up/rehearse the existing dedicated Phase 2 D1 and apply reviewed additive first-Owner migration; (2) wire a *reviewed server-side* independent effective MFA/approval attestation adapter and the exact D1 binding into the correct protected Worker application, never an env-flag shortcut; (3) run read-only bootstrap preflight against exact signed OTP subject and then obtain Greg's separate approval for exactly one Owner record; (4) commit atomically and read back Owner record/immutable identity/audit; (5) switch staging Worker to reviewed real app assembly, confirm Safari/Desktop Owner dashboard, denied uninvited and revoked sessions, and rollback procedure. Live P1–P6 production acceptance and invitations are later milestones.

**No changes to Task #11, #26, #28, public website or Mail Desk.** This is a small home-project interface slice, not an additional auth system.
