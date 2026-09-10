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
# Deliberately without the --import below: migrations need no spans and should
# not depend on the telemetry module loading at all.
node dist/db/migrate.js

echo "Starting server..."
# --import evaluates dist/telemetry.js before the application's module graph,
# which is the only moment @opentelemetry/instrumentation-pg can patch `pg`:
# ESM hoists imports, so nothing called from index.js is early enough. The path
# is a literal shipped in the image and never read from the environment — a
# module path from env would be an arbitrary-code-load primitive for anyone who
# can set env on the app. With OTEL_EXPORTER_OTLP_ENDPOINT empty (every deployed
# environment today) the module returns immediately. If dist/telemetry.js were
# missing this crashloops and Sevalla holds the previous revision, which is why
# `npm run verify:tracing` boots the built output.
exec node --import ./dist/telemetry.js dist/index.js
