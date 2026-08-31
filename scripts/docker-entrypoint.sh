#!/bin/sh
set -e

# Migrations run here rather than as a separate pipeline step because Sevalla
# databases are not reachable from GitHub Actions unless public access is turned
# on. The advisory lock in migrate.ts makes this safe when several instances
# start at once, and ADR 0003 (enforced by CI) guarantees the migration is
# additive, so the previous version keeps serving throughout the rollout.
#
# A failure here exits non-zero, the container never becomes ready, and Sevalla
# holds the old revision in place.

echo "Running migrations..."
node dist/db/migrate.js

echo "Starting server..."
exec node dist/index.js
