> Current sender release candidate: [SENDER-RELEASE.md](SENDER-RELEASE.md).
> Exact owner chat consent is now source-owned and production dispatch is gated
> by that exact configuration plus two fresh native WebAuthn proofs. This run
> made code/test/doc changes only; it did not deploy or send. The sections below
> are historical evidence and may describe superseded disabled/null gates.

# Application stepup candidate — live release blocked

This work implements the conditional design in `/tmp/task10-webauthn-design-review.txt`. The production public credential below is now owner-confirmed and pinned in source. Local verification uses generated keys, synthetic `.test` identities and recipients, disposable local databases, and stub transport. Pinning does not authorize an email or release a deployment.

The full sender still exports `dispatchAuthorized: false`. `PRODUCTION_CREDENTIAL_PIN` in `src/stepup-release.mjs` is an immutable public record; `FINAL_OWNER_CONFIRMATION` and `PRODUCTION_POLICY_RELEASE` remain **null**. Request bodies, headers, environment bindings, enrollment candidates, and “latest candidate” cannot replace these code-owned values. Production authentication additionally requires the exact recipient `fridman.greg@gmail.com`; the coordinator only accepts that mailbox or synthetic `.test` mailboxes. Its existing fixed From is `support@bigsoxstudios.com`. No transport, ledger, original migration, customer boundary, or Mail Desk code changed.

## Confirmed public bootstrap evidence — October 17, 2026

The established owner conversation explicitly confirmed: “This is the passkey I just created in Safari on my own device, and I confirm the fingerprint above.” The full confirmed fingerprint is:

```text
sha256:798d9a0ac8aefeb35ac0f64c29341c4962539e051d396fd82a41bcb29c973584
```

The operator supplied an independent exact read-only remote D1 lookup by public ID `wR3QcDwdxYwi3BECTAjRE8Zzv8cwiqSD1Zl8mkpyoKU`, matching all canonical public fields, the full SHA-256, and possession proof verified at `2026-10-17T05:33:20Z` within the ceremony window. Reported campaign count: **0**. This source change relies on that supplied evidence; it performs no new remote lookup. The reported existing live enrollment version is `168d1575`, with no sender or secrets.

Exact canonical public record (fixed fingerprint field order):

```json
{"credentialID":"MANaCK7rJfDfUuXeSlx46S4ypCw","publicKey":"pQECAyYgASFYINcxjXlys_igeNRhUyf9UKeHO_H1Vs3aak-7y7CzVdInIlggkRNP2BSEiVzRHn7DReQZzhdf88DJVrCEo_Ptk_qHdsE","algorithm":-7,"rpID":"canary.bigsoxstudios.com","origin":"https://canary.bigsoxstudios.com","owner":"19e39702-51ab-52dc-9172-91bcb059ec5d","email":"fridman.greg@gmail.com","epoch":"owner-canary-webauthn-v1-20261016"}
```

Only these public bytes are pinned with `Object.freeze`; no private key, assertion, JWT, cookie or secret is included. Candidate order and candidate expiry do not select or revoke this source-owned pin. Trust remains rooted in the established owner conversation and reviewed source. This confirmation covers the credential only. Exact final email authorization is absent; final confirmation stays null and sending stays disabled.

The completed exact registration and possession proof plus owner confirmation suffice for bootstrap, as confirmed by independent review; no additional pinned-key proof UI is required to publish the disabled pin. Remaining release dependencies require separate review: restricted provisioning through existing authorized connections without exposing secrets in chat/logs; exact final message confirmation bound to envelope/configuration/epoch; independent implementation/operational review and CI. Fresh live preview and dispatch ceremonies and operational sender acceptance remain required later. The sender UI requires full sender configuration, and preview spends the singleton campaign slot and must not be used as a read-only check. This change adds neither UI nor provisioning capabilities and does not deploy.

## Authentication and key contract

`verifySignedOwnerIdentity()` wraps the existing strengthened signed-owner checks: RS256 signature, exact owner subject/email/issuer, singleton audience, application token type, required integer iat/nbf/exp, no future or stale token, bounded 600-second lifetime, and no service token. It returns `identityContract: signed-owner-identity-v1`, **no MFA or cutover evidence**. The old signed-AMR and reviewed-policy verifiers retain their separate contracts. Identity-only results cannot downgrade into signed-AMR mode.

The default production sender fixes `authenticateStepupOwner()` (locally aliased as `authenticate` in the worker to preserve the original boundary test). This strict verifier requires exact `MFA_CONTRACT === STEPUP_CONTRACT`, a nonnull imported `PRODUCTION_CREDENTIAL_PIN`, and the exact owner recipient before signed identity/JWKS verification. Environment selection cannot enable signed-AMR or reviewed-policy operation. The coordinator then validates the code pin's full credential record and identity/origin/epoch bindings. The legacy `authenticate()` export and configurable factories/verifiers remain solely for offline compatibility; they are not the default production verifier. Factory arguments, request data and environment pins/final confirmations cannot replace the imported production pin, which is now the immutable confirmed public record. Dispatch remains hard-false and final confirmation remains null.

`application-webauthn-stepup-v1` adds an application proof. It does not prove Cloudflare Access AMR, a Cloudflare MFA event/time, session revocation, or policy cutover. Every request, including enrollment/UI assets, must independently pass signed Access owner verification. JWKS resolution uses the existing pinned issuer configuration; no environment-injected verifier, resolver, clock or transport exists in production. Exported factories and test helpers are offline seams, never runtime configuration. Factory defaults use the imported code-owned pin; explicit offline factory arguments remain test seams.

`@simplewebauthn/server` is pinned exactly to **14.0.3**, with the resolved transitive dependency graph and integrity hashes in `package-lock.json`. Production uses its registration and authentication verifiers, never handwritten WebAuthn cryptography. Requests and base64url fields have strict bounds, canonical unpadded encoding, exact credential ID/raw ID, exact origin and hostname RP ID, UP **and** UV. Cross-origin ceremonies and topOrigin are rejected. Initially only **ES256 / EC2 / P-256** keys and `none` attestation are supported for native Safari, to reduce the algorithm/certificate attack surface. Both browser options and server verification require UV. None attestation proves no hardware identity or local-only creation.

The fingerprint is `sha256:` followed by the full lowercase 64-digit SHA-256 of UTF-8 JSON with exactly these fields, in this fixed order:

```text
credentialID, publicKey, algorithm, rpID, origin, owner, email, epoch
```

`publicKey` is the canonical base64url representation of the verified COSE public-key bytes; `algorithm` is -7. `epoch` is the release/session epoch. All public record bytes, including owner identity and exact origin/RP ID, participate. Pin those exact public bytes after owner confirmation and independent review, never a lookup by candidate order. Candidates are explicitly UNTRUSTED even after possession proof.

## Durable flow

`0002_stepup.sql` adds only `stepup_challenge` and `stepup_candidate`, with immutable-binding/transition triggers and durable row caps. `0001_canary.sql`, its campaign table and four triggers remain byte-for-byte unchanged. Enrollment never reads or writes that campaign. Tests use its original schema only in disposable local fixture databases.

1. An explicit POST to `/stepup/session` creates a 32-byte random `__Host-stepup` Secure, HttpOnly, SameSite=Strict, Path=/ cookie, **before** any ceremony. Its SHA-256 is durably recorded with the exact JWT hash, issuer/audience, owner, origin and epoch. A caller-chosen cookie has no record and is rejected. An existing cookie is validated and never refreshed or replaced. Duplicate/malformed cookies are rejected. Session records last 600 seconds and share the challenge table's 128-row cap.
2. Each ceremony receives a separate 32-byte random ID and challenge and a fixed 120-second deadline. Immutable server context binds JWT SHA-256, stepup cookie SHA-256, purpose, release epoch, and the server-computed configuration/envelope digest. Dispatch additionally binds the existing campaign/digest/binding/approved capability/status/deadline. Enrollment possession binds the candidate ID and fingerprint.
3. Library crypto verification precedes the conditional `issued -> verified` D1 update. Server time, JWT lifetime, and ceremony deadline are rechecked after actual crypto. The same row is the durable grant: `verified -> used` is a separate one-winner conditional SQL consume. Counters are **not** replay defense: stored verification counter is zero, so synchronized passkeys with zero counters work. The challenge/grant CAS is the replay defense.
4. Preview consumes a fresh preview grant before the existing `ledger.initialize()` can consume the single campaign slot. Its snapshot contains the stable public pinned credential contract/fingerprint, with no transient grant/deadline. The campaign binding includes both the original `__Host-canary` cookie and the stepup session hash. JWT refresh or even a different legitimately server-issued stepup cookie cannot adopt an existing campaign. Review/approval never extend the original maximum 300-second intention.
5. Dispatch requires a distinct fresh signed assertion and grant. Code-owned final chat confirmation must match the exact envelope digest, complete snapshot/configuration digest, and epoch. The grant is consumed before the unchanged original `approved -> submitted` campaign CAS. The deadline is checked before claim and again before transport; expiration after claim finishes UNKNOWN without transport. No send occurs without the original campaign CAS. Transport remains no-retry.

Grant consumption and campaign claim are intentionally separate and durably linked by the grant's immutable context, which includes the exact approved campaign/capability. A crash between them burns the proof and cannot resume it. A crash after campaign claim cannot retry the campaign. A new ceremony can never revive an already claimed campaign. Lost/expired preview capability still permanently spends the slot. Proof IDs alone are insufficient: exact signed JWT, both original cookies, configuration and stage must still match.

Every POST requires exact same-origin Origin, `Sec-Fetch-Site: same-origin`, `Content-Type: application/json`, and the exact `X-Canary-Action` path. Unknown fields/actions, authorization headers, query aliases, oversized streams, and malformed base64url fail closed. Ceremony bodies are bounded to 16 KiB; original coordinator bodies remain 4 KiB. Public candidate records expire after 600 seconds; there are at most 64. Expired rows are pruned on subsequent issuance, so idle expired rows remain bounded. There is no reset, HTTP pin/approval, candidate promotion, recovery or admin endpoint.

## Enrollment and owner actions

`src/enrollment.mjs` is an enrollment-only alternate entrypoint of this same isolated worker. It has no sender/transport/provider-key or campaign-ledger dependency. Self-hosted `/enroll.js` uses plain browser WebAuthn APIs; no CDN or third-party script. CSP allows only self scripts/connects. The Create passkey and Prove possession buttons are separate explicit clicks. There is no conditional mediation, automatic prompt, silent reuse, or background authentication.

Registration stores a canonical public candidate after UV/UP verification and returns only an opaque continuation handle kept in browser memory. A separate authentication ceremony must verify possession of that candidate's key before a distinct public candidate ID is generated and the UI outputs that ID, full fingerprint and public record. Its durable `public_id`/`proof`/`verified` fields cannot be reset or overwritten. Multiple concurrent candidates stay untrusted. JWTs, cookies, provider keys and assertions are never displayed or logged.

The owner must:

1. After later operational configuration review, open the exact reviewed native HTTPS hostname in **native Safari on the owner's local device**, behind the pinned Access owner identity. Do not use a remote automation browser.
2. Click Create passkey, complete UV, then separately click Prove possession and complete UV. Compare and explicitly confirm the **full displayed fingerprint here in the established owner conversation**. Retain the public record for independent comparison. This confirms a candidate fingerprint only; it does not authorize email.
3. Have the exact public record, fingerprint, origin/RP ID, signed-owner bindings and release epoch independently reviewed and pinned in code in a separate release review. No candidate auto-selection is allowed.
4. Review the exact final From, To, Subject and full body in chat and explicitly confirm **that exact final message**. Any message/configuration/epoch change voids confirmation. Record the corresponding envelope/configuration digests and epoch in the separately reviewed code-owned `FINAL_OWNER_CONFIRMATION`; it is currently null.
5. Only after independent implementation/browser/operational release review, complete a fresh UV-required preview ceremony, review and approve the immutable preview, then explicitly confirm one dispatch and complete a **different** fresh UV-required dispatch ceremony within its deadlines. A browser approval or dialog cannot substitute for the prior exact-message chat confirmation.

`wrangler.enrollment.toml` is bundle-only: no bindings, routes, workers.dev, previews, credentials, schedules or services. The sender config remains disabled too. Later root/operator review must provide exact native hostname/Access owner/issuer/audience/epoch and a dedicated isolated D1 database with additive migration review. Do not configure a customer database, provider key, or approval signing key on enrollment. Do not deploy from these offline configs. No migration or deployment was run remotely in this task.

## Trust and residual risks

Bootstrap authority comes from the established owner's chat confirmation and separately reviewed code pin, assuming an uncompromised local browser/device and correct hostname/operator configuration. Registration or possession proof alone supplies no owner identity. A holder of an old signed Access session can submit their own candidate, but cannot authorize it. Same-origin script/browser/device compromise can misrepresent the public fingerprint or ceremony. The owner must compare exact bytes; WebAuthn cannot defeat same-origin compromise.

Passkeys may synchronize; this implementation does not establish hardware confinement, native local creation, or exclude copies through a compromised synchronization account. UV/UP are signed authenticator flags, not proof of a particular human or Cloudflare MFA. Counter zero is supported deliberately. Old Access sessions can still exert bounded storage/CPU pressure or denial of service (128 session/challenge rows, 64 candidates), including consuming capacity until expiry. D1 and reviewed code/configuration remain trusted. No rate-limit product or paid service was added.

## Confirmed-pin delta verification

All **637 canary** and **481 Mail Desk** tests pass (1,118 total; original 1,108 preserved, 10 added). Both package checks, UI bundle consistency, `git diff --check`, and repository ESLint (74 files, zero errors/warnings) pass. Tests compare the exact public record and full fingerprint, reject identity/origin/RP ID/epoch mismatches, prove immutability and forged-key rejection, and retain strict missing/legacy/unknown-mode and runtime-override denial. Production-entrypoint negatives use denied recipient or issuer configuration before external JWKS resolution; no external JWKS/network is used.

The existing local Miniflare/workerd D1 probe passes, including real ES256 in workerd, 32 contenders and one winner per transition, one stub transport, zero enrollment campaign rows, immutable bindings, row caps and expiry pruning. Initial sandbox loopback denial was resolved through approved local execution; outbound I/O remains blocked. Both Wrangler 4.151.0 offline dry runs pass with no live bindings: sender 736.56 KiB (gzip 141.39), enrollment 748.81 KiB (gzip 141.48). Only the existing missing Astro base-tsconfig warning remains. No remote D1, provider, secret, deployment, send, commit or push was used. Detailed report: `/tmp/task10-owner-pin-build.txt`.

## Historical local verification before the confirmed-pin delta

Run `npm test` and `npm run check` in both `owner-canary` and `mail-desk`. The original 953 tests remain unchanged and pass (472 canary + 481 Mail Desk); new WebAuthn tests add coverage rather than replacing assertions. `owner-canary/node_modules` was changed from the existing external symlink to a local isolated install; its external target and all external tracked source were untouched. Mail Desk's existing symlink was preserved. Package fetch/install used npm only, without scripts. The 27-package owner dependency graph reported zero advisories at installation.

Using the pre-existing local tool installation (read-only), run:

```sh
node owner-canary/scripts/validate-stepup-d1.mjs /absolute/path/to/tool/node_modules
```

This starts disposable local Miniflare/workerd D1 databases with outbound I/O blocked. It validates real none registration/ES256 authentication **inside workerd**, plus the actual coordinator and signed synthetic Access JWTs against real local D1 bindings. Thirty-two verification/preview/consume/dispatch contenders produce one winner per transition, one stub transport call, no enrollment campaign writes, enforced immutable bindings/caps, expiration pruning and rejected replay. The script disposes its runtimes. Fixtures sign real ES256 authenticator data; they do not mock the WebAuthn verifier. Additional unit cases cover wrong UP/UV/origin/RP ID/challenge/credential/key/signature, stale/future bindings, refresh/cookie substitution, candidate/HTTP forgery, deadline crossing during real crypto, post-consume/post-claim expiry, and crash gaps without email.

Both entrypoints must pass Wrangler `deploy --dry-run` only, using isolated temporary tool configuration/log/output directories; no accounts, credentials, remote D1 or deployment. The existing root ESLint toolset is reused; the distro `eslint-scope` exports version `main`, so root lint uses an in-memory version metadata correction and the existing flat Astro configuration adapter. No external tool source is edited. Wrangler warns about the pre-existing absent root Astro tsconfig dependency; both Worker bundles still succeed. The owner has now confirmed the native Safari ceremony as recorded above; independent implementation/release review remains outstanding.

Production-entrypoint hardening results: pre-edit **582/582 canary tests**; current **596/596 canary tests**, **481/481 Mail Desk tests**, **1,077 total** (all original **953**, plus **124 new**). The 14 additional production tests cover legitimate signed-AMR/policy identities, exact/legacy/unknown/missing modes, forged environment/request pins and confirmations, and factory isolation while the actual code pin remains null. Both package checks and `git diff --check` pass. No protected migration, ledger, transport, customer code or existing test file changed in this hardening delta.

Prior implementation verification (not rerun for this narrow delta): Root ESLint checked **73 files, zero errors and zero warnings** using the existing adapter/toolset described above. Installed owner dependencies: **27 packages audited, zero vulnerabilities**, exact server version **14.0.3**.

Prior runtime/bundle evidence (not rerun for this narrow delta): Local Miniflare/workerd **PASS**, also independently run by root in `/tmp/task10-stepup-root-d1.log`, with actual none registration and ES256 authentication in workerd; 32 challenge-verification, preview, direct-consume and coordinator-dispatch contenders, exactly one winner per transition, one stub transport invocation, zero enrollment campaign rows. Binding immutability, replay denial, the 128-row shared session/challenge cap and expiry pruning passed on actual D1. Both Wrangler **4.151.0** dry runs passed with **no D1/service bindings or routes**: sender **737.29 KiB** (gzip **141.31 KiB**), enrollment **748.11 KiB** (gzip **141.13 KiB**). These sizes predate production hardening. The sole bundle warning was the absent pre-existing root Astro tsconfig dependency. Final delta independent review and CI remain with root before enrollment release. No upload, remote D1, credential use, paid service, actual email, deployment, commit or external tracked-source edit occurred.

Exact changed/added source and documentation files (all under `owner-canary/`):

```text
README.md
WEBAUTHN.md
package.json
package-lock.json
migrations/0002_stepup.sql
public/app.js
scripts/validate-stepup-d1.mjs
src/auth.mjs
src/enrollment-assets.mjs
src/enrollment.mjs
src/stepup-release.mjs
src/stepup.mjs
src/ui-assets.mjs
src/worker.mjs
tests/enrollment-browser.test.mjs
tests/production-stepup.test.mjs
tests/stepup-fixtures.mjs
tests/stepup.test.mjs
wrangler.enrollment.toml
```

The pre-existing untracked `mail-desk/node_modules` symlink remains unchanged. The owner dependency symlink was replaced only locally with isolated dependencies, without changing its external target. Temporary test/bundle artifacts live under `/tmp`; no git commit was made.
