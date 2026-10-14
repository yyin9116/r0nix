#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: macos-bundle-smoke.sh path/to/r0nix.app [path/to/dmg] }"
dmg_path="${2:-}"

# 每一条检查都必须自己报出「哪一条挂了」和「实测值是什么」。
# 之前这里是一串裸的 test/otool/codesign：`set -e` 下任何一条失败都只留下
# 一个孤零零的 exit 1，CI 日志里连是内容不对还是签名不对都分不出来。
fail() {
  echo "macos-bundle-smoke: FAILED -- $1" >&2
  exit 1
}

verify_app() {
  # 参数顺序是 (app 路径, 标签)。路径在前是刻意的：
  # `check-release-readiness.mjs` 按字面量断言 `verify_app "$mount_point/r0nix.app"`
  # 必须存在，用来保证「DMG 里那个 app 真的被检查过」这条约束不被绕过。
  local candidate="$1"
  local label="${2:-app}"
  local binary="$candidate/Contents/MacOS/r0nix"
  local runtime="$candidate/Contents/Resources/runtime"

  [[ -x "$binary" ]] || fail "$label: 可执行文件不存在或不可执行：$binary"
  [[ -d "$runtime" ]] || fail "$label: 内嵌运行时目录不存在：$runtime"
  [[ -f "$runtime/libpython3.12.dylib" ]] || fail "$label: 内嵌运行时缺 libpython3.12.dylib：$runtime"

  # 装好的 app 绝不能依赖开发机上的 Python framework，内嵌运行时是唯一受支持的边界。
  local links
  links="$(otool -L "$binary" 2>&1)" || fail "$label: otool -L 失败：$links"
  if ! printf '%s\n' "$links" | grep -Fq '@rpath/libpython3.12.dylib'; then
    fail "$label: 二进制没有走 @rpath 找 libpython3.12.dylib。实际依赖：$(printf '%s' "$links" | tr '\n' '|')"
  fi
  if printf '%s\n' "$links" | grep -Fq '/Library/Frameworks/Python.framework'; then
    fail "$label: 二进制依赖了开发机的 Python.framework。实际依赖：$(printf '%s' "$links" | tr '\n' '|')"
  fi

  # 光看链接不够 —— 链接对了，Python 仍可能没找到**包内**那份运行时，转而回落到
  # 编译期写死的框架前缀。让包自己跑一遍自检来证伪：它断言 sys.base_prefix 就是包内
  # 的 runtime，并要求 encodings 与 fitz 都能导入（见 src-tauri/src/py_render.rs）。
  #
  # 放在这里而不是「进程存活」那个脚本里，是因为后者结构性地抓不到这个问题：应用
  # 启动阶段根本不碰 Python，而 CI runner 上恰好装着同版本的 python.org 解释器，
  # 于是「找不到内嵌 runtime」在 CI 上完全静默，只在用户机上第一次开 PDF 时崩。
  local runtime_check
  if ! runtime_check="$("$binary" --check-python-runtime 2>&1)"; then
    fail "$label: 内嵌 Python 自检失败，包不是自包含的：$(printf '%s' "$runtime_check" | tr '\n' '|')"
  fi
  printf '%s\n' "$runtime_check" | grep -q 'python-runtime-check: ok' \
    || fail "$label: 自检未打出 ok：$(printf '%s' "$runtime_check" | tr '\n' '|')"

  local detritus
  detritus="$(find "$runtime" \( -name '__pycache__' -o -name '*.pyc' \) -print -quit 2>/dev/null)" || detritus=""
  [[ -z "$detritus" ]] || fail "$label: 内嵌运行时残留 Python 字节码：$detritus"

  local signature
  if ! signature="$(codesign --verify --deep --strict "$candidate" 2>&1)"; then
    fail "$label: codesign --verify --deep --strict 失败：$signature"
  fi
}

verify_app "$app_path" "app"

if [[ -n "$dmg_path" ]]; then
  [[ -f "$dmg_path" ]] || fail "dmg: 文件不存在：$dmg_path"
  hdiutil verify "$dmg_path" >/dev/null || fail "dmg: hdiutil verify 失败：$dmg_path"
  mount_point="$(mktemp -d "/tmp/r0nix-dmg-mount.XXXXXX")"
  mounted=false
  cleanup() {
    if [[ "$mounted" == true ]]; then
      hdiutil detach "$mount_point" -quiet || hdiutil detach "$mount_point" -force -quiet
    fi
    rmdir "$mount_point" 2>/dev/null || true
  }
  trap cleanup EXIT
  hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$mount_point" >/dev/null \
    || fail "dmg: hdiutil attach 失败：$dmg_path"
  mounted=true
  verify_app "$mount_point/r0nix.app" "dmg-mounted-app"
fi

echo "macos-bundle-smoke: ok"
