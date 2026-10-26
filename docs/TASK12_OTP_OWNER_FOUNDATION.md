# Task 12: independent email OTP Owner foundation

Development only, OFFLINE verified. No automated live OTP Owner identity proof or
production acceptance is established. MF1–MF6
in [Phase 2](TASK12_PHASE2_IMPLEMENTATION.md) remain binding. This supplement
implements the MF3 email-OTP exception, where identity effectively is email.
It does not change the generic provider resolver, invitation flow or schema.

## Small isolated implementation

- `portal/otp-identity.mjs`: validates the custom host before authentication;
  default Access verifier checks RS256 signature, exact issuer, exclusive members
  audience and valid times. A trusted verifier is injectable for tests/future
  reviewed server composition. The adapter additionally checks exact
  `ctx.access.aud`, requires runtime `ctx.access.getIdentity().idp.type` to equal
  `onetimepin`, and requires identity email to equal signed JWT email exactly.
  Email syntax is checked, but the stored subject is the original exact string:
  provider `otp`, subject verified Access email. No case/alias normalization,
  Google subject inference, forwarded-header trust or provider auto-linking.
- `portal/member-dashboard.mjs`: standalone server handler with injectable
  verifier, activation evidence verifier, runtime context and D1. Every admitted
  request (including unknown paths and unsupported methods) reads current binding,
  role, status and grants in one D1 snapshot. Only active D1 members enter. Role
  labels are selected from fixed text; no email, subject, ID, tokens, policy
  details or database errors appear in HTML. There are no request mutations.
- Mobile HTML uses system fonts, semantic landmarks, headings, visible focus,
  high contrast, role/status and “Services coming soon”. No service URLs,
  credentials, proxy or pretend service functionality. Both `/services/{name}`
  and `/api/services/{name}` (including descendants) require a checked explicit
  grant, even for Owner, and still return 404 because services are unconnected.
  Owner route also remains unconnected. Unknown routes reveal no resources.
- Every response, including denial/error/HEAD, sets private no-store plus CDN
  no-store, CSP, no-referrer, nosniff, frame denial and noindex. No static assets,
  client JavaScript, dependencies, cookies or application session store added.
- Only one exact configured custom hostname is allowed; HTTPS origin must match
  exactly, Host and optional Origin must agree. Workers.dev, Pages.dev, preview
  aliases and team Access hosts cannot be configured as the portal hostname.
  Final production route inventory must separately prove no alternate path to
  resources, direct origin, preview, service binding or unprotected hostname.

Neither existing `portal/worker.mjs` nor any deployment configuration imports
these modules. The default dashboard has no activation evidence verifier and
cannot activate through environment flags. This is a production-oriented server
foundation, not a complete production entrypoint or current login feature.

## OTP is a login method, never independent MFA

There is no `mfaVerified` identity claim here. Email OTP alone establishes no
independent second factor. Existing generic branded identities require different
proof; the OTP adapter intentionally cannot mint that brand or bypass the
existing invite/link functions. A future invite integration requires separate
review under MF1–MF3. Google, Apple and OTP bindings remain separate even if all
emails match. Switching methods requires the existing separately approved link
flow, never a matching-email fallback.

`verifyActivation` is a **trusted server evidence-verification dependency**, not
an HTTP callback, browser JSON or environment setting. No real implementation is
shipped because the current OAuth token cannot read effective policy. A future
reviewed adapter must obtain authentic readback of the exact effective Cloudflare
app/policy hierarchy, verify a separate independent MFA requirement actually
covering OTP, and verify one explicit audited Owner approval of that exact policy
and target. Readback must include org/Worker/account/hostname/path overrides,
allow/bypass/service-token alternatives and effective IdP rules; a config file or
an empty account app listing cannot establish this. Missing, ambiguous, changed,
failed or stale proof must deny. If Cloudflare cannot enforce independent MFA for
this OTP route, this option stays disabled.

The handler checks the adapter's result against exact issuer/audience/origin,
`source=cloudflare-effective-policy-readback`, `independentMfaRequired=true`,
`otpIdentityShapeVerified=true`, SHA-256 policy digest, one nonempty opaque
`ownerApprovalAuditId`, `ownerApprovalCount=1`, integer `verifiedAt` and
`expiresAt`, and a maximum five-minute evidence lifetime. Repeated requests need
valid current evidence; policy expiry/outage blocks access. These structural
checks are not themselves cryptographic verification or live policy readback.
Only the future server verifier may attest these fields after validating source
and approval; returning constants as tests do is forbidden in production. The
approval audit record must bind the policy digest, exact target, source revision
and Owner's explicit decision, so old approval cannot cover a changed policy.
No automatic MFA inference or activation flag fallback is provided.

## Known staging evidence and required field test

Greg reports successfully completing a real email-code OTP login followed by a
separate Cloudflare MFA challenge in iPhone Safari. Human screenshot inspection
shows the custom-member staging Access app with Biometrics/Security Key/
Authenticator MFA customization, 24-hour duration, OTP and Google selected, an
owner-only allow policy including the exact email, and policy MFA respecting
global settings while global MFA is disabled. These are human observations and
configuration inspection, not automated runtime identity proof or server
attestation of independent MFA enforcement.

The existing staging-only `GET /owner/identity-check` is the read-only diagnostic
for a separately authorized runtime field test. It requires the exact custom
hostname `members-staging.bigsoxstudios.com`, no query, matching optional Host and
Origin headers, the owner email secret, independently verified signed Access JWT
and authenticated Access context. Workers.dev is denied. It preserves existing
field-presence booleans and displays only sanitized booleans:

- `otpProviderConfirmed`: only `identity?.idp?.type === 'onetimepin'`; Google,
  case differences, missing fields and other shapes remain false, with no fallback.
- `signedJwtRuntimeEmailExactMatch`: exact runtime email equality with the
  independently signature-verified, owner-allowlisted JWT email. Mismatch denies
  access; missing identity or a failed identity read returns 503.
- `memberAppAudienceConfirmed`: the signed JWT has only the exact custom-member
  app audience and `ctx.access.aud` equals that audience exactly.
- `mfaEvidenceEstablished`: always false, regardless of provider or AMR fields.
  This diagnostic cannot prove independent MFA from the JWT or runtime identity.

Responses remain no-store/noindex and expose no raw identity, provider strings,
email, JWT, secret, nonce, time or identifiers. Local synthetic tests do not
establish a successful live runtime field test. This change enables no dashboard,
account creation, grants or production acceptance and is not deployed.

The user's existing Safari staging Google login is separate from this future OTP
route. Observed: `ctx.access=true`, IdP type present, OIDC subject absent, AMR
array absent, MFA evidence not established. This proves neither upstream Google
subject nor MFA. Account app listing was empty and zone Access API returned 403;
policy is unreadable with the current Wrangler OAuth token. Existing staging and
its Google login are unchanged. No new login prompt or OTP was sent.

Cloudflare documents runtime `ctx.access`, `getIdentity()` and exact `aud`:
[Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
Its [IdP API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/methods/get/)
defines `onetimepin`. This documents the provider code, not proof that an actual
OTP session's runtime identity necessarily has this exact nested field.
Before integration, a separately authorized field test must observe an actual OTP
session on the intended route. Check only sanitized booleans for exact nested
type, exact JWT/runtime email agreement and exact audience; never persist raw
JWTs, emails, PINs or the identity object in logs/reports. Require authenticated
Access runtime context, not JSON fetched by a browser or forwarded headers. If
`idp.type` is absent, differently shaped, ambiguous or not `onetimepin`, stop.
Do not add heuristic fallbacks, labels, email-provider guesses or JWT `sub`
remapping. A synthetic local runtime shape is not a successful field test.

Signout uses only the fixed relative `/cdn-cgi/access/logout`, no return URL,
query string, external destination or user input. This is the documented
[Cloudflare logout path](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).
Cloudflare must intercept that exact path on the final host; verify it at launch.
If the request reaches this handler, it returns no logout success (404 for an
active member). The help states Access logout affects sessions across apps and
does not log out the email provider. Service-native session revocation remains
the existing separate MF4 obligation.

## One-time Owner bootstrap procedure/design — production disabled

Disconnected offline factory source, migration, and negative tests now exist;
see [first-Owner bootstrap source and production approval gate](TASK12_FIRST_OWNER_BOOTSTRAP.md).
No executable write CLI or Owner SQL seed is shipped. Available evidence cannot
prove the first real OTP identity or independent MFA policy; email-string-only
bootstrap would violate the contract. Production D1 writes remain prohibited.
A future separately reviewed one-time tool must satisfy all of the following:

1. Validate a short-lived, externally verifiable **signed attestation** from a
   reviewed trusted server observer of a successfully verified OTP request. That
   observer must use the same Access signature/issuer/audience/host/context/email
   checks as this adapter. An Access JWT alone does not attest `idp.type`;
   therefore signing an arbitrary email or accepting JWT email alone is forbidden.
   Attestation must bind exact provider `otp`, exact subject/email, runtime type,
   verified Access session binding, intended fresh DB identity, origin, audience,
   issuer, policy digest, expiration, nonce and reviewed implementation revision.
   Verify signer allowlist, algorithm, signature, audience, time and nonce; no
   browser-supplied self-attestation. Keep JWT/attestation raw values out of code,
   docs, logs and shell arguments; use private ephemeral input and destroy it.
2. Separately review real effective independent MFA policy readback, including
   all overrides and bypasses, and prove enforcement on this OTP route. Verify
   signed/audited approval bound to that digest and bootstrap proof. Require one
   explicit Owner decision naming the exact intended recipient, role `owner`,
   target DB/host, source revision and bootstrap nonce. No default recipient/role,
   wildcard approval, inference from Google login or reuse of general development
   authorization. Keep recipient details in private approval custody.
3. Default to **read-only dry-run**, verify fresh DB/schema and intended binding,
   count existing members/owners/bindings, check exact provider+subject collision,
   provider-per-member collision and conservative contact collision. Output only
   sanitized checks/counts and opaque plan digest; no raw subject/contact. Any
   existing person/Owner, duplicates, unexpected schema, pending invite or changed
   state blocks first-owner creation; never promote or link an existing record.
4. After separate concrete review, write once atomically with uniqueness guards:
   a fresh active Owner member, exact OTP binding and immutable bootstrap audit
   event with approval/proof/policy digests, never raw proof. Use a separately
   reviewed one-time consumed-nonce/receipt constraint and compare read-state in
   the same transaction. The base schema alone has no bootstrap nonce table;
   the disconnected migration supplies a permanent singleton receipt. Concurrent
   or repeated bootstrap must fail closed, with no partial rows, no second Owner,
   no email-based upsert.
5. Read back exact intended binding/role/status and sanitized audit evidence;
   disable/remove write capability after success. Readback failure is an incident
   requiring inspection, never blind retry. Test rollback, duplicate/concurrent
   attempts and proof/approval expiry in ephemeral D1 before authorizing live use.

No production command is supplied. Reviewing this design does not authorize its
execution, a schema change or live initialization. MF1 invite and revoke design
is unchanged; bootstrap cannot become a reusable enrollment back door.

## Exact remaining launch prerequisites

1. Independent security review of this exact commit and future integration;
   resolve findings and review any changes to identity, activation or bootstrap.
2. Separate authorization for fresh D1 creation/migration rehearsal, retention,
   backup and rollback; no reuse of Task 11 or existing production databases.
3. Exact final custom host and all routes/aliases/previews inventoried; issuer,
   exclusive intended members audience and distinct owner-app audience reviewed.
   Disable workers.dev/previews, deny unknown hosts and protect the entire app.
4. Separately authorized OTP runtime field test above, without changing existing
   staging Google login; fail closed if documented assumptions do not hold.
5. Real effective independent MFA readback and enforcement proof for this OTP
   route; implement/review the trusted activation verifier and its freshness,
   approval binding and outage behavior. One explicit audited Owner approval.
6. Separately reviewed signed OTP identity proof, exact recipient/Owner role and
   one-time bootstrap tool/dry-run/duplicate protection; explicit approval before
   any production D1 write. No Owner creation from email text alone.
7. Reviewed production entrypoint/config and logout interception, no-cache on
   every app response and edge cache settings; no service advertised as working.
8. Final-production MF6 P1–P6 plus OTP-vs-Google same email, wrong issuer/audience,
   direct hosts/routes, immediate live-D1 revocation/grant denial, D1 errors,
   policy-proof expiry/outage, correct role and no-JIT/write/leak acceptance.
   Independent service-session cleanup remains required before any service launch.

## Local verification

Reuse existing Node 24 and dependencies; do not install packages:

```sh
PATH=/tmp/bss-task11b-evidence:$PATH node --test --experimental-test-isolation=none portal/*.test.mjs
PATH=/tmp/bss-task11b-evidence:$PATH npm run validate
PATH=/tmp/bss-task11b-evidence:$PATH node --test --experimental-test-isolation=none tests/*.test.mjs membership-notify/test/*.test.mjs owner-launchpad/test/*.test.mjs members-portal-staging/*.test.mjs
PATH=/tmp/bss-task11b-evidence:$PATH npm audit --json
PATH=/tmp/bss-task11b-evidence:$PATH npm audit --omit=dev --json
```

The new six test cases contain security matrices and use random local RSA keys,
synthetic signed Access JWTs and ephemeral Miniflare D1. One test runs the entire
new handler in workerd. Synthetic activation readback/approval and runtime
identity are deliberately injected; they establish no live identity or MFA.
All login/denial requests in the zero-write matrix preserve full table snapshots.
Runtime outbound traffic is prohibited. Miniflare loopback socket permission is
needed; this is not Cloudflare access or a deployment. Full results/commit/tree
and launch prerequisites are in `/tmp/BSS_TASK12_OTP_OWNER_IMPL_20261025.md`.
