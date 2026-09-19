#!/usr/bin/env bash
set -Eeuo pipefail

readonly RELEASE="${1:-}"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly COMPOSE_FILE="${REPO_ROOT}/apps/pilot-realtime-api/compose.yaml"
readonly ENV_FILE="${REPO_ROOT}/apps/pilot-realtime-api/.env"
readonly STATE_DIR="${REALTIME_STATE_DIR:-/var/lib/cloud-nexus-pilot/realtime}"
readonly STATE_FILE="${STATE_DIR}/releases.env"
readonly IMAGE_REPOSITORY="cloud-nexus-pilot-realtime"

[[ "${RELEASE}" =~ ^[0-9a-f]{40}$ ]] || { echo "Usage: $0 <40-character-git-sha>" >&2; exit 2; }
for command in caddy curl docker git ss; do
  command -v "${command}" >/dev/null || { echo "Required command missing: ${command}" >&2; exit 1; }
done
[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
[[ -z "$(git -C "${REPO_ROOT}" status --porcelain)" ]] || { echo "Worktree is not clean" >&2; exit 1; }
[[ "$(git -C "${REPO_ROOT}" rev-parse HEAD)" == "${RELEASE}" ]] || { echo "Checked-out HEAD does not equal release SHA" >&2; exit 1; }
docker info >/dev/null
install -d -m 0750 "${STATE_DIR}"
caddy_backup="${STATE_DIR}/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ).backup"
install -m 0640 /etc/caddy/Caddyfile "${caddy_backup}"

for name in NODE_ENV CORS_ORIGIN SUPABASE_URL SUPABASE_PUBLISHABLE_KEY OPENAI_API_KEY DEEPGRAM_API_KEY; do
  grep -Eq "^${name}=.+" "${ENV_FILE}" || { echo "Required environment variable is absent or empty: ${name}" >&2; exit 1; }
done

REALTIME_RELEASE="${RELEASE}" REALTIME_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/ >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3010/health >/dev/null || echo "No currently healthy realtime service (permitted for first deploy)"

previous_release=""
if [[ -r "${STATE_FILE}" ]]; then
  previous_release="$(sed -n 's/^CURRENT_RELEASE=//p' "${STATE_FILE}")"
  [[ -z "${previous_release}" || "${previous_release}" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid current release state" >&2; exit 1; }
fi

docker build --file "${REPO_ROOT}/apps/pilot-realtime-api/Dockerfile" --tag "${IMAGE_REPOSITORY}:${RELEASE}" "${REPO_ROOT}"
docker image inspect "${IMAGE_REPOSITORY}:${RELEASE}" >/dev/null
REALTIME_RELEASE="${RELEASE}" REALTIME_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --no-deps --no-build pilot-realtime-api

container_state=""
for _ in {1..30}; do
  container_state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' cloud-nexus-pilot-realtime)"
  [[ "${container_state}" == "running healthy" ]] && break
  sleep 2
done
[[ "${container_state}" == "running healthy" ]] || { echo "Realtime container is not running and healthy: ${container_state}" >&2; exit 1; }
ss -ltn '( sport = :3010 )' | grep -Eq '127\.0\.0\.1:3010' || { echo "Port 3010 is not bound to IPv4 loopback" >&2; exit 1; }
if ss -ltn '( sport = :3010 )' | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]|\*):3010'; then
  echo "Port 3010 has a wildcard listener" >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3010/health >/dev/null
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
curl --fail --silent --show-error --max-time 10 https://realtime.cloudnexuspilot.com/health >/dev/null
origin_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
  --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
  --header 'Origin: https://unauthorized.invalid' \
  https://realtime.cloudnexuspilot.com/ws/session)"
[[ "${origin_status}" == "403" ]] || { echo "Unauthorized Origin returned ${origin_status}, expected 403" >&2; exit 1; }
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/ >/dev/null
curl --fail --silent --show-error --max-time 10 https://worker.cloudnexus360.com/ >/dev/null

state_stage="$(mktemp "${STATE_DIR}/releases.env.XXXXXX")"
trap 'rm -f "${state_stage:-}"' EXIT
printf 'CURRENT_RELEASE=%s\nPREVIOUS_RELEASE=%s\n' "${RELEASE}" "${previous_release}" >"${state_stage}"
chmod 0640 "${state_stage}"
mv "${state_stage}" "${STATE_FILE}"

echo "Deployed ${IMAGE_REPOSITORY}:${RELEASE}; Caddy backup: ${caddy_backup}. Run the authenticated WSS smoke check documented in README.md."
