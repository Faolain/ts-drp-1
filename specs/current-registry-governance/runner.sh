set -euo pipefail
: "${BASE_SHA:?explicit transition base is required}"
: "${GITHUB_WORKSPACE:?repository root is required}"
: "${RUNNER_TEMP:?runner temporary directory is required}"
BASE_COMMIT="$(git rev-parse --verify --end-of-options "${BASE_SHA}^{commit}")"
MERGE_BASE="$(git merge-base --all "$BASE_COMMIT" HEAD)"
case "$MERGE_BASE" in
  ''|*[!0-9a-f]*) echo "Exactly one merge-base is required." >&2; exit 1 ;;
esac
if [ "${#MERGE_BASE}" -ne 40 ]; then
  echo "A complete SHA-1 merge-base is required for this repository." >&2
  exit 1
fi
CHECK_DIRECTORY="$(mktemp -d "$RUNNER_TEMP/protocol-v3-current.XXXXXX")"
git show "$MERGE_BASE:packages/protocol-v2/scripts/check-protocol-freeze.mjs" > "$CHECK_DIRECTORY/check-protocol-v2-freeze.mjs"
git show "$MERGE_BASE:packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs" > "$CHECK_DIRECTORY/check-protocol-v3-freeze.mjs"
PROTOCOL_FREEZE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \
  node "$CHECK_DIRECTORY/check-protocol-v2-freeze.mjs" "$MERGE_BASE"
PROTOCOL_V3_FREEZE_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \
  node "$CHECK_DIRECTORY/check-protocol-v3-freeze.mjs" "$MERGE_BASE"
