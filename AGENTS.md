# 后端约束（改 `src-tauri/` 前必读）

完整版见 [`docs/backend-constraints.md`](docs/backend-constraints.md)。

- `src-tauri/src/tauri_commands.rs` 只负责 IPC 参数校验、跨层编排和事件发射，不放 PDF 解析或编码实现。
- `src-tauri/pdf-core/` 保持纯逻辑，不依赖平台代码；依赖方向为 `commands → manager / py_render → pdf-core`。
- 新增功能前先查 `docs/backend-constraints.md` 的“强制复用”表。
- 固定超时使用集中定义的常量；可配置运行时超时保留变量值。
- 取消等待使用 `wait_for_request_canceled`，不要新增 `loop + sleep` 轮询。
- 文件扩展名白名单只维护 `tauri_commands.rs` 中的 `*_EXTENSIONS` 常量数组。
- 提交前运行 `npm run check:backend` 和 `cargo test --manifest-path src-tauri/Cargo.toml`；ignored native 测试另行运行 `npm run test:native`。
