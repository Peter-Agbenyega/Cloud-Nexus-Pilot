# Separate local acceptance stack — approved and implemented

Approved31October2026. Durable configuration/runtime paths supersede the proposed
temporary paths below. See RECOVERY_TEST_STACK.md and review/recovery-stack for
actual installation and acceptance results. Original database recovery is separate.

Original stack stays untouched. Its recovered original gateway keys and signer
are protected outside Git. Its database currently cannot open global/pg_filenode.map.
Do not restart, initialize, reset WAL, regenerate catalogs or restore over that data.

If approved, create only a separate loopback synthetic acceptance stack:

- Private configuration directory: /private/tmp/cnp-pilot-recovery-test, mode0700;
  key/session/env files0600. Fresh test-only signing identity and test accounts.
- Resource prefix cnp-pilot-recovery-test-<random>; isolated Docker networks and
  a NEW named database volume. No original bind mount, backup or saved user imported.
- Reuse exact pinned PostgreSQL/Auth/REST images from the original recorded stack;
  apply repository migrations002/003 only to the NEW synthetic database.
- Loopback ports: frontend43101, realtime43310, gateway59090, Auth59091,
  REST59092, synthetic provider59093. All probed unused; recheck before creation.
  PostgreSQL has no host port. Never expose original or replacement publicly.
- Use an isolated Git worktree on the same reviewed source for build/runtime:
  /private/tmp/cnp-recovery-acceptance. Parameterize local helper paths/ports with
  guards; never run hardcoded original-stack bootstrap against replacement resources.
- Explicit SYNTHETIC banner, loopback provider only, bounded local usage grant,
  no live provider keys, microphone disabled until user action.
- Verify read-only auth, HTTP chunk acknowledgement, persisted result recovery,
  duplicate retry/provider/usage counts, invalid credential zero dispatch,
  stop/restart stale-response guards, then prepare manual physical microphone check.
- Stop/remove only newly created labeled test resources when later requested;
  retain replacement test data unless deletion separately authorized.

This enables independent application and physical capture/delivery acceptance
with synthetic responses. It does not prove live speech recognition, recover
original saved sessions, repair the original database, preserve identity continuity
between stacks or establish production readiness. Original database recovery is a
separate investigation; no claim is made that its missing map is the only damage.
The retained database dump may support a later isolated restore investigation,
with its own age/completeness checks; never overwrite the original database.

Approval requested: create exactly this separate local synthetic stack and its
isolated worktree. No cloud deployment, purchase or original-stack change included.
