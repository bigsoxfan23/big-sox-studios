# Operations, retention and rollback

## Current state

Local code only. Do not run deployment, provision resources, activate routes, add credentials or change host services as part of Task #9. Tests create only in-memory SQLite databases. The synthetic intake helper is import-only and is not a production ingestion adapter. No scheduled task or automatic sync runner is registered.

## Future manual acceptance gates

1. Owner reviews this diff and security behavior, and separately authorizes staging configuration. Create an independent Cloudflare Access application for the future private mail host, exact owner allow policy and required custom MFA; verify denial for other identities and bypass paths. Do not alter existing applications.
2. Dedicated staging D1 was authorized and provisioned October 14, 2026: bss-mail-desk-staging (ID 6595c7ed-cbdb-4d8d-8f89-fc8b87f68860). Apply the reviewed migration ONLY to this database, configure exact issuer/audience/owner/HTTPS origin, and provision an independent random CSRF secret as a secret binding after separate credential/access review. Confirm workers.dev/preview bypasses remain disabled and assets always traverse the Worker. Keep SEND_MODE=mock and Notion off. No production routes/DNS for this task.
3. Run authenticated Cloudflare/D1 acceptance, concurrency and failure checks against synthetic data, inspect cache/CSP headers and cookies, test refresh/expiry, and inspect mobile layouts at 390px plus desktop and keyboard/screen-reader behavior. Local SQLite tests do not prove Cloudflare deployment behavior.
4. **OWNER PRIVACY PERMISSION AUDIT** must explicitly authorize any future Notion access. Audit existing property types and accepted views/lifecycle before implementing live sync. Assigned To may require an existing person ID rather than the dry-run select representation. Share only the existing ticket source under the approved policy; never create another ticket database, alter old records, write Reference/Notion Sequence or replace the existing activity service. A future token belongs only in a secret binding.
5. Tasks #10/#11 own inbound route/domain activation, sender verification, real provider wiring and any separate authorization for acknowledgements. Live send needs a reviewed code change to a future entry point, independent enable flags, secrets, provider acceptance and owner approval. Flags alone never activate this staging Worker.

## Delivery and recovery

`reserved → dispatching → sent | failed | UNKNOWN`. A unique `(case_id, revision)` prevents duplicate reservation; a compare-and-set allows one dispatch. D1 batch atomically records sent status, outbound message, audit and pending delivery sync job. A separate case-created sync job is enqueued at synthetic intake. Sync never invokes a provider or changes delivery state.

An interrupted dispatch remains dispatching. After a conservative five-minute window, the import-only `recoverUncertain(db)` helper marks stale dispatching UNKNOWN. It does not execute automatically. Never automatically change UNKNOWN/dispatching to reserved, generate a replacement intent to evade the lock, or infer failure from a missing provider response. A future owner-run reconciliation must inspect provider evidence by intent UUID and preserve an audit trail before deciding the outcome; no reconciliation UI or resend API is included.

`runMockSync` is off unless explicitly called with NOTION_SYNC_MODE=mock. It claims at most ten due jobs, uses five-minute leases, recovers expired synthetic leases, retries failures at 30/60/120/240 seconds, and marks the fifth failure dead. Jobs are independent of sending. `case_created` and `delivery_sent` are separate job kinds; the mapper is an initial-case dry-run preview, not a live update routine. A real implementation must handle create ambiguity, external-ID uniqueness, page linkage and safe lifecycle-preserving delivery updates under separate authorization.

## Retention policy proposal (not enabled)

Keep synthetic staging data only for review, then delete the isolated staging database after owner authorization. For future real data, owner approval must establish retention periods, backups, access and deletion procedures. Proposed defaults for review: rate buckets after expiry, audit events for 90 days, closed case message/draft PII for 90 days. Indexes support queue/thread retrieval, audit expiry, dispatch recovery, sync scheduling and rate cleanup.

Never independently expire inbound dedupe keys or outbound intent UUID/revision/status records: deleting these permits replay or duplicate sends. If PII is purged, preserve non-PII tombstones and suppression/terminal states, and ensure an old approval cannot become usable again. Current foreign keys prevent casual case deletion while child records exist. No automatic destructive retention job exists. `audit_events` intentionally has no cascading case FK so audit history survives a future authorized redaction. No raw JWT or cookie is stored; session_hash is a SHA-256 binding.

## Rollback

This build has no side effects to reverse. For a future authorized staging installation: first disable the isolated mail desk Access application/routing and all dispatch paths, preserve a secure D1 backup including dedupe and intent tombstones, then restore the prior isolated Worker version if one exists. Do not drop or roll back schema while sends are in flight. Classify stale dispatches UNKNOWN and reconcile offline before any restart. Leave all existing website/CMS/portal services, Notion sources, Reference allocation and activity logging untouched. Never roll delivery state back from sent to pending. Retain backups and private data only under the owner's approved policy.
