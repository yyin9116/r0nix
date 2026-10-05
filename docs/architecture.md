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
| 阅读笔记 | `App.tsx` + `PDFViewer.tsx` + `MarkdownViewer.tsx` | 以 `ReaderDocument.id` 为键，旧版本路径键首次载入时迁移；引用位置可选，支持编辑和删除 |
| 对照翻译 | `readingAssistant.ts` + PDF/Markdown viewer | UI 只负责块编排和展示，模型请求统一走 LiteLLM/OpenAI-compatible 适配器 |
| 翻译缓存 | `translationCache.ts` | 以文档、模型和目标语言为键，按源块指纹校验，最多保留 24 条缓存 |
| 研究画布 | `Whiteboards.tsx` | 卡片、分组、连线整体版本化持久化，载入时过滤孤儿引用 |
| 原生网页历史 | `WebBrowser.tsx` + `nativeWebview.ts` | 原生 WebView 页面内导航追加本地历史；应用主动导航使用不重复记录的同步标记 |

## 已审阅并完成

- 缩放视觉层与 PDF 重绘解耦，避免逐帧重排。
- 右键滚轮缩放锁定当前页时保留邻页布局占位但隐藏邻页绘制，避免变换中的当前页露出或覆盖其它页造成闪烁和跳页。
- 嵌入 Python runtime 禁止写入 `__pycache__`，避免 PyMuPDF 首次调用改变 Tauri watcher 目录并触发重复原生重编译。
- 右键手势不再释放时强制居中；激活页范围受控。
- 侧栏和阅读模式切换使用当前页的视口锚点补偿布局变化，不再强制把页面滚动到中心，避免破坏持久化的阅读位置。
- 离屏 PDF 页启用 `content-visibility`，减少大文档绘制开销。
- 阅读块加载完成会刷新图像候选。
- 矢量图合并范围收紧，避免把整页路径当作图片。
- 同一 xref 的多个图片放置只合并近似重合 bbox，邻近但独立的图片保持独立导出目标。
- PNG、SVG、SVG crop、原始图片和图片列表命令统一经过 30 秒原生任务超时包装，超时会向 UI 返回明确错误。
- 图片列表扫描使用独立请求 ID 和原子取消探针；资源侧栏关闭、切页或组件卸载时可通知 PyMuPDF 在图像/矢量遍历边界停止。
- 同一 PDF 页的图片扫描共享进行中的 Promise，资源索引不会把尚未完成的扫描误记为完成；调用方取消会以失败/取消结束并允许后续重试。
- 图片扫描共享任务使用内部 `AbortController`，调用方只取消自身等待；仍有其他消费者时底层扫描继续，最后一个消费者取消才中止任务并从 in-flight 表移除，避免资源侧栏关闭误伤当前页预取。
- 图片 bbox 统一扣除 PDF 页面 cropbox 的 `x0/y0` 并裁剪到页面尺寸，避免非零页面原点导致图片标注、右键命中和导出裁剪整体偏移。
- PDF 文件释放使用待释放队列和当前 tab 引用检查；关闭、替换或删除与快速重新打开同一文件时，不会在 React 提交前误关仍被使用的 PDF.js/Rust 句柄。
- 待打开文档也属于可取消的 tab 生命周期：关闭无 `fileId` 的加载中 tab 会标记路径，异步打开完成后若发现取消则释放新句柄并丢弃结果。
- Full translation hover 以 PDF.js text layer 的段落聚合为主，后端 bbox 只作 fallback；引用回跳矩形来自实际高亮 spans 的联合几何，而不是可能偏紧的后端块框。
- Full translation hover 命中时优先采用同一 PDF.js text layer 已构建的 DOM block spans；局部列/句子启发式只作为无法命中 DOM block 的 fallback，保证右侧长行和双栏段落完整。
- Full translation hover 在同一段落的相邻 text spans 之间移动时复用高亮节点，只更新命中语义，不重复创建整组 overlay。
- Full translation 的段落范围以 PDF.js DOM text layer 为唯一可见几何来源；PyMuPDF bbox 只负责 block 身份和文本兜底，避免紧框裁掉换行、连字或双栏段落。
- PageCanvas 在异步 text layer 完成后显式刷新 assist 绑定，首次 canvas 绘制与文字层挂载之间不会丢失 hover 交互。
- PageCanvas 每次文档或渲染倍率变化都会先取消并清空旧 text layer，旧 PDF 的 hover 不会在新页面绘制期间继续响应。
- Full translation 的 assist selection 统一驱动右侧 panel 状态：点击块时同时设置 `isNotesOpen` 和 `sidePanelView=translation`，避免选区事件已触发但翻译结果不可见。
- 右侧面板使用 `lg` 断点布局预留和 `padding-right` 过渡；桌面 PDF 不被覆盖，移动端面板隐藏时不保留无效的 20rem 空间。
- 单页阅读块提取按 `fileId + page` 共享 in-flight Promise，图片标注、导出菜单和资源入口不会重复触发同一页 native/PDF.js 提取；切换文档后旧响应不会写入新文档状态。
- 缩略图行使用 `memo` 和稳定的点击/ref/context-menu 回调，普通页码同步不会重新执行全部缩略图组件。
- 普通文本选择移除自绘选择层，避免全屏闪烁。
- selectable PDF.js text layer 明确保留 WebKit 的跨 span 原生选择能力，避免 macOS 桌面端退化为单字符选中。
- 页面壳层显式 `user-select: none`，只有 selectable PDF.js text layer 开启 `user-select: text`；选择绘制规则沿用 PDF.js 的 text-layer scoped `::selection`/`br::selection`，避免 WebKit 将透明绝对定位 span 的选择反馈扩展成整页闪烁。
- PDF viewer 的 scoped `::selection` 使用强制优先级覆盖应用根节点选择样式；普通页面选区背景不会泄漏到整页壳层。
- PDF viewer 额外覆盖应用根节点的全局选区背景，并将选区颜色重新限定到 `.textLayer`；macOS WebKit 的透明文字 span 拖选不会再把整页染成闪烁选区。
- 全文翻译 hover 段落按整层 text spans 推断列边界，不再用当前短行的右边界截断后续长行。
- hover 矩形的宽度按实际 host 右边界裁剪，长行贴近页面右侧时不会被错误截断。
- 右键滚轮缩放预览固定以页面左上角为 transform origin，锚点直接按视觉尺寸调整滚动位置，不再从变换后的 DOMRect 反推中心偏移。
- 右键滚轮缩放锁页由目标 `PageCanvas` 的实际绘制完成回调释放；渲染变慢时不会因固定释放定时器提前触发中心页重算，异常路径仍有有界 fallback。
- 已挂载页面的 `PageCanvas` 使用稳定回调和 `memo`，切页、侧栏或资源状态变化不会让未变化页面重复进入 React/PDF.js 渲染路径。
- E2E smoke 文案断言已与设置页同步。
- 代理下载增加 HTTP(S) 校验、30 秒超时和 64 MiB 上限。
- 原生 WebView 点击 PDF 通过事件触发一次性加载态，native 端将响应流直接写入临时 PDF 文件并验证 `%PDF-` 文件头，前端只接收路径，避免大文件经 IPC base64 造成内存峰值和空白页竞态。
- 目录扫描避免软链接循环；关闭 PDF 使用 `finally` 释放原生句柄。
- Tauri 打开 PDF 时若 PDF.js 加载失败，会释放已打开的 Rust handle 并返回显式错误，不再以只有页数、没有可渲染文档的假成功状态继续运行。
- 关闭 PDF/Markdown tab 会调用统一 `api.closeFile`，同时释放 PDF.js 文档缓存和 Rust/PyMuPDF 句柄，避免多次打开文档后句柄累积。
- macOS 打包必须先修补 app 内的 PyMuPDF 动态库路径，再由 `create-macos-dmg.sh` 从已修补 app 生成 DMG；不使用会重新清理 app 的 Tauri DMG bundle 作为最终分发物。
- PDF tab 关闭、文档替换和资料删除会先提交 React tab 卸载，再延迟释放 PDF.js/Rust 句柄，避免 canvas/text layer 清理与 native close 竞争。
- Tauri 打开 PDF 只登记文件元数据，不再首屏等待 PyMuPDF 页数扫描；原生分页任务首次需要时才解析页数并回写句柄，避免大 PDF 打开阶段重复解析和 8 秒超时假成功。
- 按需原生页数解析受 30 秒超时保护，超时以显式错误返回，不再让损坏或极端 PDF 无限占用调用方。
- PDF.js 打开前的原生字节读取使用 request ID、分块读取和原子取消探针；前端超时会通知 Rust 停止读取，超时任务不会继续把结果写回打开流程。
- 阅读块提取复用 request ID 取消页数解析；页数超时或调用方 Abort 后不会回写 PDF 句柄的页数缓存。
- PyMuPDF 页数、阅读块、图片扫描和导出共享有界并发闸门；超时后的 blocking 任务即使需要等待当前 Python 调用自然返回，也会持有 permit，避免大量取消任务耗尽线程池。
- 高频 PyMuPDF 页数、PNG 和 SVG 导出路径在每次 native 调用结束后显式关闭 `Document`；不依赖 Python 引用计数决定释放时机，连续打开多个 PDF 或重复导出时降低句柄和文件资源累积。
- Tauri 阅读块提取使用请求 ID 和原子取消探针；AbortSignal 可通过 IPC 通知原生任务，PyMuPDF 在页/block 边界停止遍历并释放任务记录。
- Full translation hover 优先使用 PDF.js text layer 的事件目标，只有文字间隙才进行几何回退命中，避免每帧遍历整页文本节点。
- 浏览器模式增加 PDF.js 文本块兜底，Full translation 不再固定返回空块。
- 删除未被阅读器消费的默认导出格式死配置，避免显示未实现的 JPG 能力。
- 模型连接测试的超时通过 IPC 传入 Rust，避免测试失败后原生请求继续占用 60 秒。
- Tauri LLM 请求携带唯一 request ID；Ask AI/翻译取消时调用原生取消命令，Rust 在 HTTP 发送和响应读取阶段均可抢占并清理取消状态。
- 引用动作现在会生成持久化笔记，PDF 与 Markdown 均支持编辑、删除和跨标签页恢复。
- Markdown 阅读辅助选区携带稳定 `blockId`；从编辑/对照视图打开笔记时会先切回预览并等待 block 挂载，再回跳原文。引用写入本地笔记与剪贴板复制解耦，剪贴板权限失败不会丢失引用。
- Markdown 增加用户主动触发的分块对照翻译；PDF 全文翻译结果改为原文/译文双栏块展示。
- 画布增加键盘删除和 Escape 取消连线，并在载入时清理缺失分组和孤儿连线。
- 翻译结果加入版本化本地缓存；失败块不会阻塞其它块，PDF/Markdown 均可单块重试。
- PDF/Markdown 的全文翻译、单块重试和选区翻译均绑定 AbortController 与当前请求身份；切换文档、编辑源文档或更换选区时，旧响应不会覆盖当前结果。
- Tauri 全文块提取按 24 页分段执行，每段独立受 30 秒超时保护，并向 UI 汇报页级进度。
- 发布检查增加前端构建命令、嵌入 Python runtime、托盘退出入口和 Release workflow 门禁。
- 发布检查增加跨平台 Python runtime hygiene 门禁，禁止 `__pycache__`/`.pyc` 进入嵌入目录；CI 和 Release workflow 均执行该检查。
- PDF 原始图片导出已接入 Tauri/PyMuPDF，按真实资源扩展名写入；普通视图图片命中层不再阻断 PDF.js 文本选择。
- PDF.js 全文块提取与资源索引逐页清理 `PDFPageProxy`，避免 1000 页扫描后页面对象持续累积；阅读器可见页渲染仍由页面组件生命周期控制。
- 全文搜索的单页 `PDFPageProxy` 同样在 `finally` 释放，避免搜索操作成为长文档资源泄漏的旁路。
- PDF.js 文档加载按 `fileId` 共享进行中的 loading Promise；重复打开不会创建并行 `PDFDocumentProxy`，关闭 tab 时先销毁 loading task，再等待共享 Promise 收尾并销毁对应文档。
- PDF.js loading task 受 30 秒超时保护；超时会调用 `loadingTask.destroy()` 并清理共享 Promise，坏文件不会永久占用打开流程。
- PDF 原始字节读取限制为 512 MiB，并在读取过程中检查文件增长；超大或变化中的文件返回明确错误，避免按文件大小进行无界内存分配。
- `open_pdf` 在 Tauri 命令边界拒绝空路径、非 PDF 扩展和空 `fileId`；native core 拒绝重复登记同一 `fileId`，不再静默覆盖仍可能被引用的文档。
- 原始 xref 图片导出跳过整页 PNG 光栅；图片标注/导出菜单只按当前页或相邻页提取阅读块，避免长文档隐式全文扫描。
- PDF 非活动页保留轻量尺寸占位，只有可见页和 overscan 页挂载 canvas、text layer、标注及图片交互子树。
- PDF 非活动页在 `PageCanvas` 的资源入口处提前退出，不调用 `PDFDocumentProxy.getPage()`；因此轻量占位不会隐式创建 PDF.js 页面代理。
- 缩略图使用 PDFViewer 级别的单一 `IntersectionObserver`，每页只注册可见回调，避免长文档为每个缩略图创建独立观察器。
- 阅读块、笔记和标注开始携带稳定 `documentId`、`blockId` 和来源矩形；Markdown 对照翻译保留标题、列表、表格和代码节点类型。
- 资源索引按文档缓存图片/链接元数据，支持增量跳过、取消和失败重试。
- 资源索引缓存同时保存已扫描页的真实 viewport 尺寸；恢复缓存后块候选、图片标注和右键命中不会因缺少页面尺寸回退到固定 A4 坐标。
- 右键图片菜单先显示页面操作，再按保留的鼠标坐标异步补齐图片候选；首次索引未完成时不会丢失“导出此图片”的入口，索引失败仍保留页面导出。
- 资源扫描进度通过 `requestAnimationFrame` 合并，取消时清理待执行帧，避免长文档扫描把每页状态更新都推入 UI 渲染队列。
- 资源索引单独保存 `scannedPages`，不能从文本页集合推导；空白文本页完成图片和链接扫描后同样会被缓存。资源缓存键优先包含 PDF.js 文档 fingerprint，并以源文件字节数作为加载早期回退，路径内容替换或同大小内容替换都会自动切换缓存命名空间。
- 旧版本资源缓存若没有 `scannedPages`，但页面已经具备完整图片、链接和文本结果，兼容跳过路径会在本次读取时自动补写扫描页集合，避免迁移后继续重复扫描。
- 资源侧栏关闭会触发扫描 effect cleanup，当前页任务和待执行进度帧立即取消；重新打开时只补扫未缓存页。
- 资源扫描的 PDF.js 单页边界使用 30 秒超时；页面代理晚到时主动 cleanup，注释或文本读取超时只标记当前页失败，后续页仍可继续并支持重试。
- 资源索引同时缓存已扫描页集合和页文本，能区分“已扫描但没有资源”的空页，并在重启后继续提取 DOI；不会因空页缺少图片/链接记录而重复扫描整篇 PDF，旧版本缓存会按版本自动失效。
- 资源索引扫描通过独立缓存适配器管理版本、字段校验和容量上限；扫描任务使用稳定引用避免每页状态更新导致任务重启。
- 资源缓存 fixture 覆盖空页、页文本恢复和旧 schema 隔离，作为发布验证的一部分运行。
- PDF 笔记和标注点击回跳使用 `page + sourceRect`，不再只定位到页码。
- PDF 长文档块提取按 24 页分段，调用方取消时不再启动后续分段；1000 页 fixture 已通过分段完整性测试。
- PDF 全文搜索按页检查取消状态，切换文档或卸载阅读器时会中止旧搜索；缓存文档缺失会显式报错，不再静默返回空阅读块。
- SVG 局部导出不依赖当前 PyMuPDF 不支持的 `clip` 参数，改用 SVG viewport 裁剪，并通过嵌入 Python fixture 验证。
- xref 图片识别保留宽幅/条带型 raster 资源；PDF.js hover 几何按行和连续文字片段拆分，相关双栏与断行规则由纯服务 fixture 覆盖。
- Tauri 图片索引保留 `xref`、`block`、`vector` 来源契约；前端不会把结构化 block 候选降级为 xref，避免图片候选排序、去重和导出策略误判。
- native 图片索引同时读取 `get_images()` 与 `page.get_image_info()`，覆盖内联图片；普通 xref 仍走原始资源导出，补充索引只保存 bbox/尺寸/扩展名，不计算重复 digest 或把图片字节放入 JSON。
- Full translation 单栏宽段落不再套用双栏中心半径过滤，避免 hover、Ask 和蓝色块只覆盖段落一侧。
- PDF 页面 canvas 绘制不再等待可选链接注释解析；链接命中层在页面显示后异步补齐，慢或损坏的注释不会阻塞正文首屏。
- 矢量资源识别只合并几乎重合的重复路径，不再按邻近距离把相邻图表、边框或文字路径拼成大块；复杂矢量页仍以多个局部候选交给资源面板筛选。
- 图片/矢量候选的零容差合并只接受真实重叠，不把刚好贴边的独立资源合成一个导出块；正容差仅用于明确允许的近邻合并。
- 前端图片候选与 native raster 索引保持同一尺寸范围；真实 xref 图片不再因与图中标签/说明文字重叠而被前端过滤，文字重叠约束仅用于矢量路径的误识别抑制。
- Markdown block parser 使用内容稳定 ID，节点结构包含 `kind/depth/tableAlign/sourcePath`，预览、翻译和阅读辅助共享同一节点序列；Markdown viewer 的翻译缓存和引用使用 `ReaderDocument.id`，不再以路径或标题作为主键。
- Markdown 读取 API 在网络边界校验响应结构；`content` 缺失或类型错误会失败并提示，不会用空字符串覆盖当前文档。
- 阅读笔记和 PDF 标注已迁移到 `ReaderDocument.id` 主键；旧版本按规范化路径保存的数据会在对应文档存在时合并迁移，并在删除文档时同时清理稳定 ID 和旧路径键。
- 原生 WebView 的页面内跳转不再因父层 URL 同步而重置前进/后退历史；应用主动导航和原生导航事件分别处理，并由 `browserHistory` fixture 覆盖追加、分叉和重复导航。
- 原生 WebView 下载的 PDF 仅写入带 `r0nix-web-` 前缀的应用临时文件；PDF 句柄关闭后删除对应文件，启动时清理超过 24 小时的残留，网络/写盘失败路径删除半成品，且路径校验限制在应用临时目录内。
- 原生 WebView PDF 下载完成后再次确认来源网页标签仍存在；来源已关闭或 PDF 句柄创建失败时调用受控临时文件清理命令，避免异步下载产生幽灵文档和临时文件泄漏。
- 原生 WebView 命令只接受带 host 的 HTTP(S) URL；WebView 创建成功后才登记 tab 映射，历史/显示/尺寸/关闭命令只能操作已登记 tab，避免 scheme 逃逸和幽灵窗口。
- Markdown/PDF 翻译的全文任务和单块重试均校验当前请求身份，旧响应不能覆盖新文档、新配置或新重试结果。
- 模型 API Key 只存在于当前会话内；普通 localStorage 设置只保存服务地址、模型和提示词等非密钥配置，兼容 schema 启动时会擦除历史明文 key，未来 schema 不会被改写。
- 版本化本地状态的写入失败会保留既有值并发出统一持久化 warning；文档、Tab、笔记、标注和画布不再因 localStorage 配额或 WebView 存储异常直接抛出未处理异常。
- 读取到高于当前版本的本地状态时进入只读保护：当前版本使用 fallback 继续运行，但不会覆盖未来 schema 数据，避免降级启动造成数据回退。
- Rust LLM 请求对响应体设置 8 MiB 上限，先检查 `Content-Length`，再对未知长度响应按 chunk 限制读取；请求取消、超限和非 UTF-8 响应均以显式错误结束。
- PDF 与 Markdown 全文分块翻译共享 3 路有界并发适配器；最终结果和 PDF 增量进度都按 block 顺序归并，单块失败隔离，文档切换或用户取消会终止整个批次。
- `npm run verify` 同时执行嵌入 Python/PyMuPDF 的 Rust 集成测试，覆盖 1000 页分段、取消探针、原始图片提取和 SVG 局部裁剪，避免只验证前端契约。
- CI 额外执行 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 和 native lifecycle contract；PDF 句柄关闭的核心逻辑不再依赖 Tauri `AppHandle`，临时文件清理保留在命令适配层。
- CI 与 Release workflow 通过统一的 `npm run check:contracts` 和 `npm run test:fixtures` 入口执行 P 级契约和结构化 fixture：图片索引、Markdown block、阅读辅助、文档引用、白板、Tab 生命周期、核心导航、翻译竞态、PDF 打开取消，以及 PDF block、资源缓存、文档迁移、设置安全和浏览器历史测试；桌面 GUI 仍单独归入安装后人工/runner 回归。
- CI 与 Release workflow 额外执行 `npm run test:e2e`，覆盖 1000 页 PDF 虚拟化、跨 span 原生选择、右键缩放锁页、Full translation hover、设置和浏览历史；该浏览器证据不能替代打包桌面 GUI 回归。

## 待审阅

P 级痛点、验收标准和推荐执行顺序统一记录在 [产品痛点与开发优先级](./product-priorities.md)。后续实现以该文档为主，避免在 PDF、Markdown、资源索引和模型能力之间无序扩张。

- 浏览器端图像识别和图像导出仍依赖后端 HTTP API，桌面端 Rust/PyMuPDF 链路已有集成测试。
- 1000 页后端分段提取已通过 fixture；GitHub Actions run `32553879761` 已通过 Windows 安装 smoke，并完成 macOS bundle/DMG 构建和 artifact 上传；桌面端真实打开、滚动、缩放的 GUI 性能仍需在打包应用中测量。
- Tauri 开发构建已在当前 macOS 环境重新编译并启动（`cargo run --manifest-path src-tauri/Cargo.toml --no-default-features`），日志确认原生 runtime、Rust `open_pdf` 和 39 页 PDF.js 加载成功；文本选择、段落 hover、缩放帧率仍未完成桌面人工点击和截图回归。
- Markdown 使用 `marked` GFM lexer，再由 `markdownBlocks.ts` 归一化为共享节点；HTML 以不可执行文本保留，脚注定义会恢复为 `auxiliary` 阅读块，普通引用链接定义保持原生引用语义。
- 当前没有独立 unit-test runner 和 lint 脚本；Rust 单测中依赖嵌入 Python 的测试仍被显式忽略。
  - 前端单测由 `npm run test:fixtures` 下的 `node --experimental-strip-types scripts/test-*.mjs` 承担，
    **没有 jsdom / testing-library**，因此只覆盖纯逻辑，不覆盖渲染。
  - **可测性边界（踩过坑）**：`--experimental-strip-types` 直跑 TS 时，相对 import **必须带显式扩展名**，
    无扩展名会 `ERR_MODULE_NOT_FOUND`。所以一个服务模块若想被真实单测加载，只有两条路：
    ① 该模块不 import 任何本地 value 模块（只 `import type`，会被擦除）；② 它的相对 import 写全 `.ts`。
    违反这条的后果不是「没测试」，而是「只能退化成 `readFileSync` + `includes` 的字符串断言」——
    `userSettings.ts` 就是被迫这样弱测的（它 `import "./localStore"`）。
    `services/readerAnnotations.ts` 选择②并在文件头注明原因，删掉那个 `.ts` 会让测试立刻变红。
  - **修 trap 优先于测 trap**：比「写测试提醒大家别忘」更可靠的是让「忘」变成编译错误。
    例：`readerAnnotationSchema` 用 `Record<ReaderAnnotationKind, true>` 穷举联合，
    运行时白名单由它派生 —— 往联合里加成员而漏加白名单，`tsc` 直接报「缺少属性」，
    而这件事原本是 `tsc` 看不见的静默数据丢失。
- 文件夹导入会跳过 symlink，并受目录数量与 30 秒总时限约束，避免大型或异常目录树无限占用 blocking 线程。
- 桌面端打包需要在实际 macOS/Windows 环境分别验证原生 WebView、托盘和安装器行为。
- 当前尚未在 CI 中启动打包后的 macOS/Windows 应用做 GUI 集成测试；需要对应 runner 和签名/系统 WebView 环境。
- Tauri 开发运行链路已在当前 macOS 环境验证：原生 runtime、Rust `open_pdf`、PDF.js 文档加载和页面缩略图渲染成功；仍缺少打包产物安装后的同等 GUI 证据。
- macOS release `.app` 已在当前机器实际启动验证；内嵌 Python/PyMuPDF 动态库使用 bundle 相对 rpath，release workflow 会在 bundle 后重新签名，签名版再执行公证和 stapling。Release workflow 现在还会启动 bundled binary 做 process smoke，Windows release workflow 已加入 NSIS 安装、runtime 文件和启动 smoke；安装后的 GUI smoke 和打包应用端到端行为仍需 release runner 结果作为发布证据。
- 本地 release `.app` 经 rpath 修补和 ad-hoc 重签名后通过 `codesign --verify --deep --strict`，生成的 DMG 通过 `hdiutil verify`，并由 bundle smoke 挂载后再次验证 DMG 内的 `.app`；Release workflow 已加入同等 macOS bundle smoke，但锁屏环境仍未完成安装后 GUI 点击验证。
- 正式版本 tag 缺少 Developer ID/公证凭据时，Release workflow 会明确标注并发布 ad-hoc macOS DMG；该包未经过 Apple 公证，首次打开可能需要用户在系统安全设置中手动允许。配置凭据后才会切换到正式签名与公证流程。
- 当前源码已重新构建 debug Tauri `.app` 和 DMG；经统一 rpath/ad-hoc 重签名后 `macos-bundle-smoke.sh` 与 `hdiutil verify` 均通过。该证据只证明 bundle 结构、签名和 DMG 完整性，不替代解锁后的 GUI 点击验证。
- 首屏按 tab 懒加载 PDF、Markdown、网页、设置和画布；PDF.js 文档模块也延迟到首次打开 PDF 时加载，生产首屏主 chunk 已从约 1.1 MB 降至约 380 KB，PDF.js 独立 chunk 约 445 KB。
- `check:pdf-virtualization` 会锁定页面占位、active page gating、有限 overlay 和 `content-visibility` 约束，避免性能优化在后续迭代中回退。
