# Pilot dependency and quality verification

Scope: Cloud Nexus Pilot frontend and realtime service only. Earlier broader attempted manifests/lock are archived as evidence; those sibling/generic manifest changes were restored exactly to HEAD. Final scope assertions in `final-scope-review.json` prove unchanged sibling manifests and private lock entries. Shared URI/router lock patches remain because Pilot realtime reaches those exact shared packages.

## Verified final checks

- Clean `npm ci` exit0; actual supported ESLint10.13.0 for both Pilot workspaces. Realtime @eslint/js10.0.1 and existing TS-eslint8.57.1 support it. Node22.23.3 satisfies engine requirements.
- Pilot Next15.5.28; realtime Fastify5.12.7 and Zod4.6.7; actual Next/PostCSS8.5.32 verified by `npm run check:pilot-dependencies` and a CI step after npm ci.
- Both lint checks exit0; realtime strict typecheck exit0; realtime test command compiles and passes57 tests.
- Operations34/34 pass, including two new lock-contention tests. Harness doubles flock just as its other external commands; production Linux lock code is untouched. These are control-flow tests, not physical Linux kernel lock qualification.
- Active WebSocket smoke cases now have a bounded2s deadline; intentionally silent-timeout case retains150ms. Premature-close fixture terminates immediately. Existing failure assertions unchanged.

## Dependency audit disposition

Final scoped runtime audit: **exit0, zero reported findings** for `apps/cloud-nexus-pilot` and `apps/pilot-realtime-api`. This is registry audit evidence, not a claim that all vulnerabilities or production risks are absent.

Final whole-monorepo runtime audit: **exit1, seven package entries: one critical and six high**. None silently waived. The following remain outside assigned Pilot artifacts and block whole-monorepo promotion until separately authorized remediation. Full payload carries all advisories and exact paths.

| Package | Severity | Exact installed paths/version | Advisory references | Disposition/relevance |
|---|---|---|---|---|
| fastify | high | `node_modules/fastify` (5.10.0) | https://github.com/advisories/GHSA-3m5p-2c4r-xxw2; https://github.com/advisories/GHSA-4mh8-r7rc-xpvc; https://github.com/advisories/GHSA-667r-xxjv-c9mm; https://github.com/advisories/GHSA-9q9j-q6p8-xq58; https://github.com/advisories/GHSA-hwr6-493r-vm6h; https://github.com/advisories/GHSA-p68q-wchp-6fh7; https://github.com/advisories/GHSA-w2qp-rph6-63g4 | Generic API: separately validate Fastify5.12.7; no runtime manifests outside Pilot were changed. |
| nanoid | high | `apps/ai-automation-agency/node_modules/nanoid` (3.3.11); `apps/cloud-nexus-market/node_modules/nanoid` (3.3.11); `apps/cloud-security-digital-factory/node_modules/nanoid` (3.3.11); `apps/devops-automation-agency/node_modules/nanoid` (3.3.11) | https://github.com/advisories/GHSA-28wg-ghj8-5hjv; https://github.com/advisories/GHSA-2v37-7h3g-55p8; https://github.com/advisories/GHSA-xwg4-73v4-xw9w | Sibling frontend paths: separately update3.3.20 within3.x. |
| next | critical | `apps/ai-automation-agency/node_modules/next` (15.2.6); `apps/cloud-nexus-market/node_modules/next` (15.2.6); `apps/cloud-nexus-pilot/node_modules/next` (15.5.28); `apps/cloud-security-digital-factory/node_modules/next` (15.2.6); `apps/devops-automation-agency/node_modules/next` (15.2.6) | https://github.com/advisories/GHSA-2464-fhr4-w9xw; https://github.com/advisories/GHSA-267c-6grr-h53f; https://github.com/advisories/GHSA-26hh-7cqf-hhc6; https://github.com/advisories/GHSA-2xp9-vwfh-vxw4; https://github.com/advisories/GHSA-36qx-fr4f-26g5; https://github.com/advisories/GHSA-3g8h-86w9-wvmq; https://github.com/advisories/GHSA-3x4c-7xq6-9pq8; https://github.com/advisories/GHSA-4342-x723-ch2f; https://github.com/advisories/GHSA-4633-3j49-mh5q; https://github.com/advisories/GHSA-4c39-4ccg-62r3; https://github.com/advisories/GHSA-4jqv-mc3x-m676; https://github.com/advisories/GHSA-68g3-v927-f742; https://github.com/advisories/GHSA-89xv-2m56-2m9x; https://github.com/advisories/GHSA-8h8q-6873-q5fj; https://github.com/advisories/GHSA-955p-x3mx-jcvp; https://github.com/advisories/GHSA-9g9p-9gw9-jx7f; https://github.com/advisories/GHSA-c4j6-fc7j-m34r; https://github.com/advisories/GHSA-ffhc-5mcf-pf4q; https://github.com/advisories/GHSA-g5qg-72qw-gw5v; https://github.com/advisories/GHSA-ggv3-7p47-pfv8; https://github.com/advisories/GHSA-gx5p-jg67-6x7h; https://github.com/advisories/GHSA-h25m-26qc-wcjf; https://github.com/advisories/GHSA-h64f-5h5j-jqjh; https://github.com/advisories/GHSA-m99w-x7hq-7vfj; https://github.com/advisories/GHSA-mcj8-r9mp-w47p; https://github.com/advisories/GHSA-mg66-mrh9-m8jx; https://github.com/advisories/GHSA-mwv6-3258-q52c; https://github.com/advisories/GHSA-p293-qw3h-jr36; https://github.com/advisories/GHSA-p3m5-59mp-jv5r; https://github.com/advisories/GHSA-p9j2-gv94-2wf4; https://github.com/advisories/GHSA-q4gf-8mx6-v5v3; https://github.com/advisories/GHSA-vfv6-92ff-j949; https://github.com/advisories/GHSA-w37m-7fhw-fmv9; https://github.com/advisories/GHSA-wfc6-r584-vfw7; https://github.com/advisories/GHSA-xv57-4mr9-wg8v | Four sibling frontend paths: separately apply Next15.5.28 and associated tests. |
| postcss | high | `apps/ai-automation-agency/node_modules/next/node_modules/postcss` (8.4.31); `apps/cloud-nexus-market/node_modules/next/node_modules/postcss` (8.4.31); `apps/cloud-security-digital-factory/node_modules/next/node_modules/postcss` (8.4.31); `apps/devops-automation-agency/node_modules/next/node_modules/postcss` (8.4.31) | https://github.com/advisories/GHSA-6g55-p6wh-862q; https://github.com/advisories/GHSA-fxqj-rqcc-2cmp; https://github.com/advisories/GHSA-qx2v-qp2m-jg93; https://github.com/advisories/GHSA-r28c-9q8g-f849 | Sibling paths: separately apply PostCSS8.5.32; Pilot override is scoped to Next15.5.28. |
| sharp | high | `apps/ai-automation-agency/node_modules/sharp` (0.33.5); `apps/cloud-nexus-market/node_modules/sharp` (0.33.5); `apps/cloud-security-digital-factory/node_modules/sharp` (0.33.5); `apps/devops-automation-agency/node_modules/sharp` (0.33.5) | https://github.com/advisories/GHSA-f88m-g3jw-g9cj; https://github.com/advisories/GHSA-rgj7-g3m4-5g8c; https://github.com/advisories/GHSA-wq5f-xc86-pv6w | Sibling image-optimizer paths: separately qualify Sharp0.35.5 through patched framework family. |
| source-map-js | high | `apps/ai-automation-agency/node_modules/source-map-js` (1.2.1); `apps/cloud-nexus-market/node_modules/source-map-js` (1.2.1); `apps/cloud-security-digital-factory/node_modules/source-map-js` (1.2.1); `apps/devops-automation-agency/node_modules/source-map-js` (1.2.1) | https://github.com/advisories/GHSA-68fv-2mgg-jv7q | Sibling paths: separately update1.2.2. |
| zod | high | `node_modules/zod` (3.25.76) | https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 | Generic API/shared package: reviewed4.6.7 migration required; one-argument z.record in shared contract needs adaptation and contract tests. Pilot realtime4.6.7 already verified. |

Pilot patches do not alter unrelated app source or reclassify the remaining package findings as fixed. No exploit, paid provider call, deployment or shared database mutation was executed.

## Lockfile maintenance

npm10 nested regeneration retained Next's stale pinned PostCSS despite the scoped override. Only the Pilot Next/PostCSS lock record was reconciled from the canonical registry-integrity-backed8.5.32 record already in the lock; no vendor source was edited. Fresh npm ci accepted the lock and installed8.5.32. `postcss-lock-reconciliation.json` records the change. The added installed-dependency contract fails if a later install/regeneration silently restores a different version. Re-review the override and advisory ranges before future dependency updates.

## Official compatibility sources

- https://eslint.org/version-support/ — ESLint9 EOL,10 current.
- https://eslint.org/docs/latest/use/migrate-to-10.0.0 — Node22.13+ required; actual22.23.3 verified.
- https://typescript-eslint.io/users/dependency-versions/ — current10 peer compatibility; exact8.57.1 registry peers saved.
- https://github.com/vercel/next.js/releases/tag/v15.5.28 — security release retained within existing major15.
- https://github.com/fastify/fastify/releases/tag/v5.12.7 — current5.x patch family.
- https://zod.dev/v4/changelog — reviewed migration changes; realtime schema tests pass.
- https://docs.npmjs.com/cli/v10/configuring-npm/package-json/ — root scoped overrides contract.

All commands, exact exit statuses, timestamps and full-log SHA-256 hashes are stored in adjacent JSON envelopes. Final frontend typecheck/tests/production build are being run by the lead against integrated source and are not claimed here.
