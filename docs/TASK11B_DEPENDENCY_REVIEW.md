# Task 11b dependency review — 2026-10-21

Pre-deployment preparation only. The five high audit findings are remediated by removing their dependency chain, not by claiming a patched braces release. No force, dependency override, warning suppression, lint exclusion, or runtime application change was used.

## Evidence and selection

The initial installed packages (all root `node_modules/<package>`) were:

```text
eslint-plugin-astro 1.7.0
└─ astro-eslint-parser 1.4.0
   └─ fast-glob 3.3.3
      └─ micromatch 4.0.8
         └─ braces 3.0.3
```

The baseline manifest had no root lockfile. Resolving it and running `npm audit --include=dev --json` reproduced five high findings, one underlying advisory, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). As checked October 21, the advisory affects braces <=3.0.3 and lists no patched release; the registry's latest braces is 3.0.3. Deep brace patterns can exhaust the Node stack. These are development lint dependencies, not a public application request path. Avoid processing unreviewed lint configurations/glob inputs with the former toolchain.

Registry metadata (`npm view ... --json`) showed:

- Latest plugin 1.x is 1.7.0; parser 1.x is 1.4.0. Both retain the chain. A patch/minor update within the original range does not fix it.
- Plugin 2.1.1 accepts parser ^2.0.0. Parser 2.0.0 still uses fast-glob; parser 2.1.0 replaces it with tinyglobby ^0.2.17. The lockfile resolves 2.1.0.
- Plugin 2.1.1 requires ESLint >=10; its TypeScript parser and JSX accessibility peers are optional. This project did not enable those integrations before and does not remove any now.
- Latest plugin 3.2.1/parser 3.2.0 also use a clean glob chain, but introduce another major plugin/compiler migration. They are unnecessary for this fix.

Selected exact direct pins: `eslint-plugin-astro@2.1.1`, `eslint@10.13.0`. Retain the existing `@eslint/js` ^9.0.0 recommended preset (locked 9.39.5), globals ^16, and unchanged eslint.config.js. The plugin/runtime pairing is supported by published peer metadata. This upgrades the runtime without importing unrelated new core recommended rules into Mail Desk. An evaluated @eslint/js 10 preset produced nine preserve-caught-error errors in Mail Desk; that preset was not retained. No source or lint suppressions were added to accommodate it.

Before/after `eslint --print-config src/pages/members/request.astro` comparison: every one of the original 69 rules remains enabled, including all eight Astro rules; final count 72 with eleven Astro rules. ESLint 10 expands default option serialization for no-unused-vars and no-constant-binary-expression; no-shadow-restricted-names additionally checks globalThis. Original eslint.config.js and its file coverage remain unchanged. Full repository lint passes, including Mail Desk and canary files. Negative stdin probes independently confirm Astro set:html/child-content conflicts and undefined JavaScript identifiers still produce lint errors. This is preservation of the existing core policy, not adoption of every future recommended rule.

## Reproducibility and validation

The original claim that the entire graph was integrity pinned was incorrect: local base `6edf85e640e77847e442718a0a9c1e11f383bcf6` had 483 nonroot entries, of which 337 lacked both `resolved` and `integrity`. Passing `npm ci` and CI did not establish complete integrity coverage. This was treated as a release blocker.

Codex regenerated the v3 lockfile using Node **24.22.0** and npm **10.9.4** in a newly created `/tmp/bss-task11b-lockrepair/clean-project.MRbAWy` directory outside the repository. Its only initial file was a byte-identical copy of root `package.json`; it had no `node_modules` or old lockfile. Command: `npm install --package-lock-only --ignore-scripts --include=dev --include=optional --registry=https://registry.npmjs.org`, using a fresh temporary npm cache. Sandbox DNS initially failed; the successful generation used registry network access. Only the generated and verified lockfile was copied into the repository. No integrity value was fabricated; no manifest change, override, or force update was used.

Measured coverage after repair:

| Classification | Count | Evidence / exception reason |
| --- | ---: | --- |
| Nonroot package entries | 483 | All are registry tarball packages. Root project metadata is excluded. |
| Registry entries with `resolved` and SHA-512 `integrity` | 483 | Every URL and hash independently matched that package version's public registry `dist.tarball` and `dist.integrity`. |
| Missing `resolved` / missing `integrity` | 0 / 0 | Any missing registry integrity fails the verification. |
| Entries marked optional | 107 | All have both fields; optional status alone is not an exception. |
| Entries restricted by OS | 99 | All have both fields; these overlap the optional count. |
| Link / workspace / bundled / metadata-only nonroot exceptions | 0 | No such entries exist in this lockfile; no exception was needed. |

Package name/version multiplicities, dependency declarations, engines and all 746 ordinary/optional/peer resolution edges match the original lockfile. Existing resolved URLs and hashes are unchanged. npm's clean resolver hoisted `ansi-styles@6.2.3` from `wrap-ansi/node_modules` and `supports-color@10.2.2` from `@poppinss/dumper/node_modules` to root `node_modules`; these are layout changes with identical dependency targets, not version changes. Direct manifest, `.nvmrc`, CI workflows, application code, production configuration, and separate Mail Desk/canary lockfiles remain unchanged by this repair.

`npm ci --include=dev --include=optional` then removed the existing root installation and installed cleanly with scripts enabled: 391 packages installed, 392 audited including the project. The smaller installed count reflects platform selection; all 483 registry entries, including other platforms, remain integrity pinned in the lockfile. The lockfile stayed byte-identical after installation. No fast-glob, micromatch, or braces exists in the root lockfile or installed dependency tree.

Evidence is retained under `/tmp/bss-task11b-lockrepair/evidence`, with verification scripts in its parent directory and implementation report `/tmp/BSS_TASK11B_LOCKFILE_REPAIR_REPORT.md`. Confidence is high for complete lockfile registry integrity coverage and unchanged dependency resolution, based on exhaustive structural checks and registry metadata comparison. This does not prove execution on every supported OS or absence of future advisories; independent review of the newly published exact PR head is still required.

`.nvmrc` pins Node 24.22.0; engines constrain this tested 24.22.x line and npm >=10.9.4 <11; packageManager records npm 10.9.4. Astro 7.4.2 requires Node >=22.23.4 and npm >=9.6.5. Plugin/parser 2.x require ^22.22.3 || ^24.16.0 || >=26.3.0. Node 24.22.0/npm 10.9.4 satisfy both. Host Node 22.22.1/npm 9.2.0 do not; validation used a temporary Node binary and npm under /tmp, with no global changes. A packageManager field alone does not enforce npm selection.

The root GitHub workflow now reads .nvmrc, installs npm 10.9.4 into the runner's temporary directory, uses npm ci, audits both graphs, builds/lints, and runs membership/public/owner tests. No deployment job or credential was added. Other service workflows are unchanged.

Verified locally:

- Full `npm audit --include=dev`: zero vulnerabilities; `npm audit --omit=dev`: zero vulnerabilities. Registry availability is required; a failed query is not a clean audit.
- `npm run validate`: lint, Astro check and production build pass; Astro check reports 0 errors, 0 warnings and 81 hints. Build/content sync also emits missing-content glob warnings for the existing empty austin/agents/newsletter collections. No source changes were made for these diagnostics.
- Membership 74/74; public regressions 16/16; owner 100/100; owner syntax check passes.
- Public and offline owner Wrangler 4.151.3 dry-run bundling pass (run the owner command inside owner-launchpad because its tsconfig is relative to working directory). Logs were redirected to `/tmp` after an initial read-only log-path error; both reruns exit 0 without that error. No remote bindings validated or provisioned.

## Owner monitoring gate

Coordinator must independently rerun clean install, both audits and all validation on the exact PR head before Gate 1 approval. A new advisory, engine mismatch, parser failure or lost rule coverage blocks that gate until investigated; do not substitute a force update or suppress the failure. Recheck registry/advisory on dependency changes and immediately before deployment; schedule a monthly owner review after acceptance. Owner records reviewer/date/head/audit results. The original five findings do not require a residual-risk waiver for this resolved graph, but zero current advisories is not a guarantee of future safety. If any finding returns without a compatible fix, retain working lint, document exposure/containment and require explicit time-bounded owner risk acceptance before proceeding; never label it fixed.
