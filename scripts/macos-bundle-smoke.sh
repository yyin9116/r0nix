#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: macos-bundle-smoke.sh path/to/r0nix.app [path/to/dmg] }"
dmg_path="${2:-}"

verify_app() {
  local candidate="$1"
  local binary="$candidate/Contents/MacOS/r0nix"
  local runtime="$candidate/Contents/Resources/runtime"
  test -x "$binary"
  test -d "$runtime"
  test -f "$runtime/libpython3.12.dylib"
  # An installed app must never depend on a developer machine's Python
  # framework. The embedded runtime is the only supported Python boundary.
  otool -L "$binary" | grep -Fq '@rpath/libpython3.12.dylib'
  ! otool -L "$binary" | grep -Fq '/Library/Frameworks/Python.framework'
  ! find "$runtime" \( -name '__pycache__' -o -name '*.pyc' \) -print -quit | grep -q .
  codesign --verify --deep --strict "$candidate"
}

verify_app "$app_path"

if [[ -n "$dmg_path" ]]; then
  test -f "$dmg_path"
  hdiutil verify "$dmg_path" >/dev/null
  mount_point="$(mktemp -d "/tmp/r0nix-dmg-mount.XXXXXX")"
  mounted=false
  cleanup() {
    if [[ "$mounted" == true ]]; then
      hdiutil detach "$mount_point" -quiet || hdiutil detach "$mount_point" -force -quiet
    fi
    rmdir "$mount_point" 2>/dev/null || true
  }
  trap cleanup EXIT
  hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$mount_point" >/dev/null
  mounted=true
  verify_app "$mount_point/r0nix.app"
fi

echo "macos-bundle-smoke: ok"
