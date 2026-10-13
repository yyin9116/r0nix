/**
 * 真实 Tauri 应用的内存足迹探针。
 *
 * ── 为什么必须有它（浏览器探针替代不了）──────────────────────
 * `probe-pdf-memory-footprint.mjs` 走的是浏览器路径：Playwright 用 `setFiles()` 喂文件，
 * 前端落到 `file.arrayBuffer()` —— **完全绕过 Tauri IPC**。而「打开一份 110 MiB 扫描件」
 * 在真实应用里多出一整段：Rust 读文件 → base64 编码 → IPC 传输 → JS `atob` → Uint8Array
 * → transfer 进 pdf.js worker。
 *
 * ── ⚠️ 构建必须带 `--no-default-features`（脚本已内置）────────────────
 * 这是本探针最容易踩、也最难自查的坑，务必读完再改：
 *
 * `src-tauri/Cargo.toml` 里有 `default = ["custom-protocol"]`，而 tauri 的构建脚本是
 *   `let dev = !has_feature("custom-protocol")`   →   `cargo:dev={dev}`
 * dev 为 false 时 **Tauri 忽略 `devUrl`，直接服务编译期嵌进二进制的 `dist/` 资源**。
 *
 * 后果不是「报错」，而是**一切看起来都正常**：窗口开了、页面渲染了、`frontend_log`
 * 也照常打到终端 —— 只是跑的是**上一次 `npm run build` 的产物**。于是：
 *   · 前端任何 `import.meta.env.DEV` 守卫的代码在生产构建里 **被 tree-shake**，
 *     永远不存在（自动打开钩子因此静默失效，症状是「什么都没发生」）；
 *   · 源码里新加的日志点当然也不会出现 —— 排查时极易误判成「effect 没跑」。
 * 实测代价：整整一轮 180s 空等，以及数轮基于「二进制能跑」的错误推断。
 *
 * ── 怎么自动打开文件 ─────────────────────────────────────────
 * macOS 上驱动真实应用的 UI 需要辅助功能权限（本机未授权，AppleScript 点不动
 * 「打开文件」对话框）。所以走 dev-only 钩子：环境变量 `R0NIX_AUTO_OPEN` →
 * Rust `dev_auto_open_path` → 前端启动时自取并打开。release 构建里该命令恒返回
 * null，行为与不存在一致。
 *
 * ── 怎么知道「打开完成」──────────────────────────────────────
 * 前端 `debugLog('api.openFile', 'pdfjs loaded')` → `frontend_log` → Rust `eprintln!`
 * → 本脚本读 app 的 stderr。比 sleep 固定时长可靠（大文件打开耗时不确定）。
 *
 * ── 进程归属怎么判 ───────────────────────────────────────────
 * 系统 WKWebView 的 WebContent / Networking / GPU 是 **XPC 进程，ppid=1**（由 launchd
 * 拉起），**不在 node 的进程树里** —— 只沿 child 链走会读到「WebKit 恒 0 MB」这种
 * 看起来像结论的假读数。做法：app 启动前先快照全系统 pid 集合，之后「不在快照里 +
 * 命令行含 WebKit」的即为本次 app 引入的；这样也不会把用户自己的 Safari 算进来。
 *
 * ── 怎么量「驻留」而不只是「瞬时峰值」──────────────────────────
 * 单份文档只能看到「加载冲高 → 回落」。要看**驻留**必须同时打开多份：
 * pdf.js 的 `documentCache` 按 fileId 持有文档、worker 持有那份 `Uint8Array`，
 * 只要标签还开着，**每个已打开文档就固定占住一份**（实测 ~1–2 倍文件大小）。
 * `PROBE_TAURI_DOCS=2` 会生成两份**不同路径**的夹具（同路径会被应用去重）并顺序打开。
 *
 * ── 轮与轮之间怎么隔离（本轮补的修复）────────────────────────
 * app 有**标签恢复**：上次会话的标签会在下次启动时被自动打开（`App.tsx` 的
 * `restoredRaw` + 一个「有 filePath 却无 fileId 就打开」的 effect）。而 WKWebView
 * 的 localStorage 落在 `$HOME/Library/WebKit/<进程名>/` —— 于是上一轮探针留下的
 * 夹具标签会被下一轮恢复：所谓「冷启动对照」根本不空（实测被恢复出一份 110 MiB
 * 夹具，WebContent 直接 927 MB）。更糟的是，这些标签**真实写进了用户自己的存储**，
 * 用户下次打开应用会看到若干条指向已删除 `/tmp` 文件的空标签。
 * 做法：用 `CFFIXED_USER_HOME` 把 app 的用户目录指到 `/tmp/r0nix-probe-home-*`。
 * 它只改 CoreFoundation 解析出的用户主目录（WebKit / AppKit 都走它），**cargo 不受影响**
 * —— 实测隔离目录下会生成 `<隔离>/Library/WebKit/r0nix`。轮与轮彻底隔离，用户状态一个
 * 字节都不碰。若改用 `HOME`，cargo 会去一个空 registry 找依赖，连构建都过不去；而绕开
 * cargo 直接起 `target/debug/r0nix` 也不行 —— 该二进制的 rpath 只有
 * `@executable_path/../Resources/runtime`（打包布局），在 `target/debug/` 下 dyld 找不到
 * `libpython3.12.dylib`，进程立刻退出（且不留任何前端日志，看起来就像「app 没启动」）。
 *
 * ── 怎么量「关闭后还不还」`R0NIX_AUTO_CLOSE_MS` + `R0NIX_AUTO_CLOSE_ACTIONS` ──
 * 只量「打开后驻留多少」看不出是**按设计驻留**还是**泄漏**；分水岭是**关掉之后还回去
 * 多少**。macOS 上点不动真实的关闭按钮（无辅助功能权限），所以同样用环境变量驱动。
 *
 * `R0NIX_AUTO_CLOSE_MS=N` 指定「打开后 N 毫秒执行关闭」；**`0` 有明确含义**：立即执行，
 * 完全不用长定时器 —— WKWebView 对不可见窗口会节流 `setTimeout`，长定时器实测不触发。
 *
 * `R0NIX_AUTO_CLOSE_ACTIONS` 指定**执行哪些**关闭动作（逗号分隔，按序执行）；不设时
 * 默认 `file`，与历史行为一致：
 *   · `file`    —— 只 `api.closeFile(fileId)`：销毁 pdf.js 文档与 Rust 句柄，
 *                  **标签仍留在界面上，viewer 与它的画布都没卸载**；
 *   · `tab`     —— `handleCloseTab(tabId)`：移除标签 → 卸载 viewer → 排队释放文件句柄。
 *                  这才是**用户按了关闭按钮**的那条路径；
 *   · `workers` —— 强制 `terminate()` 全部仍在世的 Web Worker。
 *
 * ⚠️ 「只 `file`」与「关标签」是**两件不同的事**，混为一谈会把「没卸载」读成
 * 「卸载了也不释放」。上一轮 G 组用的就是 `file`，读数（411 MB，空载 133 MB）
 * 因而无法指向真正的持有者 —— 那一组只能说明「销毁文档后还剩 278 MB」。
 *
 * 三个动作单跑一次即可分离持有者：`file,workers` 若与 `file` 一致 → worker 已被
 * `doc.destroy()` 带走、不是它；`tab` 若显著下降 → 残留是没卸载的 viewer 与画布。
 *
 * 配套的应用内证据（`api.autoOpen` / `census` 行，见 `devRuntimeCensus.ts`）：
 * worker 台账（`pending` > 0 = worker 线程还活着）与画布背景存储总量 —— 二者都落在
 * WebContent 的 footprint 里，进程读数完全无法区分，只有应用内知道答案。
 *
 * 用法：node scripts/probe-tauri-memory.mjs [页数]
 *   PROBE_TAURI_DOCS=2            顺序打开的文档数（默认 1）；**0 = 冷启动对照（不开文档）**
 *   PROBE_TAURI_SETTLE=10,30,60   静置采样点（**累加**偏移，秒），默认 10,30,60
 *   PROBE_TAURI_PYTHON=...        读进程表的解释器（默认 python3），需 ≥3.8 且有 ctypes
 *   R0NIX_AUTO_CLOSE_MS=0         打开后立即执行关闭（0 不走长定时器）
 *   R0NIX_AUTO_CLOSE_ACTIONS=tab  关闭动作清单：file | tab | workers（默认 file）
 *   R0NIX_AUTO_CYCLE=1            **循环模式**：每份打开后立即关掉，于是「文档数」= 「轮数」
 *
 * ── 怎么区分「泄漏」与「水位」`R0NIX_AUTO_CYCLE` ─────────────────
 * 单轮只能得到「关掉后还剩多少」，而剩下的可能是两种完全不同的东西：
 *  · **水位**：JSC / WebKit 的分配器首次冲高后不再把页还给系统（不是 bug，但
 *    活动监视器上就是「不下降」）；
 *  · **泄漏**：每轮线性累加。
 * 判据只有一条 —— **在同一个进程里**比较第 1 轮与第 N 轮的稳态：水位会收敛，
 * 泄漏会随轮数线性增长。跨会话比较做不到这件事：空载基线本身受系统内存压力影响，
 * 能差出几百 MB（本文件「判读要点」里那条警告就是这么来的）。
 * 用法：`PROBE_TAURI_DOCS=4 R0NIX_AUTO_CYCLE=1 R0NIX_AUTO_CLOSE_ACTIONS=tab`。
 *
 * ── 进程表从哪来 ─────────────────────────────────────────────
 * `scripts/lib/proc-table.py`（libproc 直读），**不是 `ps`**：本机沙箱按程序白名单
 * 拦可执行文件，`/bin/ps` 一律 `Operation not permitted`。详见 `readProcesses` 的注释。
 * 读不到进程表会**抛错退出**，而不是打印一排 0。
 *
 * ── 采样口径（踩过的坑）────────────────────────────────────
 * · 峰值发生在「读文件 → base64 → IPC 传输 → pdf.js 解码」那几秒里，只在 T1
 *   单点采一次必然整段错过 —— 探针因此在加载期每 2s 采一次并单独记峰值。
 * · app 进程**不能**按「名字 + 最大 pid」找：用户自己开着的 r0nix 实例 pid 往往
 *   更大，会安静地取到那个空载实例（实测 app 列全是 20–30 MB 的假读数）。
 *   判据是「启动前快照里没有的 pid」。
 * · 实测杀 app 后 6s 内它的 WebContent 全部退出（无残留），所以 pid 差值归属成立；
 *   但**同一时刻只能跑一个探针实例**，否则两次启动的 pid 混在一起。
 *
 * ── 构建前提 ─────────────────────────────────────────────
 * PyO3 0.21 拒绝 Python ≥ 3.13，而本机 PATH 上的 `python3` 是 3.13 —— 一旦 cargo
 * 需要重编 `pyo3-ffi`（例如先跑过 `cargo test` / `cargo check`），`cargo run` 会
 * 直接构建失败，报「configured Python interpreter version (3.13) is newer than
 * PyO3's maximum supported version (3.12)」。必须显式指定 3.12：
 *   PYO3_PYTHON=/opt/anaconda3/bin/python3.12 node scripts/probe-tauri-memory.mjs 200
 */
import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createScannedPdfFixture } from "./lib/pdf-fixture.mjs";

const PAGE_COUNT = Number(process.argv[2] || 200);
// 允许 0 = **冷启动对照**：不打开任何文档，只量 app 与 WebKit 的空载基线。
// 没有这个基线，「关标签释放了多少」只能跨实例比（用户自己那个实例的历史状态
// 不可控），A/B 就没有零点。
const DOC_COUNT = Math.max(0, Number(process.env.PROBE_TAURI_DOCS ?? 1));
// 用 localhost 而不是 127.0.0.1：vite 6 默认 host 在本机只绑 IPv6 的 `::1`，
// 写死 IPv4 会连不上（除非依赖 localhost 的回落，不可靠）。
const baseUrl = process.env.E2E_BASE_URL || "http://localhost:1420";
const PROJECT_DIR = process.cwd();
const TAURI_DIR = join(PROJECT_DIR, "src-tauri");
// 进程表来自 libproc（见 scripts/lib/proc-table.py 的文件头）。
// 之所以不用 `ps`：本机沙箱按**程序白名单**拦可执行文件，`/bin/ps` 一律
// `Operation not permitted`，而原先的 `readProcesses` 会把失败吞成空表。
const PYTHON = process.env.PROBE_TAURI_PYTHON || process.env.PYTHON || "python3";
const PROC_TABLE_PY = join(PROJECT_DIR, "scripts", "lib", "proc-table.py");
const SETTLE_SECONDS = (process.env.PROBE_TAURI_SETTLE || "10,30,60")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

async function isServerUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerUp(url)) return;
    await delay(400);
  }
  throw new Error(`dev server never came up at ${url}`);
}

/**
 * 读全系统进程表（pid / rss / fp / 可执行路径）。
 *
 * ⚠️ 两个必须记住的点：
 *
 * 1. **不能用 `ps`**。本机沙箱按**程序白名单**拦可执行文件 —— `/bin/ps` 一律
 *    `Operation not permitted`（给命令加免沙箱也一样），`pgrep` / `footprint` 可用。
 *    原实现用 `ps`，而它的 `catch { return [] }` 会把失败吞成**空进程表**，
 *    于是每个采样点都打印 `0 MB` —— 看上去像「这个 app 不占内存」。
 *    这类静默失败在本项目里反复出现（`exitCode === null`、`catch {}`、恒 null 的
 *    定时器），所以这里改成 **读不到就抛错**：宁可整个探针失败，也不要给出一排 0。
 *
 * 2. **必须用完整路径而不是 `comm`**。macOS 的 `comm` 会被截断到约 80 字符，而
 *    WebKit 的 XPC 可执行路径远长于此 —— 截断后可能连 `WebKit` 都保不住，
 *    于是「按路径找进程」会安静地漏掉；漏掉就等于结论下错。
 *    `proc_pidpath` 返回的路径不做这种截断。
 *
 * rss 在这一版是**从 libproc 直读**的（`ri_resident_size`），与 fp 同一次调用拿到，
 * 不再依赖 `ps` 的 rss 列。
 */
function readProcesses() {
  let raw;
  try {
    raw = execSync(`"${PYTHON}" "${PROC_TABLE_PY}"`, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `无法读取进程表（${PROC_TABLE_PY}）：${error.message}\n` +
        `  此时任何内存读数都会是 0 —— 不要把它当成结论。` +
        `（可用 PROBE_TAURI_PYTHON 指定解释器）`,
    );
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const rssKb = Number(parts[1]);
    const fpKb = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(rssKb) || !Number.isFinite(fpKb)) continue;
    rows.push({ pid, rssKb, fpMb: Math.round(fpKb / 1024), command: parts[3].trim() });
  }
  if (rows.length === 0) {
    throw new Error(`${PROC_TABLE_PY} 没有输出任何进程行 —— 视为枚举失败（不接受空表）`);
  }
  return rows;
}

const isR0nix = (command) => /(?:^|\/)r0nix$|\/r0nix(?:$|\s)/.test(command);
const isWebKit = (command) => /WebKit|webkit/i.test(command);

// 这里曾有一个 `collectAppPids`：沿 ppid 收集 app 的全部后代。已删除 ——
// libproc 的进程表不带 ppid，而且 WebKit 的 XPC 进程本来是 ppid=1（launchd 拉起），
// 后代链对它们从来无效。app 归属改用「基线里没有的 `r0nix` 进程」，
// 与 WebKit 用同一套判据，反而更一致。

/**
 * 读进程的 phys_footprint（`footprint <pid>`）。
 *
 * ⚠️ 这是本探针最关键的口径修正 —— 只看 RSS 会得出**相反的结论**：
 * RSS 只统计**常驻**页，不含被压缩或已提交但未驻留的页。实测同一个 WebContent 进程
 * 在「打开两份 110 MiB 扫描件、静置 3 分钟」后：
 *
 *     ps rss  = 424 MB      ← 看起来回落了
 *     footprint = 1159 MB   ← 稳在那儿不降（活动监视器的「内存」列就是这个）
 *
 * 也就是说 macOS 把那一千多 MB **压缩**掉了而不是释放，RSS 因此失真。
 * 用户报的「2GB 用了一段时间仍不下降」只有在这个口径下才复现得出来。
 */
function readFootprintMb(pid) {
  try {
    const raw = execSync(`footprint ${pid}`, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = raw.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
    if (!match) return null;
    const value = Number(match[1]);
    if (match[2] === "KB") return Math.round(value / 1024);
    if (match[2] === "GB") return Math.round(value * 1024);
    return Math.round(value);
  } catch {
    // 权限不足或进程刚退出：返回 null，由调用方按「未知」处理，不要当 0 混进合计。
    return null;
  }
}

function sample(baselinePids, label) {
  const rows = readProcesses();
  const toMb = (kb) => Math.round(kb / 1024);

  // 归属判据统一为「基线里没有的 + 路径匹配」：app 找 `r0nix`，WebKit 找 `WebKit`。
  // 用户自己开着的实例以及 Safari / Playwright 都在基线里，不会被算进来。
  const appRows = rows.filter((row) => !baselinePids.has(row.pid) && isR0nix(row.command));
  const webkitRows = rows.filter((row) => !baselinePids.has(row.pid) && isWebKit(row.command));
  // 兜底清单按 fp 过滤（rss 会因为 macOS 的内存压缩而严重低估）。
  const freshRows = rows.filter((row) => !baselinePids.has(row.pid) && row.fpMb > 200);

  const describe = (row) => ({
    pid: row.pid,
    rssMb: toMb(row.rssKb),
    fpMb: row.fpMb,
    command: row.command,
  });
  const appDetails = appRows.map(describe);
  const webkitDetails = webkitRows.map(describe).sort((left, right) => (right.fpMb ?? 0) - (left.fpMb ?? 0));

  const appMb = toMb(appRows.reduce((sum, row) => sum + row.rssKb, 0));
  const webkitMb = toMb(webkitRows.reduce((sum, row) => sum + row.rssKb, 0));
  const appFpMb = appDetails.reduce((sum, row) => sum + (row.fpMb ?? 0), 0);
  const webkitFpMb = webkitDetails.reduce((sum, row) => sum + (row.fpMb ?? 0), 0);

  return {
    label,
    appMb,
    webkitMb,
    totalMb: appMb + webkitMb,
    appFpMb,
    webkitFpMb,
    totalFpMb: appFpMb + webkitFpMb,
    appRows: appDetails,
    webkitRows: webkitDetails,
    freshRows: freshRows
      .map((row) => ({ pid: row.pid, rssMb: toMb(row.rssKb), command: row.command }))
      .sort((left, right) => right.rssMb - left.rssMb),
  };
}

function printSample(result) {
  console.log(
    `  ${result.label.padEnd(22)} 主进程 rss ${String(result.appMb).padStart(4)} / fp ${String(result.appFpMb).padStart(4)} MB` +
      `   + WebKit rss ${String(result.webkitMb).padStart(4)} / fp ${String(result.webkitFpMb).padStart(4)} MB` +
      `   = rss ${String(result.totalMb).padStart(4)}  |  ★fp ${String(result.totalFpMb).padStart(4)} MB`,
  );
}

async function main() {
  // 固定路径，不用 mkdtemp：夹具内容由固定种子生成，每次跑完全一致，没必要换目录。
  // 而**路径一变就会多出一条标签页** —— 自动打开走的是真实的 `openPdfByPath`，
  // 它会 `upsertDocumentFromOpen`（同时写资料库与标签页）。随机目录意味着每跑一次
  // 就往状态里塞一条 `/tmp/r0nix-tauri-mem-XXXX/scanned-200p.pdf`。
  // 固定路径只解决了「累积」，**没解决「被恢复」** —— 见下面 isolatedHome。
  const fixtureDir = "/tmp/r0nix-tauri-mem";

  /**
   * 隔离出的一套用户目录 —— 测量干净与否的关键，也是「不写用户状态」的保证。
   *
   * WKWebView 的 localStorage 落在 `$HOME/Library/WebKit/<进程名>/`，而本 app 有一条
   * **标签恢复**逻辑（`App.tsx` 的 `restoredRaw` + 一个「有 filePath 却无 fileId 就
   * 自动打开」的 effect）：上次会话的标签会在下次启动时被自动打开。
   *
   * 后果有两层，都实测到了：
   *  · **测量污染**：所谓「冷启动对照」被恢复出一份 110 MiB 夹具，WebContent 直接
   *    927 MB —— 基线根本不是空的。（上一轮记录「峰值虚高约 250 MB」也是同一根因，
   *    当时只把随机目录改成固定路径，止住了累积，没止住恢复。）
   *  · **写用户状态**：这些标签真实写进了 `~/Library/WebKit/r0nix`（app 按**进程名**
   *    取存储目录，不是 bundle identifier），用户下次打开应用会看到若干条指向已删除
   *    `/tmp` 文件的空标签。
   *
   * 用 `CFFIXED_USER_HOME` 而不是 `HOME`：前者只改 CoreFoundation 解析出来的用户主目录
   * （WebKit / AppKit 都走它），**cargo 不受影响** —— 实测隔离目录下会生成
   * `<隔离>/Library/WebKit/r0nix`。若改成 `HOME`，cargo 会去一个空 registry 找依赖，
   * 连构建都过不去。代价是不能直接起 `target/debug/r0nix`：那个二进制的 rpath 只有
   * `@executable_path/../Resources/runtime`（打包布局），在 `target/debug/` 下 dyld
   * 找不到 `libpython3.12.dylib` 会立刻退出，所以仍走 `cargo run`。
   */
  const isolatedHome = mkdtempSync(join("/tmp", "r0nix-probe-home-"));
  const docPaths = [];
  let fixture = null;
  if (DOC_COUNT === 0) {
    console.log("冷启动对照（PROBE_TAURI_DOCS=0）：不生成夹具、不打开任何文档");
  } else {
    mkdirSync(fixtureDir, { recursive: true });
    console.log(`生成夹具（${PAGE_COUNT} 页扫描件，每页独立位图，${DOC_COUNT} 份）…`);
    // 内容由固定种子生成，多份完全一致 —— 要量的是「每多一份打开文档，驻留增加多少」，
    // 不是内容差异。但**路径必须不同**：同路径会被应用去重成同一份文档。
    fixture = createScannedPdfFixture(PAGE_COUNT);
    for (let index = 0; index < DOC_COUNT; index += 1) {
      const suffix = index === 0 ? "" : `-${String.fromCharCode(97 + index)}`;
      const path = join(fixtureDir, `scanned-${PAGE_COUNT}p${suffix}.pdf`);
      writeFileSync(path, fixture);
      docPaths.push(path);
    }
  }

  // 复用已经跑着的 dev server：vite 端口被占时会**自动改用下一个端口**，
  // 那样 app 连的还是 1420（devUrl 是写死的），于是白屏且毫无提示。
  let vite = null;
  if (await isServerUp(baseUrl)) {
    console.log(`复用已运行的 dev server：${baseUrl}`);
  } else {
    console.log(`启动 dev server…`);
    const serverCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    vite = spawn(serverCommand, ["run", "dev"], { cwd: PROJECT_DIR, stdio: "ignore", detached: true });
  }

  let appProc = null;
  let appPid = null;
  const spawnFailure = { error: null, exitCode: null, signal: null };
  const appLog = [];

  try {
    await waitForServer(baseUrl);

    // 基线：app 还没起，先记 pid 集合，之后据此认出「本次 app 引入」的进程。
    const baselinePids = new Set(readProcesses().map((row) => row.pid));

    console.log(`\n════════ 真实 Tauri 内存足迹 ════════`);
    console.log(
      docPaths.length === 0
        ? `夹具   ：无（冷启动对照）`
        : `夹具   ：${docPaths.length} 份 × ${(fixture.length / 1048576).toFixed(1)} MiB` +
            `（合计 ${((fixture.length * docPaths.length) / 1048576).toFixed(1)} MiB）`,
    );
    for (const path of docPaths) console.log(`         ${path}`);
    console.log(`启动   ：cargo run --no-default-features（dev 模式，加载 devUrl）`);
    // 关闭动作要显式打出来：`file`（只销毁文档）与 `tab`（真关标签、卸载 viewer）
    // 是两件不同的事，而两次运行的读数可能接近 —— 不打出来就分不清跑了哪一组。
    const cycleOn = /^(1|true|yes)$/i.test(process.env.R0NIX_AUTO_CYCLE || "");
    const closePlan = cycleOn
      ? `循环模式：每份打开后立即关闭，${docPaths.length} 份 = ${docPaths.length} 轮`
      : process.env.R0NIX_AUTO_CLOSE_MS === undefined
        ? "不关闭（只量打开后驻留）"
        : `${process.env.R0NIX_AUTO_CLOSE_MS}ms 后执行 [${process.env.R0NIX_AUTO_CLOSE_ACTIONS || "file"}]`;
    console.log(`关闭   ：${closePlan}`);
    console.log(`用户目录：已隔离到 ${isolatedHome} —— 不读写你真实的 WebKit 存储`);
    console.log(`默认窗口会出现在桌面上（这是真实应用，不是无头浏览器）\n`);
    printSample(sample(baselinePids, "T0 基线（app 未启动）"));

    const opened = { count: 0, line: null, paths: new Set() };
    // 必须带 --no-default-features，否则会加载编译期嵌入的 dist 而不是 vite —— 见文件头说明。
    // 冷启动对照下**不设** `R0NIX_AUTO_OPEN` —— 设成空串前端也会早退，但
    // 「变量存在且为空」与「变量不存在」在排查时是两件事，不制造这种歧义。
    const appEnv = { ...process.env, CFFIXED_USER_HOME: isolatedHome };
    delete appEnv.R0NIX_AUTO_OPEN;
    if (docPaths.length > 0) appEnv.R0NIX_AUTO_OPEN = docPaths.join(";");
    appProc = spawn("cargo", ["run", "--no-default-features"], {
      cwd: TAURI_DIR,
      env: appEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // ⚠️ 少了这两个监听，「spawn 失败」与「正在运行」在代码里完全同形：
    // 两者都是 exitCode === null、都没有输出 —— 上一轮就是这样白等了 180 秒。
    appProc.on("error", (error) => {
      spawnFailure.error = error;
    });
    appProc.on("exit", (code, signal) => {
      spawnFailure.exitCode = code;
      spawnFailure.signal = signal;
    });

    const watch = (stream, sink) => {
      if (!stream) return;
      stream.setEncoding("utf8");
      createInterface({ input: stream }).on("line", sink);
    };

    watch(appProc.stderr, (line) => {
      // 全量留痕：只打印自己关心的那几行会把「前端根本没加载」这类错误丢掉，
      // 而那种失败的症状是「什么都没发生」—— 最容易被误读成「打开很慢」。
      appLog.push(line);
      if (line.includes("api.openFile") || line.includes("api.autoOpen") || line.includes("domProbe")) {
        // 普查行（worker 台账 / 画布背景存储）才是判据所在，160 字符会把它们截掉 ——
        // 截掉的恰好是「证据」而留下的是「事件」，那等于白跑一轮。
        const limit = /census|terminateWorkers|close action/.test(line) ? 1400 : 160;
        console.log(`    [app] ${line.slice(0, limit)}`);
      }
      // 「打开完成」有**两个**独立证据，取先到的那个：
      //  · `pdfjs loaded` —— 文档进了 pdf.js 并解析出页数；
      //  · `[api.autoOpen] opened` —— 钩子对该路径调用的 `openPdfByPath` 已 resolve。
      // 只认前者会**误判**：后台标签的文档走到「open_pdf success + metadata ready」
      // 就停住（`page_count=deferred`、不挂 PDFViewer），永远不打 `pdfjs loaded` ——
      // 于是「两份都开了」被读成「只开了一份」，白等满 300s。而内存其实已经吃进去了
      // （fileId 已建、WebKit fp 已上台阶），实测确认。
      const openMatch = line.match(/api\.autoOpen\] opened \| \{"autoOpenPath":"([^"]+)"/);
      if (openMatch) opened.paths.add(openMatch[1]);
      if (line.includes("pdfjs loaded")) opened.count += 1;
    });
    watch(appProc.stdout, (line) => {
      appLog.push(line);
      if (line.includes("Running")) console.log(`    [cargo] ${line.slice(0, 140)}`);
    });
    const deadline = Date.now() + 300_000;
    let loadPeak = null;
    let tick = 0;
    /** 已打开的文档数：两个独立证据取较大者（理由见 stderr watcher 里的注释）。 */
    const openedCount = () => Math.max(opened.count, opened.paths.size);
    // 冷启动对照没有「打开完成」这个事件可等，改为等 app 进程真正出现 —— 否则 T1
    // 会采在 app 起来之前，读数恒为 0，看起来像「app 根本没启动」（本轮实测踩到过）。
    while (
      (openedCount() < DOC_COUNT || (DOC_COUNT === 0 && appPid === null)) &&
      Date.now() < deadline
    ) {
      if (spawnFailure.error || spawnFailure.exitCode !== null) break;
      // cargo 是父进程，真正的 app 是它的子进程 —— 每次都重新解析，拿到 app 自己的 pid。
      appPid = findAppPid(baselinePids);
      // 峰值就发生在「读文件 → base64 → IPC → pdf.js 解码」那几秒里。只在 T1 采一次
      // 必然整段错过，所以加载期每 2s 采一次并单独跟踪峰值。
      if (appPid && tick % 4 === 0) {
        const duringLoad = sample(baselinePids, `加载中 +${(tick * 0.5).toFixed(0)}s`);
        if (!loadPeak || duringLoad.totalFpMb > loadPeak.totalFpMb) loadPeak = duringLoad;
      }
      tick += 1;
      await delay(500);
    }
    appPid = findAppPid(baselinePids);

    if (spawnFailure.error) {
      console.log(`\n❌ app 启动失败：${spawnFailure.error.message}`);
      console.log(`   （最常见原因是构建产物路径不对，或二进制被换成了非 dev 构建）`);
    } else if (spawnFailure.exitCode !== null && openedCount() < DOC_COUNT) {
      console.log(`\n❌ app 在打开完成前退出（exitCode=${spawnFailure.exitCode}）`);
      for (const line of appLog.slice(-12)) console.log(`    ${line.slice(0, 160)}`);
    } else if (openedCount() < DOC_COUNT) {
      console.log(
        `\n⚠️ 未在 300s 内确认 ${DOC_COUNT} 份文档打开完成（实际 ${openedCount()} 次）：` +
          `后续读数可能只是「还没开完」的状态`,
      );
      console.log(`  若下面没有 [app] 行，优先检查 app 是否真的加载了 vite（而不是 dist）：见文件头。`);
      for (const line of appLog.slice(-12)) console.log(`    ${line.slice(0, 160)}`);
    } else if (DOC_COUNT === 0) {
      console.log(`\n    冷启动对照：不给 app 任何文档\n`);
    } else {
      console.log(`\n    [app] ${openedCount()} 份文档加载完成\n`);
    }

    await delay(1500);
    const atOpen = sample(baselinePids, "T1 打开完成");
    printSample(atOpen);

    // 口径自检：进程表的 fp 来自 libproc 的**硬编码结构体偏移**（rss@64 / fp@72）。
    // 偏移写错不会报错，只会让所有数字变成垃圾 —— 这类错误没有症状，只有交叉验证能抓。
    // 所以拿同一个 pid 与 `/usr/bin/footprint` 对一次；偏差 > 5% 直接告警。
    if (appPid) {
      const fromLibproc = readProcesses().find((row) => row.pid === appPid)?.fpMb ?? null;
      const fromFootprint = readFootprintMb(appPid);
      if (fromLibproc === null || fromFootprint === null) {
        console.log(
          `  ⚠️ 口径自检未能完成：libproc=${String(fromLibproc)} / footprint=${String(fromFootprint)}` +
            `（读数仍可用，但少了一道防线）`,
        );
      } else {
        const deltaPercent = (Math.abs(fromLibproc - fromFootprint) / Math.max(fromFootprint, 1)) * 100;
        console.log(
          `  口径自检：pid=${appPid} fp libproc ${fromLibproc} MB vs footprint ${fromFootprint} MB` +
            `（Δ${deltaPercent.toFixed(1)}%）${deltaPercent > 5 ? "  ⚠️ 偏差过大，结构体偏移可能写错" : "  ✓"}`,
        );
      }
    } else {
      console.log(`  ⚠️ 口径自检跳过：没找到 app pid`);
    }

    // 峰值以加载期的采样为准 —— T1 已经晚了几秒，真正的尖峰已经过去。
    // 判据统一用 footprint：RSS 在 macOS 上会因为内存压缩而失真（见 readFootprintMb 注释）。
    let peak = atOpen;
    if (loadPeak && loadPeak.totalFpMb > peak.totalFpMb) {
      peak = loadPeak;
      console.log(
        `  ${loadPeak.label.padEnd(22)} 主进程 rss ${String(loadPeak.appMb).padStart(4)} / fp ${String(loadPeak.appFpMb).padStart(4)} MB` +
          `   + WebKit rss ${String(loadPeak.webkitMb).padStart(4)} / fp ${String(loadPeak.webkitFpMb).padStart(4)} MB` +
          `   = rss ${String(loadPeak.totalMb).padStart(4)}  |  ★fp ${String(loadPeak.totalFpMb).padStart(4)} MB   ← 加载期峰值`,
      );
    }
    let previous = atOpen;
    for (const seconds of SETTLE_SECONDS) {
      await delay(seconds * 1000);
      const settled = sample(baselinePids, `T2 静置 ${seconds}s`);
      printSample(settled);
      console.log(
        `       ↳ 相对上一采样 rss ${settled.totalMb - previous.totalMb >= 0 ? "+" : ""}${settled.totalMb - previous.totalMb} MB` +
          ` / fp ${settled.totalFpMb - previous.totalFpMb >= 0 ? "+" : ""}${settled.totalFpMb - previous.totalFpMb} MB`,
      );
      if (settled.totalFpMb > peak.totalFpMb) peak = settled;
      previous = settled;
    }

    console.log(
      `\n  ★ 全程峰值 fp ${peak.totalFpMb} MB / rss ${peak.totalMb} MB（${peak.label}）` +
        ` → 末次 fp ${previous.totalFpMb} MB / rss ${previous.totalMb} MB`,
    );
    console.log(`\n  主进程明细（fp / rss）：`);
    for (const row of previous.appRows) {
      console.log(
        `    ${String(row.fpMb ?? "?").padStart(5)} / ${String(row.rssMb).padStart(5)} MB  pid=${row.pid}  ${row.command.slice(0, 62)}`,
      );
    }
    console.log(`\n  app 引入的 WebKit 进程（${previous.webkitRows.length} 个，fp / rss）：`);
    for (const row of previous.webkitRows) {
      console.log(
        `    ${String(row.fpMb ?? "?").padStart(5)} / ${String(row.rssMb).padStart(5)} MB  pid=${String(row.pid).padStart(6)}  ${row.command.slice(0, 58)}`,
      );
    }
    if (previous.webkitRows.length === 0) {
      console.log(`    （一个都没有 —— 要么 WebKit 进程在基线里已存在，要么本次启动没拉起新进程）`);
    }

    console.log(`\n  其他新出现的大进程（兜底，防漏计；同时段的无关噪音也会出现在这里）：`);
    for (const row of previous.freshRows
      .filter((row) => !isWebKit(row.command) && !isR0nix(row.command))
      .slice(0, 6)) {
      console.log(`    ${String(row.rssMb).padStart(5)} MB rss  pid=${row.pid}  ${row.command.slice(0, 62)}`);
    }

    console.log(`\n──────── 判读要点 ────────`);
    console.log(`  · 口径：**以 fp（footprint）为准**，rss 只作参考。macOS 会把内存压缩掉而不是`);
    console.log(`    释放，rss 因此严重失真 —— 实测同一个 WebContent 进程 rss=424 MB 而 fp=1159 MB。`);
    console.log(`    活动监视器的「内存」列 = fp；只用 rss 会把「压缩」误读成「回落」。`);
    console.log(`  · 主进程 = Rust（PyMuPDF + base64 编码 + IPC）；WebKit = 前端（pdf.js + canvas）。`);
    console.log(`  · 加载期是**瞬时重**：峰值 fp ≈ 7–9 倍文件大小（base64 过桥 3N + JS 解码 ~3.3N`);
    console.log(`    + WebKit 图像解码/上传缓冲）。实测 2 × 110 MiB ⇒ 峰值 fp ≈ 1.98 GB。`);
    console.log(`  · 峰值之后 **Rust 侧全部归还**（fp 回落到空载水平），但 **WebKit 侧不归还**：`);
    console.log(`    WebContent 进程的 fp 停在 ≈ 5 倍「已打开文件总量」，需关标签才释放。`);
    console.log(`  · 所以「不下降」的形状 = 已打开文档数 × 单份驻留，而不是随时间单调上升。`);
    console.log(`    判据是「fp 是否随打开数台阶式上升」，不是 rss 的单点绝对值。`);
    console.log(`  · 内存绝对值不可跨会话比：空载基线本身受系统内存压力影响，会差出几百 MB。`);
    console.log(`  · 同一时刻只能跑一个探针实例：两次启动的 pid 会混在一起，归属就失效了。`);
  } finally {
    // 只杀本次探针拉起的进程；用户自己开着的实例（以及复用的 dev server）不动。
    if (appPid) {
      try {
        process.kill(appPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    if (appProc && appProc.exitCode === null) {
      appProc.kill("SIGTERM");
      await delay(800);
      if (appProc.exitCode === null) appProc.kill("SIGKILL");
    }
    if (vite) {
      try {
        process.kill(-vite.pid, "SIGTERM");
      } catch {
        // server already gone
      }
    }
    // 夹具留在固定路径上供下次复用（内容由固定种子生成，可重现）。
    // 不删目录：路径一变，app 就会多记一条标签页。
    // 隔离 HOME 则直接删掉：它只承载本次运行的 localStorage / workspace，
    // 留着只会在 /tmp 里堆垃圾。
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch {
      // 删不掉也无妨：它在 /tmp 下，系统迟早会清。
    }
  }
}

/** 找出本次启动的 app 进程：基线里没有的 `r0nix`（用户自己开着的实例在基线里，不会被误伤）。 */
function findAppPid(baselinePids) {
  const rows = readProcesses().filter((row) => !baselinePids.has(row.pid) && isR0nix(row.command));
  return rows.length > 0 ? rows[0].pid : null;
}

main().catch((error) => {
  console.error("probe-tauri-memory failed:", error);
  process.exitCode = 1;
});
