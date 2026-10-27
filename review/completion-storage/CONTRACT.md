# Pilot durable processing contract

Implemented additive migration: `packages/db/migrations/postgres/003_pilot_durable_processing.sql`.

Target is the existing PostgreSQL17 + compatible GoTrue/PostgREST design. This does not allocate a guest, reactivate hosted Supabase, create another authentication system, or perform a shared migration. Historical VM215 remains a proposal, not a verified allocation. The current application principal and user access token continue to be verified through existing auth.

## Callers and privilege separation

Authenticated PostgREST caller uses its verified JWT. `auth.uid()` supplies owner identity; an owner supplied only in JSON is never accepted for these RPCs. `anon` has no RPC grants. The new account and operation tables permit authenticated owner-only SELECT and prohibit all direct browser writes.

Only the trusted `service_role` caller can settle operations or grant allowance. The Next adapter supplies its server-only `PILOT_PROCESSING_SERVICE_KEY`; this is an existing-compatible self-hosted role credential, not a paid service requirement. If the trusted completion capability is absent, processing must fail closed before reservation/provider dispatch. Never expose this key publicly, log it, or use it as the browser anon key.

| RPC | Arguments | Result/behavior |
|---|---|---|
| `pilot_create_session` | `p_session_id uuid`, `p_mode text`, `p_consent_version text` | Owned session row; idempotent existing owned ID; explicit consent-version required. Modes general/mock/meeting/interview. Max100 owned sessions; new session30min lifetime. |
| `pilot_read_session` | `p_session_id uuid`, `p_after_sequence bigint=0` | `{session,events,guidance}`; owner required. Up to1000 ordered final events after cursor and500 recent guidance-operation records. Export must page by cursor if needed. |
| `pilot_stop_session` | `p_session_id uuid` | Owned session row; repeated stop preserves ended_at. Prevents new operations. |
| `pilot_delete_session` | `p_session_id uuid` | Boolean; false for absent/foreign. Deletes associated records via existing cascades. Pending provider work conservatively consumes its full bound; deletion never refunds an unknown provider call. |
| `pilot_reserve_operation` | `p_session_id uuid/null`, `p_operation_id text`, `p_max_units integer`, `p_request_hash text`, `p_kind text='transcription'` | `{acquired,state,result}`; owner derived from JWT. Max units1..2000000, operation ID1..128, hash64 lowercase hex, kinds transcription/guidance. |
| `pilot_complete_operation` | `p_owner_id uuid`, `p_operation_id text`, `p_request_hash text`, `p_used_units integer`, `p_outcome text`, `p_result jsonb`, `p_transcript_text text/null`, `p_source text='microphone'` | **Service only.** Atomic quota settlement, operation result and final transcript insert; repeated completion returns stored outcome without overwriting or duplicating. Result max256KiB; transcript max100k chars. |
| `pilot_set_allowance` | `p_owner_id uuid`, `p_granted_units bigint`, `p_max_concurrency integer=2` | **Service only.** Sets total granted allowance and concurrency1..8; constraints prevent allowance below already consumed/reserved amount. No automatic grants. |

`pilot_reserve_operation` states: `reserved`, `succeeded`, `failed`, `unknown`, `quota_exhausted`, `concurrency_exceeded`, `session_inactive`. Only `acquired:true` authorizes a new provider dispatch. Successful replay returns stored result. Pending, failed or unknown replay never reacquires. Different input/session/kind/units for one operation ID raises `operation_conflict`.

Reservation, concurrency and allowance checks serialize on the owner account row. Expired reservations (90s) become unknown and consume their full bound when the owner next reserves. Completion after expiry is also unknown/full-bound. Unknown outcomes are deliberately not automatically retried or refunded. Operational reconciliation remains necessary; failed-provider uncertainty must not be called zero cost.

Final transcript events use existing `transcript_segments`, unique `(interview_session_id,client_event_id)`, new ordered `pilot_sequence`, and `provider_result`. Raw audio is not persisted. Guidance results are associated with the owned session in `pilot_processing_operations` and included in reads. New restrictive child policies also require a genuinely owned parent session, closing direct-PostgREST cross-owner references allowed by a row-owner-only policy.

## Migration and rollback boundaries

Prerequisites are actual migration002, `auth.uid()`, roles anon/authenticated/service_role, and the existing pgvector extension. Run against a disposable restoration before any authorized shared migration. No destination, production role grant, credential distribution or migration has been executed here.

This migration is additive and reapplicable. Earlier session rows remain readable, with null Pilot expiry; they are not silently turned into active paid-processing sessions. It adds no default entitlement. A compatible rollback disables new processing admission and uses the previous application with existing data retained. Do not drop the new tables/columns or reset quotas to roll back a UI change. Do not replay unknown operations. Shared rollback requires the actual reviewed source/schema pair and owner approval.

## Executed local test scope

Command: `python3 scripts/db-test/test_pilot_durable_storage.py`.

PostgreSQL17.11 was initialized under a unique `/private/tmp/pilot-db-contract-*` directory with a private Unix socket and **no TCP listener**. No external database URL is accepted, and inherited PG* variables are discarded. The harness creates synthetic auth roles/claims, tests migration003 verbatim, stops its own server and removes only that newly created directory. It does not use customer backups, identities, passwords or shared data.

The installed Mac lacks pgvector. The compatibility fixture reads actual migration002 and replaces only its pgvector-extension declaration and two unrelated resume/job embedding column types with double arrays. This is explicitly **not** full002/pgvector/GoTrue deployment acceptance. Complete deployed initialization remains a prerequisite gate.

Final database result:22 tests passed, exit0 (`postgres-contract-r4.log`). Tests cover anonymous denial, A/B isolation, permitted writes, owned CRUD, privileged quota/settlement, exhausted quota, atomic concurrent reservations, replay/hash mismatch, unknown cost, deduplicated final writes, cursors, guidance associations, process restart, pre003 seeded-row compatibility, and reapplication.

Existing route/sanitization scripts were adapted to the production durable-repository boundary without deleting their33 cases. Valid silent PCM16 WAV fixtures and synthetic providers verify permitted direct/chunk transcription, safe HTTP errors, no raw provider sentinel in HTTP/SSE/logs, foreign-session rejection, durable final-event polling, and validated-only guidance output. Final result33/33 passed, exit0 (`route-adaptations-first.log`). No paid provider or real microphone call occurred.

## Independent integrity review corrections

The final migration also rejects authenticated edits/deletes of certified transcript events, strips certification supplied on manual inserts and assigns their sequence itself, and prevents clients from forging processing expiry/consent metadata. Existing legitimate owned manual transcript/note edits still work. Because RLS does not govern TRUNCATE, administrative table privileges are explicitly revoked from browser roles.

If an authenticated client pre-created an untrusted row with the same final client-event ID, trusted completion atomically upgrades that same-owner row with actual provider text/result and a **new sequence**. The new sequence ensures an already saved cursor cannot miss certification. Conflicting certified/foreign records fail instead of becoming a silent success. Stop settles pending reservations as unknown/full-bound and prevents a late completion from creating a final transcript; repeated stop does not charge twice.

Final native database regression result is **28/28 passed, exit0**, superseding the earlier22-test result for the expanded migration. Log: `postgres-integrity-final.log`. It includes metadata forgery/cursor poisoning, certified update/delete denial, legitimate manual-edit permission, TRUNCATE denial, preexisting-event promotion/cursor recovery, processing metadata immutability and pending-stop settlement.

## Actual local HTTP acceptance stack

The engine is installed Docker29.6.1. Reused PostgreSQL17.6.1.127 and GoTrue2.197.0 exact rehearsal digests; downloaded official PostgREST16.5 and pinned its observed digest. These historical compatibility versions are local test fixtures, not a declaration of production patch approval. The current official [PostgREST16.5 release](https://github.com/PostgREST/postgrest/releases/tag/v16.5) and [GoTrue2.197.0 configuration source](https://github.com/supabase/auth/blob/v2.197.0/internal/conf/configuration.go) were consulted for the test contract.

Full migration002 **with pgvector and unmodified embedding types**, then current003, ran inside the new disposable image-backed database. This closes the native fixture’s pgvector-initialization limitation for this local container layer; it does not prove an upgrade of customer data or deployment on a Proxmox guest.

- One uniquely labeled private Docker data network holds PostgreSQL and both API services. PostgreSQL has no published host port.
- Docker internal networks suppressed the API published ports. Only the synthetic Auth and REST containers were additionally connected to a separate uniquely labeled frontend bridge. That interface permits egress; there are no production credentials, provider keys, customer records or email delivery in this fixture.
- API host ports58091/58092 and the Python gateway58090 bind127.0.0.1. The gateway routes only `/auth/v1/` and `/rest/v1/`, validates synthetic API keys, bounds payloads, uses a small loopback-origin CORS allowlist and logs no tokens/payloads.
- Private configuration: `/private/tmp/cnp-pilot-local-stack/pilot.env` and `private.json`, mode0600. User tokens reside only in `sessions.json`, also0600. None is in git or printed.
- Initial fresh GoTrue bootstrap required setting the dedicated auth role’s schema search path and making it owner of auth.uid. After GoTrue’s initial migration, the standard PostgREST claim fallback was restored. These corrections are reflected in the bootstrap script.
- An engine shutdown interrupted setup. Normal installed Docker-app startup restored the engine. Only the original stopped fixture PostgreSQL container’s metadata was recreated with the exact same name/network/data mount to repair its non-idempotent init command; old inspect (environment values redacted) and raw log/hash were retained privately. No data directory or shared resource was removed. Current IDs/topology and old/new provenance are in `local-stack-identity.json`.

Actual HTTP command: `python3 scripts/db-test/test_local_pilot_http.py`.

Final result: **33 checks passed, exit0** (`local-http-final.log`, `local-http-acceptance.json`). These use real GoTrue signup/password login/GET-user, JWT role/issuer acceptance, real PostgREST roles/RLS/RPCs, A/B denial, quota grant/hold/settlement, altered-input denial, saved event replay/cursors and stop/delete. Provider invocation count is zero. Synthetic A, B and browser accounts have a bounded total grant20,000,000 units each, concurrency2; successful fixture usage remains charged and no reservations remain from this test.

The root’s compiled browser/HTTP product journey uses this stack separately. These33 checks do not themselves prove physical microphone capture, provider quality, Proxmox connectivity, hosted acceptance or production release.

### Local fixture scripts and shutdown

`start_local_pilot_stack.py` is a test-only bootstrap reflecting the executed steps; it requires precreated synthetic mode0600 configuration, refuses to overwrite an existing stack and accepts no production database URL. It creates only uniquely labeled local resources and uses a restart-idempotent PG command. The full final bootstrap has not been rerun from a second empty cluster while the root’s browser exercise uses the current stack; do not call it a separately qualified production installer.

`resume_local_pilot_stack.py` records the narrow original restart repair; running it against an already running fixture fails clearly. Container metadata removal preserves the private PG directory. For normal existing containers with the corrected command, their same-container start is sufficient.

After the frontend/realtime checks are stopped and no fixture requests remain, stop only this stack with:

```sh
python3 scripts/db-test/stop_local_pilot_stack.py
```

The prepared helper verifies exact labels before stopping its three containers, and verifies its gateway process command before signaling it. It preserves private credentials and PG data. Optional `--remove-container-metadata` also removes only these stopped containers and empty uniquely labeled networks, never bind-mounted data. The helper was syntax-checked, not executed while the root’s acceptance run needs these services. Do not confuse a prepared shutdown procedure with an observed shutdown result.

## Actual backup and restoration exercise

`python3 scripts/db-test/test_pilot_backup_restore.py` completed **26 checks, exit0**. It asserts the exact fixture container ID and `cloudnexus.purpose=pilot-local-acceptance` label before any database action; no external URL, caller-selected database or shared cluster is accepted.

The script verified synthetic A/B identities through real GoTrue HTTP, created an owned session and two final transcript events through authenticated reserve/service-only completion RPCs, and created/deleted another final-event fixture before the dump. It then ran actual `pg_dump --format=custom` of the fixture source database and actual `pg_restore --exit-on-error` into a uniquely named temporary database in the same fixture cluster.

Restored-database assertions proved owner metadata, final text ordering, unique event identities, resume-cursor behavior, userB denial, anonymous denial and absence of the already-deleted session/final event. These restoration assertions use actual PostgreSQL authenticated/anon roles with explicit claims from GoTrue-verified synthetic users; a second restored GoTrue HTTP service was not deployed. The original source fixture remained readable during the exercise.

The final custom archive is185,008 bytes, mode0600, SHA256 `481ea53009da749929eb9d93ef4dcbca59c80ad5f2db42be1fbe35faa3c0886d`. Its private absolute path, exact container/image identity, every executed command/exit/timestamp/result hash and cleanup result are in `backup-restore.json`. Binary dump bytes and credentials were never printed or committed.

All cleanup assertions passed: only the new temporary restored database was dropped, only this run’s created owned source fixtures were deleted through their authorized RPC, and only the container’s duplicate dump file was removed. The private mode0600 archive remains for review. The root’s soak session, source database and account grants were not dropped, reset or replaced. Two attempts consumed320 bounded synthetic work units total; those reservations were settled and were not refunded or represented as zero usage. Provider calls remained zero.

The first attempt’s `pg_dump` succeeded, but Docker’s archive-copy API could not access the dump on its tmpfs mount. That attempt safely cleaned its own fixtures and container dump. `backup-restore-first.json`/`.log` retain the failure. The corrected exercise writes through the existing private bind mount and copies binary bytes directly to a newly created mode0600 file, avoiding binary stdout; `backup-restore-final.log` records success. Nonzero psql exits in the successful receipt are the deliberately asserted cross-user and anonymous denials, not unexplained failures.

Retained: the fixture database’s consistent-snapshot schema, auth rows, owned metadata, final transcript/provider results, operation state and quota state. Not retained: raw audio (never stored), live sockets/provider connections/buffers, and source writes committed after the dump snapshot. Signing keys and service configuration remain separate private configuration artifacts; no full production auth cutover or zero-data-loss RPO is claimed. This proves a local synthetic database restore, not Proxmox or hosted disaster recovery.

## Verified restart-safe fixture lifecycle (supersedes prepared-helper limitation)

The final lifecycle helpers were repaired and then **actually executed** after the root’s soak completed:

```sh
# Working directory: /private/tmp/cnp-quality-gates
# Prerequisites: installed Docker engine running; existing private fixture config.
python3 scripts/db-test/stop_local_pilot_stack.py
python3 scripts/db-test/resume_local_pilot_stack.py
python3 scripts/db-test/resume_local_pilot_stack.py  # idempotency check
```

All three commands exited0. Evidence: `verified-lifecycle-cycle.json`, `verified-lifecycle-cycle.log`, `verified-stack-stop.log`, `verified-stack-resume.log`, `verified-stack-resume-idempotent.log` and the detailed `local-stack-stop.json`/`local-stack-resume.json` command envelopes.

Stop validates **every** exact owned container ID/label/network and the PG bind mount before acting. It verifies the gateway process command before signaling that PID, stops Auth/REST before PostgreSQL, and retains private configuration/data. Resume validates the same resources, starts the already-corrected PG container **without recreating it**, starts stopped API containers, starts its gateway only if the recorded process is not its live gateway and the loopback port is free, then waits for actual Auth and REST health200. Current003 is reapplied only to the known fixture database; no account allowance is created or reset. The legacy metadata-repair branch is restricted to the exact stopped legacy fixture with its same bind mount/network and archived provenance; it was not used in this verified cycle.

The gateway was genuinely stopped and restarted (new PID77856); the second resume reused that PID and did not recreate a container or launch another gateway. All three container IDs were unchanged. Actual GoTrue GET-user verification accepted the **pre-stop access token** after restart, proving continuity for this synthetic signing/session configuration.

The root’s owned30-minute soak session retained **169 final events**, identical event/session/guidance hashes and identical ordered cursors before/after the backend cycle. Account allowance, consumed units and reserved units were identical; no quota reset/refund or provider invocation occurred. Private env bytes were unchanged. This is evidence of the real local stop/start procedure, beyond process-only unit tests. The working gateway URL remains `http://127.0.0.1:58090`; Auth and REST readiness are both200. The helpers do not stop/start the separately managed frontend, realtime service or synthetic provider fixture; their root startup procedure is separate.
