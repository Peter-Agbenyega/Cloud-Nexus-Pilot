# Pilot recovery and release checkpoint — October 19, 2026

## Baseline and scope

Repository: `Peter-Agbenyega/Cloud-Nexus-Pilot`. Recovery branch: `recovery/pilot-release-2026-10-19` in an isolated clone. Starting commit: `429dd7a39b7229165b80201a3563eb74ef5b05b5`, comprising PR11 `c4f49e85ff5b36d5505b83c95f15b9375ed01bca` and the existing October 9 mock-interview body-validation fix. PR11 contains the PR10 release-safety baseline. No applicable AGENTS.md or local .agents/.codex skills were found in the inspected source tree/ancestors.

The canonical Desktop checkout, its conflicted index and stash `fd8b73df2acacb6ab2ee475e27f907263e381100` remain untouched. Its unfinished direct-Deepgram/summary migration was not applied to this release. Cloud Nexus Apply and CASMI were not modified; Apply's completed coordinator explicitly released the execution slot. No additional worker was started.

The exact new research attachment is still unavailable. These acceptance criteria come from the actual routed app, source contracts, tests and existing release documents; no research requirements have been invented.

## Acceptance inventory

| Capability | Evidence and result |
| --- | --- |
| Existing workspace, practice, vault, transcripts and summary | Existing implementation retained. Next production build emits the current page/API routes. No replacement scaffold. |
| Ordinary-user provider authorization | Existing Supabase verification retained. Policy regressions and actual-route dependency doubles verify 401/403/503 denial before provider/session work. |
| Streaming session ownership | Existing store isolation tests retained; new route regressions verify the authenticated owner is forwarded for creation/chunk/events/stop and foreign sessions are denied. |
| Guidance success/failure contracts | Synthetic provider output preserves token/final/done; missing providers, exceptions and malformed output end with error/done and no fabricated final answer. |
| Local persistence and capture lifecycle | Existing empty-vault, delete/auth-outage, persistence and capture-ownership regressions pass. No recording, microphone permission or manual audio test was performed. |
| Invalid JSON bodies | Four reproduced null-body failures repaired. Malformed JSON, null, arrays and primitives return 400 before guidance streaming; valid deterministic response contracts are retained. |
| Production build | Passes after bundling the existing licensed fonts locally. No Google Fonts download required. |
| Live customer/provider journey | Unverified. Real-account auth/CRUD/import, browser audio, ordinary-user WSS and measured transcript-to-guidance latency remain release gates. |
| Research-specific completeness | Unverified until the exact research becomes accessible. Billing remains explicitly planned, as in the reviewed baseline. |

## Changes and reproduced problems

1. Root `package.json` and lockfile now declare the existing `ws` dependency used by `ops/realtime/ws-smoke.mjs`. The operations README supplies a root-only production install command. This fixes PR10's outstanding dependency finding without changing Docker, Caddy, credentials or infrastructure.
2. Carried the prior connectivity diagnostic repair into the coherent branch. Generic browser fetch failure no longer claims a paused/deleted project or proven DNS failure. Explicit DNS evidence, HTTP failures, timeout and cancellation remain distinct. SDK/auth configuration and expected origin are unchanged.
3. Added `lib/server/json-request.ts` and applied it to interview-context, interview-report, debug-diagnosis and generate-guidance. Before repair, actual handlers threw on null property access, or opened a guidance response whose stream failed. Tests reproduced those four failures before the fix. Existing valid response shapes and guidance event contracts are retained.
4. Added route-source tests with isolated import doubles. They execute the actual TypeScript handlers, deny all network calls and cover malformed inputs, authorization, ownership, truthful provider failures and valid outputs. They do not simulate a complete deployed Next request environment.
5. The first production build failed downloading Inter/JetBrains Mono (`ENOTFOUND fonts.googleapis.com`). Bundled the 13 unmodified WOFF2 subsets already referenced by Pilot's existing build, with their Unicode ranges, weights, fallback metrics, licenses and SHA-256 manifest. Layout loads local CSS; no provider/API behavior changes. Fonts total 305,208 bytes. License sources: [Inter](https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt), [JetBrains Mono](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt).

## Final validation

Runtime: Node **22.23.3**, selected through `/opt/homebrew/opt/node@22/bin` to match the repository's Node 22 CI line. The default Homebrew Node 25 binary cannot start because its simdjson dylib is absent; no system installation was changed. Cached dependencies were copied into the isolated clone; no environment files were copied or read.

- `npm run test --workspace apps/cloud-nexus-pilot`: **103 passed** — 24 realtime client, 40 intelligence/auth/persistence, 8 existing route, 13 connectivity and 18 provider/route tests. Synthetic fixtures and mocked provider effects only; the new route suite asserts zero network calls.
- `npm run lint --workspace apps/cloud-nexus-pilot`: **pass**, no lint warnings.
- `npm run typecheck --workspace apps/cloud-nexus-pilot`: **pass** on the final code.
- `npm run build --workspace apps/cloud-nexus-pilot`: **pass**, including Next's type/lint checks and 15 prerendered pages. Existing Supabase `process.version` Edge-runtime warning, stale Browserslist data and webpack cache serialization warnings remain.
- `npm run build --workspace apps/pilot-realtime-api`: **pass**.
- Realtime API selected auth/claim/proxy/signal tests: **10 passed** with `node --test --test-name-pattern='production Supabase auth|verified Supabase claims|signal-aware fetch|forwarded client IP|spoofed forwarded' apps/pilot-realtime-api/dist/*.test.js`. The complete socket suite was not claimed as run/passed.
- Clean root-only install: copied only root manifests into a new fixture and seeded a task-local cache with the exact integrity-addressed public ws tarball. `npm ci --offline --omit=dev --ignore-scripts --workspaces=false --audit=false --fund=false --cache ./cache`: **pass**, exactly one package installed. The copied smoke CLI imports successfully and exits 1 with the expected missing-JWT message, without a socket/provider request. This independently verifies the deployment-host dependency fix, rather than relying on monorepo hoisting.
- WOFF2 headers, all 13 source/asset hashes, CSS references and both license files: **verified**.
- `git diff --check`: **pass**.

Blocked check: `node --test ops/realtime/tests/ws-smoke.test.mjs` yielded one passing missing-JWT case and eight failures because this sandbox rejects `listen(127.0.0.1)` with EPERM. No escalation, permission change, alternate listener or foreground browser was used to bypass this. Production startup, socket readiness and browser/audio tests therefore remain unverified. No Linux test result from another checkout is used as evidence here.

## Deployment identity and exact remaining gates

Authenticated Vercel metadata confirms production deployment `dpl_6egLvHkikpie25Z7Ux1M9NoFAdKW`, state **READY**, target **production**, SHA `f6a24716952ffd1b4d92be695adee267a4c3a31e`, aliased to `cloudnexuspilot.com` and `www.cloudnexuspilot.com`.

Project: `prj_gv3EGRDtboiptK7DcevvsxvvJnoR`, `cloud-nexus-pilot-cloud-nexus-pilot-ebpu`, account `team_MUZZoWAsIqodGK9XbE3LY9dZ`. The previously verified Next.js root is `apps/cloud-nexus-pilot` in the correct Pilot repository. The separate `final-round-ai/web` link was never used. Project metadata's newer target-null deployment is not called production.

**No new deployment was created, promoted or claimed.** The user's existing deployment approval is retained. Publication is blocked by existing release conditions, not by a request for duplicate generic approval:

1. `PILOT-COMPLETION-2026-09-23.md` requires remote CI, independent release reviews, real-account checks, browser capture, authenticated WSS and end-to-end latency before live release. PR10 separately requires Worker 2/Worker 3 review before merge. Fresh GitHub review reads show only automated COMMENTED reviews on PR10 and no reviews on PR11. Self-review and this sole-worker task do not satisfy those independent gates. No worker was spawned, message sent or merge performed to evade them.
2. Final changes are local and reviewable; no push/merge was performed. Exact-final-source remote CI and independent review must be established through the existing reviewed release path before publication.
3. The eight blocked smoke cases and real-account/browser/provider checks need a permitted execution host and existing authorized ordinary-user session. No credentials, OAuth grants, security configuration or paid provider calls were created/requested. October 15 auth/DNS observations remain historical, not current success evidence. This pass's host DNS could not resolve even dns.google; public web-tool reads were unavailable. Those failures do not establish current Supabase project status.
4. A consequential CLI metadata read failed with `fetch failed`; no relinking or authentication workaround followed. Authenticated connector metadata succeeds, but it does not establish that a new local-source deployment can be uploaded. Reverify exact target/root and supported publishing access when the review/runtime gates are met.

Next unfinished step: independent review of the saved patch plus permitted-host socket/customer-flow checks, then exact-source CI and publishing to the verified existing Pilot project. The canonical migration remains a separate review item. No SQL/schema/data migration, infrastructure change, purchase, external send, recording, push, merge or deployment occurred.
