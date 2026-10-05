#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: macos-app-process-smoke.sh path/to/r0nix.app}"
binary="$app_path/Contents/MacOS/r0nix"
test -x "$binary"

log_path="$(mktemp "${TMPDIR:-/tmp}/r0nix-process-smoke.XXXXXX.log")"
pid=""
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$log_path"
}
trap cleanup EXIT

"$binary" >"$log_path" 2>&1 &
pid=$!
for _ in {1..30}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "macos-app-process-smoke: application exited during startup" >&2
    cat "$log_path" >&2 || true
    exit 1
  fi
  sleep 1
done

echo "macos-app-process-smoke: ok"
