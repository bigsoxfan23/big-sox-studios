# Big Sox Studios · Mail Desk staging

Task 10 adds a **disabled-by-default** Email Routing handler, additive inbound/link migration and offline adapter models. Staging still has no inbound enable flag, live send path or Notion transport. See [Task 10 handoff and activation checklist](TASK10_HANDOFF.md) for current behavior, failure tradeoffs and deferred gates. The Task 9 description below is historical where superseded by this handoff.

Isolated review build for Task #9. No Worker deployment, DNS, mail routes, inbound HTTP handler, public form, real mail, or live Notion integration. One isolated Cloudflare Free D1 database exists but remains empty pending migration approval. The staging entry point imports only a mock provider. Merely changing environment flags cannot activate Resend. No auto acknowledgements exist.

Run with Node 22.13+ (tested on 22.22.1); Task 10 adds a locally pinned MIME dependency:

```sh
npm ci --prefix mail-desk --ignore-scripts --no-audit --no-fund
npm test --prefix mail-desk
npm run check --prefix mail-desk
```

The test suite uses real SQLite via Node's built-in `node:sqlite`, with a small D1-compatible adapter, generated local RS256 keys, synthetic `example.test` addresses, and mocked fetch. No Cloudflare account, mail provider, Notion, or secrets are used. In-process `node:test` isolation is explicit because this execution environment's process-isolated runner reported only file-level results. SQLite and this flag can produce Node experimental warnings.

`wrangler.staging.toml` is standalone. Its D1 UUID is the dedicated, newly created Free-tier staging database; issuer, audience, owner and origin are empty and fail closed. `workers_dev` and preview URLs are disabled; no routes, domains or cron triggers are configured. All assets pass through Worker authentication with `run_worker_first = true`. No root package, website, portal, CMS or existing workflows were changed.

## Review the implementation

- `src/security.mjs`: local RS256 signature verification using the configured issuer's JWKS and Web Crypto. Exact issuer, audience and case-sensitive owner email; mandatory numeric `nbf`, `exp`, `iat`; no cookie/email-header token fallback. Five-minute JWKS cache fails closed on missing keys/fetch failures.
- `src/worker.mjs`: authenticated static allowlist and private API, strict POST Origin, session-bound signed CSRF cookie/proof, streamed body size limit, allowed fields, database rate limits and safe denial auditing. Errors contain fixed codes, never provider messages or secrets.
- `src/store.mjs` and `migrations/0001_initial.sql`: atomic send claim, unique revision intent, transactional sent effects, crash reconciliation, durable inbound dedupe and delivery tombstones. UUIDs are opaque, never ticket numbers or References.
- `src/intake.synthetic.mjs`: import-only fixture helper; rejects non-synthetic data and recipients outside `example.test`. Atomic dedupe also enqueues a case-created sync job without sending anything.
- `src/notion.mjs`: dry-run initial-case mapper and optional synthetic executor (`NOTION_SYNC_MODE=mock`); default is `off`. No Notion fetch, token consumption, database creation, old-record mutation or activity writes exist.
- `src/resend.future.mjs`: unimported future adapter requiring independent production/live/allow/key gates. The official Resend wire header is **`Idempotency-Key`**; `Resend-Idempotency-Key` is also included as the requested alias, with the same opaque intent UUID. The official header carries deduplication semantics. No real request was made.
- `public/`: cream/navy/orange, mobile-first queue, thread and compose → review → explicit mock Send. Dynamic content uses DOM text nodes, `textContent` or textarea `.value`; untrusted email HTML is never rendered. Authenticated responses use CSP and no-store.

See [SECURITY.md](SECURITY.md), [OPERATIONS.md](OPERATIONS.md), and [VALIDATION.md](VALIDATION.md) for behavior, future gates and test evidence. This is a local build, **not Cloudflare live acceptance**.

## Authoritative Notion ownership

The only ticket source is existing **Studio Backlog & Tickets**, data source `103d8328-de8b-4b7f-8986-000ce40450b5`. Existing **Studio Ticket Activity** source `17401fd3-c5f4-46bb-b516-c420b6e3ce24` stays under the existing OptiPlex service, which assigns per-category Reference IDs and logs activity every five minutes. This app never allocates a ticket sequence and never writes `Reference` or `Notion Sequence`.

The dry-run payload uses Notion API `2025-09-03` and `parent.data_source_id`, the specified initial Inbox mapping and External Case ID. Property representations (including Status and Assigned To) are assumptions for a future owner-approved schema audit; no real schema or requester data was accessed. A future live executor must reconcile by External Case ID and store the resulting page linkage, prevent duplicate creates after uncertain responses, preserve existing lifecycle/views, and distinguish initial creation from later delivery updates. **Do not use the initial-case mapper to reset existing records on delivery jobs.** There is intentionally no live executor in Task #9.

References checked for implementation details: [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Resend idempotency](https://resend.com/blog/engineering-idempotency-keys), [Notion upgrade guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03). These documentation reads did not access owner services.
