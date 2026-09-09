#!/usr/bin/env bash
set -euo pipefail

npm run build:ui -- --watch &
ui_pid=$!
trap 'kill "$ui_pid" 2>/dev/null || true' EXIT INT TERM

exec npx tsx watch src/apps/gateway.ts
