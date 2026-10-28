# Task 12.UI — Big Sox Studios visual foundation

Presentation only, on the existing protected Members Staging Worker. Shared studio styles use actual public-site dark-theme palette and font stacks, and the published logo mark. No client-side scripts, analytics, tracking, third-party fonts, new frontend framework, D1 schema, services or expenses.

Implemented:
- Owner/member dashboard: branded heading, membership role/status, honest placeholder for unconnected services, sign out, Owner-only link to design preview.
- Protected /app/ui-preview: read-only illustration of invitation, welcome, member, Owner workspace, expired and unavailable states. NO invites, claims, grants or account changes. Owner role read live from D1 before each visit.
- First Owner enrollment confirmation, success and error screens share the studio shell, without changing form fields, signed OTP, five-minute HMAC ticket, same-origin referrer policy, or D1 writes.
- Existing no-store/noindex CSP updated only to permit trusted inline CSS and public brand mark image. Desktop/mobile responsive and keyboard-focus styling included.

Closeout gate: full tests, independent security review, GitHub PR/CI, protected staging canary, and explicit Owner desktop/iPhone visual acceptance. Do not check Task 12.UI done before visual approval. Functional invitations, grants and revocations belong to Task 12.1–12.4.
