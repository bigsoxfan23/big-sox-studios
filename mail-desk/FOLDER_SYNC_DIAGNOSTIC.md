# Folder-sync diagnostic

Local change on `fix/mail-desk-cleanup-a-folder-sync`, based on main commit
`4ae2876c2a5052f344866a8487e215981d5e841d`. Independent Codex security review is
next; this note does not authorize deployment or production writes.

After a separately approved release, use the existing authorized read-only D1
query workflow with these SELECTs. They return internal case IDs and sync
metadata only; do not select message, requester, credential or response content.

```sql
SELECT f.case_id, f.folder, f.version, s.synced_version,
       s.next_attempt, s.lease_until, l.state AS link_state
FROM case_folders f
JOIN case_folder_sync s ON s.case_id = f.case_id
JOIN notion_links l ON l.case_id = f.case_id
WHERE l.state = 'linked'
ORDER BY f.case_id;

SELECT case_id, event, created_at
FROM audit_events
WHERE event GLOB 'folder_sync_error_*'
ORDER BY created_at DESC, case_id;
```

Events have the fixed form `folder_sync_error_<stage>_<category>`. Stages are
`notion_query`, `identity_match`, `version_check`, `notion_patch`, `db_ack`, and
`cleanup`. Categories are allowlisted exact codes, with known HTTP server errors
grouped as `notion_http_5xx`; unrecognized errors become `other`. No raw error,
URL, response body, header, token, or customer content is stored. Existing
historical audit rows are preserved. Deduplication is one row per case/stage/
category for as long as that audit row is retained, independent of folder version.

`notion_query_notion_http_403` points to the Notion query/access boundary;
`notion_patch_notion_http_400` points to the assignment request boundary. These
codes identify where to investigate, not the underlying cause. Verify access and
the exact dedicated **Mail Desk Folder** select schema through an authorized
read-only inspection before proposing a separate fix. `identity_match` means
the query did not reconcile to the existing linked page. `db_ack`/`cleanup` with
`other` indicates a local storage boundary failure. Audit failures are swallowed
so they cannot prevent lease cleanup; absence of an event is not proof of success.

The reported live baseline is three linked Inbox cases with `version=0`,
`synced_version=-1`, null remote folder and readiness flag true. A failed attempt
normally releases its 120-second lease and schedules the same assignment for
300 seconds later. Repeated identical errors intentionally do not update the
audit timestamp: it is the first recorded occurrence, not a last-attempt time.
Use queue metadata to inspect current progress. Cleanup failure retains the
existing error propagation and lease-expiry behavior.

For future fix verification, compare these SELECT results across normal cron
runs and confirm, through authorized read-only Notion inspection, that the
dedicated select becomes **Inbox** and `synced_version` equals the current
`version`. Historical diagnostic rows remain after recovery. A revision race
does not count as processed or acknowledge a newer version; it remains queued.
Read reconciliation still runs for acknowledged pages on the existing schedule.
No queue resets, link edits, migration, new bindings, credential changes,
deletions, emails, auto-sends or membership actions are part of this diagnostic.

Local validation uses the `node:sqlite` fixture and injected mock Notion fetches:
`cd mail-desk && npm test`, `npm run check`, then `git diff --check` at the repo
root. All 812 tests pass; syntax checks and diff whitespace checks pass. The
registry install failed on DNS; validation used an existing local `postal-mime`
4.0.6 copy from a worktree with the same lockfile. No production reads or writes
were performed, and no real external calls or emails were made by tests.
