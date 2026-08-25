#!/usr/bin/env bash
# ============================================================================
# Builds this package and produces a versioned .tgz the exact same way
# `npm publish` would, without needing a registry yet:
#   - other repos on this machine can depend on it via
#       "referenced-automation-api": "file:../shared-packages/referenced-automation-api-1.0.0.tgz"
#   - or hand the .tgz to DevOps to `npm publish <file>.tgz --registry <nexus-npm-url>`
#     once a private npm registry (e.g. Nexus) is wired up.
#
# Usage: ./scripts/create-package.sh [output-dir]
#   Default output-dir: ../shared-packages (sibling to this repo)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${1:-../shared-packages}"
mkdir -p "$OUT_DIR"

npm ci
npm run build

# `npm pack` runs the "prepack" script (build) again and writes
# <name>-<version>.tgz into the current directory - move it into place.
TARBALL="$(npm pack --silent)"
mv "$TARBALL" "$OUT_DIR/"

echo ""
echo "Package written to: $(cd "$OUT_DIR" && pwd)/$TARBALL"
echo "Consume it from another repo with:"
echo "  npm install $(cd "$OUT_DIR" && pwd)/$TARBALL"
