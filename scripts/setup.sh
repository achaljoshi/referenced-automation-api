#!/usr/bin/env bash
# ============================================================================
# One-shot local setup - works from a completely fresh clone of the whole
# repo family, in any order: builds whichever sibling packages this repo
# depends on (from a sibling checkout, cloning nothing on its own) before
# `npm ci`, since npm ci fails otherwise if e.g. referenced-automation-utils
# hasn't been packaged into ../shared-packages yet.
#
# Pure API testing needs no browser binaries (no `page`/`browser` fixture is
# used here), so there is no `playwright install` step - see the `ui`/`sap`
# repos for that.
#
# Usage: ./scripts/setup.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SHARED_PACKAGES_DIR="../shared-packages"

# Builds <repo_name> into $SHARED_PACKAGES_DIR if its tarball isn't already
# there. Assumes <repo_name> is checked out as a sibling of this repo (the
# same layout scripts/create-package.sh's default output dir assumes).
ensure_package() {
  local repo_name="$1"
  if compgen -G "$SHARED_PACKAGES_DIR/automation-${repo_name}-*.tgz" > /dev/null 2>&1; then
    echo "== ${repo_name}: already packaged =="
    return
  fi
  local repo_dir="../${repo_name}"
  if [ ! -d "$repo_dir" ]; then
    echo "ERROR: ${repo_name} is not packaged and not checked out at ${repo_dir}." >&2
    echo "Clone it as a sibling of this repo first:" >&2
    echo "  git clone https://github.com/achaljoshi/${repo_name}.git ${repo_dir}" >&2
    exit 1
  fi
  echo "== Building ${repo_name} (dependency) =="
  ( cd "$repo_dir" && ./scripts/create-package.sh "$SHARED_PACKAGES_DIR" )
}

echo "== Ensuring dependency packages exist in ${SHARED_PACKAGES_DIR} =========="
ensure_package referenced-automation-utils

echo ""
echo "== Installing dependencies =========================================="
npm ci

echo ""
echo "Setup complete. Try: npm test"
