# 后端约束审计报告 · pdf-reader-tauri

审计对象：`src-tauri/`（Rust 后端，Tauri 2）
审计维度：重复实现 / 分层边界 / 横切关注点 / 契约一致性 / 守卫覆盖 / 测试
依据：`docs/backend-constraints.md`（本次同步产出）

---

## 一、水位判断

> **「有约定无门禁」，且前后端偏斜严重。**

前端有 **16 个** `check-*-contract.mjs` 守卫（`check:contracts` 串成一条命令，接进 `npm run verify`），
后端 **0 个** 守卫 —— 唯一的机器门禁是 `cargo test`。

这个偏斜本身是本次最重要的发现：**项目的约束意识已经建立，但只覆盖了前端一半。**
后端 3978 行 Rust 代码里，没有任何一条"新增违规会被拦住"的机制。

同时必须说明：**后端的实践质量明显高于"无门禁"这个水位应有的水平。**
`pdf-core` 是一个设计正确的 crate（纯逻辑 + `thiserror` 枚举错误 + 输入上限常量 + 内联单测），
`run_pdf_export_blocking`（`:712`）是一个教科书级的横切封装（限流 + 取消 + 超时 + 清理四合一，已泛型化）。
**问题是这些好实践没有被强制执行，于是散落的调用点各自复制、逐渐漂移。**

### 维度评分

| 维度 | 评分 | 依据 |
|---|---|---|
| 分层结构 | ★★★★☆ | `pdf-core` 干净、依赖方向单向；IPC 层 2493 行过于臃肿 |
| 复用（不重复造轮子） | ★★☆☆☆ | 3 处 chunk 循环、5 处扩展名白名单、超时字面量 4 处，均为复制 |
| 横切关注点 | ★★☆☆☆ | 有正确范本但仅 1/5 处使用；错误映射 100% 手写 |
| 契约一致性 | ★★★★★ | 38 声明 / 38 注册 / 0 漂移（本次实测） |
| 守卫覆盖 | ★★☆☆☆ | 前端 16 个，后端 0 个 |
| 测试 | ★★★☆☆ | 取消语义有 `tokio::test` 覆盖；错误分支覆盖不足 |

---

## 二、必须点名的好实践

不要让这份报告读起来像全盘否定。以下都是**已经做对**的：

1. **生产代码 `unwrap()` / `expect()` 数量为 0**（实测 36 处全部位于 `#[cfg(test)] mod tests` 区块内）。
   这在 Rust 项目里并不常见，值得保持。
2. **IPC 契约 100% 一致**：38 个 `#[tauri::command]` ↔ 38 个 `generate_handler!` 注册 ↔ 前端 31 个唯一调用，
   **零漂移、零死命令**。
3. **所有外部输入都有上限**：`MAX_PDF_BYTES`(512MiB) / `MAX_PROXY_DOWNLOAD_BYTES`(64MiB) /
   `MAX_LLM_RESPONSE_BYTES`(8MiB) / `MAX_IMPORT_SCAN_DIRS`(10000) / `MAX_RENDER_ZOOM`(8.0) /
   `MAX_PLANNED_TILES`(4096)，且大多做了「先查 Content-Length 再查累加」双重校验。
4. **取消机制成体系**：7 类取消场景、统一的 `request_id` 语义、`CANCELED_REQUEST_TTL` 自动回收。
5. **`pdf-core` 是正确的分层范本**：无平台依赖、有单测、上限常量集中、错误用 `thiserror` 枚举。
6. **安全边界明确**：`is_managed_*_path` 校验父目录 + 文件名前缀，清理逻辑不会误删用户文件。
7. **`#[tauri::command]` + `Result<T, String>` 签名一致**，前端能可靠拿到错误串。

---

## 三、问题清单（P0 → P3）

### P0-1 · 扩展名白名单五处复制，白名单可被绕过

**位置**：`tauri_commands.rs:214 / 224 / 281 / 397 / 416`

五个函数结构几乎相同，差异只在 `matches!` 里的字符串：

```rust
// :214 ensure_importable_extension
ext == "pdf" || ext == "md" || ext == "markdown"
// :281 ensure_markdown_extension
ext == "md" || ext == "markdown"
// :224 ensure_pdf_extension
ext.eq_ignore_ascii_case("pdf")
// :397 ensure_allowed_text_write_path
matches!(ext.as_str(), "md" | "markdown" | "csv" | "json" | "svg" | "txt")
// :416 ensure_allowed_binary_write_path
matches!(ext.as_str(), "pdf" | "png" | ... | "ccitt")
```

**为什么是 P0（不只是风格问题）**：这是**安全边界**。当前已经存在不一致 ——
`ensure_allowed_binary_write_path` 允许 `paper.pdf` 写出（`:2181` 已测），
而 `ensure_importable_extension` 也允许 pdf，三处语义靠人工同步维持。
**任何人往白名单加一个扩展名，漏改一处就产生一个绕过口**（例如只加了 text 白名单的 `svg`，
binary 白名单没同步，或反之）。

**建议**：合并为单一事实来源。引入依赖成本：**零**（纯重构）。

```rust
const IMPORTABLE_EXT: &[&str] = &["pdf", "md", "markdown"];
const TEXT_WRITE_EXT: &[&str] = &["md", "markdown", "csv", "json", "svg", "txt"];
const BINARY_WRITE_EXT: &[&str] = &["pdf", "png", "jpg", /* ... */];

fn ensure_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .map(|ext| allowed.iter().any(|a| ext.eq_ignore_ascii_case(a)))
        .unwrap_or(false)
}
```

---

### P0-2 · `wait_for_request_canceled` 用 40ms 轮询，取消响应被延迟且空转烧 CPU

**位置**：`tauri_commands.rs:680-687`

```rust
async fn wait_for_request_canceled(request_id: &str) {
    loop {
        if is_request_canceled(request_id).await { return; }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
```

**问题有三层**：

1. **延迟**：取消最多要等 40ms 才被观察到。`llm_chat_completion`（`:1757`、`:1784`）两处
   `tokio::select!` 都依赖它 —— 网络请求取消会多挂最多 40ms。
2. **空转**：每个未取消的 waiter 每 40ms 醒一次抢一次 `Mutex`。LLM 流式响应期间
   （可能持续数分钟）这个循环一直在跑。
3. **有现成方案但没用**：`tokio` 已开 `features=["full"]`，`tokio::sync::watch` /
   `Notify` 就在依赖树里；`tokio_util::sync::CancellationToken` 是标准做法。

**建议**：改用 `Notify` 或 `CancellationToken`，取消时立即唤醒。
引入依赖成本：**零到一行**（`tokio::sync::Notify` 已可用；`CancellationToken` 需加 `tokio-util`）。

```rust
// 方案 A：零新依赖
static CANCELED_NOTIFY: Lazy<Notify> = Lazy::new(Notify::new);
// wait 侧
let notified = CANCELED_NOTIFY.notified();
if is_request_canceled(id).await { return; }   // 先查后等，避免丢通知
notified.await;
// cancel 侧
CANCELED_REQUESTS.lock().await.insert(id.into());
CANCELED_NOTIFY.notify_waiters();
```

⚠️ 迁移时注意 `CANCELED_REQUESTS` 有 600s TTL 自动清理（`:672`），
`Notify` 无状态，注册/移除逻辑要一并调整，并补一个"先查后等不丢通知"的测试。

---

### P1-1 · 已定义 `PDF_OPERATION_TIMEOUT`，仍有 8 处写死时长

**位置**：见下方逐条清单。

> **更正**：本报告初版写的是「4 处字面量 `Duration::from_secs(30)`」，**这个数字是错的**。
> 它来自我早期一次 grep（只查了 `Duration::from_secs`），漏掉了 `from_millis` 和
> `.timeout(...)` 两种形式。后续写守卫脚本时用完整正则重扫，实测是 **9 处**。

```rust
const PDF_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);   // :53 已存在
```

| 位置 | 内容 | 建议 |
|---|---|---|
| `:259` | `Duration::from_secs(24 * 60 * 60)` | 提为 `STALE_TEMP_FILE_AGE` |
| `:685` | `sleep(Duration::from_millis(40))` | 见 P0-2，随轮询改造消失 |
| `:699` | `Duration::from_secs(5)` | 提为独立常量（语义是排队上限，非操作超时） |
| `:903` | `timeout(Duration::from_secs(30), page_count_task)` | → `PDF_OPERATION_TIMEOUT` |
| `:986` | `timeout(Duration::from_secs(30), task)` | → `PDF_OPERATION_TIMEOUT` |
| `:1378` | `timeout(Duration::from_secs(30), task)` | → `PDF_OPERATION_TIMEOUT` |
| `:1414` | `.timeout(Duration::from_secs(30))` | → 收进 HTTP 客户端工厂 |
| `:1529` | `.timeout(Duration::from_secs(60))` | → 独立常量 `PDF_DOWNLOAD_TIMEOUT` |
| `:1731` | `.timeout(Duration::from_millis(timeout_ms))` | **保留**——用户可配置且已 clamp |

**最后一行尤其重要**：它是产品功能（LLM 超时可配），把它"改成常量"是**功能回退**。
判定标准是「是否来自运行时输入」，不是「是否长得像魔法数字」。

**为什么重要**：`:1312` 走 `run_pdf_export_blocking`（用了常量），`:1378` 手写 30 秒。
**改超时值要改 8 个地方，漏改则行为静默不一致** —— 这正是 agent 加功能时最典型的"复制上一份"痕迹。

**建议**：全部替换为常量。成本 **零**。

---

### P1-2 · 错误映射 100% 手写，`Result<_, String>` 52 处 + 手写错误文案 52 处

**位置**：全文件，`format!("... failed: {err}")` / `"... error: {err}"` 共 **52 处**，
`Result<..., String>` **50 处**。

**问题**：`pdf-core` 已经有 `CoreError`（`thiserror` 枚举，`:8-16`），
但 `tauri_commands.rs` 全程把它 `.to_string()` 拍平成 `String`（如 `:693`），
`#[from]` / `?` 自动转换**一次都没用上**。

后果：
- 错误**结构化信息全丢**，前端只能靠字符串匹配来区分错误类型；
- 文案不统一（`"{label} failed: {err}"` vs `"read response bytes failed: {err}"` vs `"PDF download failed: {err}"`）；
- 拼写错误无法被编译器发现。

**建议**：在 `pdf-core` 定义跨层错误枚举（`DownloadError` / `RenderError` / `ValidationError`），
用 `thiserror` + `#[from]` 承载，IPC 边界处统一 `map_err(|e| e.to_string())` **一次**。
成本：**零**（`thiserror` 已在依赖里）。

---

### P1-3 · 三处 chunk 流式读取循环几乎逐行重复

**位置**：`:1454`（proxy 下载）、`:1592`（下载到临时文件）、`:1666`（读 LLM 响应）

三处都是：查 `content_length()` 上限 → `while let Some(chunk) = response.chunk()` →
累加判上限 → `extend_from_slice`。只有落盘那一处多了 `write_all` 和清理。

**建议**：抽一个 `read_capped(response, max_bytes) -> Result<Vec<u8>, String>`，落盘场景复用其上限检查。
成本 **零**。这条同时解决"上限值改一处漏三处"的问题。

---

### P2-1 · `tauri_commands.rs` 2493 行，IPC 层过胖

38 个 command + 全部校验 + 全部 HTTP + 全部瓦片计算 + 20 处 `eprintln!` + 8 个静态全局态
（`:27-43`）挤在一个文件。

**建议**拆为：
```
src-tauri/src/ipc/pdf.rs        文档类 command
src-tauri/src/ipc/transfer.rs   下载 / 上传类
src-tauri/src/ipc/webview.rs    webview tab 类（:1834-2055 已自成体系，天然可切）
src-tauri/src/ipc/llm.rs        模型调用类
src-tauri/src/net/mod.rs        HTTP 客户端构建 + capped read（消除 P1-3）
src-tauri/src/state.rs          7 个全局态收敛
```
`tauri_commands.rs` 保留 `mod` 声明与 re-export，**函数签名和 IPC 契约完全不变，零行为风险**。

---

### P2-2 · `eprintln!` 20 处，前端侧已有结构化日志通道却未打通

`frontend_log` command（`:379`）接收 `level` / `scope` / `message` / `payload` 四个结构化字段，
但后端自身日志全是裸 `eprintln!`（`:22 / 1402` 等）。
`level` 参数被接收后从未校验或使用。

**建议**：后端也走 `tracing` 或至少统一前缀宏（`log::warn!` / `eprintln!("[pdf] ...")`），
并对 `level` 做枚举校验。

---

### P2-3 · `reqwest::Client` 三处各自构建，策略不一致

| 位置 | timeout | redirect | 用途 |
|---|---|---|---|
| `:1412` | 30s | limited(8) | proxy 下载 |
| `:1527` | 60s | limited(8) | 下载到临时文件 |
| `:1729` | 动态 | limited(3) | LLM 调用 |

三处都设了 `danger_accept_invalid_certs(false)`（正确），但**没有任何重试**。
网络抖动 = 直接失败。

**建议**：抽 `fn build_http_client(timeout: Duration, redirects: u32) -> Result<Client, String>`，
统一策略；重试按业务决定（下载适合重试，LLM 不适合）。
成本 **零**（`retry-policies` 才需要新依赖）。

---

### P3-1 · `is_pdf_url`（`:317`）60 行启发式匹配，误判难以评估

包含 5 套 `.pdf` / `/pdf/` / `/pdfs/` / query key / fragment 规则。测试覆盖 8 个正例 3 个反例，
但**反例明显不足**（如 `https://example.com/pdf-guide/intro` 会被判为 PDF）。
属策略选择而非缺陷，但应补反例测试并注释说明误判代价（多余一次拦截，成本低、可接受）。

---

## 四、落地顺序

### 第一批：零依赖、零行为风险（建议立即做）

1. 扩展名白名单合并为单一常量来源 → **P0-1**
2. `Duration::from_secs(30)` × 3 替换为 `PDF_OPERATION_TIMEOUT` → **P1-1**
3. 抽 `read_capped()` 复用 → **P1-3**
4. 抽 `build_http_client()` → **P2-3**
5. `tauri_commands.rs` 按 `ipc/` 子模块拆分（纯搬迁） → **P2-1**

### 第二批：需要少量重构，收益最大

6. `wait_for_request_canceled` 改 `Notify`（含丢通知测试） → **P0-2**
7. `CoreError` 跨层化，`#[from]` 替代 52 处 `format!` → **P1-2**

### 第三批：建立门禁（**这一步才让前面不再退化**）

8. 落地 `scripts/check-backend-constraints.mjs` + 基线文件，
   接入 `npm run check:contracts`（见下节规则表）
9. 把 `docs/backend-constraints.md` 提到根目录或写进 `AGENTS.md`，
   让 agent 每次改动前必读

> **第三批不做，前两批会在三个月内重新退化。** 有约束文档而无门禁，
> 等于告诉 agent "建议这样写" —— 而这正是本次问题的成因。

---

## 五、建议的守卫规则

对应 `scripts/check-backend-constraints.mjs`，零依赖、基线模式：

| 规则 | 检测 | 当前基线（实测 2026-10-04） |
|---|---|---|
| `timeout-literal` | `Duration::from_(secs\|millis)(` 命中且不在常量定义区 | **9** |
| `polling-loop` | `loop {` 往后 8 行含 `::sleep(` / `.sleep(` | **1** |
| `extension-family` | `fn ensure_*extension(` 或 `fn ensure_allowed_*_path(` | **5** |
| `oversized-file` | 单文件行数 > 1200 | **1**（2494 行） |
| `chunk-loop` | 单文件 `.chunk()` > 2 处 | **1**（同文件内 3 处） |
| `handwritten-header-parse` | `split_once('=')` 或 `split(';')` | **2** |
| 生产 unwrap | 排除 `#[cfg(test)]` / `tests/` / 启动 expect 后仍有 `unwrap()`/`expect()` | **0** ✅ |
| **契约漂移** | `#[tauri::command]` ↔ `generate_handler!` ↔ 前端 `invoke()` 三方一致 | **0 漂移** ✅ |
| | **TOTAL** | **19** |

**守卫已落地并实测**：`scripts/check-backend-constraints.mjs`（8 条规则，基线模式，
零依赖）。注入违规 → `exit=1` → 删除 → `exit=0` 已验证通过。

### 写守卫时踩过的 4 个坑（比规则本身更重要）

1. **Rust 的 sleep 是 `::sleep` 不是 `.sleep`**。最初写 `/\.sleep\(/`，
   结果这条规则**永远不触发**——守卫看起来在跑，实际是条死规则。
   正确：`/(?:::|\.)sleep\s*\(/`。**教训：正则静默失配比报错危险得多，必须注入违规实测。**
2. **必须排除 `tests/` 目录**。Cargo 集成测试**没有** `#[cfg(test)]` 标记，
   整个文件都是测试代码。`src-tauri/tests/tauri_commands.rs` 有 14 处 `unwrap()`，
   不排除会把"生产 0 处 unwrap"这个优点误报成 15 处违规。
3. **要给合理的启动 expect 留豁免**。`main.rs` 的
   `.expect("error while running tauri application")` 是 Tauri 应用唯一合理的 abort 点。
4. **按文件计数而非按出现次数**。否则同一文件内 3 处 chunk 循环只记成 1 条，
   阈值设 2 就永远不触发。

⚠️ **契约规则的实现坑**：`nativeWebview.ts` 用 `invokeNative()` 而非直接 `invoke()`，
只匹配 `invoke("...")` 会误报 7 个"死命令"。检测器必须同时识别包装函数名。

---

## 六、审计方法与局限

**已实测**：IPC 契约三方一致性（38/38/31，零漂移）；`unwrap` 分布（生产 0 处）；
重复模式计数（5 类）；超时字面量分布；扩展名函数族；错误文案计数。

**未实测（需实机验证，本次为静态审查）**：
- 竞态：`CANCELED_REQUESTS` 在 `tokio::select!` 与 TTL 清理任务间的时序；
- 内存：`build_tile_payloads`（`:591`）对 4096 瓦片全部 base64 后的驻留内存；
- 真实取消延迟（40ms 轮询的实际端到端表现）。

**审计阶段仅新增文件，未改动任何既有代码。**
上述「接入 npm script」「建基线文件」等改动需你确认后再执行。
