# 后端能力索引

> **这份文档是给 AI 和新成员看的执行清单，不是设计说明。**
> 超过一屏就没人读，所以只写「做什么用在哪」，不写「为什么」。
> 新增功能前先 grep 本文列出的符号 —— **大概率已经有人写过了**。

## 分层

| 路径 | 职责 | 禁止 |
|---|---|---|
| `src-tauri/src/main.rs` | 托盘、窗口、IPC 注册 | 禁止任何业务逻辑 |
| `src-tauri/src/tauri_commands.rs` | **仅 IPC 层**：参数校验、跨层编排、事件发射 | 禁止写 PDF 解析、编码、渲染逻辑 |
| `src-tauri/src/py_render.rs` | **Python 调用唯一出口** | 禁止在其它文件直接碰 `PyO3` |
| `src-tauri/src/pdf_manager.rs` | 文档生命周期管理 | 禁止持有业务状态 |
| `src-tauri/pdf-core/` | 纯逻辑 crate，可独立测试 | **禁止依赖任何平台代码** |

依赖方向单向：`commands → manager / py_render → pdf-core`。反向 import 即为违规。

## 强制复用

新增功能前先 grep 下表。命中即用，不要重新实现。

| 需求 | 用这个 | 禁止 |
|---|---|---|
| 取消 / 中断长任务 | `mark_request_canceled` / `run_pdf_export_blocking`（`tauri_commands.rs:672,712`） | 新写 `loop + sleep` 轮询 |
| 超时 | `PDF_OPERATION_TIMEOUT`（`:53`）等已有常量 | 新写字面量 `Duration::from_secs(30)` |
| base64 编解码 | `decode_base64_bytes`（`:302`）、`BASE64` engine | 手写查表 / `atob` 式实现 |
| URL 校验 | `normalize_download_url`（`:308`）、`parse_webview_url`（`:186`） | 新的 `starts_with("http")` 判断 |
| URL 拼接 | `Url::parse` 后用 `path_segments_mut()` | `format!("{base}/xxx")` |
| 文件名清洗 | `sanitize_file_name`（`:291`） | 新的手写 `replace(['/',..])` |
| HTTP 客户端 | `download_pdf_via_proxy` 的 builder 配置（`:1412`） | 新建无超时/无重定向限制的 `reqwest::Client` |
| 临时文件 | `app.path().temp_dir()` + `MANAGED_*_PREFIX` 常量 | 往系统目录随手写文件 |
| JSON | `serde_json::json!` 或 typed struct | `format!` 拼 JSON |
| 图片编码 | `encode_tile_png_base64`（`:583`）、`imageops` | 手写 PNG 编码 |
| 瓦片规划 | `pdf_core::plan_visible_tiles` | 自己算瓦片坐标 |
| 并发限流 | `acquire_python_task_permit`（`:697`） | 自己 new Semaphore |

## 扩展名白名单（唯一事实来源）

三处校验必须语义一致，**新增扩展名时三处同步改**：

- `ensure_pdf_extension`（`:224`）—— 仅 pdf
- `ensure_markdown_extension`（`:281`）—— md / markdown
- `ensure_importable_extension`（`:214`）—— pdf / md / markdown
- `ensure_allowed_text_write_path`（`:397`）—— md / markdown / csv / json / svg / txt
- `ensure_allowed_binary_write_path`（`:416`）—— pdf / png / jpg / jpeg / gif / webp / bmp / tif / tiff / jp2 / jpx / jbig2 / ccitt

⚠️ 这五处目前是**复制而非复用**，加白名单时极易漏改一处造成绕过 —— 见审计报告 P0-1。

## 常量（全部集中在 `tauri_commands.rs:44-56`）

```
DEFAULT_NATIVE_WEBVIEW_UA / MAX_PROXY_DOWNLOAD_BYTES / MAX_LLM_RESPONSE_BYTES
MAX_PDF_BYTES / MAX_RENDER_ZOOM / MANAGED_WEB_PDF_PREFIX / MANAGED_IMPORT_PREFIX
PDF_OPERATION_TIMEOUT / CANCELED_REQUEST_TTL / MAX_IMPORT_SCAN_DIRS / IMPORT_SCAN_TIMEOUT
```

上限常量**不是可选的**：任何读外部输入（网络响应、文件、文件夹扫描）都必须先卡上限。

## 提交前自检

- [ ] 新代码没有 `unwrap()` / `expect()`（测试区块除外）
- [ ] 新代码没有字面量 `Duration::from_secs(` / `from_millis(`
- [ ] 新增文件写入走了 `app.path().temp_dir()` 且带受管前缀
- [ ] 新增外部输入读取有大小/数量上限
- [ ] 取消语义有对应测试（`tokio::test`）
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 通过
- [ ] `npm run check:contracts` 通过
