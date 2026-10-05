# 后端约束改造执行单

> 更新于 2026-10-04。本文根据 `backend-audit-report.md` 与当前代码/脚本复核过；
> 审计建议不等于已实施。执行前仍须重新核对工作区、源码和命令输出，不把本文历史行号当作事实。

> **给执行 agent 的话**：本文件是可直接执行的施工单。按「任务编号」顺序做，每项都给了
> 精确到行的原文断言。**动手前必须先读 `docs/backend-constraints.md`**（能力索引），
> 它定义了本项目「什么该用什么」的强制复用规则。
>
> **绝对不要**做本文件未列出的改动。发现别的问题 → 记进文末「遗留观察」，不要顺手改。

---

## 开工前必读

| 项 | 值 |
|---|---|
| 项目根 | `/Users/yinyin/test/pdf-reader-tauri` |
| 主要改动文件 | `src-tauri/src/tauri_commands.rs`（2493 行） |
| 辅助新增文件 | `src-tauri/src/http.rs`（新模块）、`scripts/check-backend-constraints.mjs` |
| 构建验证 | `cargo build --manifest-path src-tauri/Cargo.toml` |
| 测试验证 | `cargo test --manifest-path src-tauri/Cargo.toml` 跑默认测试；`npm run test:native` 只用于额外跑 ignored 测试 |
| 现有守卫 | `npm run check:contracts`（前端 16 个契约守卫） |
| 备份 | `tar -czf /Users/yinyin/test/r0nix-backend-backup-$(date +%Y%m%d-%H%M).tar.gz src-tauri/src src-tauri/Cargo.toml` |

### 当前状态核对（2026-10-04）

| 项 | 复核结果 | 对本计划的影响 |
|---|---|---|
| `tauri_commands.rs` | 2493 行，任务 1–6 尚未实施 | 行号只作导航，必须先匹配完整代码上下文 |
| 后端守卫脚本 | `scripts/check-backend-constraints.mjs` 已存在；报告模式为 19 项 | 不重写脚本；先补基线与 package 接入，再做逐项迁移 |
| 守卫基线 | `scripts/backend-constraints-baseline.json` 当前不存在 | 普通检查会把已存在项视为新增；创建基线前不得把守卫接入 CI/合同门禁 |
| package 接入 | `check:backend` 未定义，`check:contracts` 尚未调用后端守卫 | 任务 7.5 仍待执行 |
| native 测试命令 | `npm run test:native` 带 `-- --ignored`，只运行 ignored lib tests | 必须另跑默认 `cargo test`，不能把两者等同 |
| 根目录 agent 说明 | 当前不存在 `AGENTS.md` | 任务 7.6 是新建简短入口，不是复制整份能力文档 |

基线扫描结果（当前实测原始结果）：`timeout-literal=9`、`polling-loop=1`、`extension-family=5`、
`oversized-file=1`、`chunk-loop=1`、`handwritten-header-parse=2`，总计 19。
其中 `timeout-literal` 把 `Duration::from_millis(timeout_ms)` 这个运行时变量误报为字面量；任务 7
须先修正规则并注入回归用例，再按修正后的报告冻结基线（预期总数 18）。
守卫输出会省略为 0 的规则；生成的 JSON 基线可能是稀疏对象，不应要求 0 项都显式写出。

**依赖情况**：`Cargo.toml` 已含 `thiserror`、`tokio`（`features=["full"]`）、`once_cell`、`reqwest`。
任务 1–5 **不需要新增任何依赖**。任务 6 若走方案 B 需要 `tokio-util`，走方案 A 则不需要。

---

## 任务 1 · 扩展名白名单合并为单一事实来源【P0】

**为什么做**：当前 5 处复制粘贴的白名单是**安全边界**（文件写入准入）。
加一个扩展名漏改一处就产生绕过口。这是本次唯一的安全类问题。

**位置**：`tauri_commands.rs:214 / 224 / 281 / 397 / 416`

### 步骤 1.1 · 在常量区（`:44` 之前，紧接 `const NATIVE_WEBVIEW_UA` 上方）插入

在第 51 行 `const MANAGED_WEB_PDF_PREFIX: &str = "r0nix-web-";` **之后**、
第 52 行 `const MANAGED_IMPORT_PREFIX` **之前**，插入以下常量块：

```rust
// Extension allow-lists — single source of truth.
// Every add/remove MUST go through these arrays; do not inline `matches!` elsewhere.
const IMPORTABLE_EXTENSIONS: &[&str] = &["pdf", "md", "markdown"];
const PDF_EXTENSIONS: &[&str] = &["pdf"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown"];
const TEXT_WRITE_EXTENSIONS: &[&str] =
    &["md", "markdown", "csv", "json", "svg", "txt"];
const BINARY_WRITE_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "jp2", "jpx", "jbig2",
    "ccitt",
];
```

### 步骤 1.2 · 用统一 helper 替换 5 个函数

**逐条断言原文完全匹配再替换**（行号会随编辑漂移，断言是唯一可靠护栏）。

---

**① 替换 `ensure_importable_extension`（:214）**

原文（逐字）：
```rust
fn ensure_importable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "pdf" || ext == "md" || ext == "markdown"
        })
        .unwrap_or(false)
}
```
替换为：
```rust
fn ensure_importable_extension(path: &Path) -> bool {
    ensure_extension_allowed(path, IMPORTABLE_EXTENSIONS)
}
```

---

**② 替换 `ensure_pdf_extension`（:224）**

原文：
```rust
fn ensure_pdf_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}
```
替换为：
```rust
fn ensure_pdf_extension(path: &Path) -> bool {
    ensure_extension_allowed(path, PDF_EXTENSIONS)
}
```

---

**③ 替换 `ensure_markdown_extension`（:281）**

原文：
```rust
fn ensure_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "md" || ext == "markdown"
        })
        .unwrap_or(false)
}
```
替换为：
```rust
fn ensure_markdown_extension(path: &Path) -> bool {
    ensure_extension_allowed(path, MARKDOWN_EXTENSIONS)
}
```

---

**④ 替换 `ensure_allowed_text_write_path`（:397）**

原文：
```rust
fn ensure_allowed_text_write_path(path: &Path) -> Result<(), String> {
    let allowed = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            matches!(
                ext.as_str(),
                "md" | "markdown" | "csv" | "json" | "svg" | "txt"
            )
        })
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err("text write only supports md, markdown, csv, json, svg, or txt files".to_string())
    }
}
```
替换为：
```rust
fn ensure_allowed_text_write_path(path: &Path) -> Result<(), String> {
    if ensure_extension_allowed(path, TEXT_WRITE_EXTENSIONS) {
        Ok(())
    } else {
        Err(format!(
            "text write only supports {} files",
            TEXT_WRITE_EXTENSIONS.join(", ")
        ))
    }
}
```

---

**⑤ 替换 `ensure_allowed_binary_write_path`（:416）**

原文：
```rust
fn ensure_allowed_binary_write_path(path: &Path) -> Result<(), String> {
    let allowed = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            matches!(
                ext.as_str(),
                "pdf"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "bmp"
                    | "tif"
                    | "tiff"
                    | "jp2"
                    | "jpx"
                    | "jbig2"
                    | "ccitt"
            )
        })
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err("binary write only supports pdf, png, jpg, or jpeg files".to_string())
    }
}
```
替换为：
```rust
fn ensure_allowed_binary_write_path(path: &Path) -> Result<(), String> {
    if ensure_extension_allowed(path, BINARY_WRITE_EXTENSIONS) {
        Ok(())
    } else {
        Err(format!(
            "binary write only supports {} files",
            BINARY_WRITE_EXTENSIONS.join(", ")
        ))
    }
}
```

> ⚠️ 注意：原二进制白名单的错误文案是 `"binary write only supports pdf, png, jpg, or jpeg files"`
> —— **只说了 4 个，实际允许 13 个**，文案本身是错的。新版用 `join()` 自动生成，不会再漂移。
> 若有前端代码依赖这个错误文案做判断，需 grep 前端确认（预期：无）。

### 步骤 1.3 · 新增 helper

在 `ensure_non_empty_path`（`:206`）**之前**插入：

```rust
/// Case-insensitive extension check against a single allow-list.
fn ensure_extension_allowed(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            allowed
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}
```

### 步骤 1.4 · 验证

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:native
```

**必须通过的既有测试**（`:2159` `restricts_native_file_command_extensions`）：
已覆盖 `PAPER.PDF`（大写）、`figure.jp2`、`export.csv`、`script.sh` 拒绝等。
改造后行为必须**完全一致**——特别是大写扩展名仍要通过。

---

## 任务 2 · 超时字面量改用常量【P1】

**为什么做**：`PDF_OPERATION_TIMEOUT`（`:53`）已定义为 30 秒，但仍有 4 处写死 30。
改超时值要改 4 个地方，漏改则行为静默不一致。

### 步骤 2.1 · 替换 `:903`

原文：
```rust
    let page_count = match tokio::time::timeout(Duration::from_secs(30), page_count_task).await {
```
替换为：
```rust
    let page_count = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, page_count_task).await {
```

同一分支的错误文案也要同步（`:913`）：
```rust
            return Err("page count timed out after 30 seconds".to_string());
```
替换为：
```rust
            return Err(format!(
                "page count timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ));
```

### 步骤 2.2 · 替换 `:986`

原文：
```rust
    let result = match tokio::time::timeout(Duration::from_secs(30), task).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => Err(format!("read pdf bytes task failed: {err}")),
```
替换为：
```rust
    let result = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => Err(format!("read pdf bytes task failed: {err}")),
```

对应文案（`:991`）：
```rust
            Err("read pdf bytes timed out after 30 seconds".to_string())
```
替换为：
```rust
            Err(format!(
                "read pdf bytes timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ))
```

### 步骤 2.3 · 替换 `:1378`

⚠️ **这一步的行号会因任务 1 的插入而漂移。用原文断言定位，不要信行号。**

原文：
```rust
    let result = match tokio::time::timeout(Duration::from_secs(30), task).await {
        Ok(Ok(result)) => result.map_err(|err| format!("get_pdf_reading_blocks task failed: {err}")),
```
替换为：
```rust
    let result = match tokio::time::timeout(PDF_OPERATION_TIMEOUT, task).await {
        Ok(Ok(result)) => result.map_err(|err| format!("get_pdf_reading_blocks task failed: {err}")),
```

对应文案（`:1385`）：
```rust
            Err("PDF reading block extraction timed out after 30 seconds".to_string())
```
替换为：
```rust
            Err(format!(
                "PDF reading block extraction timed out after {} seconds",
                PDF_OPERATION_TIMEOUT.as_secs()
            ))
```

### 步骤 2.4 · 新增常量 `:699` 的 `from_secs(5)`

原文：
```rust
async fn acquire_python_task_permit(label: &'static str) -> Result<OwnedSemaphorePermit, String> {
    match tokio::time::timeout(
        Duration::from_secs(5),
        PDF_PYTHON_TASK_PERMITS.clone().acquire_owned(),
    )
```
在常量区新增：
```rust
const PYTHON_PERMIT_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
```
并把上面改为：
```rust
    match tokio::time::timeout(
        PYTHON_PERMIT_ACQUIRE_TIMEOUT,
        PDF_PYTHON_TASK_PERMITS.clone().acquire_owned(),
    )
```

> ⚠️ 这个 5 秒**语义不同于** 30 秒操作超时（是排队等信号量的上限），
> 所以用**独立常量**而不是复用 `PDF_OPERATION_TIMEOUT`。

### 步骤 2.5 · 验证

```bash
# 改造后生产代码中的数值时长只应出现在常量定义区
grep -n "Duration::from_secs(" src-tauri/src/tauri_commands.rs
```
预期：生产代码中的时长构造集中在常量区；`:259` 的 stale 清理阈值也提取为
`STALE_TEMP_FILE_AGE`，避免把它留成可选债务。源码 grep 也会命中测试中的时长，测试区命中不算违规，
最终以守卫的 `productionOnly` 结果为准。

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:native
```

---

## 任务 3 · 抽取带上限的流式读取【P1】

**为什么做**：三处 `.chunk()` 循环几乎逐行重复（`:1454` / `:1592` / `:1666`）。
抽出来后上限值改一处即可，避免"漏改第三处"。

### 步骤 3.1 · 新增函数

在 `src-tauri/src/http.rs` 新模块新增 `pub(crate)` helper；不要把 HTTP body 读取实现放回 IPC 命令文件。
在 `lib.rs` 注册 `mod http;`。helper 内容：

```rust
/// Read a response body into memory, aborting as soon as `max_bytes` is exceeded.
///
/// `reqwest` does not expose a body-size limit, so the cap has to be enforced
/// while streaming: once via `Content-Length` (cheap rejection) and again on
/// every chunk (authoritative, because the header may lie or be absent).
async fn read_capped_body(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let limit_label = max_bytes / 1024 / 1024;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("response exceeds {limit_label} MiB limit"));
    }
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("read response bytes failed: {err}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("response exceeds {limit_label} MiB limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
```

### 步骤 3.2 · 替换 `download_pdf_via_proxy` 的循环（`:1444-1466`）

原文：
```rust
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROXY_DOWNLOAD_BYTES as u64)
    {
        return Err(format!(
            "download response exceeds {} MiB limit",
            MAX_PROXY_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("read response bytes failed: {err}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_PROXY_DOWNLOAD_BYTES {
            return Err(format!(
                "download response exceeds {} MiB limit",
                MAX_PROXY_DOWNLOAD_BYTES / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
```
替换为（引入 `crate::http::read_capped_body`）：
```rust
    let bytes = crate::http::read_capped_body(response, MAX_PROXY_DOWNLOAD_BYTES).await?;
```
> 替换后删除调用方不再需要的 `mut`；不要留下可避免的编译 warning。`read_capped_body` 自己取得 response 所有权并在内部可变读取。

### 步骤 3.3 · 替换 `read_llm_response_body`（`:1654`）—— 整个函数

原文：
```rust
async fn read_llm_response_body(mut response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_LLM_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "model service response exceeds {} MiB limit",
            MAX_LLM_RESPONSE_BYTES / 1024 / 1024
        ));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("failed to read model response: {err}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_LLM_RESPONSE_BYTES {
            return Err(format!(
                "model service response exceeds {} MiB limit",
                MAX_LLM_RESPONSE_BYTES / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    String::from_utf8(bytes).map_err(|err| format!("model service response was not UTF-8: {err}"))
}
```
替换为：
```rust
async fn read_llm_response_body(response: reqwest::Response) -> Result<String, String> {
    let bytes = crate::http::read_capped_body(response, MAX_LLM_RESPONSE_BYTES).await?;
    String::from_utf8(bytes).map_err(|err| format!("model service response was not UTF-8: {err}"))
}
```

> ⚠️ **错误文案会变**：从 `"failed to read model response: {err}"` 变成 `"read response bytes failed: {err}"`。
> 这是**有意的统一**。执行前请 grep 前端确认没有依赖旧文案：
> ```bash
> grep -rn "failed to read model response" src/ scripts/
> ```

### 步骤 3.4 · 第三处（`download_pdf_to_temp` 的 `:1586-1624`）**保持手写，不要替换**

**理由**：这一处是「落盘」而非「读进内存」——它边读边 `write_all` 到文件，同时收集前 1024 字节
做 `%PDF-` 魔数校验，失败还要 `remove_file` 清理。强行套 `read_capped_body` 会把 512MiB
文件整个读进内存，**是性能回退**。

但必须做两件事：
1. 把上限常量的重复判断改用 `MAX_PDF_BYTES`（已经在用，无需改）；
2. 在该函数上方加注释说明为何不复用：

```rust
// Deliberately NOT using read_capped_body: this streams to disk and keeps only
// a 1 KiB header prefix for the %PDF- magic check. Buffering the whole file
// (up to MAX_PDF_BYTES = 512 MiB) to reuse the helper would be a regression.
```

### 步骤 3.5 · 验证

```bash
grep -R -n "\.chunk()" src-tauri/src/http.rs src-tauri/src/tauri_commands.rs  # 预期总计 2 处：helper 1 + 落盘 1
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:native
```

---

## 任务 4 · 统一 HTTP 客户端构建【P2】

**为什么做**：三处 `reqwest::Client::builder()` 各配各的，策略漂移，且**均无重试**。

### 步骤 4.1 · 新增工厂函数

在 `src-tauri/src/http.rs` 中新增 `pub(crate)` 工厂，与任务 3 的读取 helper 共处 HTTP 适配器模块。
`tauri_commands.rs` 只负责调用工厂和编排请求，不直接拥有 client policy：

```rust
/// Shared HTTP client policy: TLS verification on, bounded redirects.
///
/// `danger_accept_invalid_certs(false)` is stated explicitly (rather than left to
/// the default) because it is a security boundary — any future edit that flips it
/// should be a deliberate, visible change.
fn build_http_client(
    timeout: Duration,
    redirects: u32,
    proxy: Option<&str>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(redirects))
        .timeout(timeout)
        .danger_accept_invalid_certs(false);
    if let Some(proxy_url) = proxy {
        let trimmed = proxy_url.trim();
        if !trimmed.is_empty() {
            let proxy = reqwest::Proxy::all(trimmed)
                .map_err(|err| format!("invalid proxy url: {err}"))?;
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|err| format!("failed to create HTTP client: {err}"))
}
```

### 步骤 4.2 · 替换 `download_pdf_via_proxy` 的构建段（`:1412-1426`）

原文：
```rust
    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(false);
    if let Some(proxy) = proxy_url {
        let trimmed = proxy.trim().to_string();
        if !trimmed.is_empty() {
            let req_proxy =
                reqwest::Proxy::all(&trimmed).map_err(|err| format!("invalid proxy url: {err}"))?;
            client_builder = client_builder.proxy(req_proxy);
        }
    }
    let client = client_builder
        .build()
        .map_err(|err| format!("failed to create proxy client: {err}"))?;
```
替换为：
```rust
    let client = crate::http::build_http_client(PDF_OPERATION_TIMEOUT, 8, proxy_url.as_deref())?;
```

> ⚠️ 错误文案变化：`"failed to create proxy client: {err}"` → `"failed to create HTTP client: {err}"`。
> `invalid proxy url: {err}` **保持不变**（helper 里一致沿用）。

### 步骤 4.3 · 替换 `download_pdf_to_temp` 的构建段（`:1527-1541`）

⚠️ 这处原本是 **60 秒**，不是 30 秒。**新增常量，不要用 `PDF_OPERATION_TIMEOUT`**：

在常量区新增：
```rust
const PDF_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
```
原文：
```rust
    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(60))
        .danger_accept_invalid_certs(false);
    if let Some(proxy) = proxy_url {
        let trimmed = proxy.trim().to_string();
        if !trimmed.is_empty() {
            let req_proxy =
                reqwest::Proxy::all(&trimmed).map_err(|err| format!("invalid proxy url: {err}"))?;
            client_builder = client_builder.proxy(req_proxy);
        }
    }
    let client = client_builder
        .build()
        .map_err(|err| format!("failed to create PDF download client: {err}"))?;
```
替换为：
```rust
    let client = crate::http::build_http_client(PDF_DOWNLOAD_TIMEOUT, 8, proxy_url.as_deref())?;
```

### 步骤 4.4 · 替换 `llm_chat_completion` 的构建段（`:1729-1734`）

⚠️ 这处**没有 proxy 参数**，且重定向上限是 **3** 不是 8。

原文：
```rust
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(Duration::from_millis(timeout_ms))
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|err| format!("failed to create model client: {err}"))?;
```
替换为：
```rust
    let client = crate::http::build_http_client(
        Duration::from_millis(timeout_ms),
        3,
        None,
    )?;
```

### 步骤 4.5 · 关于重试 —— **本任务不做**

审计建议过"给下载加重试"，但**不要在这一轮加**：重试会改变幂等性语义，
且 PDF 下载已有 30/60 秒超时与大小上限兜底。加重试需要单独评估
（哪些错误可重试、退避策略、是否会放大服务端压力）。

**记入文末「遗留观察」，不在本次执行。**

### 步骤 4.6 · 验证

```bash
grep -n "reqwest::Client::builder" src-tauri/src/http.rs            # 预期：1 处
grep -R -n "danger_accept_invalid_certs" src-tauri/src/http.rs      # 预期：1 处（工厂内）
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:native
```

---

## 任务 5 · 收敛内部错误映射【P1 · 独立评估，不随手扩展】

**审计发现**：52 处错误包装格式不一，值得治理；这本身不证明前端正在依赖字符串分类。
`pdf-core::CoreError` 只表达纯 PDF 域错误，不应承载 HTTP、IPC、超时或 Python 适配器错误。

> ⚠️ **这是本单中风险最高的一项。** 它不是 P0 修复的前置条件，默认延后到独立变更，
> 先列出实际错误来源、调用边界和前端兼容契约，再决定是否抽象。不得为减少 `format!` 数量而批量改写 50 余个调用点。

### 步骤 5.1 · 保持域错误与适配器错误分层

保留 `src-tauri/pdf-core/src/lib.rs` 中的 `CoreError`，只用于 `pdf-core` 的纯逻辑错误。
如有多个后端调用确实需要统一 HTTP/文件/Python 错误映射，再在 `src-tauri/src/`
建立应用层错误类型（例如 `backend_error.rs`）；它可以包装 `CoreError`，但不能反向把
网络、IPC 或平台依赖引入 `pdf-core`。

跨 IPC 的命令签名继续保持 `Result<T, String>`。本计划不声称在这个字符串里增加 `kind`
就构成机器可读契约；若前端确需结构化错误，应另开兼容性任务，同时改 Rust 返回类型、
前端适配器、错误 UI 和契约测试。

### 步骤 5.2 · 实施前的决策门

在改代码前列出错误来源、目前调用方、用户可见文案以及对应测试。只对存在重复分类/处理逻辑的边界引入应用层类型；不把所有 `Result<_, String>` 机械替换成枚举。

若最终保持 Tauri 命令 `Result<T, String>`，边界映射须维持现有文案，除非先更新并验证依赖文案的前端契约（至少检查 `scripts/check-dialog-errors.mjs`）。若要让前端按错误类别分支，必须作为单独 IPC 兼容性变更设计 typed response，不能把 `[kind] message` 称为结构化协议。

### 步骤 5.3 · 验证门

只有决策门通过后才实施。按错误来源逐组迁移，每组增加针对错误种类和原文案的测试；验证命令：

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run check:contracts && npm run build && npm run test:e2e
```

---

## 任务 6 · 取消机制去轮询化【P0 · 需谨慎】

**为什么做**：`wait_for_request_canceled`（`:680`）每 40ms 醒一次抢一次 Mutex。
取消最多延迟 40ms；LLM 流式响应期间（可能数分钟）这个循环持续空转。

> ⚠️ **这一项风险最高，改之前务必读完「影响面」小节。**

### 影响面（**必须全部覆盖，否则会破坏 tile 取消功能**）

`CANCELED_REQUESTS` 有 **11 处直接加锁访问**，不只是 LLM 路径：

| 位置 | 用途 |
|---|---|
| `:673` / `:676` | `mark_request_canceled` 内部：插入 + TTL 回收 |
| `:1078`, `:1080`, `:1093`, `:1098`, `:1101`, `:1142`, `:1149` | `request_tiles` 的 spawn 任务内多点检查 |
| `:1764`, `:1791`, `:1799` | `llm_chat_completion` 的清理分支 |
| `:2079`, `:2091` | 测试代码 |

**`request_tiles`（`:1077-1151`）依赖 `is_request_canceled` 在 4 个时间点轮询检查。**
改造后这些 `is_request_canceled()` 调用**可以原样保留**（helper 签名不变），
只有 `wait_for_request_canceled` 的**内部实现**要换。

### 步骤 6.1 · 新增 `Notify`

在常量区（`:43` 之后、`DEFAULT_NATIVE_WEBVIEW_UA` 之前）新增：
```rust
static CANCELED_NOTIFY: once_cell::sync::Lazy<tokio::sync::Notify> =
    once_cell::sync::Lazy::new(tokio::sync::Notify::new);
```

### 步骤 6.2 · 改 `wait_for_request_canceled`（`:680`）

原文：
```rust
async fn wait_for_request_canceled(request_id: &str) {
    loop {
        if is_request_canceled(request_id).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
```
替换为：
```rust
/// Block until `request_id` is cancelled.
///
/// Register before checking the request-specific flag. `Notify::notified()`
/// alone is not registered until polled; `enable()` closes the lost-wakeup
/// window when the cancel arrives between the check and `.await`.
async fn wait_for_request_canceled(request_id: &str) {
    loop {
        let notified = CANCELED_NOTIFY.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if is_request_canceled(request_id).await {
            return;
        }
        notified.await;
    }
}
```

### 步骤 6.3 · 在 `mark_request_canceled` 里唤醒（`:672`）

原文：
```rust
async fn mark_request_canceled(request_id: String) {
    CANCELED_REQUESTS.lock().await.insert(request_id.clone());
    tokio::spawn(async move {
        tokio::time::sleep(CANCELED_REQUEST_TTL).await;
        CANCELED_REQUESTS.lock().await.remove(&request_id);
    });
}
```
替换为：
```rust
async fn mark_request_canceled(request_id: String) {
    CANCELED_REQUESTS.lock().await.insert(request_id.clone());
    // Wake every waiter immediately instead of letting them poll on a 40 ms tick.
    CANCELED_NOTIFY.notify_waiters();
    tokio::spawn(async move {
        tokio::time::sleep(CANCELED_REQUEST_TTL).await;
        CANCELED_REQUESTS.lock().await.remove(&request_id);
    });
}
```

### 步骤 6.4 · 清理语义

正常 HTTP/LLM 分支完成时，`tokio::select!` 会丢弃取消等待 future；它不需要因 request id 被清理而唤醒。
因此**不要**为了清理 HashSet 而广播 Notify，也不要新增 `clear_request_canceled`。保留现有每个请求完成后的 remove 和 TTL 回收；Notify 只用于 `mark_request_canceled`。

`Notify` 是全局广播，其他 request 的 waiter 也会被唤醒并重新检查自己的 ID，这是预期行为；确认此影响在当前并发规模可接受。如之后出现唤醒风暴或需严格按请求隔离，再单独评估 `CancellationToken` / per-request channel 及 `tokio-util` 依赖。

### 步骤 6.5 · 必须新增的测试

在 `mod tests`（`:2057`）中**新增**（不要改现有测试）：

```rust
    #[tokio::test]
    async fn cancellation_before_wait_is_observed_immediately() {
        let request_id = "llm-notify-cancel-before-wait".to_string();
        CANCELED_REQUESTS.lock().await.insert(request_id.clone());
        tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_request_canceled(&request_id),
        )
        .await
        .expect("a pre-existing cancel flag must return without waiting for a notify");
        CANCELED_REQUESTS.lock().await.remove(&request_id);
    }

    #[tokio::test]
    async fn cancellation_state_is_scoped_to_request_id() {
        let request_id = "llm-notify-waiter".to_string();
        let other_id = "llm-notify-other".to_string();
        CANCELED_REQUESTS.lock().await.remove(&request_id);
        CANCELED_REQUESTS.lock().await.insert(other_id.clone());
        assert!(!is_request_canceled(&request_id).await);
        assert!(is_request_canceled(&other_id).await);
        CANCELED_REQUESTS.lock().await.remove(&other_id);
    }
```

测试应作为普通 `#[tokio::test]`，不要标记 `#[ignore]`；它们必须由默认 `cargo test` 执行。

### 步骤 6.6 · 验证

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:native
npm run test:e2e
grep -n "sleep(Duration::from_millis(40))" src-tauri/src/tauri_commands.rs  # 预期：无匹配
```

---

## 任务 7 · 启用后端约束守卫（**先建立门禁，再逐批降低基线**）

> `scripts/check-backend-constraints.mjs` 已存在，但当前没有基线文件，也没有接入 package scripts。
> 因此历史“注入违规测试通过”的记录不可替代本地复验。先校准误报并补检测用例，
> 再用修正后的实测状态建立初始基线并启用守卫；随后每完成一批修复就降低相应基线。

### 步骤 7.1 · 校准守卫脚本并补回归用例

先读 `scripts/check-backend-constraints.mjs`，确认规则及扫描范围与当前源码一致。当前
`timeout-literal` 将 `.timeout(Duration::from_millis(timeout_ms))` 误报；先收紧检测为数值时长字面量，
并用小型回归用例证明 `from_secs(30)` 会命中、`from_millis(timeout_ms)` 不命中。还要覆盖
扫描范围/生产代码过滤，避免仅靠手动查看输出推断规则正确。

8 条规则一览：

| # | 规则 | 检测方式 | 拦什么 |
|---|---|---|---|
| 1 | `timeout-literal` | 仅匹配常量区外的**数值时长字面量**；表达式/变量如 `from_millis(timeout_ms)` 不算 literal | 任务 2 的机器化验收 |
| 2 | `polling-loop` | `loop {` 往后 8 行窗口内含 `::sleep(` 或 `.sleep(` | 任务 6 的机器化验收 |
| 3 | `extension-family` | `fn ensure_*extension(` **或** `fn ensure_allowed_*_path(` | 任务 1 的机器化验收 |
| 4 | `oversized-file` | 单文件 > 1200 行 | 任务 8 的进度追踪 |
| 5 | `chunk-loop` | 单文件 `.chunk()` > 2 处 | 任务 3 的机器化验收 |
| 6 | `handwritten-header-parse` | `split_once('=')` 或 `split(';')` | 遗留项，基线冻结为 2 |
| 7 | `production-unwrap` | `.unwrap()`/`.expect()`，排除测试代码与启动 expect | 保持当前 0 的好成绩 |
| 8 | `ipc-drift` | `#[tauri::command]` ↔ `generate_handler!` 双向一致 + 无重名 | **最有价值**，编译期发现不了 |

**实现上已踩过并修掉的 4 个坑（改脚本时别再犯）：**

1. **Rust 的 sleep 是 `::sleep` 不是 `.sleep`**。最初写 `/\.sleep\(/` 导致规则**永远不触发**、
   静默失效（看起来一切正常，实际是死规则）。正确写法：`/(?:::|\.)sleep\s*\(/`。
2. **必须排除 `src-tauri/tests/` 目录**。Cargo 集成测试**没有** `#[cfg(test)]` 标记，
   整个文件都是测试代码，`unwrap()` 是惯用写法。该文件现有 14 处 unwrap，不排除会全部误报。
3. **必须豁免 `main.rs` 的 `.expect("error while running tauri application")`**。
   `Builder::run` 失败没有优雅处理方式，是 Tauri 应用唯一合理的 abort 点。
4. **`chunk-loop` 按文件计数**（不是按出现次数），否则同一文件内 3 处只记成 1 条。

### 步骤 7.2 · 修正检测后冻结实测初始基线

```bash
cd /Users/yinyin/test/pdf-reader-tauri
node scripts/check-backend-constraints.mjs --report
```

**当前原始报告输出（2026-10-04；含一项误报，不可直接冻结）**：

| 规则 | 改造前 | 改造后目标 | 说明 |
|---|---|---|---|
| `timeout-literal` | **9 原始 / 8 修正后** | **0** | `timeout_ms` 是运行时值，不是字面量；其余时长抽成常量 |
| `polling-loop` | **1** | **0** | 任务 6 完成后归零 |
| `extension-family` | **5** | 5（保持） | 薄封装是正确终态，**不追求降到 0** |
| `oversized-file` | **1** | 1 → 0 | 2494 行；做任务 8 才降 |
| `chunk-loop` | **1** | **0** | 任务 3 完成后（3 处 → helper 1 + 落盘 1） |
| `handwritten-header-parse` | **2** | 2（保持） | `download_file_name` 遗留项，**本轮明确不改** |
| `production-unwrap` | **0** | **0** | 保持 ✅ |
| `ipc-drift` | **0** | **0** | 保持 ✅ |
| **TOTAL** | **19 原始 / 18 修正后** | **8（任务 1–7 完成、任务 8 未做）** | |

**原始 `timeout-literal` 报告是 9 处**（审计报告里写"4 处"是当时只 grep 了 `Duration::from_secs`，
漏了 `from_millis` 和 `.timeout(...)` 形式；其中 1 处是下方说明的运行时变量误报）。逐条清单：

| 行号 | 内容 | 归属任务 | 处置 |
|---|---|---|---|
| `:259` | `Duration::from_secs(24 * 60 * 60)` | 2.4 | 提为 `STALE_TEMP_FILE_AGE` |
| `:685` | `sleep(Duration::from_millis(40))` | 6 | **轮询，随任务 6 一起消失** |
| `:699` | `Duration::from_secs(5)` | 2.4 | → `PYTHON_PERMIT_ACQUIRE_TIMEOUT` |
| `:903` | `timeout(Duration::from_secs(30), ...)` | 2.1 | → `PDF_OPERATION_TIMEOUT` |
| `:986` | `timeout(Duration::from_secs(30), task)` | 2.2 | → `PDF_OPERATION_TIMEOUT` |
| `:1378` | `timeout(Duration::from_secs(30), task)` | 2.3 | → `PDF_OPERATION_TIMEOUT` |
| `:1414` | `.timeout(Duration::from_secs(30))` | 4.2 | → `build_http_client(PDF_OPERATION_TIMEOUT, ...)` |
| `:1529` | `.timeout(Duration::from_secs(60))` | 4.3 | → `PDF_DOWNLOAD_TIMEOUT` |
| `:1731` | `.timeout(Duration::from_millis(timeout_ms))` | 4.4 | **保留，见下** |

> ⚠️ **`:1731` 不算违规，不要改**：`timeout_ms` 来自 `LlmChatCompletionRequest.timeout_ms`，
> 是**用户可配置的运行时值**，且已 `.clamp(1_000, 120_000)` 做过上界约束。
> 改成常量会破坏「LLM 超时可配置」这个产品功能。守卫应忽略它；任务 2/4 全做完且
> `:259` 提取为常量后，`timeout-literal` 应为 **0**。

**关于 `extension-family` 保持 5**：任务 1 把 5 个函数改成薄封装（都调用同一个
`ensure_extension_allowed` helper），**这是正确终态不是违规**。若追求降到 1，
需让调用方直接 `ensure_extension_allowed(path, CONST)`，但会降低可读性，**不推荐**。

**关于 `handwritten-header-parse` 保持 2**：`:1479` 与 `:1481` 是 `download_file_name`
里手写的 Content-Disposition 解析（同一逻辑的两行）。审计建议改用 header 解析库，
但**本轮明确不做**（见「遗留观察」）。

先完成规则修正与检测用例，再运行 `--report` 并按修正后的实测结果创建初始基线，这样门禁可以
在改造过程中阻止新增违规；初始基线记录的是已知技术债，不代表认可它。每批修复通过测试后立即运行 `--update-baseline`，
并确认对应计数下降。不要将“改造后目标”预先写入初始基线。

### 步骤 7.3 · 逐批降低基线（**不要固化新增违规**）

```bash
# 初始基线已建、守卫已接入后：每批修复与测试通过，再冻结下降后的计数
node scripts/check-backend-constraints.mjs --report        # 核对已降到预期
node scripts/check-backend-constraints.mjs --update-baseline
cat scripts/backend-constraints-baseline.json
```

首次按当前实测冻结是为既有违规建立基线，不是允许新增；后续每批修复都必须把基线调低。
严禁在修复前把目标数字写入基线，因为那会让检查结果与实际源码脱节。

任务 1–7 完成、任务 8 尚未实施时的目标基线：

```json
{
  "polling-loop": 0,
  "extension-family": 5,
  "oversized-file": 1,
  "chunk-loop": 0,
  "handwritten-header-parse": 2,
  "timeout-literal": 0,
  "production-unwrap": 0,
  "ipc-drift": 0
}
```

以上总数应为 **8**；`oversized-file: 1` 只有任务 8 完成后才可降到 0，届时总数为 **7**。
`timeout-literal: 0`，因为 LLM 动态超时不属于数值字面量违规。建议在该 json 旁加一行注释说明
（json 不支持注释，故在执行汇报里注明）。

### 步骤 7.4 · **实测守卫真的会拦**

规则、基线或扫描范围有改动时都必须重新实测：注入违规 → `exit=1` → 删除 → 恢复。

```bash
# 1) 注入临时违规文件
cat > src-tauri/src/__guard_probe.rs <<'PROBE'
pub fn probe_timeout() {
    let _ = std::time::Duration::from_secs(99);
}
pub fn probe_poll() {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(40));
        if check() { return; }
    }
}
pub fn probe_unwrap() -> u32 { "x".parse().unwrap() }
PROBE

# 2) 确认三条规则都命中、退出码为 1
node scripts/check-backend-constraints.mjs; echo "exit=$?"
# 修正规则并以 18 项报告冻结初始基线后，参考输出：
#   timeout-literal  10  (基线 8 + 注入的 2 个数字字面量)
#   polling-loop      2  (基线 1 + 注入的 1 个轮询)
#   production-unwrap 1  (0 → 1， +1)

# 3) 删除并回读确认
rm -f src-tauri/src/__guard_probe.rs
ls src-tauri/src/__guard_probe.rs 2>&1          # 必须输出 No such file
node scripts/check-backend-constraints.mjs; echo "exit=$?"   # 期望 exit=0
```

> ⚠️ **zsh 的 `nomatch` 坑**：`rm -f a __probe*.mjs` 在无匹配时会在 `rm` 之前整条中止，
> 只打印一行 `no matches found`，看起来像已经执行过了。**删除后必须用 `ls` 回读确认。**


### 步骤 7.5 · 接入 `package.json`

在 `scripts` 字段中，**紧邻**已有的 `check:design-tokens` 之后插入一行：

```json
"check:backend": "node scripts/check-backend-constraints.mjs",
```

然后把 `check:contracts` 那一行改为（**只加这一项**）：

```json
"check:contracts": "npm run check:native-lifecycle && npm run check:webview-pdf-open && npm run check:pdf-virtualization && npm run check:image-index && npm run check:resource-cache && npm run check:markdown && npm run check:reading-assist && npm run check:document-reference && npm run check:whiteboard && npm run check:tab-lifecycle && npm run check:core-navigation && npm run check:dialog-errors && npm run check:translation-race && npm run check:pdf-open-cancellation && npm run check:design-tokens && npm run check:backend",
```

> ✅ `check:contracts` 已被 `verify` 引用，所以这一改就接进了主流程。
> **不要动 `verify` 本身。**

验证：
```bash
npm run check:backend
npm run verify 2>&1 | tail -30
```

### 步骤 7.6 · 把能力索引挂到 agent 可见位置

`docs/backend-constraints.md` 已经在仓库里，但 agent 不一定会主动读。
根目录当前没有 `AGENTS.md`。新增一段简短的后端入口和链接即可，不要复制整份能力索引，
也不要覆盖后来出现的项目指令（若文件已存在则只追加不冲突的小节）：

```markdown
## 后端约束（改 src-tauri/ 前必读）

完整版见 `docs/backend-constraints.md`。

- `src-tauri/src/tauri_commands.rs` = **仅 IPC 层**，禁止写业务逻辑
- `src-tauri/pdf-core/` = 纯逻辑，禁止依赖平台代码
- 依赖方向单向：`commands → manager / py_render → pdf-core`
- **新增功能前先 grep** `docs/backend-constraints.md` 的「强制复用」表，大概率已有人写过
- 固定超时用集中定义的常量；可配置运行时超时保留变量值
- 取消用 `wait_for_request_canceled`，禁止写 `loop + sleep` 轮询
- 扩展名白名单只改 `tauri_commands.rs` 顶部的 `*_EXTENSIONS` 常量数组
- 提交前跑：`npm run check:backend && cargo test --manifest-path src-tauri/Cargo.toml`；ignored native 测试另跑 `npm run test:native`
```

> ⚠️ 执行前先检查：`ls -la AGENTS.md`。若存在且内容是别的项目规范，**追加到末尾**，
> 不要覆盖用户已有内容。

---

## 任务 8 ·（可选）拆分 `tauri_commands.rs`

**只在任务 1–7 全部完成且测试通过后做。** 这一项纯属结构改善，**不做也不影响正确性**。

目标结构：
```
src-tauri/src/
  lib.rs              # mod 声明 + re-export（保持 pub mod tauri_commands;）
  main.rs             # 不变
  ipc/
    mod.rs
    pdf.rs            # 文档类 command
    transfer.rs       # 下载/上传类
    webview.rs        # webview tab 类（:1834-2055 天然可切）
    llm.rs            # 模型调用类
  http.rs             # build_http_client + read_capped_body（任务 3/4 产出）
  state.rs            # 7 个全局静态态
  pdf_manager.rs      # 不变
  py_render.rs        # 不变
```

**硬约束**：
1. `lib.rs` 保留 `pub mod tauri_commands;`，且 `tauri_commands` 模块必须
   **re-export 所有 command**（`pub use ipc::pdf::*;` 等），
   否则 `main.rs` 里的 `r0nix::tauri_commands::open_pdf` 路径会断。
2. **函数签名、命令名、参数名一律不变**——`generate_handler!` 列表和前端调用完全不受影响。
3. 当前 `ipc-drift` 守卫只从 `tauri_commands.rs` 提取 `#[tauri::command]` 声明，
   不会递归发现 `ipc/*.rs`。**拆分前必须先扩展守卫并用多模块注入用例验证**；
   否则搬迁后守卫会把合法命令误报为漂移，或漏掉模块中的未注册命令。
4. 拆分后 `cargo build` 必须通过，且 `npm run check:backend` 的 `ipc-drift` 必须仍为 0。
5. 用 `git mv` 保留历史，不要复制粘贴。

验证：
```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:native
npm run check:backend && npm run build
```

---

## 完整验证清单（全部任务完成后逐条跑）

```bash
# 1. Rust 编译无 error
cargo build --manifest-path src-tauri/Cargo.toml

# 2. 默认 Rust 单元/集成测试（含新增取消测试）
cargo test --manifest-path src-tauri/Cargo.toml

# 3. 额外运行当前标记为 ignored 的 native 测试；不是默认测试的替代品
npm run test:native

# 4. 后端守卫无新增违规
npm run check:backend; echo "guard exit=$?"

# 5. 前端契约守卫不受影响
npm run check:contracts

# 6. 前端构建通过
npm run build

# 7. 端到端冒烟
npm run test:e2e

# 8. 全量（最严格）
npm run verify
```

**任何一条失败都不要继续下一批任务。**

---

## 遗留观察（本轮明确不做，记录备查）

| 项 | 位置 | 说明 |
|---|---|---|
| 手写 Content-Disposition 解析 | `:1476` `download_file_name` | 手写 `split(';')` + `split_once('=')`。正确做法是用 `content_disposition` crate 或 `reqwest` 的 header 解析。**本轮基线冻结为 1，不修。** |
| HTTP 重试 | `build_http_client` | 审计建议过，但重试改变幂等性语义，需单独评估（可重试错误范围、退避策略、服务端压力）。 |
| `eprintln!` 20 处 | 全文件 | 前端已有结构化 `frontend_log` 通道（`:379`，接收 level/scope/message/payload），后端自身日志却全裸 `eprintln!`，且 `level` 参数从未被使用。 |
| `is_pdf_url` 误判 | `:317` | 60 行启发式匹配，正例测试 8 个、反例仅 3 个。`https://example.com/pdf-guide/intro` 会被误判为 PDF（代价：多一次拦截，可接受）。建议补反例测试。 |
| 7 个全局静态态 | `:27-43` | `CANCELED_REQUESTS` 等散落模块顶层。任务 6 完成后收敛到 `state.rs`。 |
| `pdf_manager.rs` 疑似死代码 | 全文 | 仅 `list_documents` / `set_page_count` 被调用，`open_document` / `close_document` / `get_document_info` 需确认是否可达。**改造前先用 `cargo` 确认，不要凭猜测删除。** |

---

## 给执行 agent 的三条纪律

1. **逐条断言原文再替换。** 前面任务的编辑会让后面任务的行号漂移——
   **行号只是提示，`old_string` 完整匹配才是护栏**。匹配不上就停下报告，不要强行替换。

2. **改完必须回读验证。** 不要因为「代码看起来对了」就交付。
   尤其是错误文案改动（任务 1.2⑤、3.3、4.2）——必须 grep 前端确认没有依赖旧文案。

3. **发现问题不要顺手改。** 记进「遗留观察」表，在最终汇报里列出。
   本单的改动面已经很大，混入无关重构会让 review 无法进行。
