# Policy-source assurance — local implementation, release blocked

The design review at `/tmp/task10-policy-auth-design-review.txt` conditionally
accepted a reviewed deployment snapshot design. Actual independent evidence is
incomplete. This implementation is not MFA proof or a release PASS.
`PRODUCTION_POLICY_RELEASE = null` denies policy authentication and configuration.
The production Worker still fixes real `authenticate`, native `fetch`, and
`dispatchAuthorized:false`. The current diagnostic, deployment configuration,
migration, Mail Desk, customer send blocks and public sites are untouched.
No live account facts were verified or populated. All fixture values are invented.

`MFA_CONTRACT=reviewed-policy-release-v1` selects a distinct policy-source contract;
it does not establish evidence. The original `signed-amr-mfa-v1` verifier still
requires signed AMR containing `mfa`. Missing AMR never establishes MFA.
Neither contract proves the timestamp of a particular independent MFA event.
Policy assurance is bounded by reviewed effective enforcement and cutover evidence,
with stolen bearer-token and upstream session/refresh risks remaining.

The code-owned snapshot has exactly these fields (no additional fields):

| Field | Required meaning / constraint |
| --- | --- |
| `contract` | Exact `reviewed-policy-release-v1` |
| `accountId` | Exact independently reviewed account, 32 lowercase hex characters |
| `appId`, `policyId` | Exact reviewed application/policy UUIDs |
| `audience` | Exact owned app audience; bounded ASCII, 16–256 characters |
| `issuer` | Exact HTTPS team Cloudflare Access issuer |
| `origin` | Exact canonical HTTPS origin, at most 2048 ASCII characters |
| `ownerSub`, `ownerEmail` | Exact signed owner identity; bounded ASCII, 256/254 characters |
| `effectivePolicyDigest` | `sha256:` plus 64 lowercase hex characters; full canonical nonsecret effective evidence artifact |
| `sessionCutoff` | Nonnegative safe integer issuance cutoff, no later than `validFrom` |
| `validFrom`, `validUntil` | Nonnegative safe integer seconds; positive window at most 600 seconds; start inclusive, end exclusive |
| `evidence` | Exact five-reference object described below |

`evidence` requires `completeEffectivePolicy`, `independentMfaEnforcement`,
`sessionCutover`, `configurationFreeze`, and `independentReview`. Each is an
immutable nonsecret artifact reference in `sha256:<64 lowercase hex>` form.
Keep the content-addressed artifacts accessible to independent reviewers outside
this runtime. No credentials, JWTs or secret evidence belong in source.

The effective evidence artifact must cover the **whole** effective configuration:
raw complete successful enumerations and identities, pagination completeness,
reusable policies, app/organization precedence and overrides, interpretations and
supporting authoritative semantics, session/refresh investigation, cutover and
freeze records, and independent reviewer findings. Canonicalize the complete
nonsecret artifact as RFC 8785 JSON before hashing; do not digest only selected
Allow/MFA fields or a summary boolean. Runtime validates reference syntax and
binds the digest; it cannot inspect artifact content, prove completeness, or
independently establish external semantics. Those are explicit release gates.
The separate release digest covers the fixed-order validated snapshot JSON,
including all five evidence references. It is not the effective artifact digest.

A subsequent separately reviewed source change must populate exact values and
freeze the code-owned snapshot and its evidence object. Environment, HTTP,
credentials, API reads and imported test fixtures must never supply this snapshot.
Offline factories/resolver/clock/release seams exist only for local tests. The
production default accepts none of them from request or environment.

Both verifiers use RS256, configured pinned JWKS, exact issuer/sub/email/type,
scalar or singleton exact audience, and mandatory nonnegative safe-integer
`nbf`/`iat`/`exp`. No future issuance or not-before, expiry must be future, and
positive lifetime/age are bounded to 600 seconds with zero clock tolerance.
`nbf` may precede `iat`. Service credential headers and service identity claims
are rejected by presence, including empty/null values. JWT headers allow only
`alg:RS256`, bounded ASCII `kid` and optional `typ:JWT`, before key resolution;
claims never select a URL/key source. Optional AMR must be structurally valid;
only the original AMR verifier uses it as its assurance contract.

Policy verification additionally requires all configured identity/origin values
to equal the reviewed snapshot, and `iat > sessionCutoff`. Identity expiry is
`min(token.exp, release.validUntil)`. It returns an immutable named assurance with
release digest, effective evidence digest, cutoff and window. The coordinator
recomputes that binding from its own code-owned snapshot, rejects missing or
mismatching assurance, and stores the full snapshot and assurance in the immutable
ledger snapshot covered by the capability/configuration digest. Changing evidence,
app/account/policy, cutoff, or window invalidates an existing intention. Mode
changes cannot adopt an existing intention. Exact JWT/cookie binding, five-minute
maximum intention, ordered approvals and permanent singleton remain enforced.
Identity/evidence expiry is rechecked immediately before durable claim and before
transport. Expiry during claim consumes the slot as UNKNOWN without transport;
it never opens a retry. The diagnostic is never imported as a sending verifier.

Before any policy release authority exists, independent review must establish:

1. Exact account, app `548572b1-8ec0-4a3a-997b-f156e853bba9`, policy
   `6f4e520c-d8d6-42cc-abcd-b7da1ec489bf`, audience ownership, intended origin,
   issuer `https://old-hill-995d.cloudflareaccess.com`, signed owner subject
   `19e39702-51ab-52dc-9172-91bcb059ec5d` and email `fridman.greg@gmail.com`.
   These identifiers come from the supplied review, are not verified here, and
   are not a populated production contract. Verify all independently.
2. Complete applicable policy set, every page and reusable reference: exactly
   the reviewed owner Allow and exact email selector, no broad, bypass, service,
   nonidentity or additional authorization path. App lifetime exactly ten minutes.
3. Supported effective independent MFA semantics, including `mfa_disabled:false`
   and `session_duration:"0m"`, organization matching/precedence/overrides and
   reviewed independent authenticators. Settings alone are not self-proving;
   Google/email OTP as initial IdPs do not prove second-factor independence.
   Missing, unsupported, ambiguous or unresolved inherited settings deny.
4. Finalize and verify enforcement, revoke app sessions, and record a conservative
   cutoff. Investigate global Access sessions, MFA sessions and refresh: a fresh
   app `iat` and app-session revocation alone are insufficient. Revoke relevant
   upstream sessions or establish mandatory reauthentication under final policy.
5. Independently reviewed immutable evidence and a short explicit release window,
   with configuration frozen throughout it. Any relevant change immediately
   invalidates authority and pending intentions: disable the service/route, never
   extend deadlines or refresh snapshots automatically. A snapshot is not live
   introspection or instantaneous drift detection. If a freeze cannot be maintained,
   this release approach is insufficient; runtime checks need separate design.

Private exposure boundaries, dedicated D1/binding and permanent-row retention,
actual runtime behavior, credential/sender scope, recipient/content and release
review remain required. Evidence completion does not remove the hardcoded send
block. Any later release change needs independent review. Provider acceptance
still does not establish inbox delivery or SPF/DKIM/DMARC. This work performs no
network, credential access, deployment, migration, remote D1 or sending action.

Local validation on 2026-10-16 (Node 22.22.1), uncommitted:

- Full owner-canary suite: **472/472 passed**, including all 317 existing tests
  and 155 added policy/signature/adversarial/coordinator tests; zero skipped.
- Full Mail Desk suite: **481/481 passed**, zero skipped.
- Both package `check` scripts passed; canary check now includes the policy module.
- Root ESLint 9.39.1 passed across this worktree using the existing offline tools,
  a byte-identical repository ESLint configuration, and the tools' `NODE_PATH`.
  The initial attempt without `NODE_PATH` failed dependency resolution
  (`Invalid Version: main`); no package install was performed.
- Root `npm run check` could not run: `astro: not found` (root dependencies absent).
  No root Astro check/build success is claimed.
- `git diff --check` passed; protected baseline blob tests passed. Diagnostic
  source/config, migrations, Mail Desk and public website/launchpad have no diff.

Tests use generated local RSA keys, invented evidence references and temporary
SQLite ledgers; global network fetch is blocked and transport is stubbed. No
live assurance, deployed behavior or release authorization is established by them.
Preexisting untracked dependency symlinks remain untouched.
