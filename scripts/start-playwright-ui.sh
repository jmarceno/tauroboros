#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
UI_PORT=${TEST_SERVER_PORT:-3000}
BACKEND_PORT=${PLAYWRIGHT_BACKEND_PORT:-3789}
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/tauroboros-playwright-ui-XXXXXX")
PROJECT_ROOT="$TEMP_ROOT/project"

cleanup() {
    if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    rm -rf "$TEMP_ROOT"
}

trap cleanup EXIT INT TERM

mkdir -p "$PROJECT_ROOT/.tauroboros"

cat > "$PROJECT_ROOT/.gitignore" <<'EOF'
.tauroboros/
.worktrees/
EOF

cat > "$PROJECT_ROOT/README.md" <<'EOF'
# Playwright UI harness
EOF

git init -b master "$PROJECT_ROOT" >/dev/null 2>&1
git -C "$PROJECT_ROOT" config user.email "test@example.com"
git -C "$PROJECT_ROOT" config user.name "Test User"
git -C "$PROJECT_ROOT" add .gitignore README.md
git -C "$PROJECT_ROOT" commit -m "init" >/dev/null 2>&1
git -C "$PROJECT_ROOT" branch e2e-secondary >/dev/null 2>&1

cat > "$PROJECT_ROOT/.tauroboros/settings.json" <<EOF
{
  "workflow": {
    "server": {
      "port": $BACKEND_PORT,
      "dbPath": ".tauroboros/tasks.db"
    },
    "container": {
      "enabled": false
    }
  }
}
EOF

export PROJECT_ROOT
export DATABASE_PATH="$PROJECT_ROOT/.tauroboros/tasks.db"
export SERVER_PORT="$BACKEND_PORT"
export DEV_PORT="$UI_PORT"

cd "$REPO_ROOT"
./start-rust-dev.sh &
SERVER_PID=$!

for _ in {1..60}; do
  if curl --silent --fail "http://localhost:${BACKEND_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl --silent --show-error --fail \
  -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"branch":"master"}' \
  "http://localhost:${BACKEND_PORT}/api/options" >/dev/null

wait "$SERVER_PID"