# Realtime production operations

This directory is the authoritative production procedure for the single Cloud Nexus Pilot realtime container behind same-host Caddy. Production is a Linux host. The Compose project directory is `apps/pilot-realtime-api`, the container is `cloud-nexus-pilot-realtime`, and the process listens only on `127.0.0.1:3010` with `restart: unless-stopped`, Docker init, a 15-second stop grace period, a read-only root filesystem, all capabilities dropped, and no-new-privileges.

## Caddy: preserve the existing configuration

`Caddyfile.cloudnexuspilot` contains exactly one site definition. Caddy performs WebSocket upgrades automatically; no manual `Connection` or `Upgrade` rewriting is needed. The existing `worker.cloudnexus360.com -> 127.0.0.1:3000` definition belongs to another service and must remain unchanged.

Never append this block with `>>`. Review `/etc/caddy/Caddyfile`, back it up, and establish exactly one modular import if it is not already present:

```caddyfile
import /etc/caddy/sites-enabled/*
```

Preserve every existing directive and site, especially `worker.cloudnexus360.com`. Make the import as an explicit reviewed replacement of the main file: copy it to a temporary file, edit that file, run `caddy validate --config <temporary-file> --adapter caddyfile`, retain a timestamped backup, replace the main file only after validation, then reload Caddy. Do this once—not on every release. Confirm there is no existing inline `realtime.cloudnexuspilot.com` block before installing the fragment.

Thereafter, from the repository root, run `ops/realtime/install-caddy-site.sh` as an account already authorized to write `/etc/caddy` and reload Caddy. The script does not request or accept a sudo password. Validation, reload, and endpoint failures all restore the previous fragment (or its prior absence). If restoring the running Caddy configuration also fails, it reports that manual recovery is required and retains the backup. It backs up the current main config and old fragment, replaces the one named fragment idempotently through a staged file, validates before reload, reloads rather than restarts, verifies both public domains, and restores the prior fragment on failure. A duplicate inline definition causes validation to fail instead of overwriting unknown configuration.

## Why the trusted proxy is exactly loopback

The previous Docker publish path translated Caddy's loopback connection through a Docker bridge, so the peer observed by Fastify depended on the bridge gateway. Production Compose now uses Linux host networking while setting `HOST=127.0.0.1`. Therefore:

```text
public client -> Caddy -> 127.0.0.1:3010 -> Fastify peer 127.0.0.1
```

`WS_TRUSTED_PROXY_CIDRS=127.0.0.1/32` is set by Compose and is the narrowest stable value. Fastify uses Caddy's forwarded client address only when the socket peer is loopback. Caddy's default reverse proxy behavior sets `X-Forwarded-For` and ignores spoofable incoming values when no global `trusted_proxies` option is configured. Do not add a broad Docker CIDR or a Caddy `trusted_proxies` setting for this same-host topology.

Before release, prove the live path without logging headers or tokens:

```sh
docker exec cloud-nexus-pilot-realtime node -e \
  'console.log(require("node:os").networkInterfaces())' # topology only; optional
ss -ltn '( sport = :3010 )'
docker inspect --format '{{.HostConfig.NetworkMode}}' cloud-nexus-pilot-realtime
```

The required results are a `127.0.0.1:3010` listener and network mode `host`. The automated server tests additionally prove that two forwarded IPs use two per-IP buckets through a trusted loopback peer, and that an untrusted peer cannot spoof `request.ip`.

## Pre-deploy and deploy

Use an account that can access Docker, read Caddy configuration, write `/var/lib/cloud-nexus-pilot/realtime`, and run `caddy validate`. The Linux host must provide `flock`; deploy and rollback share an exclusive lock to prevent overlapping release operations. No credential is accepted on a command line. Put production values in the existing uncommitted `apps/pilot-realtime-api/.env`; the scripts test variable names for non-empty presence but never print values.

1. Fetch the reviewed commit and check out its exact 40-character Git SHA. Ensure `git status --porcelain` is empty.
2. Verify `systemctl is-active docker caddy`, `systemctl is-enabled docker caddy`, `docker info`, and `docker compose version`.
3. If the Caddy fragment changed, install it first with `install-caddy-site.sh`. Record its printed backup path.
4. Run `ops/realtime/deploy-realtime.sh <git-sha>` from the clean checkout.
5. Export a short-lived ordinary Supabase user access token (never a service-role key), run the authenticated smoke check, then unset it:

   ```sh
   export REALTIME_SMOKE_JWT='<short-lived-user-access-token>'
   node ops/realtime/ws-smoke.mjs
   unset REALTIME_SMOKE_JWT
   ```

The deploy script validates Docker and Compose, checks required environment presence, verifies port 3000, checks current realtime health, backs up Caddy, validates Caddy, builds `cloud-nexus-pilot-realtime:<git-sha>` only if that exact tag does not already exist, records immutable `CURRENT_RELEASE` and `PREVIOUS_RELEASE`, and updates only `pilot-realtime-api` using `--no-deps --no-build`. It then verifies container health, loopback-only binding, local and external health/TLS, bad-Origin rejection, and both local and public worker service responses. It never restarts unrelated containers. `/health` remains cheap process liveness and does not contact Supabase; the authenticated WSS check is the dependency/readiness proof.

Before replacing the container, deploy and rollback atomically record `PENDING_RELEASE` alongside the unchanged `CURRENT_RELEASE` and `PREVIOUS_RELEASE`. On a failed Compose update or post-deploy check, the script attempts to restore and verify the recorded current release. It returns nonzero even when recovery succeeds. A successful deployment commits the new release state and clears the pending field. Redeploying the same SHA preserves the previous rollback target and reuses the existing image.

If recovery fails or the process is interrupted before completion, the pending journal remains. Further deploys refuse to proceed. `rollback-realtime.sh` then restores the recorded **current** release rather than skipping it for the older previous release. With no recorded current release (a failed first deployment), it refuses to invent a recovery target: inspect the container and journal and recover manually. Do not delete pending state merely to bypass this check.

The immutable image and `/var/lib/cloud-nexus-pilot/realtime/releases.env` must be retained through the release observation window. Do not prune the previous image.

## Deterministic rollback

Run `ops/realtime/rollback-realtime.sh`. For a completed release with no pending transition, it refuses to rebuild: it reads `PREVIOUS_RELEASE`, verifies that exact image already exists, updates only the realtime service, atomically swaps current/previous release state, and verifies local health, Caddy validity, public HTTPS/TLS, and the worker service. A failed rollback attempts to restore the release that was current before the rollback; unsuccessful recovery retains pending state. Then run `ws-smoke.mjs` with a fresh short-lived user token. The smoke check succeeds only after sending authentication and observing `session.ready`. Timeout, premature close, malformed messages, transport errors, and server rejection exit nonzero without printing tokens or server payloads.

If Caddy changed in the release, restore the timestamped prior fragment printed by `install-caddy-site.sh` (or the deploy Caddy backup after reviewing it), validate it before replacement, reload Caddy, and repeat both-domain checks. The `.env` is not modified by deploy or rollback, so the existing environment configuration is preserved.

## Reboot recovery

After a planned reboot verify:

```sh
systemctl is-enabled docker caddy
systemctl is-active docker caddy
docker inspect --format '{{.Name}} {{.HostConfig.RestartPolicy.Name}} {{.State.Status}} {{.State.Health.Status}}' cloud-nexus-pilot-realtime
ss -ltn '( sport = :3010 )'
curl --fail --silent --show-error http://127.0.0.1:3010/health >/dev/null
curl --fail --silent --show-error https://realtime.cloudnexuspilot.com/health >/dev/null
curl --fail --silent --show-error https://worker.cloudnexus360.com/health >/dev/null
```

The expected container is running/healthy with `unless-stopped`; Caddy and Docker start at boot; 3010 is loopback-only; both public services respond. Complete recovery with the authenticated WSS smoke check. No host startup unit is managed by this repository.

## Safe inspection and security semantics

Use `docker ps --filter name=cloud-nexus-pilot-realtime`, `docker inspect --format '{{.State.Health.Status}} restarts={{.RestartCount}}' cloud-nexus-pilot-realtime`, `docker logs --since 30m cloud-nexus-pilot-realtime`, `systemctl status caddy`, and `journalctl -u caddy --since '30 minutes ago'`. Realtime logs identify abnormal close codes, authentication failure categories, and global/per-IP limit rejection without credentials or content.

Never log or paste JWTs, OpenAI/Supabase keys, sensitive headers, audio, transcripts, or private guidance. Browser Origins are allow-listed and explicit unauthorized Origins are rejected. Missing Origin remains allowed for non-browser clients. Bearer authentication is the authorization boundary; Origin is not authentication.

## Verified endpoint distinction

On 2026-09-23, the existing worker returned HTTP 404 at `/` and HTTP 200 at `/health` with `ok: true`, service `nexusapply-worker`, and status `healthy`. All release checks use `/health` locally and publicly. The worker site and application are not modified by these scripts.

The realtime `/health` response can be HTTP 200 while reporting missing OpenAI or Deepgram providers. This is liveness, not an end-to-end audio test. Configure providers through the existing host's secret/environment mechanism, restart only the realtime service as part of a reviewed release, and verify authenticated WSS plus microphone/transcription/guidance before claiming production readiness.

## Regression checks

Run `npm run test:realtime-ops` from the repository root. CI runs this alongside the realtime API tests. The suite runs the actual shell scripts with isolated command doubles and temporary state, plus local WebSocket servers. It covers failed deployment/recovery, interrupted-state recovery, same-SHA image reuse, rollback, first-deploy failure, Caddy validation/reload/endpoint restoration, and readiness failures. It needs no credentials, Docker daemon, or production connection. These tests do not replace live host topology, TLS, authenticated readiness, or microphone/STT/LLM latency verification.
