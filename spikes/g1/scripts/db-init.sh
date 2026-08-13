#!/bin/sh
set -eu

spike_db_url="${ONTOLOGY_SPIKE_DATABASE_URL:-postgresql://ontology_spike:ontology_spike@127.0.0.1:55432/ontology_spike}"
spike_db_name="$(psql "$spike_db_url" -X -A -t -v ON_ERROR_STOP=1 -c 'select current_database()')"

if [ "$spike_db_name" != "ontology_spike" ] && [ "${ONTOLOGY_SPIKE_ALLOW_NONDEFAULT_DB:-0}" != "1" ]; then
  echo "Refusing to initialize database '$spike_db_name'. Expected 'ontology_spike'." >&2
  echo "Set ONTOLOGY_SPIKE_ALLOW_NONDEFAULT_DB=1 only for an explicitly isolated database." >&2
  exit 2
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_dir="$(dirname -- "$script_dir")"

psql "$spike_db_url" -X -v ON_ERROR_STOP=1 -f "$project_dir/sql/001_schema.sql"
psql "$spike_db_url" -X -v ON_ERROR_STOP=1 -f "$project_dir/sql/010_seed.sql"
psql "$spike_db_url" -X -v ON_ERROR_STOP=1 -f "$project_dir/sql/020_indexes.sql"
psql "$spike_db_url" -X -v ON_ERROR_STOP=1 -f "$project_dir/sql/040_overlay_functions.sql"
psql "$spike_db_url" -X -v ON_ERROR_STOP=1 -f "$project_dir/sql/030_verify.sql"
