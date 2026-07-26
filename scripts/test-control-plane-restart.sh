#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_dir="$(cd -- "$script_dir/.." && pwd)"
cd "$repository_dir"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing restart acceptance from a dirty tracked worktree." >&2
  exit 1
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Refusing restart acceptance with untracked source files." >&2
  exit 1
fi

acceptance_id="${CONTROL_PLANE_ACCEPTANCE_ID:-}"
if [[ -z "$acceptance_id" ]]; then
  acceptance_id="$(node -e "console.log(require('node:crypto').randomUUID())")"
fi
if [[ ! "$acceptance_id" =~ ^[a-zA-Z0-9_-]{8,128}$ ]]; then
  echo "CONTROL_PLANE_ACCEPTANCE_ID is not filesystem-safe." >&2
  exit 1
fi

artifact_directory="${CONTROL_PLANE_ACCEPTANCE_ARTIFACT_DIR:-/tmp/ai-super-canvas-control-plane-acceptance}"
container_name="${CONTROL_PLANE_CONTAINER_NAME:-ai-super-canvas-app-1}"
service_name="${CONTROL_PLANE_SERVICE_NAME:-ai-super-canvas.service}"
base_url="${CONTROL_PLANE_BASE_URL:-http://127.0.0.1:3000}"
mkdir -p "$artifact_directory"

commit_sha="$(git rev-parse HEAD)"
container_id_before="$(docker inspect --format '{{.Id}}' "$container_name")"
image_id_before="$(docker inspect --format '{{.Image}}' "$container_name")"

export CONTROL_PLANE_ACCEPTANCE_ID="$acceptance_id"
export CONTROL_PLANE_ACCEPTANCE_ARTIFACT_DIR="$artifact_directory"
export CONTROL_PLANE_BASE_URL="$base_url"
export CONTROL_PLANE_COMMIT_SHA="$commit_sha"
export CONTROL_PLANE_CONTAINER_ID_BEFORE="$container_id_before"
export CONTROL_PLANE_IMAGE_ID="$image_id_before"

RUN_REAL_CONTROL_PLANE_E2E=1 corepack pnpm exec playwright test \
  tests/e2e/control-plane-test.real.spec.ts \
  --config=playwright.real.config.ts \
  --project=chromium \
  --grep "before service restart"

systemctl --user restart "$service_name"

ready=0
for _attempt in {1..30}; do
  if curl --silent --show-error --fail \
    --connect-timeout 2 \
    --max-time 5 \
    "$base_url/api/ready" >/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  echo "Service did not become ready after restart." >&2
  exit 1
fi

container_id_after="$(docker inspect --format '{{.Id}}' "$container_name")"
image_id_after="$(docker inspect --format '{{.Image}}' "$container_name")"
if [[ "$container_id_before" == "$container_id_after" ]]; then
  echo "App container identity did not change across restart." >&2
  exit 1
fi
if [[ "$image_id_before" != "$image_id_after" ]]; then
  echo "App image changed during restart acceptance." >&2
  exit 1
fi

export CONTROL_PLANE_CONTAINER_ID_AFTER="$container_id_after"
RUN_REAL_CONTROL_PLANE_RESTART_E2E=1 corepack pnpm exec playwright test \
  tests/e2e/control-plane-test.real.spec.ts \
  --config=playwright.real.config.ts \
  --project=chromium \
  --grep "after service restart"

manifest_path="$artifact_directory/control-plane-$acceptance_id.manifest.json"
screenshot_path="$artifact_directory/control-plane-$acceptance_id.png"
echo "Acceptance ID: $acceptance_id"
echo "Commit: $commit_sha"
echo "Image: $image_id_before"
echo "Manifest: $manifest_path"
echo "Screenshot: $screenshot_path"
