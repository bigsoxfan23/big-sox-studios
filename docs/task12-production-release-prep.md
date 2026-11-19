# Big Sox Studios Task #12 — production-only release preparation

Date: November 18, 2026 (Central). Source-only candidate branch `task12/production-prep-20261118`, based on the existing stacked draft PR #80 at `e56ae82580be7daca33af45af34aa9ef6ad06737`. **Not merged or deployed**. No new production member accounts or emails.

## What is already accepted

Existing STAGING Owner MFA, controlled OTP Member first login, one provider-accepted welcome for the disposable fixture, Owner revocation, and same-browser-session application denial. Screenshot displayed "Access unavailable" but raw HTTP status was not captured. All temporary Access rules were removed; original two staging policies remain. Original historical live welcome `UNKNOWN` stays locked; never retry it. All Jellyfin and service grants remain zero.

## Why source and deployment are separated

The existing approved OTP entrypoint and Member dashboard contain exact STAGING hostname, Access audience, and staging D1 IDs. **Never deploy that staging entrypoint to production.** The source-only production entrypoint under `members-portal-production/` enforces a separate origin, distinct production Access JWT audience, existing production Requests D1 ID, newly created isolated production Members D1 ID, and an explicit `PORTAL_PRODUCTION_MODE=reviewed-production-12` gate. The supplied Wrangler example deliberately has placeholder IDs, no route, no direct workers.dev access, and the production gate disabled. It must be impossible to accidentally activate or provision an account simply by deploying the example.

The companion Owner example keeps the existing production Requests D1 and is also not deployable until its fresh Members D1 placeholder is replaced. The current production Owner Worker must retain its existing encrypted secrets, MFA settings, and live traffic until the verified candidate can be switched over. Welcome live sending stays disabled.

## Exact intended production boundaries

- Members hostname: `members.bigsoxstudios.com`. Set Cloudflare Access app and policy **before** any public Worker domain/DNS route becomes reachable. Require Cloudflare-approved One-time PIN and MFA; exclude broad emails and public authentication paths.
- Production Owner hostname: existing `owner.bigsoxstudios.com`, Access audience `e558d6d6d467575e87242a666242f508dc6355e5d0f14f07bb9fa0a808e5b7c0`, MFA unchanged.
- Production Requests D1: existing `21e13fa1-0ab3-4573-8d20-983c847ba0e9`, preserve all current records/audit ledger, backup before any mutation.
- Production Members D1: new isolated `bss-members-portal-production` to be created only after independent review; bootstrap with `portal/schema.sql` and migrations 0001 then 0003–0007 after schema inspection (0002 already represented in base). Do not copy staging Members, audit, invitations, test receipts or secrets.
- Members Worker: `big-sox-studios-members`, `workers_dev=false`, `preview_urls=false`, no custom domain until Access and D1 checks. Must bind `DB` to new Members D1 and `APPROVED_REQUESTS_DB` only to existing Requests D1, with distinct database IDs and exact `APPROVED_MEMBER_DB_ID` and `BOOTSTRAP_DATABASE_ID` equal to that new Members D1.
- Existing public site `big-sox-studios` uses GitHub-triggered Workers Builds on `main`. The 14 stacked draft PRs #67–80 are 38 commits / 69 files versus `main` and a merge can auto-deploy public production: verify a rollback version and releases as one integrated change.
- Secrets must be managed through encrypted Worker bindings; do not write tokens, passwords or SMTP/API credentials in Git, Notion or output logs. No paid additions.

## Independent candidate review feedback and engineering corrections

An initial bounded Codex security review of the SOURCE-ONLY production candidate found two MED issues (no production Member admission hold before approved-request withdrawal, and a production Owner Mail Desk link that led to a staging environment). ChatGPT implemented the following corrections in this branch, **after** that review:

- For production Owner origins, `withdrawalHoldRequired` is true even if onboarding flags have been downgraded. The existing durable Member hold must commit before the Requests D1 withdrawal CAS; without a properly bound production Members D1 and verified Owner config, withdrawal is denied rather than allowed to race activation. Production `onboardingApi` now requires distinct exact production Request ID, new Member D1 and a reviewed production-only flag. Staging source pins and behavior remain unchanged.
- Until a separate production Mail Desk and Access app are verified, the Owner dashboard shows a non-clickable “Mail Desk — Not connected in production yet” card; it cannot link production correspondence to a staging service. The production Owner config uses a same-origin placeholder that is never rendered as a live navigation link.
- New source tests cover production withdrawal holding despite disabled flags, staging compatibility, lack of D1 fail-close and non-staging production links. A fresh independent Codex re-review of the final source-only candidate returned **GO for SOURCE ONLY**: all four confirmed MED findings were resolved; no new HIGH/MED confirmed in its bounded scope. This is **not** a go-ahead to deploy; separate D1, Access, binding, DNS and runtime acceptance remain mandatory.

## Release gates before any production mutation

1. Complete independent Codex review of exact PR stack and this subsequent production-prep diff (Codex full review reached subscription quota on November 18 and produced **no final verdict**); fix HIGH/MED issues. Source-only local tests do not substitute.
2. Verify exact prod Workers, production D1 backup/recovery, immutable hold triggers and database migrations in isolated SQLite; confirm no data copied from staging.
3. Provision a restricted Members Access app and one-time PIN/MFA policy; obtain its new exact Access audience, then fill the deploy **candidate** configuration only. Do not use a staging audience. Verify secure routing and exact Cloudflare bindings.
4. Upload inactive Member Worker candidate and preserve exact versions. Before serving traffic, check host-only 404, unconfigured 503 and no-session 403 behavior; verify production-mode switch remains disabled until explicit reviewed acceptance.
5. Prepare Owner Worker candidate with both correct production D1s and no real welcome sending; independently check Access audience, secrets, rollback and D1 consistency.
6. Integrate/merge in dependency-safe order and monitor public-site auto deployment. Activate protected Members route only after all safeguards. Run Owner MFA and Member OTP browser tests with authorized identities, verify no grants or welcome sends unless deliberately reviewed, and check revocation and first-login failure cases.
7. Independently verify and document precise merge commits, Worker versions, Access app (no secret), D1 IDs, tests and rollback. Task12 stays IN PROGRESS until technical acceptance proven; Greg's explicit Owner acceptance is separate.

## Verified local and independent source evidence

- Source base: existing draft PR #80 `e56ae82580be7daca33af45af34aa9ef6ad06737`, exact Git tree `91faf50ad24c7a7397f9154dc1d6735d25c94b5f`. Production candidate is on a separate unmerged branch.
- Initial unified Codex review: exceeded quota, log preserved privately, no verdict. Replacement three bounded independent reviews of the PR #67–80 integrated source covered OTP/JWT and admission, D1/Owner/withdrawal, and welcome/provider/public Worker changes. Each found no confirmed HIGH/MED in its bounded scope; caveats and external infrastructure gaps remain. They are collectively a **source review**, not deployment acceptance.
- Initial independent production-candidate review: two confirmed MED findings (production hold gap; production Mail Desk staging link). First re-review: hold and mail fixed, discovered two further staging destinations (Member directory and welcome preview). Final independent Codex follow-up: **SOURCE-ONLY GO**, all four MED paths corrected; production synthetic rendering/hold probes positive, no new HIGH/MED. Reviewer test subset 54/55 PASS, the remaining local workerd sandbox bind test failed with `EPERM` (not a positive runtime acceptance).
- ChatGPT separate regression execution after source fixes: Members/portal **364/364 PASS**, Owner **246/246 PASS**, and public/notify tests not requiring a built `dist` **225/225 PASS**. Full public static build was not rerun locally because the available OptiPlex Node `22.22.1` is below Astro's required `>=22.23.4`; its three built-site test files need the generated `dist`. Run complete build and CI against the new draft PR using supported Node before any merge. Existing PR #80 Validate run `42962842767` was SUCCESS, but does not cover this new branch.
- No live or staging production Worker, D1, Access policy, MFA, mail credential, member or PR merge changed by this candidate review. No new spending.

## Current safety status

This is **preparation only**. No D1 was created, Worker uploaded, Access policy altered, DNS record added, PR merged or production deployment made in this phase. The production entrypoint and new member-dashboard dual-origin guard have not yet received independent review or authenticated production runtime testing. Do not switch the config flag from `disabled-before-verified-release` until those prerequisites are verified.
