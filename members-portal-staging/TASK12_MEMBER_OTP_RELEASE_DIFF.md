# Task12 Member OTP release diff — DRAFT / NOT APPROVED

Source implementation: this actual Codex CLI session, 2026-11-01, starting at
`a35181de6085918e4312966da58c9818668a6836` (draft PR77). This increment adds only
the future entrypoint and synthetic denial tests. Existing assembly, auth,
`worker.mjs`, configs and deployment are unchanged. No network, credentials,
Cloudflare API, remote D1, real email/Member actions, deploy, push or spending.

This delta supplements the [PR76 staging gates](../portal/TASK12_MEMBER_OTP_STAGING_GATES.md),
which remain the release/acceptance contract. **No ready-to-run activation
scripts:** exact approved Member emails and explicit Owner approval are missing.

The following is the **verified current Cloudflare snapshot supplied for this
task**, consistent with PR76, not a fresh live inspection by this session:

| Existing resource | Preserved snapshot |
| --- | --- |
| Member Access app | `42fd6150-5f0e-4a1c-a0ba-952148b73b18` |
| Exact Owner allow policy | `b3cf1b27-c1ac-4a7a-adb7-f31c344b47a0`, precedence **1** |
| Controlled recipient policy | `9c7c5212-f937-49b8-9e8b-38bd025ab8e9`, precedence **2** |
| Member Worker | `big-sox-studios-members-staging`, active version `4010b907-c453-4867-b0c9-f300cf115095`; remains legacy |
| Existing Member D1 binding | `DB=43a8a15b-e195-4712-9198-1dcc9f0152af` |

Future Access delta, separately approved: add an exact allow-email Member policy
at precedence **3**, requiring `login_method` for One-time PIN IdP
`60daf8e5-5b08-4fb3-9746-76f8ac5046b7`. No Everyone/domain selectors or overlap
with Owner or controlled recipient addresses. Offering OTP alone is insufficient;
Google must fail that Member policy. A possible policy-specific independent MFA
waiver needs explicit Owner approval and effective-policy precedence verification.
**Never disable application MFA or Owner MFA, or disable the Access app.** Preserve
both existing policies and the separate Owner Access application.
References: [login method policy requirement](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)
and [MFA policy override/precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/).

Future Worker source must be **`approved-otp-release-entry.mjs`**, which default
exports `createApprovedOtpAssembly()`; the current `worker.mjs` stays disabled for
`/app`. No existing config selects this future entrypoint. Preserve and inherit
**all existing Worker secrets/vars**, without overwriting them; retain existing
bindings and add only the reviewed requirements below. If an inherited value
conflicts with a source pin, stop for review rather than silently replacing it.

| Future required binding/var | Exact value/type |
| --- | --- |
| `PORTAL_APPROVED_OTP_ASSEMBLY` | `reviewed-staging-12` |
| `PORTAL_APPROVED_MEMBERS` | `enabled-12-approved` |
| `PORTAL_SIMPLIFIED_MEMBER_UI` | `enabled-12` |
| `APPROVED_REQUESTS_DB` | D1 binding to `48b0a0cc-40ad-4495-8883-a42b4a938b71`, separate from `DB` |
| `APPROVED_REQUESTS_ID` | `48b0a0cc-40ad-4495-8883-a42b4a938b71` |
| `APPROVED_MEMBER_DB_ID` | `43a8a15b-e195-4712-9198-1dcc9f0152af` |
| `BOOTSTRAP_DATABASE_ID` | `43a8a15b-e195-4712-9198-1dcc9f0152af` (also required by the assembly guard) |
| `APP_ORIGIN` | `https://members-staging.bigsoxstudios.com` |
| `ACCESS_ISSUER` | `https://old-hill-995d.cloudflareaccess.com` |
| `ACCESS_AUDIENCE` | `f3ad2eeca58fc7e607b96e47b28672b78a920d34474f97a15e56a6235fc1cdbe` |
| `OWNER_ACCESS_AUDIENCE` | `e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0`, distinct from Member audience |
| `OTP_CUSTOM_HOSTS` | Typed JSON array `["members-staging.bigsoxstudios.com"]` |

`OTP_CUSTOM_HOSTS` **must use a JSON binding/structured env var**, never a text
binding containing a hostname or serialized JSON: the source requires
`Array.isArray`. See [Workers JSON environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/#json-values).
All pins must match [the assembly](approved-otp-assembly.mjs); bindings must be
real, distinct D1 objects in a future approved release. Flags do not replace
signed JWT verification, exact host/audience/issuer, runtime OTP identity or fresh
D1 authorization. The added tests use **no JWT**, trap identity/D1 access, and
exercise config denial, typed-array rejection, host denial and legacy safe-off.

Before any separately authorized activation, revalidate the complete app/policy
snapshot, source-to-Worker mapping, inherited env, D1/schema readiness, backups
and PR76 acceptance gates. Record the policy snapshot for rollback. Rollback,
under separate release authorization, restores Worker version
`4010b907-c453-4867-b0c9-f300cf115095` and the pre-change Access policy snapshot
(including precedence and MFA); verify legacy behavior and Owner protection.
Rollback never rewrites User email/Identity or invents a Member/D1 reversal.

No User email/Identity change is authorized. Manual Jellyfin provisioning and an
explicit manual Jellyfin service grant, a **live accepted welcome** receipt, real sends, real
Member activation, browser acceptance and any staging/production release each
remain separately approved work. A simulated welcome cannot admit a Member;
login grants no Jellyfin access. Task12 remains in progress.

Local validation: Node 24.22.0 syntax checks and focused ESLint passed; all 3 new
tests and 100 existing targeted tests passed (7 assembly SQLite/guard cases,
14 legacy Worker cases, 79 PR76 readiness cases). The initial new test's legacy
noindex-header assertion was corrected only in the new file. Two existing workerd
cases could not run (`listen EPERM 127.0.0.1`); the successful assembly rerun used
`--test-skip-pattern='workerd D1'`. No escalation or existing-source fixes;
no full-suite run or live/browser acceptance is claimed.
