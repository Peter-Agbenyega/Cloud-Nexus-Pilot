#!/usr/bin/env bash
# Shared transaction handling for deploy and rollback. Sourced after paths are set.
readonly IMAGE_REPOSITORY="cloud-nexus-pilot-realtime"
readonly CADDY_CONFIG="${CADDY_ROOT:-/etc/caddy}/Caddyfile"
current_release=""
previous_release=""
pending_release=""
transition_active=0

load_release_state() {
  install -d -m 0750 "${STATE_DIR}"
  exec 9>"${STATE_DIR}/release.lock"
  flock -n 9 || { echo "Another realtime release operation is running" >&2; return 1; }
  if [[ -f "${STATE_FILE}" ]]; then
    current_release="$(sed -n 's/^CURRENT_RELEASE=//p' "${STATE_FILE}")"
    previous_release="$(sed -n 's/^PREVIOUS_RELEASE=//p' "${STATE_FILE}")"
    pending_release="$(sed -n 's/^PENDING_RELEASE=//p' "${STATE_FILE}")"
    [[ "${current_release}" =~ ^[0-9a-f]{40}$ || ( -z "${current_release}" && -n "${pending_release}" ) ]] \
      || { echo "Invalid current release state" >&2; return 1; }
    for value in "${previous_release}" "${pending_release}"; do
      [[ -z "${value}" || "${value}" =~ ^[0-9a-f]{40}$ ]] \
        || { echo "Invalid release state" >&2; return 1; }
    done
  fi
}

write_release_state() {
  local stage
  stage="$(mktemp "${STATE_DIR}/releases.env.XXXXXX")" || return 1
  if ! printf 'CURRENT_RELEASE=%s\nPREVIOUS_RELEASE=%s\nPENDING_RELEASE=%s\n' "$1" "$2" "$3" >"${stage}" \
    || ! chmod 0640 "${stage}" || ! mv "${stage}" "${STATE_FILE}"; then
    rm -f "${stage}"
    return 1
  fi
}

start_release() {
  REALTIME_RELEASE="$1" REALTIME_ENV_FILE="${ENV_FILE}" docker compose \
    --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --no-deps --no-build pilot-realtime-api
}

verify_release() {
  local container_state="" listeners origin_status
  for _ in {1..30}; do
    container_state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' cloud-nexus-pilot-realtime)" || return 1
    [[ "${container_state}" == "running healthy" ]] && break
    sleep 2
  done
  [[ "${container_state}" == "running healthy" ]] || { echo "Realtime container is not running and healthy" >&2; return 1; }
  [[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' cloud-nexus-pilot-realtime)" == "host" ]] \
    || { echo "Realtime container must use host networking" >&2; return 1; }
  listeners="$(ss -ltn '( sport = :3010 )')" || return 1
  grep -Eq '127\.0\.0\.1:3010' <<<"${listeners}" || { echo "Port 3010 is not bound to IPv4 loopback" >&2; return 1; }
  if grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]|\*):3010' <<<"${listeners}"; then
    echo "Port 3010 has a wildcard listener" >&2
    return 1
  fi
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3010/health >/dev/null || return 1
  caddy validate --config "${CADDY_CONFIG}" --adapter caddyfile || return 1
  curl --fail --silent --show-error --max-time 10 https://realtime.cloudnexuspilot.com/health >/dev/null || return 1
  origin_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    --header 'Connection: Upgrade' --header 'Upgrade: websocket' \
    --header 'Origin: https://unauthorized.invalid' \
    https://realtime.cloudnexuspilot.com/ws/session)" || return 1
  [[ "${origin_status}" == "403" ]] || { echo "Unauthorized Origin was not rejected with 403" >&2; return 1; }
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null || return 1
  curl --fail --silent --show-error --max-time 10 https://worker.cloudnexus360.com/health >/dev/null || return 1
}

finish_release_operation() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "${transition_active}" == 1 ]]; then
    # Keep the pending journal if recovery itself fails; a later rollback will
    # target CURRENT_RELEASE (the last good release), never skip to PREVIOUS.
    status=1
    if [[ -n "${current_release}" ]] \
      && docker image inspect "${IMAGE_REPOSITORY}:${current_release}" >/dev/null \
      && start_release "${current_release}" && verify_release \
      && write_release_state "${current_release}" "${previous_release}" ""; then
      echo "Release failed; restored last-good release ${current_release}" >&2
    else
      echo "Release failed; recovery incomplete. Pending state retained in ${STATE_FILE}. Run rollback after resolving the failure; first deployments without a recorded release require manual recovery." >&2
    fi
  fi
  exit "${status}"
}
trap finish_release_operation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

transition_release() {
  local target="$1" next_previous="$2"
  # Write intent before replacing the container, including on first deployment.
  transition_active=1
  write_release_state "${current_release}" "${previous_release}" "${target}"
  start_release "${target}"
  verify_release
  write_release_state "${target}" "${next_previous}" ""
  transition_active=0
}
