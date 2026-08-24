#!/usr/bin/env bash
# ============================================================================
# Runs the full suite, and if any scenarios failed, re-runs exactly those
# scenarios once from the Cucumber rerun file. Mirrors the retry step used
# in .gitlab-ci.yml / .github/workflows/ci.yml so you can reproduce a CI
# retry locally.
#
# Usage: ./scripts/retry-failed.sh [extra mvn args...]
#   e.g. ./scripts/retry-failed.sh -Denv=stage
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

RERUN_FILE="target/cucumber-reports/rerun.txt"
MVN="./mvnw"
[ -x "$MVN" ] || MVN="mvn"

echo "== First attempt =========================================="
rm -f "$RERUN_FILE"
set +e
$MVN -q clean test "$@"
FIRST_EXIT=$?
set -e

if [ ! -s "$RERUN_FILE" ]; then
  echo "No failed scenarios recorded in $RERUN_FILE - nothing to retry."
  exit "$FIRST_EXIT"
fi

echo ""
echo "== Failures detected, retrying just the failed scenarios =="
cat "$RERUN_FILE"
echo ""

$MVN -q test "$@" -Dcucumber.features="@${RERUN_FILE}"
RETRY_EXIT=$?

if [ "$RETRY_EXIT" -eq 0 ]; then
  echo "All previously-failed scenarios passed on retry."
else
  echo "Scenarios still failing after retry - treat this as a real failure."
fi
exit "$RETRY_EXIT"
