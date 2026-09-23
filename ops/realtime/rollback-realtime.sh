#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly COMPOSE_FILE="${REPO_ROOT}/apps/pilot-realtime-api/compose.yaml"
readonly ENV_FILE="${REPO_ROOT}/apps/pilot-realtime-api/.env"
readonly STATE_DIR="${REALTIME_STATE_DIR:-/var/lib/cloud-nexus-pilot/realtime}"
readonly STATE_FILE="${STATE_DIR}/releases.env"
source "${SCRIPT_DIR}/release-common.sh"

for command in caddy curl docker flock ss; do
  command -v "${command}" >/dev/null || { echo "Required command missing: ${command}" >&2; exit 1; }
done
[[ -f "${ENV_FILE}" && -r "${STATE_FILE}" ]] || { echo "Missing environment file or release state" >&2; exit 1; }
load_release_state
if [[ -n "${pending_release}" ]]; then
  target_release="${current_release}"
  next_previous="${previous_release}"
else
  target_release="${previous_release}"
  next_previous="${current_release}"
fi
[[ "${current_release}" =~ ^[0-9a-f]{40}$ && "${target_release}" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "Rollback state is incomplete; manual recovery is required" >&2; exit 1; }
docker image inspect "${IMAGE_REPOSITORY}:${current_release}" >/dev/null
docker image inspect "${IMAGE_REPOSITORY}:${target_release}" >/dev/null
REALTIME_RELEASE="${target_release}" REALTIME_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
transition_release "${target_release}" "${next_previous}"
echo "Rolled back to ${IMAGE_REPOSITORY}:${target_release}. Complete the authenticated WSS smoke check."
