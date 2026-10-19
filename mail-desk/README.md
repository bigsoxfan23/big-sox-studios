# Big Sox Studios · Mail Desk

Use the existing owner-only Cloudflare Access desk to read a case, type a reply,
**Review reply**, inspect its exact envelope and text, **Send reply**, and confirm
once. The repository defaults to **simulated sending**, with real sends disabled.
Inbox cases can be genuine inbound email. The UI distinguishes simulation, pending
activation, provider acceptance, refusal and uncertainty.

[Simple replies: implementation, verification, rollout and rollback](SIMPLE_REPLIES.md)
is the current Task 10 handoff. The former Owner Canary passkey/campaign workflow is
retired as the proposed sender. PR #27, its terminal UNKNOWN campaign and the dormant
`worker.outbound.mjs`, `outbound.candidate.mjs` and `resend.future.mjs` experiments
remain historical and are not activated or imported.

This source change preserves the existing Email Routing/Gmail ingress, cases,
drafts, APIs, D1 audit, Notion hooks and five-minute sync. It has not been deployed.
No customer data, Notion, Access configuration, DNS or public website was changed.

The only proposed real-send activation in this release is support@bigsoxstudios.com
to fridman.greg@gmail.com on a genuine inbound support test case. It requires all
explicit activation settings, migration 0005, the owner-only authenticated session,
a valid Cloudflare Secret, signed session-bound review, CSRF and a manual final
confirmation. No other aliases or customers are enabled. UNKNOWN attempts are
permanently locked; idempotency never authorizes a retry.

Run offline with Node 22.13+ (tested on 22.22.1):

```sh
npm ci --prefix mail-desk --offline --ignore-scripts
npm test --prefix mail-desk
npm run check --prefix mail-desk
```

Tests use in-memory SQLite, generated RS256 keys, synthetic messages and mocked
provider transport. They never require a real Resend key or Cloudflare session.
The new transport uses one bounded POST, no threading headers, no HTML and no
provider-body/exception logging. The existing simulator remains available.

`wrangler.staging.toml` contains closed sending defaults, blank authentication
placeholders and Notion-off placeholders. Do not deploy it verbatim over the
working service: preserve the existing live configuration, secrets, bindings and
schedule as described in the handoff. A non-sending UI preview needs no Resend
secret and works without applying 0005. Real activation is a separate reviewed
owner action; the owner alone performs the final browser confirmation.

The authoritative Notion ticket source remains Studio Backlog & Tickets
(`103d8328-de8b-4b7f-8986-000ce40450b5`), and Studio Ticket Activity remains
`17401fd3-c5f4-46bb-b516-c420b6e3ce24`. Existing sync ownership, Reference and Notion
Sequence allocation are unchanged. This task does not add outbound Notion writes.

Older `TASK10_*`, `SECURITY.md`, `OPERATIONS.md` and `VALIDATION.md` documents record
prior implementation stages; their synthetic-only, dormant-ingress, no-live-Notion,
passkey and campaign statements are historical where superseded by the current
[Simple replies handoff](SIMPLE_REPLIES.md).
