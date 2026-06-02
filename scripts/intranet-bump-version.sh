#!/bin/sh
# Bump minor version in repo-root `version` (format vMAJOR.MINOR, e.g. v2.0 → v2.1).
# Prints new version on stdout; progress on stderr.
set -e
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || ROOT="."
cd "$ROOT"
VERSION_FILE="$ROOT/version"
CURRENT=$(cat "$VERSION_FILE")
MAJOR=$(echo "$CURRENT" | sed 's/^v//' | cut -d. -f1)
MINOR=$(echo "$CURRENT" | sed 's/^v//' | cut -d. -f2)
NEW_MINOR=$((MINOR + 1))
NEW_VERSION="v${MAJOR}.${NEW_MINOR}"
echo "$NEW_VERSION" > "$VERSION_FILE"
echo >&2 "Bumping $CURRENT → $NEW_VERSION"
echo "$NEW_VERSION"
