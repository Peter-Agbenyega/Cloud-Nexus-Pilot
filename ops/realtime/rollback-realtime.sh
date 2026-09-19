#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly COMPOSE_FILE="${REPO_ROOT}/apps/pilot-realtime-api/compose.yaml"
readonly ENV_FILE="${REPO_ROOT}/apps/pilot-realtime-api/.env"
readonly STATE_DIR="${REALTIME_STATE_DIR:-/var/lib/cloud-nexus-pilot/realtime}"
readonly STATE_FILE="${STATE_DIR}/releases.env"

[[ -r "${STATE_FILE}" ]] || { echo "Missing release state: ${STATE_FILE}" >&2; exit 1; }
current_release="$(sed -n 's/^CURRENT_RELEASE=//p' "${STATE_FILE}")"
previous_release="$(sed -n 's/^PREVIOUS_RELEASE=//p' "${STATE_FILE}")"
[[ "${current_release}" =~ ^[0-9a-f]{40}$ && "${previous_release}" =~ ^[0-9a-f]{40}$ ]] || { echo "Rollback state is incomplete or invalid" >&2; exit 1; }
docker image inspect "cloud-nexus-pilot-realtime:${previous_release}" >/dev/null
REALTIME_RELEASE="${previous_release}" REALTIME_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
REALTIME_RELEASE="${previous_release}" REALTIME_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --no-deps --no-build pilot-realtime-api

container_state=""
for _ in {1..30}; do
  container_state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' cloud-nexus-pilot-realtime)"
  [[ "${container_state}" == "running healthy" ]] && break
  sleep 2
done
[[ "${container_state}" == "running healthy" ]] || { echo "Rollback container is not running and healthy: ${container_state}" >&2; exit 1; }
ss -ltn '( sport = :3010 )' | grep -Eq '127\.0\.0\.1:3010' || { echo "Port 3010 is not bound to IPv4 loopback" >&2; exit 1; }
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3010/health >/dev/null
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
curl --fail --silent --show-error --max-time 10 https://realtime.cloudnexuspilot.com/health >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/ >/dev/null
curl --fail --silent --show-error --max-time 10 https://worker.cloudnexus360.com/ >/dev/null

state_stage="$(mktemp "${STATE_DIR}/releases.env.XXXXXX")"
trap 'rm -f "${state_stage:-}"' EXIT
printf 'CURRENT_RELEASE=%s\nPREVIOUS_RELEASE=%s\n' "${previous_release}" "${current_release}" >"${state_stage}"
chmod 0640 "${state_stage}"
mv "${state_stage}" "${STATE_FILE}"

echo "Rolled back to cloud-nexus-pilot-realtime:${previous_release}. Complete the authenticated WSS smoke check."
