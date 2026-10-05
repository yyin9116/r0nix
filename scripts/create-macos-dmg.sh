#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: create-macos-dmg.sh path/to/r0nix.app path/to/output.dmg}"
dmg_path="${2:?usage: create-macos-dmg.sh path/to/r0nix.app path/to/output.dmg}"

test -d "$app_path"
mkdir -p "$(dirname "$dmg_path")"

staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/r0nix-dmg.XXXXXX")"
cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT

# Build the volume from a clean staging directory so the DMG contains only the
# application and the conventional Applications drop target.
ditto "$app_path" "$staging_dir/r0nix.app"
ln -s /Applications "$staging_dir/Applications"
hdiutil create \
  -volname r0nix \
  -srcfolder "$staging_dir" \
  -ov \
  -format UDZO \
  "$dmg_path" >/dev/null
echo "macos-dmg: created $dmg_path"
