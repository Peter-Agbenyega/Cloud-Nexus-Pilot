#!/usr/bin/env bash
set -Eeuo pipefail

readonly CADDY_ROOT="${CADDY_ROOT:-/etc/caddy}"
readonly MAIN_CONFIG="${CADDY_ROOT}/Caddyfile"
readonly SITES_DIR="${CADDY_ROOT}/sites-enabled"
readonly SITE_CONFIG="${SITES_DIR}/realtime.cloudnexuspilot.com.caddy"
readonly SOURCE_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/Caddyfile.cloudnexuspilot"
readonly STAGE_DIR="$(mktemp -d)"
readonly BACKUP_DIR="${CADDY_ROOT}/backups/realtime-$(date -u +%Y%m%dT%H%M%SZ)"

cleanup() { rm -rf "${STAGE_DIR}"; }
trap cleanup EXIT

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

install -d -m 0755 "${BACKUP_DIR}" "${SITES_DIR}"
install -m 0644 "${MAIN_CONFIG}" "${BACKUP_DIR}/Caddyfile"
if [[ -e "${SITE_CONFIG}" ]]; then
  install -m 0644 "${SITE_CONFIG}" "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy"
fi
install -m 0644 "${SOURCE_CONFIG}" "${STAGE_DIR}/realtime.cloudnexuspilot.com.caddy"
install -m 0644 "${STAGE_DIR}/realtime.cloudnexuspilot.com.caddy" "${SITE_CONFIG}"

if ! caddy validate --config "${MAIN_CONFIG}" --adapter caddyfile; then
  if [[ -f "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy" ]]; then
    install -m 0644 "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy" "${SITE_CONFIG}"
  else
    rm -f "${SITE_CONFIG}"
  fi
  echo "Validation failed; restored the previous site fragment" >&2
  exit 1
fi

systemctl reload caddy
if ! curl --fail --silent --show-error --max-time 10 https://realtime.cloudnexuspilot.com/health >/dev/null \
  || ! curl --fail --silent --show-error --max-time 10 https://worker.cloudnexus360.com/ >/dev/null; then
  if [[ -f "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy" ]]; then
    install -m 0644 "${BACKUP_DIR}/realtime.cloudnexuspilot.com.caddy" "${SITE_CONFIG}"
  else
    rm -f "${SITE_CONFIG}"
  fi
  caddy validate --config "${MAIN_CONFIG}" --adapter caddyfile
  systemctl reload caddy
  echo "Post-install verification failed; restored ${BACKUP_DIR}" >&2
  exit 1
fi

echo "Installed realtime site; backup: ${BACKUP_DIR}"
