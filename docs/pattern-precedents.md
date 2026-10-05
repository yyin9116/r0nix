# Pattern 层的 UX 先例对照

> 用途：在设计 Pattern 层之前，先看**别人已经解决过没有**，避免把已被别人验证过的约束重新发明一遍。
> 本文是 Pattern 层先例调研的**单一来源**。`docs/design-system.md` §11.6 只放指针，不复制内容。
> 调研时间 2026-10-04。所有「我们的实测」数字都来自本仓当前工作区，附测量方式。
>
> §2 是 8 个 Pattern 的逐条对照；**§5 是另一件事** —— 为「伴读 Agent」（阅读中主动提示的
> 原位对话，见 `docs/design-system.md` §11.7）做的先例调研，覆盖 PDF 阅读器 / Markdown 阅读器 /
> 划词与侧栏翻译三类形态。

---

## 0. 边界：哪些先例可以用，哪些不能

本项目是**本地优先的 PDF 阅读器**（阅读器 + 白板 + Markdown 查看器 + 内嵌浏览器），
不是后台管理系统。因此有一条硬边界：

| 不能抄 | 原因 |
|---|---|
| TablePage / SearchForm / Wizard / MasterDetail 这一族 | 这是**后台管理系统**的词汇表。我们没有表单页、没有向导分步、没有服务端分页表格 |
| Polaris 的「保存的筛选视图」 | 依赖账户与服务端视图存储；我们是单机应用 |
| 电商专属筛选维度（价格滑块、颜色色块） | 场景不同 |

**这类硬抄的代价已经有过一次前车之鉴**：`src/ui` 组件层建立后渗透率长期停在
**1 / 17**（17 个非 `ui/` 的 `.tsx` 里只有 `Settings.tsx` 引用，
`Settings.tsx:23` 的 `from"../ui"` —— 注意 `from` 后无空格，源码被压缩过，
用带空格的正则搜会得到「零命中」的假结论）。

所以本文件的用法是——**抄约束，不抄外观**：
采的是「最多几个动作」「关闭后焦点去哪」「收起来时用户怎么知道里面有东西」，
而不是「用哪个插画风格」。

---

## 1. 结论速览

| Pattern | 本仓手写次数 | 最值得抄的先例 | 一句话判据 |
|---|---|---|---|
| **EmptyState** | 15 | IBM Carbon（三类空状态）+ Atlassian（至少一个动作） | 分三类，主操作只 1 个，零结果类**必须保留筛选控件** |
| **SectionCard** | 4 | IBM Carbon **Tile**（不是 Card） | 同层容器**不带阴影**；动作是页内动作，浮层入口不进来 |
| **WorkbenchToolbar** | 4 | Apple HIG（Rule of Five + 破坏性操作进溢出） | 可见项 ≤5，破坏性动作进溢出菜单 |
| **SidePanel** | 3 | Material 3 **supporting pane** | 宽度只有一个值；展开状态由 ReaderShell 单一持有 |
| **ListRow** | 4 | IBM Carbon structured list | 只两档高度；正文换行不截断 |
| **CollectionHeader** | 3 | Carbon Filtering + NN/g | 收起时必须显示「已选 N 项」+ 一键清除 |
| **ReaderShell** | 1 | M3 canonical layouts（契约，非组件） | 唯一注入运行时变量的层 |
| **OverlayMenu** | 2 | WAI-ARIA APG menu-button（契约，非组件） | Escape 关闭且**焦点还给触发按钮** |

---

## 2. 逐条对照

### 2.1 EmptyState（实测 15 处）

**我们的病历**：`border-dashed` 在本仓出现 **15 处**（`PDFViewer.tsx` 8 / `Whiteboards.tsx` 4 /
`MarkdownViewer.tsx` 2 / `WhiteboardCanvas.tsx` 1），语义全部是「这里还没有内容」，
但外观散成：

| 维度 | 实测分布 |
|---|---|
| 圆角 | **6 种**：`rounded-2xl`×6 / `lg`×3 / `xl`×2 / `3xl`×2 / `md`×1 / `[28px]`×1 |
| 描边档 | **2 种**：`border-default`×12 / `border-subtle`×2 |
| 内边距 | **8 种**：`px-3`×5 / `py-4`×4 / `py-6`×3 / `px-4`×3 / `py-10`×2 / `py-12`×1 / `px-8`×1 / `px-5`×1 |

同一语义 15 种写法，这是「组件层建好了、页面还是很怪」的典型样本。

**先例**

- **IBM Carbon** 把空状态分成三类：`no-data`（本来就没有）/ `user-action`（用户还没做）/
  `error-management`（出错了）。标题写**正向陈述句**。**只给一个主操作。**
  清空筛选后**必须保留查询控件**（否则用户要重新打一遍）。
- **Shopify Polaris `EmptyState`** 的 props 只有
  `heading / image / action / secondaryAction / fullWidth / children`，**只允许一个 primary CTA**。
  文案语气按状态分档：首用要 encouraging、错误态要 reassuring、无结果要 helpful。
- **Atlassian** 的 EmptyState 有三档动作 primary / secondary / **tertiary**，
  并强制「**至少一个动作，不留死路**」。
- **Ant Design `Empty`** 提供 `PRESENTED_IMAGE_DEFAULT`（详版，带占位插图）与
  `PRESENTED_IMAGE_SIMPLE`（简版，用于 Select 之类的内联场景）。
- **Material 3 没有正式的空状态组件**；MUI 用 Box + Typography + Button 组合。
  —— 反证：这不是「必然要有组件」的东西，必须有**明确的组合规则**才值得抽。

**采纳**

1. 分三类，不是一种外观。类别决定「有没有插画」和「给几个按钮」。
2. **零结果类必须保留搜索/筛选控件**并给「清除筛选」这一条出路 ——
   这条直接决定它和 `CollectionHeader` 的接缝在哪。
3. 主操作最多 1 个；Atlassian 的 tertiary 档只用于错误类（重试 / 查看详情）。
4. **内联场景用无插画简版**（侧栏批注空列表、白板侧车空区块），整屏用带插画详版。
   —— 这条是 Ant 的 SIMPLE 变体给我们的启发，我们原本会一律做成大插画。
5. 文案语气分档写进 Pattern 的接口注释，不靠调用方自觉。

**拒绝**

- Carbon 的企业插画风格（我们无插画资产，且 Swiss 定位不适合装饰性插图）。
- `Empty.useEmpty()` 式的全局替换点（单应用，没有宿主需要换实现）。

**判据**：`<EmptyState variant="first-use|no-results|error" />`，
主操作为**单值** `primaryAction`（不是数组 —— 用类型堵死「两个主按钮」）。

---

### 2.2 SectionCard（实测 4 处，集中在 Settings）

**我们的病历**：`src/ui/Card.tsx` 已存在，但「标题 + 说明 + 一行控件」这个**组合**没有名字，
Settings 里每个分组各自拼容器。手写 4 次。

**先例：IBM Carbon Tile**

- **Tile 和 Card 是两件事**：Tile 是简单的基础容器；Card 建立在 Tile 之上，
  是复杂模式（信息层级、多动作、溢出菜单、可选中）。**Carbon 本身没有 Card 组件**，
  只在 pattern asset library 里链出去。
- 四种变体：`base`（承载信息）/ `clickable`（导航触发）/ `selectable` / `expandable`。
- **Tile 与页面背景同层，没有 elevation。明确禁止用阴影来揭示次级信息、动作或通知**
  —— 那类内容应该用 modal / popover / dialog。
- 最小高度 2:1 高宽比；**组内不允许混用变体**。

**采纳**

1. **`SectionCard` 对应 Carbon 的 Tile base 变体，不是 Card。所以它不带阴影。**
2. 「一行控件」必须是**页内动作**。需要浮层的一律走 `OverlayMenu`，
   不在 SectionCard 里就地展开 —— 否则每个卡片的展开行为会长得不一样。
3. 组内不混变体：一个容器里要么全 base、要么全 clickable，
   避免出现「有的能点有的不能点」而视觉上一样。
4. 高度用 `min-h` 而非固定 `h`。2:1 是**卡片组**的要求；
   我们的设置项是纵向列表，取「标题行 + 内容行」两段式即可。

**拒绝**

- `selectable` / `expandable` 变体 —— 设置页没有卡片级多选场景
  （主题选择已经是 radio 组，再套一层卡片选中是重复表达）。
- masonry 布局 —— 不是瀑布流。

**判据**：`<SectionCard title description actions>`，
`actions` 只接受 `Button` / `IconButton`，**不接受任意 children 容器**
（这是防止它退化成「又一个 div」的关键约束）。

---

### 2.3 WorkbenchToolbar（实测 4 处）

**我们的病历**：PDFViewer 工具条、Whiteboards 工具条、MarkdownViewer 工具条、
WebBrowser 工具条各写一套。同一个「工具钮」在 PDFViewer 里抽成了
`pdfReader/ToolButton.tsx`，在别处仍是手写 `<button>`。

**先例：Apple HIG 工具栏**

- **Rule of Five**：工具栏项不超过 **5 个**。
- 超出部分用**系统自带的溢出菜单**，不要自己另造一个「更多」。
- 按 leading / center / trailing 分区。
- **每屏只有一个 primary action。**
- **破坏性操作放进溢出菜单 + 确认 + 撤销。**

**采纳**

1. 每个工具条 ≤5 个直接可见项；超出的进溢出菜单（复用 `OverlayMenu` 的契约）。
2. **破坏性项必须进溢出菜单。** 现状反例：`Whiteboards.tsx:637` 的「清空白板」
   `clearBoard` 是一个**平铺的可见按钮**，直接违反这条 —— 应移入溢出菜单并加确认。
3. 分区：leading = 导航/返回，trailing = 视图控制（缩放、侧栏开关）。
4. 唯一的 primary action 用实心填充，其余用描边/幽灵态。

**拒绝**

- macOS 原生 `NSToolbar` 的行为（自动折叠、用户可定制工具栏）——
  我们是 Web 层工具条，不引入平台特有的可定制机制。

**判据**：可见项 >5 时构建期报错（可做成守卫规则），
或至少在 Pattern 注释里写死上限，别只靠约定。

---

### 2.4 SidePanel（实测 3 处）

**我们的病历**：定宽侧栏出现 `w-64 / w-72 / w-80` **三个值混用**
（另有 `fieldStyles.ts` / `Settings.tsx` 的输入框宽度命中同一正则，需按语义区分）。
PDFViewer 侧栏、Whiteboards 侧车、Settings 各写一套。

**先例：Material 3 canonical layouts**

- **`list-detail`**：840dp 以上推荐；紧凑屏退化为单页（列表 ⇄ 详情），大屏并排。
- **`supporting pane`**：主区约 2/3 + 侧栏；紧凑屏把侧栏收进 bottom sheet，大屏固定宽侧栏。
- 适配三策略：**Show-and-Hide / Levitate / Reflow**。
- 断点：Compact <600 / Medium 600–839 / Expanded 840–1199 / Large 1200–1599 / XL ≥1600。
- 可直接对照的实现：`ListDetailPaneScaffold` / `SupportingPaneScaffold`。

**采纳**

1. **我们的阅读器是 `supporting pane`，不是 `list-detail`。**
   （主区 = PDF 页，侧栏 = 大纲/缩略图/批注。）这句定位要写进文档，
   否则后来者会按 list-detail 做，引入本不存在的导航层级。
2. **侧栏宽度收敛为一个值**，可折叠为 0。
3. 紧凑宽度下侧栏改为**浮层**而非挤压主区。M3 用 bottom sheet 是因为移动端；
   桌面端我们用 overlay/popover 更合适 —— 这一条是**刻意偏离**先例，理由要写明。
4. 断点采用 M3 的 600 / 840 / 1200 三档。注意：我们的 Tailwind `md:` / `lg:` / `xl:`
   **默认值恰好接近但不等于**这三档，必须**显式记录**采用哪一套，不能靠默认值。
5. 侧栏展开状态**由 ReaderShell 单一持有**，不允许每个面板各自存一份。

**拒绝**

- `ListDetailPaneScaffold` 的返回栈语义（紧凑屏 list ⇄ detail 的导航栈）——
  我们的侧栏不是导航层级，不需要 back stack。
- Android 的 bottom sheet 形态（见上，桌面端用浮层）。

**判据**：侧栏宽度只有一个 token；「侧栏是否展开」只有一个持有者。

---

### 2.5 ListRow（实测 4 处）

**我们的病历**：Library 文档列表、PDFViewer 大纲、翻译结果、白板侧车笔记列表。
行高、对齐、次级文字位置各写各的。多处使用 `truncate` / `line-clamp-1`。

**先例：IBM Carbon structured list**

- 两个变体：`default` / `selectable`。
- 两种高度：default **60px** / condensed **36px**。
- 两种对齐：`hang` / `flush`。
- 行文本**最多三段**且用 sentence-case；列头 1–2 个词。
- **行文本应换行而不是截断。**
- 内容变复杂了就**改用 data table**，不要继续堆叠列表行。

**采纳**

1. 只做两档高度，对应 Carbon 的 60 / 36 —— 正好覆盖
   「文档列表（宽行）」与「大纲 / 翻译（密行）」两类场景。
2. **正文必须换行，标题可截断。** 我们当前是**一律 `truncate`**，需要逐个判断：
   标题截断合理；正文/摘要截断会让人看不到内容，应换行。
3. 最多三段：主文本 + 次级文本 + 元信息（时间/页码）。
4. 不做 `selectable` 变体（无多选场景）；将来需要时直接查 Carbon，不要自己发明。
5. 内容复杂化 → 用 data table，不扩展 ListRow。

**拒绝**

- Carbon 的 `hang` 对齐变体 —— 我们没有「多行文本需要左挂对齐」的场景。

**判据**：`<ListRow height="default|condensed" primary secondary meta />`；
`primary` 允许截断，`secondary` **不允许**（用类型/注释写死）。

---

### 2.6 CollectionHeader（实测 3 处）

**我们的病历**：标题 + 计数 + 搜索 + 筛选下拉，3 处手写。
Library 里**已经有行计数器** —— 这恰好就是下面 Atlassian 说的那个东西。

**先例**

- **IBM Carbon Filtering**
  - 五种选择方式：单选 / 多选 / **多类别** / 多筛选+批量应用 / 多筛选+即时应用。
  - **起始状态**：用户通常只想排除一两个条件 → 全部默认选中；
    通常只关心某一类 → 全部默认未选中。
  - **筛选器被收进抽屉/下拉/菜单时，关闭态必须有一个可见指示器，
    至少包含「已应用几个筛选器」，并能在不重新打开容器的情况下清除。**
  - 每个类别要能一次清空；有多个类别时还要能「跨类别全部清除」。
  - **多类别筛选应放在左侧纵向或数据集上方横向，绝不放进菜单或下拉。**
- **Shopify Polaris IndexFilters**：query + filters + sort + saved views 四件套；
  区分 `pinned`（常驻显示）与 `shortcut`（高频但不必常驻），
  且**pinned 建议只保留 1–2 个最核心条件**，否则界面拥挤。
- **NN/g**：筛选器放左侧、**默认展开**、多选用 checkbox；
  **排序下拉放右上角**；每个筛选值旁边显示对应条目数。
- **Baymard**：34% 的站点筛选实现糟糕；**把会导致零结果的选项置灰**；
  截断前显示 6–10 个值，**10 个是甜点**。

**采纳**

1. **「关闭态指示器」是硬要求。** 我们的筛选下拉收起后必须显示
   「已选 N 项」+ 一键清除。这是当前实现最可能漏掉的一条 ——
   也是「把控件藏起来」这类设计的通用问法：藏起来之后用户怎么知道里面有东西。
2. **行计数器保留并显式化**：文案要能区分「共 0 条」与「筛选后 0 条」。
   这是 §2.1 空状态分类的**输入** —— 两个 Pattern 在这里咬合。
3. 排序下拉放右上角，搜索框在标题行内。
4. 筛选值旁带条目数。本地无索引时**先不做，但在 Pattern 接口里预留参数位**，
   否则将来加不进去。
5. 零结果用**置灰而非隐藏**（隐藏会让人以为这个选项不存在）。
6. 多类别筛选**不放进下拉**。我们当前只有 1–2 个类别，放下拉可接受；
   **一旦超过 2 类必须改为左侧纵向** —— 这是触发式规则，要写进注释。

**拒绝**

- Polaris 的 saved views / 标签页式视图管理（本地应用，无账户与服务端视图）。
- Baymard 的电商专属维度（价格滑块、颜色色块）。

**判据**：`<CollectionHeader title count query onQueryChange filters activeCount onClearAll />`；
**`filters` 收起时必须渲染 `activeCount` 徽标**（可做成渲染层守卫）。

---

### 2.7 ReaderShell（实测 1 处，App.tsx）

**我们的病历**：只有一份，但它是整个应用骨架（标题栏 + 内容区 + 侧栏 + 状态栏），
且是历史上被反复改动的地方。

**先例**：M3 canonical layouts 的 `supporting pane`（§2.4）+ Apple HIG 的窗口结构
（toolbar 的 leading / center / trailing 分区）。

**采纳**

1. ReaderShell 是**布局契约**，不是组件。只建一次，只回答两件事：
   分区在哪、谁持有展开状态。
2. 它必须是**唯一**注入运行时变量（如 `--scale-factor` 一类）的层。
   理由见 `docs/design-system.md` §4.7.1 的坑一、§4.1 陷阱一：注入点错层或
   **声明 `var()` 的元素与注入点不在同一定义域**，会让整条令牌链**静默失效** ——
   不报错、不报缺失、深浅两主题取同一个兜底值，截图上看像「本来就该是灰的」。

**拒绝**

- 不做成可配置的多布局框架（只有一种布局，做成框架等于制造没人用的刻度）。

**判据**：侧栏展开状态、主题、强调色注入点三者都收敛在 ReaderShell；
其他组件不得各自注入。

---

### 2.8 OverlayMenu（实测 2 处）

**我们的病历**：`ContextMenu.tsx` + `ReadingAssistMenu.tsx`，**都低于「≥3 次才建」的门槛**。

**先例：WAI-ARIA APG menu-button**

触发按钮：

- `aria-haspopup="menu"`，且 `aria-expanded` 与菜单可见性**同步**

菜单本体：

- `role="menu"` / 子项 `role="menuitem"`
- **roving tabindex**
- `↑` `↓` / `Home` `End` 在项间移动
- `Escape` 关闭，并把**焦点还给触发按钮**
- `Tab` **关闭菜单**（而不是在项间移动）
- 打开时聚焦第一个**未禁用**项

APG 点名的常见错误：导航栏误用 `role="menu"`（menu 是**动作集合**，不是导航）、
缺 `aria-haspopup`、用 `role="link"` 代替 `menuitem`。

**采纳**

1. **不建组件，采纳行为契约。** §4 会解释为什么这和门槛规则不冲突。
2. 上面 7 条逐条写成断言，可进 `check-*-contract.mjs`。
3. 现有两处**不合并**：`ContextMenu` 是右键唤起、`ReadingAssistMenu` 是按钮唤起，
   唤起方式不同，合并会造出一个两边都不满意的抽象。

**拒绝**

- 造一个 `<OverlayMenu>` 组件同时包住两者。

**判据**：两条独立断言 ——
① `aria-expanded` 与菜单可见性同真同假；
② 关闭后 `document.activeElement === 触发按钮`。

---

## 3. 从先例里提炼的五条跨 Pattern 判据

这五条在多个先例里被**独立**提到，因此可信度高于单一来源的建议：

1. **「零结果」必须和「真的没有」分成两种状态。**
   Carbon（三类空状态）、Atlassian（错误态单独一档）、NN/g、Baymard（防零结果）都说了。
   落到我们身上：`CollectionHeader` 的计数文案 + `EmptyState` 的 variant。
2. **收起来的筛选器必须自报状态。**
   Carbon 明文要求「关闭态必须有可见指示器，含已应用数量，且能不重开就清除」。
   推广为通用问法：**任何把控件藏起来的设计，都要回答「藏起来之后用户怎么知道里面有东西」。**
3. **破坏性动作进二级菜单 + 确认 + 撤销。**（Apple HIG）
   当前反例：`Whiteboards.tsx:637` 的清空白板是平铺可见按钮。
4. **同层容器不带 elevation。**（Carbon Tile）
   阴影只留给真正浮起来的东西（modal / popover / dialog）。
5. **动作数量有上限。**（HIG 的 5、EmptyState 的 1 个主 CTA、Polaris 的 1 个 primary）
   上限要写进**接口**（类型 / 断言），不能只写在文档里靠自觉。

---

## 4. 与「只建手写 ≥3 次的 Pattern」纪律的冲突处理

现有纪律①是**只建手写 ≥3 次的 Pattern**。有两个低于门槛：

| Pattern | 次数 | 是否建组件 | 改成做什么 |
|---|---|---|---|
| ReaderShell | 1 | ❌ | 采**布局契约**：只规定分区与状态归属 |
| OverlayMenu | 2 | ❌ | 采**无障碍行为契约**：7 条断言 |

**为什么不是无原则地破例**：

- 门槛规则治的是「**同一语义 15 种写法**」这类**视觉漂移**
  （`border-dashed` 15 处 6 种圆角就是这么来的）。
- 这两个的风险不是「长得不一样」，而是「**规格写错且无从对照**」——
  ReaderShell 写错 → 整条令牌链静默失效；OverlayMenu 写错 → 键盘用户直接卡住。
- 所以它们采的是**契约**而不是**组件**：不产生新的 `src/ui/*.tsx`，
  只产生断言与一段明确的职责说明。

**结论**：Pattern 目录的落地顺序不变
（`EmptyState` → `SectionCard` → `WorkbenchToolbar` → `SidePanel`），
另外并行推进「契约测试」一项（不涉及新组件，不违反门槛纪律）。

---

## 5. 阅读中的原位辅助（伴读 Agent）的先例

对应提案见 `docs/design-system.md` §11.7。先例按**产品形态**分三类 —— 这三类恰好是本仓
已存在的三个阅读面（PDF / Markdown / 翻译）。同样只抄约束。

### 5.1 最接近的形态：内联建议卡（Grammarly / Google Docs / Word Editor）

Grammarly 的交互链与本提案几乎同构：文本被下划线锚定 → 悬停/点击打开建议卡 →
卡内含「接受 / 忽略」→ 卡底 `Learn more` 给**理由** → 右侧栏提供**汇总复核面** →
设置里可按类别关闭 → 已接受的单条可撤销。

| 约束 | 出处 | 落到我们身上 |
|---|---|---|
| 锚定在原文本上，而不是另开一个列表 | 内联下划线 | 气泡挂在 `blockId` 对应段落旁 |
| 卡内必须有「为什么这么建议」的入口 | `Learn more` | §11.7 约束 4 的「自报理由」 |
| 除原位卡外**还要有一个汇总面** | 右侧 review 栏 | 已有的侧栏（笔记 / 资源）就是它 —— 别另建 |
| 「关闭 / 忽略」是**一等动作**，不是藏起来的 | `Dismiss` 与 `Accept` 同级 | 「暂不提示」必须与「展开」同为可见按钮 |
| 单条可撤销 | `undo` | 气泡产生的批注要能删，删完不留痕迹 |
| 颜色不能是唯一通道（另有 colorblind mode） | 编辑器设置 | §11.7 约束 8 |
| 可按类别停用 | 建议类型开关 | §11.7 约束 7 |

**不采纳**：Grammarly 刻意把「删除」图标缩小以引导用户接受建议。
我们**没有**要让用户接受的东西 —— 气泡产出的是解释而非改写，不该引导点击。

### 5.2 PDF 阅读器：锚点、回跳与「边听边标」

| 先例 | 可采纳的约束 |
|---|---|
| **Zotero**：划词即弹层选色；批注自动携带**回跳页码**的链接；「读出声」功能带 `Annotate Sentence` 按钮，把刚听到的那一句自动高亮 | ① 锚点必须能回跳原文；② 「自动标出某一段」在本领域**已有先例**，不是新发明 —— 但要学它把动作**显式化**（按钮触发），而不是无声地标 |
| **Hypothes.is**：讨论线程**挂在具体高亮上**，可对某一条高亮直接回复 | 这正是「追问就在气泡里完成」的先例；追问的上下文 = 该高亮 + 该线程，不串场 |
| **Adobe Acrobat AI Assistant**：右侧问答面板，回答带**可点击页码引用** | 展开后的回答应带引用且能跳页；但**面板形态本身不采纳** —— 我们已有侧栏 |
| **Okular**：默认把批注与原文分离存储，原文保持干净 | 与我们的 localStorage 批注同构，无需改动 |

**共同结论**：这一族的先例**全部是「用户先划词 / 先点击」**触发的。5.2 里没有任何一个
把「自动判断读者卡住了」当默认行为 —— 这提示 §11.7 必须把主动提示做成
**可关闭、默认克制**的增强，而不是唯一路径。

### 5.3 Markdown 阅读器：元数据浮层的克制

| 先例 | 可采纳的约束 |
|---|---|
| **Obsidian**：Live Preview 只隐藏语法、**不主动加内容**；桌面端干脆没有格式工具栏，一切靠命令 / 快捷键 | 阅读面以文本为主，浮层必须**稀疏**；能不给的浮层就不给 |
| **Notion**：划词弹出格式化菜单，其中已含「对这段问 AI」与「加评论」 | 划词菜单里**已经包含**「问 AI」—— 我们已有 `ReadingAssistMenu`，不要建第二个 |
| **Notion AI**：内容由用户显式唤起（`/` 命令或菜单项） | 「AI 主动出现」在成熟产品里是**例外**，不是默认 |

**这一类的核心判据**：Markdown 阅读面的用户预期是「什么都不弹」。所以 MVP 先做 PDF。

### 5.4 翻译：悬停 / 划词弹层的分寸

| 先例 | 可采纳的约束 |
|---|---|
| **沉浸式翻译**：悬停某段 → 译文出现在**该段下方**（不进浮层、不遮字）；划词 → 就地出释义；悬浮球 / 快捷键是**显式开关**；译文样式（虚线 / 高亮 / 马克笔）与颜色可配 | ① 「就地插入」比「浮层遮挡」更适合高密度正文；② 主动行为必须有**显式总开关**；③ 视觉样式可配 = 承认默认样式会打扰一部分人 |
| 同上：提供「+Ctrl/Shift 才翻译」的**防误触档** | 与 §11.7 约束 2 一致：不靠裸 hover 触发 |
| 同上：PDF 场景改为**另开一页**并排译文、保留原排版 | 若做「整段翻译」，复用现有 `setSidePanelView("translation")`，不要新造并排视图 |

### 5.5 三条跨形态判据（多来源独立复现）

1. **原位锚定 + 一个汇总面，两条都要。**（Grammarly 双面、Zotero 批注 ↔ 笔记）
   只有原位 → 无法回看；只有汇总 → 丢了上下文。
2. **主动行为必须有显式开关，且默认克制。**（沉浸式翻译的悬浮球与快捷键、Notion AI 的
   显式唤起、PDF 一族的纯划词触发 —— 三处独立复现）
3. **「为什么出现」是信任的前置条件。**（Grammarly 的 `Learn more`、§11.6 判据 2
   「收起来要自报状态」、§4.7「静默失效」同源）

### 5.6 自动标注：Zotero 的模型恰好是反例

自动标注在本领域有大量先例，但**最主流的那个（Zotero）同时也给出了我们要主动避开的清单**，
所以这节按「抄什么 / 拒什么」写。对应约束见 `docs/design-system.md` §11.8。

**Zotero v7 的模型**：8 种颜色（yellow `#ffd400` / red / green / blue / purple / magenta /
orange / gray）× 2 种形态（highlight、underline）。两种形态被当作近似等价，**没有波浪线**。
社区广泛使用「颜色即语义」编码，一个常见方案是：黄 = 研究发现、红 = 作者总结、
绿 = 理论框架、紫 = 研究方法、洋红 = 争议与不足、橙 = 潜在机会、灰 = 背景知识。

**采纳**：

1. **颜色承载语义这件事本身有证据。** 它让复查与检索变得可行 —— Zotero 可按颜色筛批注、
   可整体导出为笔记。对应我们的侧栏汇总栏必须**按标注类型分组并给出计数**（与 §11.6 判据 2 一致）。
2. **形态与颜色要一起定义，并留下一份书面约定。** Zotero 教程自己强调「关键是设计一套一致
   的系统」，否则跨文献的颜色含义会互相污染 —— 这正是本文档存在的理由。

**拒绝（三条都是从 Zotero 明载或社区明载的失败模式里长出来的）**：

1. **不采用「颜色即语义」。** 中文社区总结明确指出依赖颜色编码的后果：过度标注让原文杂乱、
   **让标注本身失去效果**；依赖颜色后「在黑白文档或打印件上」更难理解；对色盲 / 视觉障碍者不可用。
   Zotero 还缺键盘路径 —— 其官方无障碍 wiki 记载：不用鼠标就无法高亮，只能先 Ctrl-F 精确搜到
   原文再按 Ctrl-Alt-1 转换。→ 所以语义放在**形态**上（底带 / 实线 / 波纹），颜色只表示强度。
2. **不做无上限的标注。** 上面那条「过度标注会让标注失去效果」直接支撑 §11.8 的 60% 密度上限
   —— 它不是审美偏好，是先例里写明的失效机制。
3. **不做任意位置的浮层。** Zotero 的 sticky note 位置任意、「可能压在正文上」，其自带文字标注的
   默认黄色还被实测出**对比度低到读不清**。→ §11.7 约束 6（不得遮挡正文）与 §11.8「标注色值
   一律取既有令牌」都是针对这两条。

**只做 Zotero 没做的两件事**：

- **波浪线。** Zotero 没有这个形态。它在阅读场景里的既有联想来自拼写检查（「这里有疑问」），
  正好承接「AI 判断你可能卡住」，而且它是**唯一带伴读锚点**的形态（§11.8 硬约束 3）。
- **强度可调。** Zotero 让用户逐个选色，等于把「标多少」完全交给当下的注意力；我们把它变成
  一个可设的密度比例，外加「越读越懂」的自适应（§11.8）。

---

## 6. 来源

| 主题 | 来源 |
|---|---|
| EmptyState 三类划分、Tile 变体、structured list 规格、Filtering pattern | IBM Carbon Design System（components/tile/usage、patterns/filtering） |
| EmptyState props 与文案语气分档、IndexFilters、pinned/shortcut | Shopify Polaris |
| EmptyState 三档动作、结构化列表的导航/筛选实践 | Atlassian Design System |
| Empty 的 DEFAULT / SIMPLE 变体、useEmpty | Ant Design |
| list-detail / supporting pane、五档断点、三策略、Scaffold 实现 | Material Design 3 canonical layouts |
| Rule of Five、溢出菜单、破坏性操作保护 | Apple Human Interface Guidelines（Toolbars） |
| menu-button 的 ARIA 契约与常见错误 | WAI-ARIA Authoring Practices Guide |
| 筛选值旁显示条目数、零结果预防、截断甜点 10 个 | Nielsen Norman Group、Baymard Institute |
| 内联建议卡的锚定 / 理由入口 / 汇总面 / 撤销 / 配色无障碍 | Grammarly 用户指南与交互案例分析（support.grammarly.com、humanstandards.org） |
| 划词弹层、批注回跳页码、朗读「Annotate Sentence」、批注与原文分离 | Zotero PDF Reader 文档（zotero.org/support/pdf_reader）、University of Melbourne Library |
| 讨论线程挂在具体高亮上 | Hypothes.is |
| 右侧问答面板 + 可点击页码引用 | Adobe Acrobat AI Assistant（TechRadar 实测流程） |
| 悬停 / 划词就地翻译、显式总开关、防误触档、译文样式可配 | 沉浸式翻译官方文档与 Chrome 商店说明 |
| Live Preview 不主动加内容；划词菜单已含「问 AI」 | Obsidian 帮助文档、Notion 交互说明 |
