#!/bin/bash
# Forward-only application migration. Credentials arrive in private environment.
set -euo pipefail
umask 077
[[ "${PGDATABASE:-}" == pilot ]] || { echo 'Expected dedicated pilot database.' >&2; exit 1; }
: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}"
export PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s'
psql -Xq -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS pilot_ops;
REVOKE ALL ON SCHEMA pilot_ops FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE IF NOT EXISTS pilot_ops.migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
SQL
# Deployment operations must hold the guest's reviewed exclusive release lock.
for name in 002_cloud_nexus_pilot_interviews.sql 003_pilot_durable_processing.sql; do
  file="/migrations/$name"
  digest=$(sha256sum "$file"); digest=${digest%% *}
  previous=$(psql -XqAt -v ON_ERROR_STOP=1 -c "SELECT sha256 FROM pilot_ops.migrations WHERE name='$name'")
  if [[ -n "$previous" ]]; then
    [[ "$previous" == "$digest" ]] || { echo "Applied migration checksum changed: $name" >&2; exit 1; }
    continue
  fi
  if [[ "$name" == 002* ]]; then
    existing=$(psql -XqAt -c "SELECT to_regclass('public.interview_sessions') IS NOT NULL")
    [[ "$existing" == f ]] || { echo 'Existing schema has no reviewed baseline ledger. Refusing automatic adoption.' >&2; exit 1; }
    #002 has no transaction commands: schema and receipt commit together.
    { printf 'BEGIN;\n'; cat "$file"; printf '\nGRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;\n'; printf "INSERT INTO pilot_ops.migrations(name,sha256) VALUES ('%s','%s');\nCOMMIT;\n" "$name" "$digest"; } | psql -Xq -v ON_ERROR_STOP=1
  else
    #003 owns its transaction and is retry-safe. Interruption after its COMMIT
    #before the receipt safely reapplies003; never claims an unapplied success.
    psql -Xq -v ON_ERROR_STOP=1 -f "$file"
    psql -Xq -v ON_ERROR_STOP=1 -c "INSERT INTO pilot_ops.migrations(name,sha256) VALUES ('$name','$digest')"
  fi
  printf 'Applied %s (checksum recorded).\n' "$name"
done
psql -Xq -v ON_ERROR_STOP=1 -c "NOTIFY pgrst, 'reload schema'"
