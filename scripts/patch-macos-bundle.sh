#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: patch-macos-bundle.sh path/to/r0nix.app}"
binary="$app_path/Contents/MacOS/r0nix"
runtime="$app_path/Contents/Resources/runtime"
identity="${APPLE_SIGNING_IDENTITY:--}"

test -x "$binary"
test -d "$runtime"

add_rpath() {
  local path="$1"
  if ! otool -l "$binary" | grep -Fq "path $path "; then
    install_name_tool -add_rpath "$path" "$binary"
  fi
}

add_rpath '@executable_path/../Resources/runtime'
add_rpath '@executable_path/../Resources/runtime/site-packages/pymupdf'

if otool -L "$binary" | grep -Fq '@rpath/libiconv.2.dylib'; then
  install_name_tool -change '@rpath/libiconv.2.dylib' '/usr/lib/libiconv.2.dylib' "$binary"
fi

while IFS= read -r -d '' library; do
  codesign --force --sign "$identity" --timestamp=none "$library"
done < <(find "$runtime" -type f \( -name '*.dylib' -o -name '*.so' \) -print0)

codesign --force --sign "$identity" --deep --timestamp=none "$app_path"
echo "macos-bundle: patched and signed $app_path"
