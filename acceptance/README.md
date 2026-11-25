# Task12 private staging acceptance — source and synthetic tests only

No deployment, external API access, provider send, real ticket creation, real D1 access, migration application, credential provisioning, commit or push was performed. This implementation does not establish live acceptance, inbox delivery, effective MFA or production readiness.

## Separate entrypoints

- `members-portal-staging/private-acceptance-entry.mjs` wraps the existing approved staging Member assembly.
- `owner-launchpad/src/private-acceptance-entry.mjs` wraps the existing Owner worker.
- Only `/acceptance` and `/acceptance/*` enter the new handler. Every original route receives its original Request, environment and context unchanged. Production entrypoints do not import acceptance code. No Wrangler, Access, route, deployment or production file was changed.
- Member host: `members-staging.bigsoxstudios.com`. Owner host: `bss-owner-launchpad-staging.fridman-greg.workers.dev`. No other workers.dev, preview, public or production origin is permitted on acceptance paths.

## Flow and durable stops

1. The exact existing Outlook identity, signed Member Access JWT, trusted runtime OTP identity, independently verified MFA/policy and session-bound CSRF form create one TEST request and one request outbox entry in one Requests transaction. This private, two-identity Access/MFA form is the anti-bot boundary; there is no anonymous intake or public Turnstile bypass. Its effective policy still requires separate review.
2. Greg reviews the TEST queue and explicitly confirms POST `.../{request}/dispatch`. Verified dedicated scope/credentials and an independent run dispatch gate are required. Both the Notion ticket intent and pinned Gmail notice intent are reserved atomically before I/O. The ticket must be accepted before the notice is attempted.
3. POST `.../{request}/decision` requires the current source/request revision, fresh Owner session, SQL database-time expiry and accepted ticket/notice evidence. It records approval and creates one pending TEST Member in the isolated Members database. No service readiness or grant is fabricated.
4. GET/POST `.../{request}/send-welcome` shows and confirms the exact existing Outlook address, TEST content, run and request. It reserves one immutable welcome intent before I/O. Provider acceptance is never presented as inbox delivery.
5. GET `/acceptance/app` requires fresh signed OTP plus runtime identity, current approved request and committed accepted TEST welcome. It binds the existing Outlook identity and activates only the isolated TEST Member. All acceptance service paths deny. No real accounts, service grants, Jellyfin readiness or production sessions are created.
6. POST `/acceptance/members/{member}/remove` first revokes the authoritative request, then the isolated Member. Every subsequent app request checks the authoritative request again, denying the original JWT/session. Audit, identity, request and attempt evidence remain.

`reserved` means an attempt is already irreversibly consumed (the schema's equivalent of DISPATCHING). `unknown`, `refused` and `accepted` are terminal. Attempt budget is **one total per event/recipient**, enforced by schema CHECK, uniqueness, a singleton run lock and source checks. Timeout, malformed/uncorroborated receipt, crash or outcome-persistence failure never permits replay. A timed-out receipt verification also becomes UNKNOWN; late completion cannot change it. Changing run configuration cannot start another run in these databases.

Cross-D1 operations are deliberately fail closed, not distributed transactions. A crash/expiry between approval and pending-Member insertion can leave approved-without-Member, which cannot send a welcome or admit a Member. Revoking Requests denies sessions even if the subsequent Members write fails. Such partial states require separate Owner reconciliation; there is no repair/reset/retry endpoint. Reserved-but-unattempted effects remain permanently locked.

## Exact schema delta — applied to two isolated acceptance D1s (verified, never reapply)

Keep the already-applied `acceptance/requests.sql` and `acceptance/members.sql` unchanged. ChatGPT applied these separate deltas under Greg’s staging-only authorization after local SQLite integrity checks, to the two NEW acceptance D1s only:

| Exact target D1 UUID | Exact additional SQL file |
| --- | --- |
| `5f333c95-de64-4a37-8467-8a0bbba7dd9b` (Requests) | `acceptance/migration-0002-requests.sql` |
| `adf83cdc-e8df-4cc4-acd5-3f89ce6f34ea` (Members) | `acceptance/migration-0002-members.sql` |

Both Cloudflare readbacks verified exact physical identity markers and all-zero application/member/send/grant rows after migration. These files are the complete migration delta, not replacement schemas. Requests adds a physical-binding marker, immutable singleton run, one-way outbox, immutable request transitions, one effect per kind, reserve-only effect creation, evidence checks and automatic immutable audits. Members adds its different marker, pending-only creation, immutable member/identity transitions, activation evidence checks and automatic immutable audits. Existing zero-grant triggers remain in force. Each completion marker is inserted last, so an incomplete delta remains blocked. These non-idempotent deltas must not be reapplied blindly. Never apply either file to historical staging or production D1s.

Runtime checks require both exact configured UUIDs, distinct binding objects, no aliases to legacy binding objects, matching installed markers, the locked run/nonce and zero service grants. D1 binding objects do not expose a trustworthy physical UUID: independent reviewed binding readback is required **before** database probes, through the trusted Access/isolation proof described below. Marker probes are a second check, not a substitute for verifying actual Worker binding wiring. Default entrypoints cannot probe any database without that independent proof.

## Configuration and remaining blockers

No real secret values are in this source. Future encrypted Worker secrets decrypt into `env` at runtime. Source pins in `config.mjs` independently enforce both exact recipients, hosts, audiences, UUIDs, parent and attempt budget. Caller input cannot choose recipients, headers, CC/BCC, reply-to, ticket text or credentials. No application code logs addresses, credentials or request bodies.

Required staging configuration (never configure production):

- `ACCEPTANCE_MODE=private-staging-source`, `ACCEPTANCE_REVISION=task12-private-acceptance-v1`.
- `ACCEPTANCE_REQUESTS` / `ACCEPTANCE_MEMBERS` bindings, with corresponding `ACCEPTANCE_REQUESTS_ID` / `ACCEPTANCE_MEMBERS_ID` equal to the exact UUIDs above.
- Encrypted `ACCEPTANCE_OWNER_RECIPIENT` and `ACCEPTANCE_TEST_RECIPIENT`, exactly matching the Gmail/Outlook source constants.
- Encrypted independent 32-byte random base64url `ACCEPTANCE_CSRF_KEY` and `ACCEPTANCE_RUN_NONCE`; a single fixed `ACCEPTANCE_RUN_ID` of 16–64 alphanumeric/underscore/hyphen characters.
- `ACCEPTANCE_NOTION_PARENT=423013a6-47c5-81f8-8bea-cb3730ca4d88`, dedicated encrypted page-scoped `ACCEPTANCE_NOTION_CREDENTIAL`, dedicated encrypted staging sending-only `ACCEPTANCE_SENDER_CREDENTIAL`, and separate `ACCEPTANCE_DISPATCH_GATE=greg-one-run:<fixed run ID>`. The real credentials are unavailable. Length checks never establish credential scope.

Both factory functions accept **trusted server-owned** `verifyAccessPolicy` and `providers` dependencies. These cannot come from a request or an environment readiness flag. The shipped default exports supply neither and therefore remain closed, even if someone sets every environment flag. They make no default Notion or Resend network call. Completing real adapters and their independent verification requires separately reviewed source/configuration; supplying credentials alone cannot activate this build.

`verifyAccessPolicy({request,claims,runtime,role,runId,bindings})` must independently verify the unchanged exact Access hosts/audiences, effective two-identity allowlist/MFA and actual physical binding readback. It returns `policyVerified`, `mfaVerified`, `allowlistVerified`, `bindingsVerified`, exact `ownerHost`, `memberHost`, `requestsId`, `membersId`, and session-bound `subject`, `audience`, `runId`, `expiresAt`. Expiry cannot exceed the signed session. Existing JWT/OTP signature and runtime checks are always applied first; the hook cannot replace them. OTP presence alone is never independent MFA proof.

`providers.verifyScope` receives the two dedicated credentials and exact run/parent/recipient pins. Its independently established, fresh proof must return exact `parent`, `runId`, `expiresAt` and true `pageOnly`, `privateParent`, `stagingOnly`, `sendingOnly`, `senderVerified`, `zeroSpend`, `recipientPinsVerified`. Verify actual Notion private parent/page-only access, dedicated sender/domain, free usage/no spend and credential isolation; environment assertions are insufficient. A reviewed adapter must implement `createTicket`, `send` and `verifyReceipt`. Only a corroborated actual outcome may return `{state:'accepted',providerId}` and pass `verifyReceipt`; fake providers exist only in the offline test graph. Failed checks cannot reserve or send. There is no generic fetch transport or fallback to Mail Desk/production providers.

Greg's separately authorized single protected staging run, effective Access/MFA verification, real ticket evidence and actual inbox delivery remain outstanding. No live acceptance is claimed.

## Offline verification (Node 24.22.0)

```sh
node --test --experimental-test-isolation=none acceptance/test/flow.test.mjs
node --test --experimental-test-isolation=none acceptance/test/workerd.test.mjs
```

The first suite uses in-memory SQLite, locally signed RSA JWTs, an exclusively local JWKS fetcher and injected fake Notion/Resend providers. Its global fetch guard rejects all network requests. The second uses real **local** workerd/D1 emulation and both actual new staging factories with the same synthetic JWT/provider fixtures; it needs permission for loopback listeners, never Cloudflare access. It verifies D1 batch/trigger behavior and trigger-inclusive change counts. Neither test uses live credentials, remote bindings or real sends.

Negative coverage includes identity/host/audience/OTP/MFA failures, D1 cross-wiring/legacy aliases/missing migration, strict CSRF/form/run/revision validation, concurrent duplicates, terminal UNKNOWN/refusal, real local receipt timeout/late completion, reservation/persistence crashes, Owner expiry during awaits and inside SQL, fabricated acceptance, retained audits, zero grants, revocation and original-route/session preservation. Production import graphs are checked for acceptance-code leakage.
