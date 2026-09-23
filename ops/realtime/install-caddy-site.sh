#!/usr/bin/env bash
set -Eeuo pipefail

readonly CADDY_ROOT="${CADDY_ROOT:-/etc/caddy}"
readonly MAIN_CONFIG="${CADDY_ROOT}/Caddyfile"
readonly SITES_DIR="${CADDY_ROOT}/sites-enabled"
readonly SITE_CONFIG="${SITES_DIR}/realtime.cloudnexuspilot.com.caddy"
readonly SOURCE_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/Caddyfile.cloudnexuspilot"
readonly STAGE_DIR="$(mktemp -d)"
restore_needed=0
reload_attempted=0
BACKUP_DIR=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "${restore_needed}" == 1 ]]; then
    status=1
    if restore_fragment; then
      if [[ "${reload_attempted}" == 0 ]] || {
        caddy validate --config "${MAIN_CONFIG}" --adapter caddyfile && systemctl reload caddy;
      }; then
        echo "Install failed; restored the previous site fragment. Backup: ${BACKUP_DIR}" >&2
      else
        echo "Previous fragment restored on disk, but Caddy recovery failed; manual recovery required. Backup: ${BACKUP_DIR}" >&2
      fi
    else
      echo "Could not restore the previous fragment; manual recovery required. Backup: ${BACKUP_DIR}" >&2
    fi
  fi
  rm -rf "${STAGE_DIR}"
  exit "${status}"
}
restore_fragment() {
  if [[ -f "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy" ]]; then
    install -m 0644 "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy" "${SITE_CONFIG}"
  else
    rm -f "${SITE_CONFIG}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in caddy curl install systemctl; do
  command -v "${command}" >/dev/null || { echo "Required command missing: ${command}" >&2; exit 1; }
done
[[ -r "${MAIN_CONFIG}" ]] || { echo "Cannot read ${MAIN_CONFIG}" >&2; exit 1; }

# This deliberately refuses to rewrite an unknown monolithic configuration.
# Establish the import once, manually, after reviewing the existing Caddyfile.
if ! grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/sites-enabled/\*[[:space:]]*$' "${MAIN_CONFIG}"; then
  echo "Refusing install: ${MAIN_CONFIG} must contain exactly one: import /etc/caddy/sites-enabled/*" >&2
  exit 1
fi
if [[ "$(grep -Ec '^[[:space:]]*import[[:space:]]+/etc/caddy/sites-enabled/\*[[:space:]]*$' "${MAIN_CONFIG}")" -ne 1 ]]; then
  echo "Refusing install: sites-enabled import is not unique" >&2
  exit 1
fi

install -d -m 0755 "${CADDY_ROOT}/backups" "${SITES_DIR}"
BACKUP_DIR="$(mktemp -d "${CADDY_ROOT}/backups/realtime-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")"
install -m 0644 "${MAIN_CONFIG}" "${BACKUP_DIR}/Caddyfile"
if [[ -e "${SITE_CONFIG}" ]]; then
  install -m 0644 "${SITE_CONFIG}" "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy"
fi
install -m 0644 "${SOURCE_CONFIG}" "${STAGE_DIR}/realtime.cloudnexuspilot.com.caddy"
restore_needed=1
install -m 0644 "${STAGE_DIR}/realtime.cloudnexuspilot.com.caddy" "${SITE_CONFIG}"

caddy validate --config "${MAIN_CONFIG}" --adapter caddyfile
reload_attempted=1
systemctl reload caddy
curl --fail --silent --show-error --max-time 10 https://realtime.cloudnexuspilot.com/health >/dev/null
curl --fail --silent --show-error --max-time 10 https://worker.cloudnexus360.com/health >/dev/null
restore_needed=0

echo "Installed realtime site; backup: ${BACKUP_DIR}"
