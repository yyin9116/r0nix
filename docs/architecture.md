# 架构与审阅状态

## 分层

```text
React UI
  -> application state in App / PDFViewer / settings hooks
  -> typed service adapters (pdfApi, rustPdf, readingAssistant, webProxy)
  -> Tauri IPC commands or browser HTTP fallback
  -> PDF.js / PyMuPDF / reqwest / native WebView
```

## 服务边界

| 边界 | 所有者 | 约束 |
| --- | --- | --- |
| PDF.js 文档缓存 | `pdfJsService.ts` | 打开时缓存，关闭时销毁 |
| 本地 PDF 生命周期 | `pdf_manager.rs` + `tauri_commands.rs` | UI 只传 file id，不直接管理 Rust 状态 |
| PDF 结构提取 | `py_render.rs` | 输出归一化块和图像 bbox，过滤整页伪图像 |
| 模型服务 | `readingAssistant.ts` + `llm_chat_completion` | HTTP(S)、消息长度、模型输出和超时受控 |
| 网页/文件下载 | `urlPolicy.ts` + `webProxy.ts` | 只允许 HTTP(S)，下载大小和超时受控 |
| 用户持久化 | `localStore.ts` + `userSettings.ts` | 版本化、损坏隔离、显式警告 |
| 阅读笔记 | `App.tsx` + `PDFViewer.tsx` + `MarkdownViewer.tsx` | 以文档路径为键，引用位置可选，支持编辑和删除 |
| 对照翻译 | `readingAssistant.ts` + PDF/Markdown viewer | UI 只负责块编排和展示，模型请求统一走 LiteLLM/OpenAI-compatible 适配器 |
| 翻译缓存 | `translationCache.ts` | 以文档、模型和目标语言为键，按源块指纹校验，最多保留 24 条缓存 |
| 研究画布 | `Whiteboards.tsx` | 卡片、分组、连线整体版本化持久化，载入时过滤孤儿引用 |

## 已审阅并完成

- 缩放视觉层与 PDF 重绘解耦，避免逐帧重排。
- 嵌入 Python runtime 禁止写入 `__pycache__`，避免 PyMuPDF 首次调用改变 Tauri watcher 目录并触发重复原生重编译。
- 右键手势不再释放时强制居中；激活页范围受控。
- 离屏 PDF 页启用 `content-visibility`，减少大文档绘制开销。
- 阅读块加载完成会刷新图像候选。
- 矢量图合并范围收紧，避免把整页路径当作图片。
- 普通文本选择移除自绘选择层，避免全屏闪烁。
- E2E smoke 文案断言已与设置页同步。
- 代理下载增加 HTTP(S) 校验、30 秒超时和 64 MiB 上限。
- 目录扫描避免软链接循环；关闭 PDF 使用 `finally` 释放原生句柄。
- 浏览器模式增加 PDF.js 文本块兜底，Full translation 不再固定返回空块。
- 删除未被阅读器消费的默认导出格式死配置，避免显示未实现的 JPG 能力。
- 模型连接测试的超时通过 IPC 传入 Rust，避免测试失败后原生请求继续占用 60 秒。
- 引用动作现在会生成持久化笔记，PDF 与 Markdown 均支持编辑、删除和跨标签页恢复。
- Markdown 增加用户主动触发的分块对照翻译；PDF 全文翻译结果改为原文/译文双栏块展示。
- 画布增加键盘删除和 Escape 取消连线，并在载入时清理缺失分组和孤儿连线。
- 翻译结果加入版本化本地缓存；失败块不会阻塞其它块，PDF/Markdown 均可单块重试。
- Tauri 全文块提取按 24 页分段执行，每段独立受 30 秒超时保护，并向 UI 汇报页级进度。
- 发布检查增加前端构建命令、嵌入 Python runtime、托盘退出入口和 Release workflow 门禁。
- 发布检查增加跨平台 Python runtime hygiene 门禁，禁止 `__pycache__`/`.pyc` 进入嵌入目录；CI 和 Release workflow 均执行该检查。
- PDF 原始图片导出已接入 Tauri/PyMuPDF，按真实资源扩展名写入；普通视图图片命中层不再阻断 PDF.js 文本选择。
- 原始 xref 图片导出跳过整页 PNG 光栅；图片标注/导出菜单只按当前页或相邻页提取阅读块，避免长文档隐式全文扫描。
- PDF 非活动页保留轻量尺寸占位，只有可见页和 overscan 页挂载 canvas、text layer、标注及图片交互子树。
- 阅读块、笔记和标注开始携带稳定 `documentId`、`blockId` 和来源矩形；Markdown 对照翻译保留标题、列表、表格和代码节点类型。
- 资源索引按文档缓存图片/链接元数据，支持增量跳过、取消和失败重试。
- 资源索引扫描通过独立缓存适配器管理版本、字段校验和容量上限；扫描任务使用稳定引用避免每页状态更新导致任务重启。
- PDF 笔记和标注点击回跳使用 `page + sourceRect`，不再只定位到页码。
- PDF 长文档块提取按 24 页分段，调用方取消时不再启动后续分段；1000 页 fixture 已通过分段完整性测试。
- PDF 全文搜索按页检查取消状态，切换文档或卸载阅读器时会中止旧搜索；缓存文档缺失会显式报错，不再静默返回空阅读块。
- SVG 局部导出不依赖当前 PyMuPDF 不支持的 `clip` 参数，改用 SVG viewport 裁剪，并通过嵌入 Python fixture 验证。
- xref 图片识别保留宽幅/条带型 raster 资源；PDF.js hover 几何按行和连续文字片段拆分，相关双栏与断行规则由纯服务 fixture 覆盖。
- 矢量资源识别只合并几乎重合的重复路径，不再按邻近距离把相邻图表、边框或文字路径拼成大块；复杂矢量页仍以多个局部候选交给资源面板筛选。
- Markdown block parser 使用内容稳定 ID，节点结构包含 `kind/depth/tableAlign/sourcePath`，预览、翻译和阅读辅助共享同一节点序列。

## 待审阅

P 级痛点、验收标准和推荐执行顺序统一记录在 [产品痛点与开发优先级](./product-priorities.md)。后续实现以该文档为主，避免在 PDF、Markdown、资源索引和模型能力之间无序扩张。

- 浏览器端图像识别和图像导出仍依赖后端 HTTP API，桌面端 Rust/PyMuPDF 链路已有集成测试。
- 1000 页后端分段提取已通过 fixture；GitHub Actions run `32553879761` 已通过 Windows 安装 smoke，并完成 macOS bundle/DMG 构建和 artifact 上传；桌面端真实打开、滚动、缩放的 GUI 性能仍需在打包应用中测量。
- Tauri 开发构建已在当前 macOS 环境重新编译并启动（`cargo run --manifest-path src-tauri/Cargo.toml --no-default-features`），日志确认原生 runtime、Rust `open_pdf` 和 39 页 PDF.js 加载成功；文本选择、段落 hover、缩放帧率仍未完成桌面人工点击和截图回归。
- Markdown 使用 `marked` GFM lexer，再由 `markdownBlocks.ts` 归一化为共享节点；HTML 以不可执行文本保留，脚注定义会恢复为 `auxiliary` 阅读块，普通引用链接定义保持原生引用语义。
- 当前没有独立 unit-test runner 和 lint 脚本；Rust 单测中依赖嵌入 Python 的测试仍被显式忽略。
- 桌面端打包需要在实际 macOS/Windows 环境分别验证原生 WebView、托盘和安装器行为。
- 当前尚未在 CI 中启动打包后的 macOS/Windows 应用做 GUI 集成测试；需要对应 runner 和签名/系统 WebView 环境。
- Tauri 开发运行链路已在当前 macOS 环境验证：原生 runtime、Rust `open_pdf`、PDF.js 文档加载和页面缩略图渲染成功；仍缺少打包产物安装后的同等 GUI 证据。
- macOS release `.app` 已在当前机器实际启动验证；内嵌 Python/PyMuPDF 动态库使用 bundle 相对 rpath，release workflow 会在 bundle 后重新签名，签名版再执行公证和 stapling。Windows release workflow 已加入 NSIS 安装、runtime 文件和启动 smoke；安装后的 GUI smoke 和打包应用端到端行为仍需 release runner 结果作为发布证据。
- 本地 release `.app` 经 rpath 修补和 ad-hoc 重签名后通过 `codesign --verify --deep --strict`，生成的 DMG 通过 `hdiutil verify`；Release workflow 已加入同等 macOS bundle smoke，但锁屏环境仍未完成安装后 GUI 点击验证。
- 首屏按 tab 懒加载 PDF、Markdown、网页、设置和画布；PDF.js 文档模块也延迟到首次打开 PDF 时加载，生产首屏主 chunk 已从约 1.1 MB 降至约 380 KB，PDF.js 独立 chunk 约 445 KB。
- `check:pdf-virtualization` 会锁定页面占位、active page gating、有限 overlay 和 `content-visibility` 约束，避免性能优化在后续迭代中回退。
