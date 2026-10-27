#!/bin/bash
set -euo pipefail
umask 077
: "${POSTGRES_PASSWORD:?Private database administrator credential required}"
# The operator prepares only the approved dedicated volume as postgres:postgres0700.
# Do not fix ownership on an unknown mount or initialize over an existing cluster.
if [[ ! -f /pilot-data/db/PG_VERSION ]]; then
  [[ ! -e /pilot-data/db ]] || { echo 'Unrecognized database directory; initialization refused.' >&2; exit 1; }
  printf '%s' "$POSTGRES_PASSWORD" >/tmp/pilot-init-password
  trap 'rm -f /tmp/pilot-init-password' EXIT
  initdb -D /pilot-data/db --username=postgres --auth-local=peer --auth-host=scram-sha-256 --pwfile=/tmp/pilot-init-password >/tmp/pilot-init.log 2>&1
  printf '\nhost all all 0.0.0.0/0 scram-sha-256\n' >>/pilot-data/db/pg_hba.conf
  rm -f /tmp/pilot-init-password
  trap - EXIT
fi
[[ "$(cat /pilot-data/db/PG_VERSION)" == 17 ]] || { echo 'Expected PostgreSQL17; no automatic upgrade performed.' >&2; exit 1; }
unset POSTGRES_PASSWORD
exec postgres -D /pilot-data/db -c listen_addresses='*' -c unix_socket_directories=/tmp -c max_connections=60 -c shared_buffers=256MB -c shared_preload_libraries=pg_stat_statements
