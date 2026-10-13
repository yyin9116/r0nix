"""检查（默认只读）并清理真实应用 WebKit 存储里残留的**探针夹具标签**。

## 为什么需要它

`probe-tauri-memory.mjs` 早期版本**没有隔离用户目录**，`R0NIX_AUTO_OPEN` 打开夹具走的是
真实的 `openPdfByPath` → `upsertDocumentFromOpen`，会把标签与文档写进 app 自己的持久化
存储。此后每次启动，app 的**标签恢复**逻辑还会把它们自动打开 —— 既污染下一轮读数，
也在用户的应用里留下几条指向已删除 `/tmp` 文件的空标签。

探针现在用 `CFFIXED_USER_HOME` 隔离了，不会再产生新的；本脚本用于**检查与修复遗留**。

## 四个必须知道的坑（都实测踩过）

1. **存储目录按「进程名」而不是 bundle identifier。** 本项目 `identifier` 是
   `com.r0nix.desktop`，但 `cargo run` 起的 app 把数据写进 `~/Library/WebKit/**r0nix**/`。
   只查 `com.r0nix.desktop` 会得到「没有污染」的**错误结论**。
2. **值不是 UTF-8，是 UTF-16LE。** 用 ascii 字节搜路径必然 0 命中；解码后形如
   `{  "  v  e  r  s  i  o  n  "`。
3. **`r0nix:resource-index:doc-<id>:size-115662892` 这类键名与值里都不含路径**，
   只能按「已判为夹具的 doc id」反查。
4. **每个资产键的 `data` 形状不同**：`tabs` 是 `{tabs:[…], activeTabId}`、`documents`
   是数组、`annotations` 是 `{docId:[…]}`。用「通用 JSON 过滤」会静默漏掉不匹配的那几种
   —— 那与被判"干净"无法区分。所以这里**按键显式处理，结构不符就大声报警**。

## 用法

    python3 scripts/lib/audit-webkit-localstorage.py                 # 只读报告
    python3 scripts/lib/audit-webkit-localstorage.py --apply         # 备份后清理
    ... --fixture-prefix /tmp/别的夹具目录 --store r0nix

`--apply` 会先把 LocalStorage 三件套备份到 `<LocalStorage>/LocalStorage-backup-<时间戳>/`。
**必须在应用完全退出后执行**：app 退出时会用内存里的状态回写存储，边跑边改等于白改。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

FIXTURE_TITLES = ("scanned-200p", "scanned-200")
WARNED: list[str] = []


def decode(raw) -> str:
    return raw.decode("utf-16-le") if isinstance(raw, (bytes, bytearray)) else str(raw)  # 坑 2


def encode(text: str) -> bytes:
    """写回必须保持同一编码，否则 app 读到的是一串乱码。"""
    return text.encode("utf-16-le")


def warn(key: str, message: str) -> None:
    WARNED.append(key)
    print(f"  ⚠️ {key}: {message}")


def looks_like_fixture(blob: str, prefix: str, titles: tuple[str, ...]) -> bool:
    return prefix in blob or any(t in blob for t in titles)


def find_stores(store: str | None) -> list[str]:
    root = os.path.expanduser("~/Library/WebKit")
    if not os.path.isdir(root):
        return []
    names = [store] if store else sorted(
        name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))
    )
    found = []
    for name in names:
        for dirpath, _dirs, files in os.walk(os.path.join(root, name)):
            # 只认 WebKit 自己的 `LocalStorage` 目录。不能用「含 localstorage.sqlite3」当判据
            # —— 备份目录（`LocalStorage-backup-<时间戳>/`）就在它下面，会被当成污染源，
            # 于是清理完再查仍然报 9 处，看起来像「清理无效」。
            if os.path.basename(dirpath) != "LocalStorage":
                continue
            if "localstorage.sqlite3" in files:
                found.append(dirpath)
    return found


def plan(rows, prefix: str, titles: tuple[str, ...]):
    """→ (整键删除, 待改写 {key: 新对象}, 说明), 并按需收集被删的 doc/tab id。"""
    kill: list[tuple[str, str]] = []
    updates: dict[str, object] = {}
    notes: list[str] = []
    removed_doc_ids: set[str] = set()
    removed_tab_ids: set[str] = set()

    by_key = dict(rows)

    # ① tabs：data = {tabs: [...], activeTabId}
    key = "r0nix_reader_tabs_v1"
    if key in by_key:
        obj = json.loads(decode(by_key[key]))
        data = obj.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("tabs"), list):
            warn(key, "预期 data.tabs 是数组，结构不符 —— **未处理**（别当成干净）")
        else:
            bad = [t for t in data["tabs"]
                   if looks_like_fixture(json.dumps(t, ensure_ascii=False), prefix, titles)]
            if bad:
                total = len(data["tabs"])          # 必须在赋值前取：data 与 obj["data"] 是同一对象
                removed_tab_ids = {str(t.get("id")) for t in bad}
                keep = [t for t in data["tabs"] if t not in bad]
                obj["data"]["tabs"] = keep
                # 把「当前标签」指向被删的那条会让应用启动即指向空标签，必须一并改掉。
                if data.get("activeTabId") in removed_tab_ids:
                    previous = data.get("activeTabId")
                    obj["data"]["activeTabId"] = keep[0]["id"] if keep else "library-main"
                    notes.append(f"activeTabId 原指向 {previous}（已删），改指"
                                 f" {obj['data']['activeTabId']}")
                updates[key] = obj
                notes.append(f"{key}: {total} → {len(keep)}（删 {len(bad)}）")

    # ② documents：data = [...]
    key = "r0nix_reader_documents_v2"
    if key in by_key:
        obj = json.loads(decode(by_key[key]))
        data = obj.get("data")
        if not isinstance(data, list):
            warn(key, "预期 data 是数组，结构不符 —— **未处理**")
        else:
            bad = [d for d in data
                   if looks_like_fixture(json.dumps(d, ensure_ascii=False), prefix, titles)]
            if bad:
                removed_doc_ids = {str(d.get("id")) for d in bad}
                obj["data"] = [d for d in data if d not in bad]
                updates[key] = obj
                notes.append(f"{key}: {len(data)} → {len(obj['data'])}（删 {len(bad)}）")

    # ③ annotations / notes：data = {docId: [...]}
    for key in ("r0nix_reader_annotations_v1", "r0nix_reader_notes_v1"):
        if key not in by_key:
            continue
        obj = json.loads(decode(by_key[key]))
        data = obj.get("data")
        if not isinstance(data, dict):
            warn(key, "预期 data 是对象，结构不符 —— **未处理**")
            continue
        bad_keys = [k for k, v in data.items()
                    if k in removed_doc_ids
                    or looks_like_fixture(json.dumps({k: v}, ensure_ascii=False), prefix, titles)]
        if bad_keys:
            total = len(data)
            for k in bad_keys:
                data.pop(k, None)
            updates[key] = obj
            notes.append(f"{key}: {total} → {len(data)}（删 {len(bad_keys)}）")

    # ④ whiteboard：data = {version, zoom, cards, groups} —— 不是按 doc 索引，
    #    只报告不自动改（误删会丢用户的整块白板）。
    key = "r0nix_reader_whiteboard_v1"
    if key in by_key and looks_like_fixture(decode(by_key[key]), prefix, titles):
        warn(key, "引用了夹具路径，但结构不是按 doc 索引 —— 需人工确认，**未自动改**")

    # ⑤ resource-index：键名/值里都没有路径（坑 3），按被删的 doc/tab id 反查。
    handled = set(updates)
    for key, raw in rows:
        if key in handled:
            continue
        if any(i in key for i in removed_doc_ids | removed_tab_ids):
            kill.append((key, "指向已判为夹具的 doc/tab id"))
        elif prefix in decode(raw):
            kill.append((key, "值里带夹具路径"))

    return kill, updates, notes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-prefix", default="/tmp/r0nix-tauri-mem",
                        help="探针夹具的路径前缀（默认 /tmp/r0nix-tauri-mem）")
    parser.add_argument("--store", default=None,
                        help="只检查某个 WebKit 存储目录名（如 r0nix）；默认全部")
    parser.add_argument("--apply", action="store_true", help="备份后真正写入；不加则只报告")
    args = parser.parse_args()

    stores = find_stores(args.store)
    if not stores:
        print("没找到任何 LocalStorage 库")
        return 1

    pending = 0
    for directory in stores:
        tmp = tempfile.mkdtemp(prefix="ls-audit-")
        for name in ("localstorage.sqlite3", "localstorage.sqlite3-wal", "localstorage.sqlite3-shm"):
            src = os.path.join(directory, name)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(tmp, name))
        con = sqlite3.connect(os.path.join(tmp, "localstorage.sqlite3"))
        rows = con.execute("select key, value from ItemTable").fetchall()
        con.close()

        kill, updates, notes = plan(rows, args.fixture_prefix, FIXTURE_TITLES)
        if not (kill or updates or WARNED):
            continue

        short = directory.replace(os.path.expanduser("~/Library/WebKit/"), "")
        print(f"\n═══ {short}")
        for note in notes:
            print(f"  过滤条目  {note}")
        for key, why in kill:
            print(f"  删除整键  {key}（{why}）")
        pending += len(kill) + len(updates)

        if not args.apply:
            continue

        backup = os.path.join(directory, f"LocalStorage-backup-{int(time.time())}")
        os.makedirs(backup, exist_ok=True)
        for name in ("localstorage.sqlite3", "localstorage.sqlite3-wal", "localstorage.sqlite3-shm"):
            src = os.path.join(directory, name)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(backup, name))
        print(f"  已备份 → {backup}")

        con = sqlite3.connect(os.path.join(directory, "localstorage.sqlite3"))
        try:
            for key, _why in kill:
                con.execute("delete from ItemTable where key = ?", (key,))
            for key, obj in updates.items():
                con.execute("update ItemTable set value = ? where key = ?",
                            (encode(json.dumps(obj, ensure_ascii=False)), key))
            con.commit()
            print("  已写入。")
        finally:
            con.close()
        shutil.rmtree(tmp, ignore_errors=True)

    if pending == 0 and not WARNED:
        print(f"干净：没有键包含 {args.fixture_prefix}")
    elif not args.apply:
        print(f"\n共 {pending} 处待处理。加 --apply 执行（会先备份）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
