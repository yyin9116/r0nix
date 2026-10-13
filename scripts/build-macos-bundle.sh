#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS bundle builds require Darwin." >&2
  exit 2
fi

profile="release"
tauri_args=()
if [[ "${1:-}" == "--debug" ]]; then
  profile="debug"
  tauri_args+=("--debug")
elif [[ "${1:-}" != "" ]]; then
  echo "usage: $0 [--debug]" >&2
  exit 2
fi

app_path="src-tauri/target/$profile/bundle/macos/r0nix.app"

# A clean Tauri/PyMuPDF build needs several GiB for Rust intermediates and
# the embedded runtime. Fail before compilation when the volume is too full;
# otherwise macOS may report the resulting half-written app as a launch crash.
min_free_kib=$((4 * 1024 * 1024))
free_kib="$(df -Pk . | awk 'NR == 2 { print $4 }')"
if [[ ! "$free_kib" =~ ^[0-9]+$ || "$free_kib" -lt "$min_free_kib" ]]; then
  echo "macos-bundle: at least 4 GiB free disk space is required before building (available: ${free_kib:-unknown} KiB)" >&2
  exit 3
fi

# `${arr[@]+"${arr[@]}"}` rather than a bare `"${arr[@]}"`: macOS ships bash 3.2,
# where expanding an *empty* array under `set -u` aborts with "unbound variable".
# The CI runner uses that /bin/bash, so a bare expansion fails any default build.
npx tauri build ${tauri_args[@]+"${tauri_args[@]}"} --bundles app

architecture="$(uname -m)"
if [[ "$architecture" == "arm64" ]]; then
  architecture="aarch64"
fi
version="$(node -p 'JSON.parse(require("fs").readFileSync("src-tauri/tauri.conf.json", "utf8")).version')"
dmg_dir="src-tauri/target/$profile/bundle/dmg"
dmg_path="$dmg_dir/r0nix_${version}_${architecture}.dmg"
mkdir -p "$dmg_dir"

APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}" \
bash scripts/patch-macos-bundle.sh "$app_path"
bash scripts/macos-bundle-smoke.sh "$app_path"
bash scripts/macos-app-process-smoke.sh "$app_path"

bash scripts/create-macos-dmg.sh "$app_path" "$dmg_path"
bash scripts/macos-bundle-smoke.sh "$app_path" "$dmg_path"

echo "macos-bundle: ready"
echo "app: $app_path"
echo "dmg: $dmg_path"
