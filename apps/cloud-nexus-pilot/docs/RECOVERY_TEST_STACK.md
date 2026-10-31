# Running synthetic recovery stack

Approved31October2026 and installed separately from the damaged original stack.

- Sign in to the NEW synthetic browser account: http://127.0.0.1:59093/fixture-login
- Workspace: http://127.0.0.1:43101/workspace
- Realtime: ws://127.0.0.1:43310/ws/session
- Gateway/Auth/REST/provider: loopback59090/59091/59092/59093.
- Durable runtime checkout: ~/Cloud-Nexus-Pilot-recovery-acceptance.
- Durable private config/state/logs: ~/.local/share/cloud-nexus-pilot/recovery-test.
  Directory0700, files0600. Never commit or print private.json, env or sessions.
- Recorded new containers/networks/volume: protected stack.json. PostgreSQL uses a
  NEW named Docker volume, no original bind mount, no host DB port. Do not re-run
  bootstrap against an existing stack; it refuses existing state/configuration.
- Fresh test identities, signing key, passwords and bounded20,000,000-unit local
  allowances. Initial anon/service JWTs expire24hours after issuance; exact expiry
  is in sanitized review/recovery-stack/stack-security.json. No automatic renewal
  is promised; before expiry, use a separately guarded recovery-profile renewal
  with the existing NEW signer and rebuild public-token assets. Original-stack
  renewal helper is intentionally scoped to ORIGINAL and must not target this stack.

The test-only sign-in helper exists ONLY on the59093 fixture with recovery flag1.
It performs real GoTrue password authentication for the fresh synthetic browser
account and sets normal SSR cookies. No credential appears in the link. Recovery
cookies use sb-pilot-recovery-test-auth-token; original/hosted cookie behavior is
unchanged. This helper must never be exposed publicly or used as production auth.
NEXT_PUBLIC_PILOT_ALLOW_LOOPBACK=1 is required in this explicit local build.

Scoped app reload from the engineering checkout:
`python3 scripts/db-test/recovery_runtime.py normal`
Provider reload: same command with `provider`. Gateway reload: `gateway`.
All commands verify recorded ownership before stopping ONLY this new consumer.
The `expired` mode is a negative test, NOT normal operation; always return to
`normal` afterwards. Do not run original stack start/resume/seed commands here.

Acceptance commands under Node22, with ONLY the new protected pilot.env:
`node --env-file=<durable-private-dir>/pilot.env scripts/pilot/test-local-journey.mjs exercise`
`node --env-file=<durable-private-dir>/pilot.env scripts/pilot/test-local-journey.mjs recover`
`node --env-file=<durable-private-dir>/pilot.env scripts/pilot/test-recovery-acceptance.mjs normal`
Reload app, then run final command with `recover` to prove process-independent
persistence. `expired` acceptance requires the temporary expired app configuration.
These create ONLY identifiable synthetic records; recovery fixture records remain.

## Acceptance separation

Synthetic processing/authentication/save/replay/usage deduplication/recovery: PASS.
Capture timers, stale responses and resource cleanup: mock/helper regressions PASS.
Physical microphone: pending user check, never automatically activated.
Live speech recognition/provider: NOT RUN. Fixed fixture words are not recognition.
Original saved-session recovery: UNRESOLVED, original database map is missing.
Production: NOT VERIFIED; no public deployment, merge or paid provider call.

Select Microphone in the workspace. “Click Start Session, allow microphone access,
say ‘Pilot microphone test, one two three,’ then click End Session.” Check meter
movement, saved acknowledgement and browser recording indicator off. Then start
and end another session to check fresh capture. Report what happened; backend
numeric audio counters can corroborate delivery but cannot prove meter movement,
physical-source provenance or browser track release by themselves.
