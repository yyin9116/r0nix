#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: macos-bundle-smoke.sh path/to/r0nix.app [path/to/dmg] }"
dmg_path="${2:-}"

test -x "$app_path/Contents/MacOS/r0nix"
test -d "$app_path/Contents/Resources/runtime"
! find "$app_path/Contents/Resources/runtime" \( -name '__pycache__' -o -name '*.pyc' \) -print -quit | grep -q .
codesign --verify --deep --strict "$app_path"

if [[ -n "$dmg_path" ]]; then
  test -f "$dmg_path"
  hdiutil verify "$dmg_path" >/dev/null
fi

echo "macos-bundle-smoke: ok"
