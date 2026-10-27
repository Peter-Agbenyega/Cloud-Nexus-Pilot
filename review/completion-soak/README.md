# Verified synthetic service-path soak

The actual command exited **0** after **1810.498 seconds** of monotonic session time (30 minutes 10.498 seconds). Command wall-clock interval: `2026-10-27T14:30:17.028472+00:00` to `2026-10-27T15:00:27.949966+00:00`.

This exercises the compiled Pilot HTTP routes at localhost3100, real isolated local GoTrue identity, real PostgREST/PostgreSQL ownership and persistence, and the synthetic provider fixture at localhost58093. It is **not** microphone capture, browser permission acceptance, continuous live audio, speech recognition, model quality evaluation, or live provider acceptance. No person was recorded and no paid provider was called.

| Check | Observed result |
|---|---|
| Generated payload | One-second mono16kHzPCM16WAV tone;32,044bytes; same bounded buffer reused |
| Schedule | One generated chunk every10seconds;179scheduled submissions; processing stops briefly before expiry probe |
| Durable results |169acknowledged chunks;169distinct saved final indices; exact acknowledged-index set equals durable-index set |
| Restart/interruption |10failed requests at indices92–101; explicit unreplayed gaps; one owned-cursor recovery |
| Observed interruption window |First failed submission `2026-10-27T14:45:37.457Z` to successful recovery `2026-10-27T14:47:17.647Z`: 100.190s; exact process stop/start timing is in lead launch records |
| Ownership |Second local account denied throughout; owner can reload final results after frontend restart |
| Expiry |After30actualminutes, newchunk returned409 `operation_not_replayable`; paired synthetic-provider counter delta0 |
| Stop |Two stop requests succeeded; stored session ended; no additional final transcript rows |
| Maximum in-flight application requests |1; no growing client audio queue |
| ClientRSS maximum |45.68MiB, below256MiB bound |
| FrontendRSS maximum |103.55MiB, below1536MiB bound |
| FrontendRSS growth |Both observed runtime PID groups had negative first-to-last RSS growth;256MiB growth bound passed |
| Mixed HTTP latency |395samples, p95=116ms, max=203ms; descriptive mixed-route metric, not transcription-stage or live-provider latency |

No unknown operation was retried. Ten missing scheduled indices remain explicit in `result.json`; this is recovery of saved work with disclosed gaps, not uninterrupted audio capture. The test retained no raw audio in durable storage.

## Evidence and source identity

- `synthetic-30-minute-soak.json`: exact command, exit0, timestamps and full raw-log SHA-256 `2bc3f54301b9154c3b22b5357c62c12f097e30e2a81a11fcadc2c0d4d53a48d8`.
- `synthetic-30-minute-soak.log`: full execution stdout/stderr; `events.jsonl`: full event ledger.
- `result.json`: final checks, all saved final indices/sequences, measured RSS samples and runtime PID groups.
- `verification.json`: supplemental artifact consistency checks; **not** the supplied release-evidence checker and not extra product tests.
- `source-observation.json`: source hashes and observed build-ID file near the start. InitialHEAD was `9d90fa5c54ec7a8a5e9d0e5d5274e2a45a805cff`; finalHEAD was `20528db1c2d1f6da208a3bd4eb9375c4fd5fe312`. The lead rebuilt/restarted the frontend during the soak, so this is a runtime-transition exercise, not30minutes exclusively on the final build. A build-ID file can change before process restart; lead launch/source-transition records identify actual instances.
- `sandbox-attempt-*`: initial sandbox connectEPERM failure, retained and excluded from completed-soak duration.
- `executed-runner.py`: exact local envelope runner; contains configuration file paths only, no secret values.

Reproduction requires the lead's isolated local services and private synthetic account configuration. From the task worktree, use installed Node22:

```sh
/opt/homebrew/opt/node@22/bin/node --env-file=/private/tmp/cnp-pilot-local-stack/pilot.env scripts/pilot/test-local-soak.mjs
```

The private account JSON and environment file are prerequisites and are not included in evidence or source control. The test does not start services, migrate shared data, grant quota, create infrastructure, or contact public providers. It creates and stops one owned synthetic session and leaves saved results available for review.
