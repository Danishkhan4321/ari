#!/usr/bin/env bash
# This helper validates the workspace and starts the Ari desktop companion.
set -euo pipefail

cd "$(dirname "$0")/.."
npm test
npm test --prefix dashboard
npm run typecheck --prefix dashboard
npm test --prefix desktop
echo "Validation passed. Starting Ari desktop companion..."
npm run desktop:dev
