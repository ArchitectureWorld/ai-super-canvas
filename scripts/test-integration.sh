#!/usr/bin/env bash
set -euo pipefail
run_id="${CI_RUN_ID:-local}"
run_id="${run_id//[^a-zA-Z0-9_-]/-}"
run_attempt="${CI_RUN_ATTEMPT:-0}"
run_attempt="${run_attempt//[^a-zA-Z0-9_-]/-}"
run_pid="$BASHPID"
project="${COMPOSE_PROJECT_NAME:-ai-super-canvas-s1-test-${run_id}-${run_attempt}-${run_pid}}"
compose=(docker compose -p "$project" -f compose.control-plane-test.yaml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans; }
trap cleanup EXIT
cleanup
"${compose[@]}" up -d postgres-test
"${compose[@]}" run --rm --build test --filter @ai-super-canvas/db db:migrate
"${compose[@]}" run --rm test test:integration
