#!/usr/bin/env bash
set -euo pipefail

# Source this file from a macOS release step, then call setup_macos_signing.
# The keychain is intentionally short-lived and is removed by cleanup.

setup_macos_signing() {
  : "${APPLE_CERTIFICATE:?APPLE_CERTIFICATE is required}"
  : "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE_PASSWORD is required}"
  : "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}"

  local work_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/r0nix-signing"
  mkdir -p "$work_dir"
  MACOS_SIGNING_WORK_DIR="$work_dir"
  MACOS_SIGNING_KEYCHAIN="$work_dir/r0nix-signing.keychain-db"
  MACOS_SIGNING_CERTIFICATE="$work_dir/certificate.p12"
  MACOS_SIGNING_KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"

  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$MACOS_SIGNING_CERTIFICATE"
  security create-keychain -p "$MACOS_SIGNING_KEYCHAIN_PASSWORD" "$MACOS_SIGNING_KEYCHAIN" >/dev/null
  security set-keychain-settings -lut 21600 "$MACOS_SIGNING_KEYCHAIN"
  security unlock-keychain -p "$MACOS_SIGNING_KEYCHAIN_PASSWORD" "$MACOS_SIGNING_KEYCHAIN"
  security import "$MACOS_SIGNING_CERTIFICATE" \
    -P "$APPLE_CERTIFICATE_PASSWORD" \
    -A -t cert -f pkcs12 \
    -k "$MACOS_SIGNING_KEYCHAIN" >/dev/null
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "$MACOS_SIGNING_KEYCHAIN_PASSWORD" \
    "$MACOS_SIGNING_KEYCHAIN" >/dev/null
  security list-keychains -d user -s \
    "$MACOS_SIGNING_KEYCHAIN" \
    "$HOME/Library/Keychains/login.keychain-db"
}

cleanup_macos_signing() {
  if [[ -n "${MACOS_SIGNING_KEYCHAIN:-}" ]] && security list-keychains -d user | grep -Fq "$MACOS_SIGNING_KEYCHAIN"; then
    security delete-keychain "$MACOS_SIGNING_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if [[ -n "${MACOS_SIGNING_WORK_DIR:-}" ]]; then
    rm -rf "$MACOS_SIGNING_WORK_DIR"
  fi
}
