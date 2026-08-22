#!/usr/bin/env bash
set -euo pipefail

artifact="${1:?usage: notarize-macos-artifact.sh path/to/app-or-dmg}"
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_PASSWORD:?APPLE_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

xcrun notarytool submit "$artifact" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "$artifact"
echo "macos-notarization: stapled $artifact"
