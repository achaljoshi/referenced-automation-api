#!/usr/bin/env bash
# ============================================================================
# One-shot local setup: installs dependencies. Pure API testing needs no
# browser binaries (no `page`/`browser` fixture is used here), so there is
# no `playwright install` step - see the `ui`/`sap` repos for that.
#
# Usage: ./scripts/setup.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Installing dependencies =========================================="
npm ci

echo ""
echo "Setup complete. Try: npm test"
