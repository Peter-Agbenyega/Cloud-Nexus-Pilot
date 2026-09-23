#!/usr/bin/env bash
set -Eeuo pipefail

readonly RELEASE="${1:-}"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly COMPOSE_FILE="${REPO_ROOT}/apps/pilot-realtime-api/compose.yaml"
readonly ENV_FILE="${REPO_ROOT}/apps/pilot-realtime-api/.env"
readonly STATE_DIR="${REALTIME_STATE_DIR:-/var/lib/cloud-nexus-pilot/realtime}"
readonly STATE_FILE="${STATE_DIR}/releases.env"
source "${SCRIPT_DIR}/release-common.sh"

[[ "${RELEASE}" =~ ^[0-9a-f]{40}$ ]] || { echo "Usage: $0 <40-character-git-sha>" >&2; exit 2; }
for command in caddy curl docker flock git ss; do
  command -v "${command}" >/dev/null || { echo "Required command missing: ${command}" >&2; exit 1; }
done
[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
[[ -z "$(git -C "${REPO_ROOT}" status --porcelain)" ]] || { echo "Worktree is not clean" >&2; exit 1; }
[[ "$(git -C "${REPO_ROOT}" rev-parse HEAD)" == "${RELEASE}" ]] || { echo "Checked-out HEAD does not equal release SHA" >&2; exit 1; }
docker info >/dev/null
load_release_state
[[ -z "${pending_release}" ]] || { echo "An interrupted release is pending; run rollback-realtime.sh first" >&2; exit 1; }
if [[ -n "${current_release}" ]]; then
  docker image inspect "${IMAGE_REPOSITORY}:${current_release}" >/dev/null
fi
caddy_backup="$(mktemp "${STATE_DIR}/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.backup")"
install -m 0640 "${CADDY_CONFIG}" "${caddy_backup}"

for name in NODE_ENV CORS_ORIGIN SUPABASE_URL SUPABASE_PUBLISHABLE_KEY OPENAI_API_KEY DEEPGRAM_API_KEY; do
  grep -Eq "^${name}=.+" "${ENV_FILE}" || { echo "Required environment variable is absent or empty: ${name}" >&2; exit 1; }
done
REALTIME_RELEASE="${RELEASE}" REALTIME_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
caddy validate --config "${CADDY_CONFIG}" --adapter caddyfile
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3010/health >/dev/null || echo "No currently healthy realtime service (permitted for first deploy)"

# An existing SHA tag is reused, so retries cannot replace its original image.
if ! docker image inspect "${IMAGE_REPOSITORY}:${RELEASE}" >/dev/null 2>&1; then
  docker build --file "${REPO_ROOT}/apps/pilot-realtime-api/Dockerfile" --tag "${IMAGE_REPOSITORY}:${RELEASE}" "${REPO_ROOT}"
fi
docker image inspect "${IMAGE_REPOSITORY}:${RELEASE}" >/dev/null
next_previous="${current_release}"
[[ "${RELEASE}" != "${current_release}" ]] || next_previous="${previous_release}"
transition_release "${RELEASE}" "${next_previous}"
echo "Deployed ${IMAGE_REPOSITORY}:${RELEASE}; Caddy backup: ${caddy_backup}. Run the authenticated WSS smoke check documented in README.md."
