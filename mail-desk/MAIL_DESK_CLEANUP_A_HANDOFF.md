# Mail Desk Cleanup A operator handoff

Implemented locally on `feature/mail-desk-cleanup-a`, based on `origin/main`
`960a92ea2625850bbc35a11824d59dfdf6506005`. Uncommitted; the migration correction
passed independent review. Broader release review and operator approval remain required. No deployment or external writes were
performed. No secrets were opened, email sent, or production D1/Notion/GitHub,
membership, or billing changed.

## Backup and local validation — PASS

Before implementation, verified the supplied artifacts in
`/home/greg/.local/share/big-sox-studios/verified-backups/mail-desk-cleanup-a-20261020`:

- SQL SHA-256 matches `verification.json`:
  `71a1876c0f550074eaa15403dc7482edfd99529934d6dbf8ec1556d8ce805e16`.
- Opened the restored rehearsal database read-only: integrity `ok`, zero FK
  violations, every recorded table count matched (including 8 cases, 13 messages,
  9 receipts, 3 outbound intents, and 2 reply review modes).
- Applied the complete 0006 migration to an in-memory copy of that restored
  database: integrity/FKs PASS, all prior table content fingerprints unchanged,
  8 Inbox sidecars created. On the disposable copy, an existing populated case
  was moved to Archive and restored to Inbox, then its draft/revision was updated
  successfully. Historical audit rows were retained; only two expected folder
  audit rows were added. Integrity and foreign_key_check passed after these real
  updates. The supplied backup files were not modified.
- `cd mail-desk && npm ci --ignore-scripts --no-audit --no-fund`: PASS.
- `cd mail-desk && npm test`: PASS, 805 tests, zero failures/skips.
- `cd mail-desk && npm run check`: PASS.
- `git diff --check`: PASS.

Tests use Node 22.22.1 `node:sqlite`, mock Notion, and injected offline delivery
transports. They cover Access/CSRF/session/origin protection, malformed/duplicate/
stale/concurrent/bulk folder requests, per-case partial outcomes, 25-item cap,
counts beyond the 100 displayed cases, immutable snapshots, real-mode signed
approvals with offline transport, trash send-claim rejection, Archive replies,
UNKNOWN preservation (including immutable 0004 reviews), genuine inbound reopen,
receipt retry suppression and transaction rollback, migration compatibility,
Notion retry/link uncertainty/leases/version races/reconciliation/route bounds/
deadline/credential shielding, mobile controls, selection, and injection.

Every fixture executes 0006 in full; no substring/split/slice migration loader
remains. Populated migration tests cover (A) 0001+0002+0003+0005 without 0004 and
(B) 0001+0002+0003+0004+0005, preserving every existing trigger definition.
The 0004 UNKNOWN regression verifies folder mutation and inbound reopen reject
atomically while cases, folder state, immutable reviews and audit rows survive.

Verified production migration state is **0001, 0002, 0003 only** in
`d1_migrations`, with the hand-applied 0005 `reply_review_modes` table present.
**0004 is ABSENT**, including `live_outbound_reviews` and `live_case_lock`.
The restored genuine backup has this same migration/schema state. Only the
corrected **0006** is safe for this release; do not run all pending migrations,
apply 0004, or reapply 0005. 0001–0005 remain byte-for-byte unchanged.

Correction evidence (local, no mail content):
`/tmp/maildesk-correction-rehearsal.py`,
`/tmp/maildesk-correction-rehearsal.json`,
`/tmp/maildesk-correction-live-migrations.json`,
`/tmp/maildesk-correction-tests.log`.
Production verification used SELECT statements only; both query results report
`rows_written: 0` and `changed_db: false`.

Independent migration-correction review: **PASS**, no blocking findings. The
reviewer independently checked unchanged 0001–0005, full migration loaders,
both schema histories, strict UNKNOWN rollback, the read-only live evidence and
operator guidance; reran all 161 folder/live-outbound tests, the genuine-backup
rehearsal, and `git diff --check` successfully. Evidence:
`/tmp/maildesk-independent-correction-tests.log` and
`/tmp/maildesk-independent-correction-rehearsal.json`.

Independent review's dormant-outbound Trash blocker is fixed locally; broader
release acceptance remains separate from the passing migration-correction review. `loadEligible` now requires 0006 folder
storage and an existing non-Trash sidecar. Atomic review reservation and both
reserved→approved / approved→dispatching transitions independently require the
linked non-Trash folder and current case revision. Eighteen new offline tests
cover Archive success, Trash denial with zero provider calls, Restore requiring
fresh approval, missing schema/sidecars, and folder changes at all three write
boundaries (including stale-revision fault injection). Immutable reviews remain
unchanged on denial. Existing suites remain enabled; only the candidate source
hash pin was updated, retaining production hard-block assertions. No production
entrypoint, activation gate, transport, migration, or production record changed.

Limitations: no live-service acceptance, new live backup/export, real browser
layout/screen-reader/device test, deployment, Notion schema provisioning, or real
email delivery was performed. The backup verification establishes the supplied
artifact's integrity and rehearsal results; it does not establish current live
D1 data freshness. The current migration/schema state was separately verified
read-only; this does not replace a fresh operator backup before release.

## Storage and behavior

Apply only `migrations/0006_case_folders.sql` to the verified 0001–0003 schema
with hand-applied 0005. 0004 is not a prerequisite. It adds
`case_folders` (FK, Inbox/Archive/Trash enum, optimistic version, timestamp and
revision invalidation marker) and `case_folder_sync` (acknowledged version,
retry/reconciliation time, short lease). No `cases` columns change, so positional
INSERT writers remain compatible. Existing cases start in Inbox; a trigger
initializes both sidecars for every newly inserted case.

Every actual folder transition atomically advances the folder version and case
revision and appends a folder audit event. Drafts, messages, immutable approval
snapshots, outbound states, receipt claims/deduplication keys, and historical
sync/audit rows are retained. 0006 neither drops nor creates `live_case_lock`
and never references `live_outbound_reviews`. Any existing strict 0004 lock
remains unchanged. On a hypothetical database with 0004 and an active UNKNOWN
review, folder transitions and inbound reopening that advance revision are
unsupported until manual delivery reconciliation; they fail closed atomically.
Do not weaken or drop that lock to enable folders. No retention, purge, message-level hide,
redact, or permanent deletion operation exists.

Archive applies to Inbox; Trash applies to Inbox/Archive; Restore returns
Archive/Trash to Inbox. Redundant/unsupported transitions are conflicts. Archive
permits a fresh manual reply review. Trash refuses draft/review/send, including
an independent not-trashed predicate in atomic `claimSend`. Transition revisions
make old signed reply approvals unusable even after Restore. A manual move is
refused while a send is dispatching. A simple-reply (0005) UNKNOWN can be moved
but remains locked against another send; a 0004 UNKNOWN rejects folder changes
until manual reconciliation as described above. No folder action invokes an email transport.

A NEW genuine email receipt linked by the existing exact-envelope thread rules
reopens Archive/Trash to Inbox in the receipt-claim D1 batch. A retry with the
same durable receipt key cannot reopen or forward again. Failure rolls back the
receipt/thread/folder changes together. Missing folder migration fails closed,
including intake, rather than accepting mail without folder tracking.

## HTTP and UI contract

- `GET /api/cases?folder=inbox|archive|trash` defaults to Inbox. Response:
  `{folder,cases,counts:{inbox,archive,trash}}`. Counts cover all cases; the list
  returns the newest 100 in that folder. Each row/detail includes `folder` and
  `folderVersion`. This changes the old list response from an array to an object;
  release matching assets and Worker together and refresh old tabs.
- `POST /api/cases/folder` body:
  `{"action":"archive|trash|restore","cases":[{"id":"UUID","version":0}]}`.
  Requires existing Access, same-origin session and CSRF protections. All input
  validates before mutation; 1–25 distinct UUIDs, safe nonnegative versions.
  HTTP 200 returns per-case `{id,ok,folder,version}` or `{id,ok:false,error,...}`.
  A stale version, missing case, active dispatch or storage failure does not
  erase successful independent items. Refresh an unconfirmed outcome before any
  retry. There is no implicit retry or force-overwrite control.
- Responsive folder tabs/counts, labelled selection checkboxes, capped select-all,
  bulk controls, and whole-case actions use safe DOM text nodes. Phone navigation
  retains the Inbox/detail pane behavior, now returning to the selected folder.
  Moving a case clears its local reviewed approval; Trash disables reply controls.
  Unsaved editor text survives folder moves and refresh, and is persisted only
  through the existing draft/review action.

## Notion provisioning — explicit pre-release step, not performed

The existing ticket data source is Studio Backlog & Tickets,
`103d8328-de8b-4b7f-8986-000ce40450b5`. An authorized operator must provision and
verify a **separate select** property named exactly **Mail Desk Folder**, with
options **Inbox**, **Archive**, **Trash**. Preserve existing **Status**, **Notes**,
and all other properties. Either use the Notion UI or a separately approved
provisioning procedure; this code has no schema-provisioning route.

Only after that verification, configure the non-secret runtime flag
`NOTION_MAIL_DESK_FOLDER_READY=true` through the approved release process.
Absent/other values disable folder transport. Do not change credentials or
existing reply/Notion activation settings as part of this change. A missing or
incorrect property must be repaired by the operator; a failing PATCH stays
queued and never authorizes page creation.

Folder work runs in the existing live Notion cron, preserving its five-minute
schedule, eligibility cutover, genuine-support-only policy and durable link
reconciliation. It processes at most five linked eligible cases per invocation.
New/unlinked pages continue through the existing creation/reconciliation path;
folder work never creates pages or clears uncertain links. Older/ineligible or
synthetic cases do not gain live Notion eligibility through a folder operation.

Each folder assignment first verifies the existing exact ticket link, acquires
a 120-second D1 lease, and checks the current version. PATCH is permitted only
for an exact validated `pages/{page-id}` route and exactly the dedicated select
payload. Existing auth/token shielding, bare fetch invocation, manual redirects,
9-second deadline, and bounded response parsing remain enforced. Status and Notes
are never included in a folder PATCH.

Successful acknowledgments are conditional on the captured folder version.
Changes during transport remain pending. Transient failures, including ambiguous
PATCH results, retry the same idempotent assignment after five minutes. Due linked
pages also receive bounded read reconciliation; an already matching property
needs no PATCH. This repairs delayed stale remote writes without creating pages.
Notion and D1 are eventually consistent, not a distributed transaction: a stale
value can be briefly visible during concurrent changes, service outages or queue
backlog. A failed/UNKNOWN create/link remains unresolved until the existing safe
reconciliation can identify the same page. Never delete link rows to force retry.

Local queue inspection can compare `case_folder_sync.synced_version` against
`case_folders.version` and inspect `next_attempt`/`lease_until`; cron results also
include `folderSync` processed/unresolved counts. Do not reset UNKNOWN email or
Notion create states while investigating folder lag.

## Release safety and rollback

1. Complete independent review, including full 0006 on both schema histories and
   preservation of the strict 0004 UNKNOWN lock,
   API response change, and Notion payload/lease behavior. Keep this work uncommitted
   until the separate review is complete.
2. The authorized release operator confirms a fresh verified backup/rehearsal,
   the exact target D1 binding and existing migration state, and the property
   provisioning above. Do not perform a live D1 write from this coding session.
3. Coordinate a brief operator-controlled send/management quiescence and drain old
   requests before cutover. Apply only the reviewed full 0006 once (0004 absent;
   0005 already hand-applied), then release matching Worker/assets;
   avoid a period of folder use with any old Worker capable of sending. Verify
   sidecar coverage, FKs, preserved receipt/approval counts and owner Access.
4. Preserve the deployed owner-only Access policy, exact-requester/manual Review &
   Send with signed MAC, reply activation, secrets and five-minute cron. The checked-in
   staging TOML contains dormant/mock defaults: do not blindly replace the existing
   deployed live configuration with those defaults. Enable the folder provisioning
   flag only after confirming the dedicated property; no credential changes needed.
5. In an approved owner-only acceptance session, verify counts, whole-case moves,
   fresh email reopening, duplicate suppression, stale approval refusal and Notion
   folder-only updates. Customer email sends require their own exact manual review
   and confirmation; no release smoke test should automatically send email.

Prefer a folder-aware forward fix if rollback is necessary. Keep 0006 storage,
folder state, revision increments, receipts, UNKNOWN states and immutable records.
Do not drop sidecars/triggers or restore the old backup over post-release mail:
that would discard durable delivery/receipt safety records. Disabling the folder
provisioning flag stops only folder PATCHes and preserves pending work.

An old Worker ignores Trash and may permit new replies from it. Therefore an
operator must disable sending and quiesce incompatible management/intake before
any old-code rollback, preserve forwarding/delivery reconciliation, and restore a
folder-aware build before re-enabling normal use. Do not treat rollback as
permission to reset revisions, replay UNKNOWN deliveries, recreate Notion pages,
remove the new property, or overwrite Status/Notes. Existing Notion folder values
can remain while sync is disabled. Any data repair or restore requires a separate
operator-reviewed reconciliation plan using a fresh backup.
