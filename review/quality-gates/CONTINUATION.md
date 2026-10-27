# Local quality-gate repair and continuation

## VERIFIED DONE

- Worktree: `/private/tmp/cnp-quality-gates` (isolated from the unchanged original checkout).
- Branch: `fix/pilot-quality-gates`; base/HEAD: `c4f49e85ff5b36d5505b83c95f15b9375ed01bca` (PR11). Changes remain local and uncommitted.
- PR11 targets PR10’s branch and includes PR10 `77f87077d3ceecb7b1b108ac57c228b16559a0ca` as an ancestor. Auth and ownership work retained.
- Actual runtime: `/opt/homebrew/opt/node@22/bin/node`, Node 22.23.3, npm 10.9.9. `.nvmrc` now selects major 22; CI reads it. Node patch selection remains floating within major 22. Docker already selects Node 22.
- No workspace install lifecycle hooks. Native dependency hooks reviewed before normal clean install. No production environment files copied or loaded; worktree contains examples only. No provider calls, capture, database operations, push, merge or deployment.

| Changed file | Purpose |
|---|---|
| `apps/pilot-realtime-api/eslint.config.mjs` | Core and TypeScript recommended analysis across service source and tests. Generated output excluded. No blanket suppressions. |
| `apps/pilot-realtime-api/package.json` | Replace echo with `eslint src --max-warnings=0`; declare exact compatible lint tools. |
| `apps/pilot-realtime-api/src/server.test.ts` | Remove five unused test-double parameters; preserve test assertions. |
| `apps/pilot-realtime-api/src/wsRuntime.ts` | Declare the shutdown grace timer as const at assignment; preserve shutdown behavior. |
| `.github/workflows/ci.yml` | One `npm ci` per matrix job; select npm 10.9.9 and Node from `.nvmrc`. All lint/typecheck/build/test steps after installation preserved byte-for-byte. |
| `.nvmrc`, `package.json` | Align Node major 22 and npm declaration 10.9.9 with verification and CI. |
| `package-lock.json` | Realtime lint dev dependencies only: 144 added paths; existing sibling/dependency records unchanged. Nested regeneration avoids unrelated hoisting. |
| `review/quality-gates/` | Full local logs, execution envelopes, audit payloads, source hashes, patch, review and continuation. |

After-change frontend tests: **24 realtime + 40 intelligence = 64 passing**. Realtime API: **57 passing**. Total: **121 product tests**, using mocks/synthetic identity and local sockets. Both workspace lint/typecheck/build checks pass. These do not certify hosted audio, providers, durability or production readiness.

The first genuine realtime lint run exited 1 with six findings. All were repaired without rule suppression. A disposable copy of `authVerifier.ts` with `export const deliberateLintViolation: any = 1` caused the normal lint command to exit 1 on `@typescript-eslint/no-explicit-any`. The copy was removed; normal lint then exited 0. Probe source/log retained as evidence, not as executable source.

The final fresh `npm ci` passed (1,900 packages reported); the baseline clean install passed. The baseline lockfile remained unchanged during baseline checks. Final lock/source hashes are in `execution-index.json`. Installation counts are observations, not cross-platform guarantees.

## Commands and exits

Commands below ran from the task worktree, with Node 22 first on PATH and Next telemetry disabled. Each linked JSON envelope includes exact arguments, timestamps, exit status and SHA-256 of the complete raw log. Sandbox failures remain recorded. Approved reruns allowed package/font network access and synthetic loopback listeners. Initial scripts-disabled install was an inspection aid; normal clean installations also ran successfully.

| Record | Exact command | Exit |
|---|---|---|
| [baseline-ci-retry.json](baseline-ci-retry.json) | `npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000` | 0 |
| [baseline-ci.json](baseline-ci.json) | `npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000` | 1 |
| [baseline-frontend-build-retry.json](baseline-frontend-build-retry.json) | `npm run build --workspace apps/cloud-nexus-pilot` | 0 |
| [baseline-frontend-build.json](baseline-frontend-build.json) | `npm run build --workspace apps/cloud-nexus-pilot` | 1 |
| [baseline-frontend-lint.json](baseline-frontend-lint.json) | `npm run lint --workspace apps/cloud-nexus-pilot` | 0 |
| [baseline-frontend-tests.json](baseline-frontend-tests.json) | `npm run test --workspace apps/cloud-nexus-pilot` | 0 |
| [baseline-frontend-typecheck.json](baseline-frontend-typecheck.json) | `npm run typecheck --workspace apps/cloud-nexus-pilot` | 0 |
| [baseline-install-no-hooks-retry.json](baseline-install-no-hooks-retry.json) | `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000` | 0 |
| [baseline-operations-tests-retry.json](baseline-operations-tests-retry.json) | `npm run test:realtime-ops` | 1 |
| [baseline-operations-tests.json](baseline-operations-tests.json) | `npm run test:realtime-ops` | 1 |
| [baseline-realtime-tests-retry.json](baseline-realtime-tests-retry.json) | `npm run test --workspace apps/pilot-realtime-api` | 0 |
| [baseline-realtime-tests.json](baseline-realtime-tests.json) | `npm run test --workspace apps/pilot-realtime-api` | 1 |
| [baseline-realtime-typecheck.json](baseline-realtime-typecheck.json) | `npm run typecheck --workspace apps/pilot-realtime-api` | 0 |
| [baseline-runtime-audit.json](baseline-runtime-audit.json) | `npm audit --omit=dev --json --fetch-retries=0 --fetch-timeout=30000` | 1 |
| [final-ci.json](final-ci.json) | `npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000` | 0 |
| [final-frontend-build.json](final-frontend-build.json) | `npm run build --workspace apps/cloud-nexus-pilot` | 0 |
| [final-frontend-lint.json](final-frontend-lint.json) | `npm run lint --workspace apps/cloud-nexus-pilot` | 0 |
| [final-frontend-tests.json](final-frontend-tests.json) | `npm run test --workspace apps/cloud-nexus-pilot` | 0 |
| [final-frontend-typecheck.json](final-frontend-typecheck.json) | `npm run typecheck --workspace apps/cloud-nexus-pilot` | 0 |
| [final-operations-tests.json](final-operations-tests.json) | `npm run test:realtime-ops` | 1 |
| [final-realtime-build.json](final-realtime-build.json) | `npm run build --workspace apps/pilot-realtime-api` | 0 |
| [final-realtime-lint.json](final-realtime-lint.json) | `npm run lint --workspace apps/pilot-realtime-api` | 0 |
| [final-realtime-tests.json](final-realtime-tests.json) | `npm run test:run --workspace apps/pilot-realtime-api` | 0 |
| [final-realtime-typecheck.json](final-realtime-typecheck.json) | `npm run typecheck --workspace apps/pilot-realtime-api` | 0 |
| [final-runtime-audit.json](final-runtime-audit.json) | `npm audit --omit=dev --json --fetch-retries=0 --fetch-timeout=30000` | 1 |
| [final-ws-smoke-focused.json](final-ws-smoke-focused.json) | `node --test ops/realtime/tests/ws-smoke.test.mjs` | 0 |
| [first-real-realtime-lint.json](first-real-realtime-lint.json) | `npm run lint --workspace apps/pilot-realtime-api` | 1 |
| [lint-negative-probe.json](lint-negative-probe.json) | `npm run lint --workspace apps/pilot-realtime-api` | 1 |
| [repaired-realtime-lint.json](repaired-realtime-lint.json) | `npm run lint --workspace apps/pilot-realtime-api` | 0 |
| [update-lock-nested-retry.json](update-lock-nested-retry.json) | `npm install --package-lock-only --install-strategy=nested --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000` | 0 |
| [update-lock-nested.json](update-lock-nested.json) | `npm install --package-lock-only --install-strategy=nested --ignore-scripts --no-audit --no-fund --offline` | 1 |
| [update-lock-retry.json](update-lock-retry.json) | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000` | 0 |
| [update-lock.json](update-lock.json) | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --offline` | 1 |

## REMAINING BLOCKERS

- Runtime dependency audit exits 1: **1 critical / 8 high / 9 total package entries** before and after this patch. See [SECURITY.md](SECURITY.md) and complete `*-runtime-audit.payload.json`. Runtime dependencies were not upgraded. Findings block promotion pending reviewed remediation/disposition.
- Operations tests remain ungreen on this Mac. Baseline approved run: **26/32 pass**, with six failures associated with unavailable `flock`. Final full run: **25/32 pass**, those six plus a premature-close test receiving a timeout instead. Focused WebSocket rerun: **9/9 pass**. This is evidence of an intermittent timing failure, not proof of resolution. No tests, locking checks or deadlines were weakened. Qualify the preserved operations suite on its Linux CI environment and investigate the timing failure.
- ESLint 9.39.4 emitted an unsupported-version warning. A reviewed tooling upgrade remains separate from this scoped compatible gate repair.
- GitHub CI itself has not been executed for this local patch; sibling application builds/tests were not rerun. Their source/manifests/lock records are unchanged, and the CI matrix/gates remain preserved.
- Browser capture, live provider behavior, deployed authorization, quotas, durable/multi-instance recovery and release approval remain unverified.

## NEXT BOUNDED TASK

Review the existing `requireProviderUser`, provider-auth policy, streaming ownership checks and their tests. The current `/api/transcribe` authenticates before `request.arrayBuffer()` but then buffers the body without an explicit route bound. The streaming chunk route similarly buffers before the store performs owner checks. Close this demonstrated protection gap using the existing auth boundary: enforce owner authorization where applicable before body consumption, add a streaming byte cap that also handles absent/false Content-Length, and prove unauthenticated/cross-account/oversized requests invoke the provider stub zero times. Preserve provider selection and successful bounded-audio behavior. Inventory quota/cancellation enforcement next; do not claim those controls from body limits alone.

Continuation should start on this task worktree, review the uncommitted patch, and retain these evidence identities. No release or schema-2 acceptance is claimed by this report.

Official implementation references consulted: [typescript-eslint shared configurations](https://typescript-eslint.io/users/configs/), [ESLint flat configuration](https://eslint.org/docs/latest/use/configure/configuration-files), [npm 10 ci](https://docs.npmjs.com/cli/v10/commands/npm-ci/). Executed installed-tool behavior and source take precedence over current web examples.
