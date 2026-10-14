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

# pyo3 链接 libpython 时写入的是**构建机上那个解释器**的 install name，通常是绝对路径。
# 不重写的话，包只在这台机器上能跑：用户机上没有那条路径，应用启动即崩。
#
# install name 有两种已知形态，识别式必须同时认：
#   - uv / Homebrew 装的：`/…/libpython3.12.dylib`（文件名带 libpython）
#   - python.org 的 framework 构建（CI runner 上用的就是它）：
#     `/Library/Frameworks/Python.framework/Versions/3.12/Python`（文件名就叫 `Python`）
#
# 只匹配 `libpython` 会漏掉第二种 —— 本地（uv）形态能匹配上，所以这个 bug
# 在本地跑不出来，只在 CI 上炸。这是它值一条注释的原因。
#
# 上面已加过 `@executable_path/../Resources/runtime` 这条 rpath，重写后正好命中
# 内嵌的那份 libpython3.12.dylib，应用才真正自包含。
# 必须放在下面的 codesign 之前 —— install_name_tool 会让已有签名失效。
if ! otool -L "$binary" | grep -Fq '@rpath/libpython3.12.dylib'; then
  # NR > 1：跳过 otool 首行（二进制自身的名字），别把自己当成依赖。
  libpython_install_name="$(otool -L "$binary" | awk 'NR > 1 && ($1 ~ /libpython3\.12\.dylib$/ || $1 ~ /\/Python\.framework\/.*\/Python$/) { print $1; exit }')"
  if [[ -n "$libpython_install_name" ]]; then
    install_name_tool -change "$libpython_install_name" '@rpath/libpython3.12.dylib' "$binary"
    echo "macos-bundle: rewrote libpython dependency ${libpython_install_name} -> @rpath/libpython3.12.dylib"
  else
    echo "macos-bundle: 警告 —— 二进制里找不到 libpython3.12.dylib 依赖" >&2
  fi
fi

while IFS= read -r -d '' library; do
  codesign --force --sign "$identity" --timestamp=none "$library"
done < <(find "$runtime" -type f \( -name '*.dylib' -o -name '*.so' \) -print0)

codesign --force --sign "$identity" --deep --timestamp=none "$app_path"
echo "macos-bundle: patched and signed $app_path"
