"""进程表读取 —— 供 `scripts/probe-tauri-memory.mjs` 使用。

## 为什么不用 `ps`
本机运行环境的沙箱按**程序白名单**拦截可执行文件：`/bin/ps` 一律返回
`Operation not permitted`（即使给命令加了免沙箱也一样），`pgrep` / `footprint` 可用。
而 `ps` 是 `probe-tauri-memory.mjs` 原本唯一的进程来源，它的 `catch { return [] }`
会把失败吞成**空进程表** —— 于是每个采样点都打印 `0 MB`，看上去像「这个 app 不占内存」。
这正是本项目反复出现的静默失败，所以这里改成：读不到就**抛错**，绝不返回空表。

## 为什么用 libproc 而不是拼 `pgrep` + `footprint`
`pgrep` 给不出 rss，也给不出 ppid；`footprint` 要为每个 pid 起一个子进程。
`proc_listpids` + `proc_pid_rusage` 一次调用就能拿到全部进程的
`ri_resident_size`（rss）与 `ri_phys_footprint`（fp，即活动监视器的「内存」列），
不需要任何外部二进制。

## 结构体偏移必须校验
`rusage_info_v2` 的字段偏移是硬编码的（rss@64 / fp@72）。**偏移写错不会报错**，
只会让所有数字变成垃圾。`probe-tauri-memory.mjs` 因此在 T1 拿同一个 pid 与
`/usr/bin/footprint` 对一次，偏差 > 5% 就告警。

输出：每行 `pid\trss_kb\tfp_kb\tpath`，按 fp 降序。取不到的 pid（无权限 / 刚退出）跳过。
"""
import ctypes
import sys

RUSAGE_INFO_V2 = 2
OFF_RSS = 64
OFF_FP = 72

PROC_ALL_PIDS = 1
PATH_MAX = 4096

libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)


def list_pids():
    """枚举全部可见 pid。先问所需字节数，再按该容量取一次。"""
    needed = libproc.proc_listpids(PROC_ALL_PIDS, 0, None, 0)
    if needed <= 0:
        return []
    # 留出余量：两次调用之间可能有进程创建，按需重新分配一次更稳妥。
    count = needed // ctypes.sizeof(ctypes.c_int) + 64
    buffer = (ctypes.c_int * count)()
    written = libproc.proc_listpids(PROC_ALL_PIDS, 0, ctypes.byref(buffer), ctypes.sizeof(buffer))
    if written <= 0:
        return []
    return [pid for pid in buffer[: written // ctypes.sizeof(ctypes.c_int)] if pid > 0]


def read_pid(pid: int):
    """返回 (rss_kb, fp_kb)；取不到返回 None。"""
    buffer = ctypes.create_string_buffer(256)
    if libproc.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(buffer)) != 0:
        return None
    rss = ctypes.c_uint64.from_buffer(buffer, OFF_RSS).value // 1024
    fp = ctypes.c_uint64.from_buffer(buffer, OFF_FP).value // 1024
    return rss, fp


def read_path(pid: int) -> str:
    buffer = ctypes.create_string_buffer(PATH_MAX)
    if libproc.proc_pidpath(pid, ctypes.byref(buffer), PATH_MAX) <= 0:
        return "?"
    return buffer.value.decode(errors="replace")


def main() -> int:
    pids = list_pids()
    if not pids:
        print("proc_listpids 没有返回任何 pid", file=sys.stderr)
        return 1

    rows = []
    for pid in pids:
        got = read_pid(pid)
        if got is None:
            continue
        rss, fp = got
        rows.append((pid, rss, fp, read_path(pid)))

    if not rows:
        # 一个都读不到 = 枚举整体失效，绝不能当成「内存为 0」。
        print("proc_pid_rusage 对所有 pid 都失败", file=sys.stderr)
        return 1

    rows.sort(key=lambda row: -row[2])
    for pid, rss, fp, path in rows:
        print(f"{pid}\t{rss}\t{fp}\t{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
