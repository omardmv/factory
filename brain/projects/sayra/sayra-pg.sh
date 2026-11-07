#!/usr/bin/env bash
# Start a throwaway Postgres 16 (+ pgvector) owned by the agent user, for tests. Idempotent.
set -euo pipefail
[ "${1:-start}" = start ] || { echo "usage: sayra-pg start" >&2; exit 2; }
D="${PGDATA_DIR:-$HOME/pgdata}"; BIN="$(ls -d /usr/lib/postgresql/*/bin | tail -1)"
[ -d "$D" ] || "$BIN/initdb" -D "$D" -A trust -U agent >/dev/null
"$BIN/pg_ctl" -D "$D" status >/dev/null 2>&1 || "$BIN/pg_ctl" -D "$D" -l "$D/log" -w start >/dev/null
"$BIN/psql" -h 127.0.0.1 -U agent -d postgres -tc "select 1 from pg_database where datname='sayra'" | grep -q 1 \
  || "$BIN/createdb" -h 127.0.0.1 -U agent sayra
"$BIN/psql" -h 127.0.0.1 -U agent -d sayra -qc 'create extension if not exists vector'
echo "postgresql://agent@127.0.0.1:5432/sayra"
