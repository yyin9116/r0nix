# 令牌迁移方案

> **状态：全部闸门归零（2026-10-04）。** `scripts/design-tokens-baseline.json` 现在是一个
> **空对象 `{}`** —— 两条棘轮闸门（字面色值、`dark:` 配对）都降到 0，规则 5 从建立当天
> 起就是零容忍。全仓 `src/` 里再找不到一处 zinc / white / black 工具类，也找不到一处
> 字面色值（`index.css` 与 `tokens.css` 作为令牌定义源豁免）。
>
> 归零分三个批次，每批都遵循同一条纪律 —— **先立门禁，再扩面**：
>
> | 批次 | 范围 | 配对 | 该批新增的闸门 |
> |---|---:|---:|---|
> | 1 | `Sidebar` / `Tabs` / `ContextMenu` / `MarkdownViewer` | 58 | **规则 4**（`dark:` + 中性色配对） |
> | 2 | `WebBrowser` / `Library` / `Whiteboards` / `WhiteboardCanvas` | 153 | — |
> | 3 | `PDFViewer` + 单值中性色残留 | 214 + 16 | **规则 5**（任何中性色类，零容忍） |
>
> 迁移过程中的方法论与踩坑记录见 §7；位移登记见 §7.5 与 `docs/design-system.md` §4。
>
> ⚠️ 下面是**开工时的账面数字（708 处 / 15 个文件），已证实虚高**：其中 7 个文件
> （`App.css` / `Sidebar.css` / `LibraryPanel.css` / `MarkdownEditor.css` / `Settings.css`
> / `Toolbar.css` / `ContextMenu.css`，合计 3477 行）**全仓零 import、从未进过构建**，
> 已一并删除。也就是说「708」里约 **242 处从未到达用户**；真实起点约 **467 处**
> （CSS 198 + TSX 269），分布在 5 个真正进构建的样式表与若干 TSX 中。
> 详见 `docs/design-system.md` 第 4.2 节。
>
> 本文件保留作**方法论记录**（按色系家族穷举映射 + 分阶段退出标准）；
> 一切数字请以基线为准，不要再引用第一节的旧账面。
>
> 后续又完成三件事，均已并入本文件：**令牌与代码对齐**（删掉 37 个零引用令牌，§6）、
> **焦点可视统一**（一条 `:focus-visible` 覆盖全应用，退出标准 M9）、
> **高度刻度重建**（`--elev-raised/overlay/modal` → 按代码实测归纳的 `--elev-sm/md/lg/xl`）。

> 目标：把散落在 15 个文件里**绕过设计系统**的样式（账面 **708 处**，剔除死样式表后
> 真实起点约 **467 处**）收敛到 `src/tokens.css` 的单一来源。
> 「不改变既有视觉」是**默许原则**，不是绝对约束 —— 已刻意变更 7 处，清单见
> `docs/design-system.md` §4。
>
> 迁移基准与进度由 `scripts/check-design-tokens.mjs` 度量，基线冻结在
> `scripts/design-tokens-baseline.json`。每完成一批就把基线调低，最终归零。

---

## 1. 开工时的账面（708 处 / 15 个文件）—— 已作废，一切以基线为准

| 文件 | 违规数 | 性质 |
|---|---|---|
| `src/components/Sidebar.css` | 177 | slate + blue 字面色值，含 90 个手工深色块 |
| `src/components/MarkdownViewer.tsx` | 139 | `gray-*` 旧灰阶（136）+ `red-*` 状态色（3） |
| `src/components/WebViewPanel.css` | 96 | blue 残留 + 拟物装饰渐变 |
| `src/components/PDFViewer.css` | 95 | 状态色手混 40+ 色阶，深色变体各自为政 |
| `src/components/StartPage.tsx` | 87 | `blue-*` / `slate-*`，0 个 zinc |
| `src/App.css` | 43 | slate 系 rgba、第二套字体栈、魔法 z-index |
| `src/components/PDFViewer.tsx` | 24 | `red-*` / `amber-*` 状态色（灰阶其实已是 zinc） |
| `src/components/Library.tsx` | 11 | `red-*` / `yellow-*` 状态色 |
| `src/components/MarkdownEditor.css` | 10 | 蓝色 + 字面灰 |
| `src/components/Settings.tsx` | 8 | `emerald-*` / `red-*` 状态色 |
| `src/components/LibraryPanel.css` | 7 | 红色状态色 + slate rgba |
| `src/components/ReadingAssistMenu.css` | 6 | 字面白 / 灰 |
| `src/components/Settings.css` | 2 | `rgba(0,0,0,α)` 遮罩 |
| `src/components/Toolbar.css` | 2 | 字面灰 |
| `src/components/ContextMenu.css` | 1 | `rgba(0,0,0,0.15)` 阴影 |

分类：**CSS 字面色值 439 处 + TSX 非 zinc 调色板类 269 处**。
其中 TSX 部分又分两类：旧灰阶/蓝 **223 处**、状态色 **46 处**。

> 值得注意：`Sidebar.css` 与 `PDFViewer.css` **已经在用 zinc 字面量**（如 `#3f3f46` 11 处、
> `#a1a1aa` 9 处、`#1f1f23` 7 处）。说明这是一次**迁移做到一半**的产物 ——
> 两套色系此刻同时存在于同一文件里，这正是视觉不统一的来源。

---

## 2. 迁移顺序

| 阶段 | 内容 | 风险 | 可单独上线 |
|---|---|---|---|
| A | 接入令牌层，不改任何组件 | 低（**不是零变化** —— 会触发 §4 的 7 处刻意变更） | 是 |
| B | CSS 字面色值 → 令牌 | 低（逐文件） | 是 |
| C | TSX 调色板类 → 令牌 | 低（逐文件） | 是 |
| D | 结构性问题（强调色响应、字体栈、层级命名等） | 中，需目视验证 | 是 |
| E | 组件层落地（`src/ui/` primitive + 迁移消费方）与门禁修复 | 中，**需逐元素计算样式差分**（不是看截图） | 是 |

> 阶段 E 的关键经验：**「看起来没变」和「没变」是两回事。**
> 本轮先冻结了「445 节点 × 3 主题状态 × 25 个计算属性」的快照，改完再采一次逐元素差分。
> 它抓出了一个用肉眼绝对看不见的真回归：`FIELD` 基类里的 `w-full` 盖掉了调用方的 `w-72`，
> 输入框从 288px 被拉到 918px（那是 Settings 里一个横向撑满的输入框，截图上只是「宽一点」）。
> 同时也要能识别**假差异**：颜色必须先经 canvas 归一再比（Tailwind v4 的 `oklch` 与令牌的
> `rgb` 是同一颜色的两种序列化），`display: inline-flex → flex` 是 flex 子项的容器块级化
> 而非回归。差分脚本的价值全在于「噪声清干净了没有」。

---

## 阶段 A：接入令牌层

1. 把 `@import "./tokens.css";` 加到 `src/index.css` 的 `@import "tailwindcss";` 之后。
2. **接入即生效，不是「零视觉变化」**：`tokens.css` 的 `:root` 是**无层级**规则，
   而 `index.css` 里既有的 `--chrome-*` 字面量块位于 `@layer base` 内。
   按 CSS 层叠层规范，无层级声明排在所有 `@layer` 之后，且**层级先于权重比较** ——
   所以 tokens 一被 import 就压过那些字面量块。（开工时误以为「字面量块优先、接入零变化」，
   已在 Chrome 实测推翻。正确判据是「接入后逐条核对 §4 刻意变更表」，见退出标准 M1。）
3. 因此阶段 A 必须与 §4 的 7 处刻意变更一起评审、一起上线。
4. 兼容别名（`--chrome-*` / `--bg-primary` / `--accent-*`）保留，让未迁移代码继续工作。

---

## 阶段 B：CSS 字面色值 → 令牌

### B1. zinc 字面量（已经是对的，只需换成令牌）

| 现值 | 令牌 |
|---|---|
| `#fafafa` | `var(--surface-app)` |
| `#f4f4f5` / `#f5f5f5` | `var(--surface-sunken)` |
| `#ffffff` / `#fff` | `var(--surface-panel)` |
| `#e4e4e7` | `var(--surface-hover)` 或 `var(--border-subtle)` |
| `#d4d4d8` | `var(--border-default)` |
| `#a1a1aa` | `var(--content-disabled)` 或 `var(--border-strong)` |
| `#71717a` | `var(--content-muted)` |
| `#52525b` | `var(--content-secondary)` 或 `var(--accent)` |
| `#3f3f46` | `var(--content-secondary)` |
| `#18181b` | `var(--content-primary)` |
| 深色专用 `#0f0f11` / `#09090b` / `#111114` / `#1f1f23` / `#27272a` / `#2a2a31` / `#2f2f37` / `#232a34` / `#1a1c22` | 全部删除，交给令牌的深色档 |

> 这些深色专用字面量是「每个组件自己混了一套深灰」的产物。用令牌后一律不需要，
> 对应的 `[data-theme="dark"]` 块也可整块删除（见 B5）。

### B2. slate / blue-gray 家族（旧中性色）

| 现值 | 令牌 |
|---|---|
| `#0f172a` / `#1f2937` / `#334155` / `#475569` | `var(--content-primary)` 或 `var(--content-secondary)` |
| `#64748b` / `#52647a` / `#5b6b80` / `#7a8aa0` | `var(--content-muted)` |
| `#94a3b8` / `#c4ccd8` | `var(--content-disabled)` 或 `var(--border-strong)` |
| `#dbe2ef` / `#dbe3ee` / `#e2e8f0` / `#cbd5e1` | `var(--border-subtle)` |
| `#f8fafc` / `#f1f5f9` | `var(--surface-sunken)` |
| `rgba(148,163,184,α)` | `var(--border-subtle)` / `var(--content-disabled)`（视属性而定） |
| `rgba(15,23,42,α)` / `rgba(2,6,23,α)` / `rgba(30,41,59,α)` | 阴影改用 `--elev-*`；文字 alpha 改用 `color-mix(in srgb, var(--content-primary) N%, transparent)` |
| `rgba(0,0,0,α)`（遮罩、阴影） | 遮罩用 `color-mix(in srgb, #000 N%, transparent)`；阴影用 `--elev-*` |

### B3. blue 家族（强调色残留，必须响应切换）

| 现值 | 令牌 |
|---|---|
| `#2563eb` `#1d4ed8` `#1e3a8a` `#0f3f8c` `#3b82f6` | `var(--accent)` |
| `#dbeafe` `#eff6ff` `#bfdbfe` | `var(--accent-soft)` |
| `#60a5fa` `#93c5fd` | `var(--accent)`（描边场景）或 `var(--accent-soft)` |
| `rgba(37,99,235,α)` `rgba(59,130,246,α)` `rgba(96,165,250,α)` | `--accent-ring` 或 `color-mix(in srgb, var(--accent) N%, transparent)` |

### B4. 状态色家族（碎片化最严重：红系 25 个、绿系 9 个、黄系 7 个不同取值）

| 现值 | 令牌 |
|---|---|
| `#fef2f2` `#fff1f2` `#fff4f4` `#fee2e2` `#3a1f27` | `var(--state-danger-tint)` |
| `#fecaca` `#fca5a5` `#5f1d24` | `var(--state-danger-border)` |
| `#dc2626` `#ef4444` `#b91c1c` `#991b1b` `#7f1d1d` `#3f0b0b` `#f87171` | `var(--state-danger-fg)` |
| `rgba(220,38,38,α)` `rgba(248,113,113,α)` `rgba(185,28,28,α)` `rgba(127,29,29,α)` `rgba(252,165,165,α)` `rgba(239,68,68,α)` | `var(--state-danger-soft)` |
| `#f0fdf4` `#dcfce7` `#0f2a1d` | `var(--state-ok-tint)` |
| `#86efac` | `var(--state-ok-border)` |
| `#16a34a` `#166534` `#4ade80` | `var(--state-ok-fg)` |
| `rgba(22,163,74,α)` `rgba(74,222,128,α)` `rgba(34,197,94,α)` | `var(--state-ok-soft)` |
| `#fef3c7` | `var(--state-warn-tint)` |
| `#fbbf24` `#fde68a` | `var(--state-warn-border)` / `-fg` |
| `#d97706` `#92400e` | `var(--state-warn-fg)` |
| `rgba(245,158,11,α)` `rgba(251,191,36,α)` `rgba(120,53,15,α)` | `var(--state-warn-soft)` |

深色档会在令牌层自动接管，**所有为深色手写的状态色字面量直接删除**（含 `#3a1f27`、`#5f1d24`、
`#0f2a1d`、`#25161d`、`#13243f`、`#5f1d24`、`#3a1f27` 等），令牌已取同一值，视觉不变。

### B5. 装饰性渐变（`WebViewPanel.css:190-247`）

这是一个拟物 3D 加载球：`radial-gradient` 组合 + `#c2babb` / `#d7c4be` 光晕 + `#353535` / `#090909`。
它同时违反「零装饰」「单一中性色阶」「唯一强调色」三条规则，且在深色下也用的是浅色光晕。

处理：删除整段，替换为一个单色 spinner —— `var(--border-subtle)` 轨道 + `var(--accent)` 弧线，
动画长度取 `--duration-slow` 并循环。同文件 `:104` 的蓝色进度条渐变改为 `var(--accent)`。

### B6. 逐文件补充

| 文件 | 额外动作 |
|---|---|
| ~~`Sidebar.css`~~ | **文件已删**（§4.2 死样式表，零 import）。开工时列的「90 个深色块 / 圆角 `10px` / `140ms` / `font-size: 10px`」**全部随文件消失，无需迁移**。 |
| ~~`App.css:19`~~ | **文件已删**。原 `font-family: "Segoe UI"…` 的第二套字体栈问题随之消失；启动屏的字体内联已改写为与 `--font-sans` 一致的序列（`index.html`，唯一豁免处）。 |
| ~~`App.css`~~ | **文件已删**。原 `z-index: 3000/3200/3500/3600` 的「魔法层级」不存在了 —— 那是死代码里的数字，从来没有进过构建。`--z-*` 令牌因此**不再需要**（见 design-system §9）。 |
| `PDFViewer.css` | 64 个不同色值全部收敛；`font-size` 上调（现实测仅余 `13px`×4 需吸附、`10.5px`×1 需上调到 11px）。 |
| ~~`MarkdownEditor.css`~~ | **文件已删**。原 `#1e1e1e` 代码块底色的处理方案不再需要。 |
| `WebViewPanel.css` | 原 `WebViewPanel.css:190-247` 那段拟物 3D 加载球（B5）已删除，替换为单色 spinner。 |

---

## 阶段 C：TSX 调色板类 → 令牌

原则：**同时删除该元素的 `dark:` 链** —— 令牌已处理深浅色，`dark:` 只留给真正需要结构性差异的情况。

### C1. 旧灰阶（223 处）

| 现值 | 令牌 |
|---|---|
| `slate-*` / `gray-*` 50 / 100 | `bg-surface-sunken` |
| `gray-200` / `slate-200` | `border-border-subtle` |
| `gray-300` / `slate-300` | `border-border-default` |
| `slate-400` / `gray-400` | `text-content-disabled` |
| `slate-500` / `gray-500` | `text-content-muted` |
| `slate-600` / `gray-600` / `gray-700` | `text-content-secondary` |
| `slate-800` / `gray-800` / `gray-900` / `gray-950` | `text-content-primary` |
| `blue-50` / `blue-100` | `bg-accent-soft` |
| `blue-200` / `blue-300` | `border-border-default` |
| `blue-600` / `blue-700` | `text-accent` |

主要落点：`StartPage.tsx`（87 处，其中 0 个 zinc）、`MarkdownViewer.tsx`（136 处）。

### C2. 状态色（46 处）

| 现值 | 令牌 |
|---|---|
| `red-50` / `red-100` | `bg-state-danger-tint` |
| `red-200` / `red-300` | `border-state-danger-border` |
| `red-400` / `red-500` / `red-600` / `red-700` / `red-900` / `red-950` | `text-state-danger` |
| `emerald-400` / `emerald-500` / `emerald-600` | `text-state-ok` |
| `amber-300` / `amber-400` / `amber-600` / `amber-800` / `amber-950` | `text-state-warn` / `--state-warn-*` |
| `yellow-*` | `text-state-warn` |

主要落点：`PDFViewer.tsx`(24)、`Library.tsx`(11)、`Settings.tsx`(8)、`MarkdownViewer.tsx`(3)。
这几处**灰阶已经是 zinc**，只需处理状态色，是成本最低、收益最直接的一批。

---

## 阶段 D：结构性问题（非颜色，但同样属于设计系统）

开工时列了 10 项。逐项结账（**「作废」= 当初的判据建立在死代码上，问题根本不存在**）：

| # | 项 | 结论 |
|---|---|---|
| 1 | 侧栏强调色不响应切换（曾判为「功能性缺陷」） | **作废。** 判据是 `Sidebar.css` 的 `.rail-btn:hover/.active` 写死 `#dbeafe`/`#1d4ed8` —— 而该文件零 import、从未进过构建。真实侧栏由 Tailwind 重写、已走 `--accent`。 |
| 2 | 顶栏字体栈与主体不一致 | **已解决。** `App.css`（第二套 `Segoe UI` 栈）已作为死样式表删除；`index.html` 启动屏内联栈已改写为与 `--font-sans` 一致。 |
| 3 | `--bg-primary` 语义反转 | **已修**（刻意变更 ①），改为 `var(--surface-app)`。 |
| 4 | 默认强调色两处不一致（`#18181b` vs `#52525b`） | **已修。** 真相只有一处：`src/theme/accent.ts`。`zinc` 是唯一随主题反相的选项（浅色 `#18181b` / 深色 `#f4f4f5`），`resolveAccentToken()` 负责这件事；`ACCENT_TOKENS.zinc.solid`（`#52525b`）**只作 Settings 色板圆点的示意色**，不是注入值 —— 已在代码里写明，避免再被误读成「同一个值」。`tokens.css` 的兜底值同步改为浅色 zinc `#18181b`（原 `#52525b` 恰是修复前被烧死的那个灰）。`index.css` 兼容块已整段删除。 |
| 5 | `ThemePalette` 死代码 | ✅ **已处理。** 删掉了 `userSettings.ts` 里的 `export type ThemePalette`、`UserSettings.themePalette` 字段、`DEFAULT_SETTINGS.themePalette`、以及 `sanitizeUserSettings` 的校验与返回。`legacyAccentMigration` 的**判断保留但改了取法**：从 `(parsed as { themePalette?: unknown }).themePalette` 读这个已不属于当前 schema 的历史字段 —— 直接删会让「当年用默认 blue、且还没落盘过 palette」的老用户永远停在 blue。全仓现仅剩文档叙述，无代码引用。 |
| 6 | `blue` 仍是合法选项 | **保持不变。** `Settings.tsx` 的 `accentOptions` 六项（zinc/blue/green/orange/rose/violet）与 `ACCENT_TOKENS` 一一对应，全部走运行时注入 → 与第 1 条已解耦，蓝色现在也正确响应。 |
| 7 | 字号越界（`Sidebar.css` 20 处 `10px` / 2 处 `9px`） | **作废＋已收口。** 越界值随死文件消失；现实测仅余 `10.5px`×1（上调 11px）、`13px`×4（吸附 12/14px）。 |
| 8 | 圆角刻度外取值 `7px`(15) / `9px`(5) / `10px`(14) / `14px`(2) | **大部分作废。** 原数字几乎全来自死文件；现实测只剩 `5px`/`10px`/`11px` 各 1 处。 |
| 9 | `z-index` 魔法数字「38 处 / `-1…10000`」 | **改为「刻意不做令牌化」。** 现实测 19 处，其中 11 处是页面内部层叠上下文（`0-9`，本就不该全局化）；跨组件浮层值不一致（`20/100/120/130`）需**先收敛再谈 token**。理由见 design-system §9，`--z-*` 已删除。 |
| 10 | `PDFViewer.tsx` / `App.tsx` 单文件过长，缺组件层 | ✅ **已处理。** 两件债分开结的：① **组件层** —— `src/ui/` 已建立 8 个文件（`Button` / `IconButton` / `TextInput` / `Textarea` / `Select` / `Card` / `fieldStyles` / `cn`），`Settings.tsx` 已全量迁移，`dark:` 由 73 处降到 **0**；② **文件拆分**（2026-10-04）—— `PDFViewer.tsx` **5509 → 3684 行**，拆出 4 个文件，见 §7.7。两件债的判据不同：组件层解决「新界面不再长出第二份真相」，文件长度解决「读代码的成本」。右侧批注面板（约 1600 行，抽出去需 34 字段 props bag）**未拆**，属判断题。 |
| 11 | **强调色注入点错层（本轮新发现，P0）** | ✅ **已修。** `App.tsx` 曾把 `--reader-accent*` 注入在 `#root > div`，而 `tokens.css` / `@theme` 的所有派生值都在 `:root` 求值 → 全被烧成兜底灰并继承给后代。实测：选 green 时外壳是 `#059669`，`:root --accent` 却是 `#52525b`，`bg-accent` 渲染为 `rgb(82,82,91)`。**受影响 69 处声明**（PDFViewer.css 59 / WebViewPanel.css 7 / ReadingAssistMenu.css 3）—— 即「强调色能点，界面永远不变」。改为 `useLayoutEffect` 写到 `documentElement`；复验 `:root --accent = #059669`。修完顺带把焦点环恢复为 `:root` 派生（§4 ⑨），并删掉 `index.css` 的 26 行死兼容层（§4 ⑩）。 |
| 12 | **契约门禁长期失效（本轮新发现）** | ✅ **已修。** `PDFViewer.tsx` / `App.tsx` 在某次改动中被压缩了空格（`x = "y"` → `x="y"`，`? "a" : "b"` → `? "a":"b"`，共 361 处 `= "` / `= \``），而这些契约脚本全部用**逐字符精确**的 `src.includes("a = b")` 匹配。后果是双向静默：正断言失败（门禁变红）、负断言放行（禁止写法拦不住）。`npm run check:contracts` 的 16 条里有 **6 条**同时失效，自 2026-10-03 起一直是红的 —— 等于全部契约零约束。修法：新增 `scripts/lib/source-view.mjs`，源码一律经 `view()` 做**忽略空白**比较（对负断言是增强，原先要求精确换行的写法现在任何空白变体都能抓到），并把 `view()` 自身纳入门禁（`check:source-view` 自检「既不空转也不误判」）。门禁现 **EXIT=0**。顺带发现：`ACCENT_TOKENS.zinc` 的注释与 `tokens.css` 兜底值都声称与注入值一致，实际不然 —— 已一并更正。 |
| 13 | 白板节点调色板重复定义 | ✅ **前半已处理，后半待决策。** 已抽到单一出口 `src/theme/boardPalette.ts`（`BOARD_PALETTE` + `BOARD_COLOR_ORDER` + `CardColor`），两个组件改为消费它。**零视觉变化**：统一取的是 `WhiteboardCanvas` 那份（`fill` alpha 0.98）；`Whiteboards` 那份的 `fill` / `text` 字段原本就没有消费者（色板选择器只读 `chip` / `border`），所以那个 0.96 从未被渲染过。**仍待决策**：`stone` / `slate` / `olive` 三个非 zinc 中性色阶 —— 它们是**内容分类色**（用户给卡片选的颜色）而非 UI 表面色，是否收敛需要产品判断，且收敛会让已有白板的卡片变色。 |
| 14 | `--chrome-*` 兼容别名 | ✅ **已删除（2026-10-04）。** `tokens.css` 里的 `--chrome-surface-1..4` / `--chrome-text` / `--chrome-muted` / `--chrome-border` / `--bg-primary` / `--text-primary|secondary|tertiary` / `--accent-primary|light|hover` 整段删除 —— 最后一个引用者已随 §7 的 470 处 `dark:` 配对迁走。共替换 106 处（`tokens.css` / `PDFViewer.css` / `WebViewPanel.css` / `ReadingAssistMenu.css` / `MarkdownViewer.tsx`，其中 10 处冗余的 `var(--chrome-x, var(--fallback))` 双层兜底一并简化）。全仓现无任何 `--chrome-` 引用。**唯一色源 = `tokens.css`。** |
| 15 | **`dark:` 配对未纳入守卫** | ✅ **已处理（2026-10-04）。** 新增**规则 4**（TSX 里 `dark:` + zinc/white/black 的颜色配对 → 违规，棘轮，基线已 `{}`）与**规则 5**（TSX/TS 里任何 zinc/white/black 工具类，**含只有一份值的** → 硬失败，不设基线，扫描范围从 `.tsx` 扩到 `.ts`）。两条不重复计数。全量迁移 470 处后两条同时归零，见 §7、§8。 |

---

## 3. 接入守卫

`scripts/check-design-tokens.mjs` 采用**基线模式**：只对「新增违规」失败，不会一次性卡死既有代码。

```jsonc
// package.json
"check:design-tokens": "node scripts/check-design-tokens.mjs",
"check:source-view": "node scripts/lib/source-view.mjs",   // 契约守卫自身的自检
"check:contracts": "npm run check:source-view && ... && npm run check:design-tokens && npm run check:backend"
```

命令：

```bash
node scripts/check-design-tokens.mjs                    # 按基线比对，有新增违规则失败
node scripts/check-design-tokens.mjs --report           # 只看分布，不判失败
node scripts/check-design-tokens.mjs --update-baseline  # 迁移推进后重新冻结基线
node scripts/lib/source-view.mjs                        # 自检「忽略空白匹配」既不空转也不误判
```

注意：基线是**棘轮，只准往下走**。当数值降到 0 时就自动变成零容忍（当前正是如此 ——
基线文件是 `{}`）。在到 0 之前不要一次性删掉基线，否则 `npm run verify` 会立刻红灯。

> **基线要跟着收紧。** 本仓走完了这条路径：10 → 9（两处 `color: white` 改 `var(--accent-on)`）
> → 0（剥注释 + 收编刻意白 + 修真缺陷）。每次降低后立即 `--update-baseline` 冻结。
> 反过来，改造前先冻结基线等于把违规标成「允许」，守卫从此永不提醒。
>
> **但数字降低不等于质量提升。** 从 10 降到 9 时看起来「只剩豁免」，逐行核对才发现
> 里面藏着 1 处对比度缺陷 + 4 处漏迁。**冻结基线之后必须逐行核对剩余项。**

> **守卫自己也会烂，而且烂得无声。** 本项目实测：16 条契约里 6 条因源码被压缩空格而同时失效
> （详见阶段 D 第 12 项），`check:contracts` 从 2026-10-03 起一直红着。所以：
> - 契约脚本一律用 `scripts/lib/source-view.mjs` 的 `view()` 读源码，不要裸用 `readFileSync(...)`
>   + `includes()`。
> - `view()` 自带 `--self-test`（`npm run check:source-view`），且已接进 `check:contracts` 首位。
> - 新增/修改契约后，**必须对旧版本源码跑一次**确认真能失败 —— 「注入违规实测」是必做项，
>   不然写下的可能是永远为真的空断言。

---

## 4. 退出标准

| 里程碑 | 判据 |
|---|---|
| M1 令牌层接入 | ~~`index.css` 加入 import 后视觉无变化~~ **这个判据是错的，已作废**：tokens.css 是**无层级**规则，`index.css` 的 `--chrome-*` 在 `@layer base` 内，层级先于权重，所以接入即生效。正确判据是「接入后逐条核对 §4 刻意变更表」 |
| M2 状态色收敛 | `PDFViewer.tsx` / `Library.tsx` / `Settings.tsx` 基线归零（-43 处） |
| M3 旧灰阶收敛 | `StartPage.tsx` / `MarkdownViewer.tsx` 基线归零（-223 处） |
| M4 CSS 收敛 | 所有 `.css` 基线归零（-439 处）；`index.css` 与 `tokens.css` 保持豁免 ✅ **已达成，基线为 `{}`（零容忍）**。归零过程见 design-system §4 第三批：最后 9 处里 1 处是注释假阳性（守卫已改为剥注释）、3 处是刻意白（由 `--surface-paper` 收编）、1 处对比度缺陷、4 处漏迁。 |
| M5 结构性问题 | 阶段 D 表里除「未处理」外的各项完成；切换 6 种强调色后全界面无残留 ✅ 已达成（D1/D2/D7/D8 作废；D3/D4/D5 已修；D6 本就不需动；D9 改为刻意不做；**D11 注入点已修**） |
| M6 组件层 | `src/ui/` primitive 建立，主要长 className 常量已迁入 ✅ 已达成（9 个文件：`Button` / `IconButton` / `TextInput` / `Textarea` / `Select` / `Card` / `fieldStyles` / `cn` / 出口；`Settings.tsx` 全量迁移，`dark:` 73 → 0）。**未含**：`App.tsx` 的文件拆分（`PDFViewer.tsx` 已于 2026-10-04 拆分，见 §7.7） |
| M7 完成 | 基线文件只剩 2 个豁免项或整体删除；`npm run verify` 绿灯 ✅ **基线已清空为 `{}`**（比「只剩 2 个豁免项」更彻底）；`check:contracts` 现 **EXIT=0** |
| **M8 令牌与代码对齐** | **tokens.css 里没有零外部引用的令牌；每个刻度都能指出代码里对应的实例** —— 见 §6 |
| M9 焦点可视 | 全应用一条 `:focus-visible` 规则覆盖所有可交互元素；无裸 `focus:outline-none` ✅ 已达成（见 design-system §8.1） |
| **M10 门禁真的在拦** | `npm run check:contracts` **EXIT=0**，且每条契约都能指出它「在旧版本上会失败」的证据 ✅ 已达成（本轮修好 6 条失效契约；`check:source-view` 自检已接入首位） |

---

## 5. 迁移时的三个注意点

1. **不要重定义 Tailwind 的刻度**。`--radius-*` / `--text-*` / `--spacing` 一旦改值，
   所有 `rounded-*` / `text-*` / `p-*` 的既有尺寸会一起变。令牌层只做**别名与派生**，
   已通过编译验证：`--radius-lg` 仍为 `0.5rem`、`--text-sm` 仍为 `0.875rem`。
2. **深色只保留一种机制**。`App.tsx` 的主题副作用同时设 `.dark` 类与 `data-theme` 属性，
   这是必要的（Tailwind `dark:` 认类，手写 CSS 认属性）。令牌层用一个 `:where()` 选择器
   同时覆盖两者，迁移后各文件不应再出现新的 `[data-theme="dark"]` 块。
3. **不要把运行时注入的变量包成全局令牌**。`--reader-accent*` 由 `App.tsx` 注入在
   `#root > div`，`:root` 看不到它；自定义属性在**声明处**就完成 `var()` 代入，
   继承下去的是常量。所以在 `:root` 写 `--x: var(--reader-accent, FALLBACK)`
   等于把 `--x` 烧成 FALLBACK。需要跟随强调色时，在**使用处**直接写
   `var(--reader-accent, …)`。详见 design-system §4.1 陷阱一。

---

## 6. 令牌与代码对齐（M8 依据）

「令牌必须与代码一致」是本轮最花时间的一课。做法固定为三步：

1. **穷举引用图谱**：扫描全仓 `var(--x)`，把 `tokens.css` 里每个 `:root` 定义分成三类 ——
   ① 被外部文件引用；② 仅被 `@theme` 别名自引用；③ 完全无引用。只保留 ①，
   ②要判断别名是否真的生成过被使用的工具类，③直接删。
   判定「工具类是否被使用」**必须查 `src/`，不能查 `dist/`** ——
   Tailwind v4 会把 `docs/*.md` 里的类名也编进产物，`dist` 里有这个类不证明代码在用
   （实测 `border-border-strong` 就是这么混进去的）。
2. **删除后必须差分验证**：不是「看着没问题」，而是「新旧两版构建 + 同一 DOM 逐选择器比对计算值」。
3. **删除时要防「同特异度兄弟接管」**：删掉 `[data-theme="dark"] .a` 这类规则后，
   同层的更宽泛深色规则（`.a` 本身）会顶上来，颜色就变了。判据：若存在**深色**规则，
   其选择器类名集合是待删规则的**真子集**，则该声明不能删。

本轮据此删掉的「想当然刻度」：

| 删除项 | 数量 | 依据 |
|---|---|---|
| `--palette-accent-{blue,green,orange,rose,violet}` | 5 | 与 `App.tsx` 的 `ACCENT_TOKENS` 重复，第二处真相 |
| `--space-*` 家族 | 9 | 0 引用；且与实际代码的 **2px 半步**尺度不符，凑不进 4px 网格 |
| `--z-*` 家族 | 11 | 0 引用；值与实际 `80/90/120/130` 全不符（见 design-system §9） |
| `--state-*-soft` | 3 | ok/warn 零消费者、danger 已被 `color-mix` 派生取代 |
| `--text-title` / `--leading-reading` / `--text-*-leading` / `--ease-in` 等 | 8 | 代码里**没有任何对应实例** |
| `--border-strong`（描边第 3 档） | 1 | `border-border-strong` 工具类全仓零实例；「聚焦前态」的用途已被焦点环取代 |
| `--elev-raised/overlay/modal` → `--elev-sm/md/lg/xl` | 3→4 | 旧三档与代码实际阴影**一个都对不上**（仅 1 个消费者，其余 12 处各写各的）；新四档按代码实测归纳 |

留下的刻度都必须能**指出代码里的实例**：`--text-caption/ui/body`（各有引用）、
`--leading-ui`（界面行高）、`--duration-*` / `--ease-*`（各有引用）、
`--elev-sm/md/lg/xl`（4 档对应 12 处手写阴影）、`--state-*` 三段式（各有引用）、
描边 2 档（`border-border-subtle` / `border-border-default`，各有引用）。

> 反面教材：`--elev-raised` 定义成 `0 1px 2px rgba(24,24,27,.06)`，
> 而代码实际用的是 `0 1px 3px rgba(15,23,42,.10)` —— 令牌与代码不一致时，
> 令牌不是「单一来源」，而是**第二处需要维护的谎言**。刻度要从代码实测归纳，不能先建后凑。

---

## 7. `dark:` 配对迁移（470 → 0，已完成）

### 7.1 为什么它要单独立项

守卫的规则 1 只扫 **CSS 字面量**、规则 2 只扫 **TSX 的非 zinc 调色板类**，都不扫
`bg-zinc-50 dark:bg-zinc-950` 这种**「同一属性的深浅两份真相」**。所以「基线归零」
只说明「没有裸字面量了」，**不说明「深色不再靠手工配对」**。

### 7.2 闸门（规则 4，2026-10-04 建立）

TSX 里 `dark:` 后接 zinc / white / black 的**颜色工具类** → 违规。

- 只认颜色工具类（`bg` / `text` / `border` / `ring` / `divide` / `fill` / …），
  因此 `dark:prose-invert` 这类**不可令牌化**的变体不会被误判 —— 实测 `Card.tsx` /
  `Button.tsx` / `StartPage.tsx` / `Settings.tsx` 里残留的 `dark:` 全属此类，规则零误报。
- 允许 `dark:` 后还有别的变体前缀：`dark:hover:bg-zinc-800` / `dark:disabled:bg-zinc-800` 一并抓。
- **基线拆成两个独立闸门**：`literalColors`（规则 1/2，当前 `{}` 零容忍）与
  `darkNeutralPairs`（规则 4，棘轮）。拆开是为了不让 400+ 的数字**掩盖**「字面色值已归零」
  这个事实 —— 这正是 §3 那条教训（基线计数会掩盖真状态）的第二次应用。
- 基线文件结构随之升级为 `{ literalColors, darkNeutralPairs }`，读取时兼容旧的扁平格式。
- 已实测：注入含 `dark:bg-zinc-800` 的临时文件 → EXIT=1；删除后 → EXIT=0。

### 7.3 进度（守卫口径，以基线为准）

| 文件 | 原始 | 现状 | 迁移批次 |
|---|---:|---:|---|
| `PDFViewer.tsx` | 214 | **0** | 3 |
| `Whiteboards.tsx` | 131 | **0** | 2 |
| `Library.tsx` | 44 | **0** | 2 |
| `WebBrowser.tsx` | 17 | **0** | 2 |
| `WhiteboardCanvas.tsx` | 1 | **0** | 2 |
| `Sidebar.tsx` | 23 | **0** | 1 |
| `Tabs.tsx` | 22 | **0** | 1 |
| `ContextMenu.tsx` | 9 | **0** | 1 |
| `MarkdownViewer.tsx` | 4 | **0** | 1 |
| `App.tsx` | 5 | **0** | 试点 |
| **合计** | **470** | **0** | 基线现为 `{}` |

> 口径说明：本表用守卫的规则 4 计数（470），与旧版 grep 口径（468）略有出入
> （如 `Tabs.tsx` grep 到 20、规则 4 得 22）。**以守卫为准** —— 守卫同时是门禁，
> 它的数字才有约束力。

### 7.3.1 第 3 批（`PDFViewer.tsx`）顺带挖出的第二类残留

迁完 214 处配对后，`grep` 复检时发现同一文件里还有 **16 处「单值中性色」** ——
只写一份值、没有 `dark:` 配对，因此**规则 4 压根扫不到**。它们比配对更危险，因为
「一份值」意味着浅深共用，必然在某一侧不成立。逐处核对后确认其中两处是**真缺陷**：

| 位置 | 写法 | 症状 |
|---|---|---|
| 缩略图骨架块 | `bg-zinc-100` | 深色下是一块 **#f4f4f5 的近白方块**（页面还在渲染时最显眼） |
| 保存批注按钮 | `text-white` + `style={{backgroundColor: "var(--reader-accent)"}}` | 深色 + zinc 强调色时强调色是 #f4f4f5，**白字完全看不见** |

其余 14 处是 `text-zinc-400` / `text-zinc-500` 这类元信息文字 → `text-content-muted`
（浅色下对比度 2.5:1 → 4.6:1，同为修正）。另外删掉一处**冗余**的 `text-white`——
批注气泡的文字色由 `getAnnotationOverlayStyle` 的 inline style 给出（气泡刻意恒为深色，
因为它坐在不会随主题反色的 PDF 纸面上，见 `tokens.css` 的 `--surface-paper` 说明）。

这次发现直接催生了新的**规则 5**（见 §8）。

### 7.4 迁移口径：三类写法，不是三类同义换名

逐处核对后发现这些配对里混着三种形态，**它们的处理方式不同**：

1. **逐值精确** —— 浅深两态都与某个令牌逐值相等（≤2/255 容差）。直接换，零视觉变化。
2. **中间档** —— 令牌层没有对应值（`text-zinc-400` 在 `content-muted`(#71717a) 与
   `content-disabled`(#a1a1aa) 之间）。收敛**必然**位移。
3. **浅深不对称 / 反相** —— 如 `bg-zinc-100 dark:bg-zinc-950`（浅色取内凹档、深色取应用档），
   或 `bg-zinc-900 dark:bg-zinc-100` + `text-white dark:text-zinc-900`（反相徽标）。
   后者还暴露出**同一个模式两处深浅值不一致**（侧栏 logo 用 `zinc-900`、Markdown 按钮用 `zinc-950`），
   这正是新增 `--content-inverse` 的直接原因。

### 7.5 位移登记（36 条，Δ = sRGB 单通道最大差）

**第 1 批（58 处 / 13 条 Δ）** —— 明细见上一版记录，此处只留结论：

| 映射 | 位移 | 判断 |
|---|---|---|
| `text-zinc-800 dark:text-zinc-200` → `text-content-primary` | 浅 15 · 深 16 | 更强调 |
| `text-zinc-600 dark:text-zinc-400` → `text-content-secondary` | 浅 19 · 深 53 | 层级更清（原深色下与分组标题同色） |
| `text-zinc-400 dark:text-zinc-500` → `text-content-muted` | 浅 46 · 深 48 | **对比度修正**：浅色 2.5:1 → 4.6:1（AA） |
| `text-white dark:text-zinc-900` → `text-content-inverse` | 深 15 | 与 Markdown 按钮统一，反相更纯粹 |
| `bg-zinc-100 dark:bg-zinc-950` → `bg-surface-sunken` | 深 6 | 极细微 |
| `bg-white dark:bg-zinc-800`（favicon 衬底）→ `bg-surface-panel` | 深 15 | 深色下衬底融入标签底 |
| `hover:bg-zinc-100 dark:hover:bg-zinc-800(/50)` → `hover:bg-surface-hover(/50)` | 浅 16 | hover 略明显 |
| `disabled:bg-zinc-300 dark:disabled:bg-zinc-800` → `disabled:bg-surface-hover` | 浅 16 | 禁用视觉更轻 |
| `disabled:text-zinc-500 dark:disabled:text-zinc-500` → `disabled:text-content-muted` | 深 48 | 禁用文字在深色下更亮 |

**第 2 / 3 批新增的 Δ（探针实测，全部 ≤ 22/255）** —— 值得单独记住的几条：

| 映射 | 位移 | 判断 |
|---|---|---|
| `bg-zinc-200/50 dark:bg-zinc-950/50`（画布底）→ `bg-surface-sunken/50` | 浅 16 · 深 6 | 跨档（浅色取 hover 档、深色取应用档），取中间档 |
| `bg-surface-panel/60 dark:bg-zinc-950/60`（加载遮罩）→ `bg-surface-panel/60` | 深 15 | 遮罩与面板同色更合理 |
| `bg-zinc-50 dark:bg-zinc-900`（卡片内引用块）→ `bg-surface-sunken` | 浅 6 · 深 9 | 极细微 |
| `bg-zinc-100 dark:bg-zinc-800/80`（选中缩略图）→ `bg-surface-hover/80` | 浅 17 | 选中态统一走 hover 档 |
| `border-zinc-900/75 dark:border-zinc-100` → `border-content-primary/75` | 深 alpha 0.25 | 原来深色是纯色、浅色带 75% —— 统一为带 alpha |
| `bg-zinc-300 dark:bg-zinc-700`（竖分隔线）→ `bg-border-default` | **0（逐值精确）** | |
| `bg-surface-panel dark:bg-zinc-900` → `bg-surface-panel` | **0（逐值精确）** | 深色两侧都是 #18181b |
| `bg-zinc-50/60 dark:bg-zinc-950/60` → `bg-surface-app/60` | **0（逐值精确）** | |
| `focus:ring-zinc-400 dark:focus:ring-zinc-600` → `focus:ring-border-strong` | **0（逐值精确）** | 为此把删掉的第三档描边按需补回 |

> 最大位移（Δ 46/48）**都是修正**：原写法浅色下只有 2.5:1，不到 AA。
> 其余位移在 6–22/255，方向统一（更像主要内容 / 层级更清），没有一处降低可读性。
>
> 这些位移已在 `scripts/design-diff/cases/dark-migration.json` 里标记 `acceptedDrift`，
> 探针会**继续打印成 Δ** 但不让门禁失败 —— 记录「这里变过、变多少、是哪个决定造成的」，
> 半年后比「测试是绿的」值钱。

> ⚠️ **例外：工具按钮激活态是唯一保留的「令牌级 `dark:`」。**
> `ToolButton` 的激活态浅色写 `bg-surface-panel`（#fff + shadow 表示「浮起」）、
> 深色写 `dark:bg-surface-active`（#3f3f46 表示「填亮」）—— 两种主题的区分手段不同，
> Token 层无法用单一值表达。守卫只拦 `dark:` + zinc/white/black，故它能通过；
> 若哪天想彻底消掉，得先设计一个「激活填充」语义令牌（代价是浅色下会从白变灰、
> 属于可见变更，需单独确认）。

### 7.6 验收方式

用 `probe.mjs` 的 `comparisons` 模式，把「旧 class 串 → 新令牌类」写成 `cases/*.json`，
浅深两态下逐属性比对。它内置颜色归一化与 ≤2/255 容差，只把**真位移**报出来。

**伪类不是盲区**：`hover:` / `disabled:` 只加激活条件、不改声明值，所以只要比较
**去掉伪类前缀**的等价类（`bg-surface-hover` 对 `bg-zinc-200 dark:bg-zinc-800`），
就能证明 `hover:` 那处等价。本次 24 条 comparison 里有 8 条是这么覆盖的。

### 7.7 `PDFViewer.tsx` 文件拆分（✅ 2026-10-04 已完成）

拆分前的判断与执行顺序：

**迁移与拆分原本建议合做**（理由是「读懂成本只付一次」）。实际执行时**先做了迁移**——
因为门禁一旦立起来，拆分就不再是「顺便迁 214 处」的捆绑任务，而是可以独立排期、
独立验证的重构；反过来若先拆，拆出的新组件里仍会带着旧 class 串，反而增加核对面。

拆分结果（5509 → 1 + 4，纯搬运、零逻辑改动）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `PDFViewer.tsx` | 3684 | 主体（保留原名，仍是入口） |
| `pdfReader/readerCore.ts` | 1166 | 共享类型 + 纯函数（无 React 依赖，依赖方向单向） |
| `pdfReader/PageCanvas.tsx` | 541 | 逐页画布渲染（含唯一一处 `classList` 用法） |
| `pdfReader/PageThumbnail.tsx` | 197 | 缩略图 |
| `pdfReader/ToolButton.tsx` | 32 | 工具条按钮 |

**正确性判据用编译器，不靠读代码**：`tsconfig` 的 `noUnusedLocals` / `noUnusedParameters`
把「搬走后遗留的未使用 import」和「漏搬的符号」都变成硬错误，迭代收敛（277 → 9 → 0 条）。
`tsc --noEmit` 通过是拆分的验收门。

**右侧批注面板（约 1600 行的三个 side-panel view）这次没拆。** 实测它是纯展示、零 hook，
但要抽出去需要传一个 **34 字段的 props bag** —— 那会把「一个文件太长」换成
「一个接口太宽」，属判断题而非机械题，留给产品侧决定是否值得。
（详见 `docs/design-system.md` §11.4。）

**守卫需要同步改读法。** 有 4 条契约守卫的断言跨在这个模块里
（`pdf-virtualization` 14 条 / `image-index` 3 条 / `reading-assist` 3 条 /
`translation-race` 1 条），拆分后若继续只读 `PDFViewer.tsx`，这 **31 条会全部变红**
而功能其实没动。解法是新增 `scripts/lib/reader-view.mjs`，把模块当整体读
（`readerView()` 自动并集 `PDFViewer.tsx` + `pdfReader/` 下所有 `.ts`/`.tsx`），
只在需要 `indexOf` 先后顺序的断言上点名具体文件。

顺带发现并修掉一条**用死 CSS 做担保**的断言：`assert(styles.includes("isolation: isolate"), …)`
的唯一宿主 `.page-stack` 在 HEAD 的 src、拆分后的 src、产物里**三处零消费者**，
它过去绿并不代表选择域真被隔离。已作废并换成「选择域类必须有活消费者」的存活断言，
真正的选择隔离由相邻几条绑在活规则上的断言承担。详见 `docs/design-system.md` §11.3。

---

## 8. 闸门 5：单值中性色（2026-10-04 建立，零容忍）

规则 4 只抓「`dark:` + 中性色」的**配对**，抓不到「只写一份值」——
而后者是同一个病的另一种形态：一份值意味着浅深共用，必然在某一侧不成立。
第 3 批迁移时实测抓到 2 处真缺陷（近白方块、白字不可见，见 §7.3.1），
于是把这条也变成了门禁。

- **判定方式**：先摘掉规则 4 已覆盖的 `dark:` 配对，再看剩余文本里还有没有中性色工具类。
  这样两条规则不重复计数，「配对已归零」与「单值也已归零」各算各的。
- **不设基线**：全仓已归零，直接硬失败（与规则 3 孤儿样式表同级），不给「先冻结再收」的余地。
- **扫描范围从 `.tsx` 扩到 `.ts`**：类名也会出现在 `.ts` 里（如 `src/ui/fieldStyles.ts`），
  规则 4 之前漏了这方面（实测 `.ts` 里目前只有文档注释，但覆盖面补齐了）。
- **刻意不随主题翻转的白怎么办**：补一个语义令牌，而不是在这里开豁免。
  已有先例 `--surface-paper`（PDF 纸面）与批注气泡（inline style 恒深色 + 恒白字，
  在 `getAnnotationOverlayStyle` 里写了注释说明）。**"加令牌"是正确答案，"加例外"不是。**
- 已实测：注入 `bg-white`（无 `dark:`）→ EXIT=1；删除 → EXIT=0。

---

## 9. 收尾清理（2026-10-04）

§7 的 470 处配对归零、§8 的单值闸门立起来之后，剩下三件「迁移的尾巴」一次做完。

### 9.1 规则级死代码（见 design-system §4.6）

| 文件 | 行数 | 唯一选择器 | 删除 |
|---|---|---|---|
| `PDFViewer.css` | 1569 → 260 | 120 → 35 | 删 85，增 0 |
| `WebViewPanel.css` | 540 → 38 | 58 → 2 | 删 56，增 0 |

成因是 `StartPage.tsx` 等组件早已改用 Tailwind 工具类重写，`.css` 里的 `home-*` 系列
成了「样式已定义、消费者为零」。**存活判据双源**：类名出现在 `src/**/*.{tsx,ts}` 标识符里，
**或**出现在 `dist/assets/*.js` 产物文本里（覆盖 `classList.add` 运行时拼接）；
白名单只有 pdf.js 注入的类名。

**「只删死的、没动活的」有机械证明**：清理前备份 vs 清理后，在两边都存在的选择器上
属性值差异 **0 处**（对更早一份备份是 3 处，且全是 9.2 的别名换名）。

### 9.2 兼容别名层整段删除（见 D14）

106 处替换，全仓零 `--chrome-` 引用。`tokens.css` 现在就是唯一色源，没有第二套名字。
被判定的副作用只有一处：两处探针用例的 `before` 串原本引用 `--chrome-*`，
别名一删就解析不出值（量到透明黑）—— 已把 `before` **冻结成它当时解析出的字面量**
（`--chrome-surface-1` → `#09090b`、`--chrome-surface-2` → `#0f0f11`、`--chrome-border` → `#27272a`），
而不是删掉用例：断言的对象（迁移是否等价）依然有效，只是不能再依赖一个已不存在的间接层。
冻结后反而更准 —— 两条原本记为「已接受位移」的条目被证明其实是**逐值精确**（`eq`），
已接受位移从 37 处修正为 36 处。

### 9.3 Tailwind 不再扫描 `docs/`（见 design-system §2.1）

`index.css` 加 `@source not "../docs";`。实测**只删不增**：13 条规则消失、0 条新增、
产物 −786 字节，被删的全是文档里的示例类。加这条之前，本文档里为记录「迁移前长什么样」
而写的类名会被真的编进产物，产生指向已删令牌的死声明。

### 9.4 顺带发现：`check-design-tokens.mjs` 的豁免范围过宽

`TOKEN_SOURCES` 原本包含 `src/index.css`，但它只定义字体、不定义颜色，没有豁免的理由 ——
已收窄为只有 `src/tokens.css`。收窄后 `index.css` 里 4 处滚动条字面量（`#d4d4d8` / `#3f3f46` /
`#a1a1aa` / `#52525b`）暴露为违规，改为 `var(--border-default)` / `var(--border-strong)`，
并删掉两条 `.dark ::-webkit-scrollbar-thumb` 覆写 —— 令牌自身随主题翻转，这两条是多余的。
**这四组字面量恰好就是两个令牌的浅深四个面**，是「深浅两份真相」的又一个实例。
