#!/usr/bin/env bash
# Run Ari's local dashboard without any hosted deployment target.
set -euo pipefail

cd "$(dirname "$0")/../dashboard"
npm test
npm run typecheck
npm run dev -- --hostname 127.0.0.1 --port 43101
