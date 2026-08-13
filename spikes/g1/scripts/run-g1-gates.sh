#!/bin/sh
set -eu

g1_duration_seconds="${G1_SUSTAINED_SECONDS:-1800}"

npm run gate:tests
npm run packages:validate
npm run db:up

# Conflict/catch-up/fault cases deliberately mutate the active fixture.
sh scripts/db-init.sh
npm run spike:b

# Scale, query and policy gates require an exact clean 100k/1m baseline.
sh scripts/db-init.sh
npm run spike:b:scale
npm run spike:b:cutover
npm run spike:a
npm run spike:a:index-cost
npm run spike:c
npm run spike:d

SPIKE_DURATION_SECONDS="$g1_duration_seconds" \
SPIKE_TARGET_RPS=20 \
SPIKE_MAX_IN_FLIGHT=16 \
npm run spike:a:sustained

npm run evidence:environment
