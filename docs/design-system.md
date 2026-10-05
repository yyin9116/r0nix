# r0nix 设计系统

> 本文是 r0nix 视觉与交互的唯一规范来源。`package.json` 里写的 **Swiss Design**
> 从此有可验收的定义，而不是一句宣言。所有 UI 变更以本文为准；
> 与本文冲突的既有代码视为待迁移项，清单见 `docs/token-migration-map.md`。

---

## 1. 定位：Swiss 对本产品的具体含义

瑞士国际主义风格不是「极简」这个形容词，它有可检验的约束。落到 r0nix 上：

1. **一套无衬线贯穿**。UI 只用 Inter 一个家族（中文回退 Noto Sans SC）。不出现第二套 UI 字体。
2. **一套中性灰阶**。只用 zinc。不用 slate / gray / neutral / stone —— 几种「灰」混用是这类界面最常见的破绽。
3. **强调色唯一且可切换**。同一时刻整个界面只有一个强调色，由用户选择，全部通过 `--accent` 派生，不允许任何地方写死。
4. **层级靠字号、字重与留白建立**，而不是靠描边和阴影堆叠。描边只用于必要边界，阴影只用于真正浮起的层。
5. **装饰为零**。没有渐变、光晕、拟物、纹理。任何「为了好看」的视觉都必须能说出它传达了哪条信息。
6. **网格与刻度**。间距走 4px 网格；圆角、字号、时长都在有限档位内取值，不临时发明数值。

---

## 2. 令牌入口

令牌定义在 `src/tokens.css`。接入方式：

```css
/* src/index.css */
@import "tailwindcss";
@import "./tokens.css";
@custom-variant dark (&:where(.dark, .dark *));
```

接入顺序有意设计成**可增量迁移**：

- `tokens.css` 的 `:root` 是普通（**无层级**）规则。按 CSS 层叠层规范，无层级声明排在
  所有 `@layer` 之后，而 `index.css` 内的块位于 `@layer base` 里 ——
  **层级先于权重比较**，所以 tokens.css 一被 `@import` 就立刻生效，压过 base 层。
  （不要写成「base 层的声明仍然优先」：那是反的，已在 Chrome 实测确认。）
- 因此下面的**刻意变更**表是接入即生效的清单，不是待生效的提案。
- **两处字面量兼容层都已整段删除，现在 `tokens.css` 是唯一色源，没有第二套名字。**
  - 第一批：`index.css` 里两个 `:root` 块的 `--chrome-*` / `--bg-primary` / `--accent-*`（26 行）。
    它们 100% 被无层级的 `tokens.css` 覆盖，从 `@import` 那一刻起就是死声明；留着的唯一后果是
    让下一个读代码的人以为「改这里的值能生效」。
  - 第二批（2026-10-04）：`tokens.css` 里那批**兼容别名**本身 ——
    `--chrome-surface-1..4` / `--chrome-border` / `--chrome-text` / `--chrome-muted` /
    `--bg-primary` / `--text-primary|secondary|tertiary` / `--accent-primary|light|hover`。
    它们逐字等于对应的真令牌，删除时最后一个引用者已经迁走，共替换 106 处、零剩余引用。
    引用方：`tokens.css` / `PDFViewer.css` / `WebViewPanel.css` / `ReadingAssistMenu.css` / `MarkdownViewer.tsx`。
  - 实测：深色下 `--border-default` 读到的是 tokens.css 的 `#3f3f46`，而非兼容层曾写的 `#27272a`。

### 2.1 Tailwind 的候选扫描范围被收窄过

Tailwind v4 的自动内容探测会把**仓库里所有未被 gitignore 的文本文件**当候选源，
`docs/*.md` 也在内（本仓 `.gitignore` 专门把 `docs/*.md` 放行了）。后果是规范文档里
为了记录「迁移前长什么样」而写的 class 串会被**真的编进产物**。

实测证据（同一次构建、只改这一行指令的对照）：
`docs/design-system.md` 写 `bg-white dark:bg-[var(--chrome-surface-1)]`，产物里就真出现
`.dark\:bg-\[var\(--chrome-surface-1\)\]:where(…){background-color:var(--chrome-surface-1)}`。
兼容别名删除后这条规则引用的是一个不存在的变量（invalid at computed-value time），
成为产物里唯一一处指向已删令牌的死声明 —— 读产物的人会以为该变量还在。

修法：`index.css` 里加 **`@source not "../docs";`**。
实测这条指令**只删不增**：13 条规则消失、0 条新增、产物 −786 字节，被删的 13 条全是
文档里的示例类（`hover:bg-zinc-100` / `focus:ring-zinc-400` / `dark:disabled:text-zinc-500` …），
在 `src/` 与 `cases/*.json` 里都没有消费者。

两个必须记住的判断分工（本仓两个方向都踩过）：

1. **「产物里有这个类」不能证明代码在用。** 删 `--border-strong` 时就是踩了这个坑 ——
   它在 `src/` 零出现，只因本文档表格写了它就被编出来。判断令牌有无消费者，只能查 `src/`。
   （该令牌后来因批注输入框的灰度聚焦环出现了第一次真实需求，已按需补回，见 §3.2。）
2. **不要把扫描范围收成 `source(none)` + 只扫 `src/`。** `scripts/design-diff/cases/*.json` 里的
   before/after class 串**必须**被扫描，探针才能量到迁移前的值 —— 那些类在 `src/` 里早已不存在
   （正是被迁走的），一旦停止扫描，`comparisons` 会全部量到 `rgba(0, 0, 0, 0)`。

---

## 3. 颜色

### 3.1 表面 surface

| Tailwind 工具类 | 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|---|
| `bg-surface-app` | `--surface-app` | `#fafafa` | `#09090b` | 应用外壳、窗口底色 |
| `bg-surface-sunken` | `--surface-sunken` | `#f4f4f5` | `#0f0f11` | 内凹区：侧栏轨道、嵌入面板底、禁用输入框 |
| `bg-surface-panel` | `--surface-panel` | `#ffffff` | `#18181b` | 主面板、卡片、下拉（默认内容面） |
| `bg-surface-hover` | `--surface-hover` | `#e4e4e7` | `#27272a` | hover / 选中填充 |
| `bg-surface-active` | `--surface-active` | `#d4d4d8` | `#3f3f46` | 按下（`:active`）/ 二级 hover |
| `bg-surface-paper` | `--surface-paper` | `#ffffff` | `#ffffff` | PDF 页面与其上的贴纸式浮层（**刻意不随主题翻转**） |

> **第 6 档 `--surface-paper` 是「把刻意写成显式」的产物。** 它收编了 4 处
> `background: white` 字面量（PDF 页面 `.pdf-page-block`、快照手柄 `.snapshot-handle`、
> 快照操作条 `.snapshot-actions`）。这些白**不是漏迁** —— 它们浮在 PDF 页面上，
> 而 PDF 内容永远是纸面，深色模式下也是白纸。问题在于：在代码里，它与「忘了改」的白
> 长得一模一样，守卫只能把它们一起计入基线 —— 于是**基线数字掩盖了「同类里混着真缺陷」**。
> 给它一个名字之后：刻意变得可读、守卫得以归零，而「深色下要不要把 PDF 反色」
> 被明确划给了 reader 主题（而非 UI 主题）的职责。
>
> **第 5 档是后加的，理由是「少一档就会长出字面量」。** 迁移期实测：`hover:bg-zinc-200`
> 这类「hover 之上再深一档」的写法在原代码里有真实消费者（主题选项卡片、开关胶囊），
> 而当时只有 4 档，最贴近的 `--surface-hover` 已经用在了静止态，于是这些位置只能写
> `bg-zinc-200 dark:bg-zinc-800` 这种**深浅两份真相**。补上 `--surface-active` 之后
> 它们才收得进组件层。加档的判据仍是老规矩：**先确认真有引用，不要先备着** —— 这一档
> 是被 `src/ui/Button.tsx` 与 `src/ui/IconButton.tsx` 的 hover 态实际消费的。

### 3.2 描边 border

| Tailwind 工具类 | 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|---|
| `border-border-subtle` | `--border-subtle` | `#e4e4e7` | `#27272a` | 分隔线、极轻描边 |
| `border-border-default` | `--border-default` | `#d4d4d8` | `#3f3f46` | 控件描边（输入框、按钮） |
| `border-border-strong` | `--border-strong` | `#a1a1aa` | `#52525b` | 灰度聚焦环（`focus:ring-border-strong`） |

> 深色下原 `--chrome-border` 的值就是 `#27272a`，对应 **subtle** 档。
> 迁移 `border-color` 时用 `--border-subtle`，用 `--border-default` 会让深色描边亮一档。
>
> **第三档的删了又加，是个值得记住的循环。** 2026-10 首轮审计时 `--border-strong`
> 全仓零实例，按「不要先备着」的原则删掉了。同月 10-04 迁移 `PDFViewer` 时出现了
> 第一次真实需求：批注输入框的 `focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600`
> —— 它要的是「比控件描边显眼、但不抢强调色」的灰度聚焦环。硬塞进 `--border-default`
> 浅色差 27/255、深色差 18/255；补回这一档则两侧**逐值精确**。
> 结论没变（仍然是「有引用才加」），变的是这次**真的有了**。

### 3.3 文字 content

| Tailwind 工具类 | 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|---|
| `text-content-primary` | `--content-primary` | `#18181b` | `#f4f4f5` | 正文、标题 |
| `text-content-secondary` | `--content-secondary` | `#3f3f46` | `#d4d4d8` | 次级正文 |
| `text-content-muted` | `--content-muted` | `#71717a` | `#a1a1aa` | 元信息、分组标签 |
| `text-content-disabled` | `--content-disabled` | `#a1a1aa` | `#71717a` | 禁用态、占位符 |
| `text-content-inverse` | `--content-inverse` | `#ffffff` | `#09090b` | 坐在 `bg-content-primary` 上的前景（反相徽标、实心主按钮） |

> **第 5 档 `--content-inverse` 的由来。** 它天生要随主题反相：`content-primary` 浅色是深、
> 深色是浅，压在它上面的字必须反过来。它同时修掉一处既有不一致 —— 「深色实心块 + 反相文字」
> 这个模式在仓里出现两次，两处深色值却不一样：侧栏 logo 写 `dark:text-zinc-900`（`#18181b`），
> Markdown 按钮写 `dark:text-zinc-950`（`#09090b`）。同一语义两种值，正是靠 `dark:` 手工配对
> 对不齐的典型样本。统一取 `#09090b`（对 `#f4f4f5` 的对比度 18:1，比 `#18181b` 的 16:1 更稳）。

### 3.4 强调色 accent

运行时由 `App.tsx` 注入 `--reader-accent / -soft / -contrast`，令牌层再派生出：

| Tailwind 工具类 | 令牌 | 说明 |
|---|---|---|
| `bg-accent` / `text-accent` / `border-accent` | `--accent` | 实心强调，兜底 `#52525b`（与 `ACCENT_TOKENS.zinc` 一致） |
| `bg-accent-soft` | `--accent-soft` | 选中态底、轻量强调 |
| `text-accent-on` | `--accent-on` | 放在强调色实心块上的前景色（对比色令牌） |
| — | `--accent-ring` | 聚焦环，`color-mix` 派生 |

**硬规则**：任何位置不得写死强调色字面量。用户切到 green / rose / violet 时，
所有强调色位置必须一起变。

> 迁移前唯一的重大违反是 `Sidebar.css` 的 `.rail-btn:hover/.active` 写死 `#dbeafe` + `#1d4ed8`。
> 该文件属于 §4.2 的死样式表，已随整文件删除 —— 这一条现在是**零违反**，
> 但规则本身要保留，因为「新写一个侧栏样式表」是最容易重犯的位置。

### 3.5 状态色 state

本产品**唯一**允许的彩色。三状态 × 三段：

| 段 | 令牌（danger 为例） | Tailwind 工具类 | 用途 |
|---|---|---|---|
| tint | `--state-danger-tint` | `bg-state-danger-tint` | 提示块底色 |
| border | `--state-danger-border` | `border-state-danger-border` | **不透明**可见描边（胶囊外框、徽标） |
| fg | `--state-danger-fg` | `text-state-danger` | 文字、图标、实心强调 |

| 状态 | 浅色 fg | 对比度 | 深色 fg | 对比度 |
|---|---|---|---|---|
| ok | `#166534` | 6.81 | `#4ade80` | 8.80 |
| warn | `#92400e` | 6.37 | `#fbbf24` | 8.28 |
| danger | `#b91c1c` | 5.91 | `#f87171` | 5.40 |

> 对比度按各自 tint 计算（浅色 `#f0fdf4` / `#fef3c7` / `#fef2f2`，
> 深色 `#0f2a1d` / `#3a2a12` / `#3a1f27`），全部 ≥ AA 4.5。
> 三者都取「正文级」色阶而非 600 档 —— 600 档在 tint 上只有 2.9–4.4，不达标。
>
> **需要「半透明状态色」时（卡片、胶囊的柔和外框）不要写字面色**，就地派生：
> `border-color: color-mix(in srgb, var(--state-danger-fg) 28%, transparent);`
> 这是仓库里既有的写法（`--accent-primary` 已在多处这样用）。
> `--state-*-border` 是**不透明**的可见描边，两者用途不同，不要混用。
>
> **不再提供 `--state-*-soft` 令牌**：两个 soft 令牌（ok / warn）在仓库里零消费者，
> 而 danger 那处也早已被 `color-mix` 派生取代。保留它们等于给自己留一条与上述
> 「就地派生」并行的第二写法。同理不再提供 `text-state-danger-fg` —— 与
> `text-state-danger` 指向同一变量，属重复词汇。

### 3.6 白板内容色板：内容语义色，不是界面令牌

白板卡片 / 分组的颜色**刻意不随主题翻转**：白板是一张纸，卡片是纸上的便签，
便签颜色属于内容语义（用户选的分类色），不是界面表面色。所以它不走
`--surface-*` / `--content-*`，而是自成常量（`src/theme/boardPalette.ts`），
也**不在 `check-design-tokens` 的扫描范围内** —— 那个守卫管的是「界面样式」。

**但它仍然受 §14「非 zinc 中性色阶」约束。** 2026-10-04 按此条把五色收敛为两色。

#### 收敛依据：sRGB → OKLab 实测，不是观感

原配色的五个值，逐通道算成对 ΔE：

| 通道 | 五色最大成对 ΔE | 读法 |
|---|---|---|
| `fill` 纸面（占卡片绝大部分面积） | **0.0106** | 低于 JND —— 五色**完全同色** |
| `chip` 卡片头部条 | 0.0328 | 刚过 JND |
| `border` 1px 描边 | 0.2469 | 唯一承载差异的通道 |

四个「中性色阶」的 border 在 OKLab 下：

| 色 | L 明度 | C 色度 | h 色相 |
|---|---|---|---|
| zinc | 0.4416 | 0.0102 | 286° |
| stone | 0.5358 | 0.0078 | 74° |
| slate | 0.4559 | 0.0328 | 257° |
| olive | 0.5061 | 0.0359 | 108° |
| blue | 0.6273 | **0.1721** | 264° |

色度 ≤0.036 即「灰」；四个中性的色度全在里面，只是灰里掺了不同色相，明度极差 0.094。

> **结论：这不是颜色分类系统，而是「同一张近白纸上的一根 1px 描边色偏」。**
> 用户选了色，卡片本体（fill + chip）像素级不变 —— 伪选择。
> 注意这与「五个颜色太像」是**不同**的诊断：它们并非不可分辨（border 最大 ΔE 0.247），
> 而是差异被压缩到一根 1px 线上，同时把「唯一中性色阶」的约定撑成了四份。

#### 收敛结果

| 保留 | 语义 | 与 zinc 的 border ΔE |
|---|---|---|
| `zinc` | 常态纸面（论文卡、笔记卡、分组框） | 基准 |
| `blue` | 需要你注意的项（开放问题、批注生成的卡片） | 0.2469 |

blue 保留的依据是**量级差异**：色度 0.172，比四个中性高一个数量级，是真正的第二档
颜色而非色偏。收敛后 `BOARD_COLOR_ORDER` 只剩两项，色板选择器随之只有两个按钮。

#### 迁移（**可见变更，已接受**）

旧值 stone / slate / olive 一律落回 `zinc`。唯一入口是 `boardPalette.ts` 的
`normalizeCardColor()` —— 三条读取路径（localStorage 已存数据、手改数据、
`create*Card` 默认参数）都走它，别处不得再写一份映射（已由 `check-whiteboard-contract`
的 6 条断言锁死，含一条负例：重新引入 `"stone"` 会让守卫 exit 1）。

影响：**已有白板**里原先用这三色的卡片会变成 zinc。代价必须写明 ——
种子模板里「问题陈述 / 方法证据」两张便签原先靠 stone / olive 区分，收敛后同为 zinc，
**改由标题文本承载区分**。这是一次真实的功能损失，换掉的是「四个几乎同色的灰」。

---

## 4. 刻意变更

分三批：①–⑦ 是**令牌接入期**的变更；⑧–⑫ 是**组件层落地与强调色链路修复**的变更；
⑬–⑮ 是**台账收口**（逐行核对基线剩余项，挖出被计数掩盖的真欠债）。
三批都不是待生效的提案，已在真实浏览器读取计算值确认（验证方式见 §11.3）。

| # | 项 | 原值 | 新值 | 原因 |
|---|---|---|---|---|
| ① | `--bg-primary` 浅色 | `#ffffff` | `#fafafa` | 原定义在浅色指向 surface-3、深色指向 surface-1，语义自相矛盾。`.app-shell` 的意图是窗口底色，改为 `--surface-app` 后浅色层级才正确（外壳 `#fafafa` < 面板 `#ffffff`）。 |
| ② | `--border-default` 深色 | `#27272a` | `#3f3f46` | 新的描边三档把原 `--chrome-border` 归到 **subtle**，`--border-default` 上移一档。影响 live CSS 中 `var(--border-default)` 引用 **35 处**（PDFViewer 17 / ReadingAssistMenu 12 / WebViewPanel 6），深色下描边整体亮一档。 |
| ③ | 状态色 fg 浅色 | `#16a34a` / `#d97706` / `#dc2626` | `#166534` / `#92400e` / `#b91c1c` | 原值在各自 tint 上只有 **3.15 / 2.86 / 4.41**，低于 AA 4.5。新值取迁移前代码里实际在用的那档，回到 **6.81 / 6.37 / 5.91**。 |
| ④ | 状态色 border 浅色 | `#dcfce7` / `#fecaca` | `#86efac` / `#fca5a5` | 原值与 tint 只差一档（ok: tint `#f0fdf4` / border `#dcfce7`），胶囊外框几乎不可见。新值同样是迁移前代码里在用的描边色。 |
| ⑤ | 高度刻度 | `--elev-raised/overlay/modal` 三档固定 `rgba(0,0,0,…)` | `--elev-sm/md/lg/xl` 四档，全部走 `color-mix(in srgb, var(--content-primary) N%, transparent)` | 原三档与代码实际用的阴影**一个都对不上**，所以只有一个消费者（WebViewPanel 3 处），其余 12 处各写各的。新刻度是**按代码实测归纳**：8 个互不相同的阴影值收敛成 4 档。且因为锚在 `--content-primary` 上，深色下自动从「暗投影」翻成「浅色辉光」—— 修掉了 `--elev-raised` 在深色下几乎不可见的问题。 |
| ⑥ | 焦点环颜色 | `:root { --focus-ring-color: var(--reader-accent, var(--accent)) }` | 改用在使用处直接写 `var(--reader-accent, var(--accent))` | 当时该令牌被烧成兜底 `#52525b`，**深色下也是 `#52525b`**，落在 `#18181b` 表面上对比度只有约 **2.4:1**。⚠️ 这一条**已被 ⑨ 取代**：真正该修的是注入点，不是取消令牌。现为「`:root` 注入 → `:root` 派生 → 使用处引令牌」（见 §8.1）。 |
| ⑦ | 原生控件配色 | 只由 `index.html` 内联脚本写一次 `style.colorScheme` | `App.tsx` 的主题副作用也写 `style.colorScheme = theme` | 内联脚本与 React 对「主题」的判断一旦不同源，就会出现 `class="dark"` 而 `color-scheme: light` 的分叉，原生滚动条/输入框在深色界面上仍是浅色。让 React 成为唯一权威，内联脚本降级为「首帧优化」。 |

**第二批（⑧–⑫）**

| # | 项 | 原值 | 新值 | 原因 |
|---|---|---|---|---|
| ⑧ | 强调色**注入点** | `App.tsx` 把 `--reader-accent*` 写在 `#root > div`（应用外壳） | 写在 `documentElement`（`:root`） | **这是本轮最严重的缺陷，且不是本轮引入的。** 自定义属性在**声明它的那个元素**上就完成 `var()` 代入；`tokens.css` 与 `@theme` 的每个派生值都在 `:root` 求值，看不到外壳上的 `--reader-accent`，于是它们被**烧成兜底灰并继承给所有后代**。实测：选 green 时外壳 `--reader-accent = #059669`，而 `:root --accent = #52525b`，`bg-accent` 渲染为 `rgb(82,82,91)`。受影响 **69 处**声明（PDFViewer.css 59 / WebViewPanel.css 7 / ReadingAssistMenu.css 3）—— 即「强调色选项能点，界面永远不变」。修完实测 `:root --accent = #059669`、`bg-accent = rgb(5,150,105)`。 |
| ⑨ | 焦点环颜色（取代 ⑥） | 使用处写 `var(--reader-accent, var(--accent))` | 回到 `:root` 派生一次 `--focus-ring-color: var(--reader-accent, var(--accent))`，使用处引令牌 | ⑧ 修好之后，`:root` 上做一次代入就是**正确且必要**的：环色与强调色只有一个真相。若注入点再被挪回后代元素，这一行会立刻退化成兜底色 —— 已在 `tokens.css` 与 `index.css` 两处写明警告。 |
| ⑩ | `index.css` 兼容层 | `@layer base` 内两个 `:root` 块，26 行 `--chrome-*` / `--bg-primary` / `--accent-*` 字面量 | 整段删除 | 无层级规则排在所有 `@layer` 之后，`tokens.css` 一 `@import` 就 100% 覆盖它。它从诞生起就是死声明，只会误导后来者。 |
| ⑪ | Settings 迁移到组件层 | 手写长 className，每个元素自带 `dark:` 配对（`dark:` 出现 73 次） | 消费 `src/ui/` primitive，`dark:` 归零 | `text-zinc-800 dark:text-zinc-200` 这类值**不在 4 级内容色刻度上**，必须归一。带来 4 处**浅色侧一档位移**（详见 §4.3），深色侧除 ⑫ 外不变。另有 3 处尺寸统一：按钮 `px-4→px-3`、端口输入 `px-2→px-3`、快捷链接行的两列因兄弟按钮变窄而各自 +3.3px / +4.7px（合计 +8px，无布局缺陷）。 |
| ⑫ | 2 处真实对比度缺陷 | `.home-open-btn` 写死 `color: white`；`PDFViewer.css:1005` 引用**全仓未定义**的 `--text-on-accent` | 都改为 `var(--accent-on)` | 深色 + zinc 时强调色 solid 是 `#f4f4f5`（近白），白字实测对比度 **1.08:1**，按钮文字几乎不可见；改为 `--accent-on`（深色 zinc = `#18181b`）后 **16.12:1**。后者是**悬空令牌**——引用了一个不存在的名字，浏览器按 `color` 初始值回退，属于静默失效。 |

**第三批（⑬–⑮）：台账收口**

第二批之后，令牌守卫只剩 9 处「违规」，看起来已经是「剩下的都是豁免」。逐行核对后
发现那 9 处里藏着 **5 处真欠债**（1 处假阳性 + 3 处刻意白 + 1 处对比度缺陷 + 4 处漏迁，
其中 3 处刻意白由第 6 档令牌收编）。**教训：基线计数会掩盖「同类里混着真缺陷」，
冻结基线之后必须逐行核对剩余项，不能把「数量小」当成「质量已达标」。**

| # | 项 | 原值 | 新值 | 原因 |
|---|---|---|---|---|
| ⑬ | `.pdf-status-bar` 底色 | `background: white`，**无深色覆写** | `var(--surface-panel)` | 深色下界面底部会留一条**纯白横条** —— 该规则没有任何 `[data-theme="dark"]` 对应块。浅色侧 `--surface-panel` = `#ffffff`，与原值字面相同（零变化）；深色侧 `#18181b`（修复）。规则级探针实测：浅 `rgb(255,255,255)` / 深 `rgb(24,24,27)`。 |
| ⑭ | `.page-image-debug-badge` 文字 | `color: white` 坐在 `--state-danger-tint` 上 | `var(--state-danger-fg)` | 浅色下 tint 是 `#fef2f2`（近白），白字实测不可见。`--state-danger-fg` 浅色 `#b91c1c` / 深色 `#f87171`，两态都成立。这是本仓库第 3 处「坐在状态底上的字写死了纯白」。判据：**凡是坐在强调色 / 状态色上的文字，必须用配对的 `-on` / `-fg` 令牌。** |
| ⑮ | 首页卡片底色与其深色覆写 | 基础规则 `background: white`；深色块另覆写 `background: var(--chrome-surface-3)` | 基础规则 `var(--surface-panel)`，深色块只保留 `border-color` | 深色覆写里的 background 与基础规则**同值**（`--chrome-surface-3` ≡ `--surface-panel`），是纯冗余。删掉后填充只留一处真相，两态都由令牌翻转且仍零变化。深色描边是 `--border-subtle`（比基础的 `--border-default` 暗一档），故覆写**收窄而非删除**。 |

### 4.3 ⑪ 带来的 4 处浅色侧一档位移（有意接受）

`text-zinc-800 dark:text-zinc-200` 这类组合在 4 级内容色刻度上**没有对应项**，
只能二选一。逐条判定如下（均由「445 节点 × 3 状态 × 25 属性」的计算样式差分实测得出，
不是肉眼估计）：

| 位置 | 原值 | 新值 | 浅色 | 深色 | 判定 |
|---|---|---|---|---|---|
| Settings 页根节点默认文字 | `text-zinc-800 dark:text-zinc-200` | `text-content-secondary` | `#27272a → #3f3f46` | `#e4e4e7 → #d4d4d8` | **接受**。页根是「页面默认正文」，标题另有 `text-content-primary`。取 secondary 才能让标题立起来，且 4 级刻度里 secondary 是唯一语义相符的。两档对比度 9.4:1 / 7.3:1，均远超 AA。 |
| 开关行标签 | `text-zinc-800`（浅色）/ `dark:text-zinc-100` | `text-content-primary` | `#27272a → #18181b` | 不变 | **接受**。表单行的标题性文字，取 primary 更准确。 |
| 开关行描边 | `border-zinc-200 dark:border-zinc-700` | `border-border-default` | `#e4e4e7 → #d4d4d8` | 不变 | **接受**。§3.2 已规定「控件描边」= `--border-default`；深色侧原值恰好就等于它。 |
| 主题选项卡片底色 | `bg-zinc-100 dark:bg-zinc-800` | `bg-surface-hover` | `#f4f4f5 → #e4e4e7` | 不变 | **接受**。深色侧原值等于 `--surface-hover`；浅色侧 `zinc-100` 其实等于 `--surface-sunken`，但选中态需要比卡片底(`#fafafa`)更明确，取 hover 档反而更清楚。 |

另有 2 处**改善**（不是位移，是补齐缺失状态）：
禁用输入框首次有了禁用态（`disabled:bg-surface-sunken disabled:text-content-disabled`，
原实现无禁用样式，禁用与可用长得一样）；快捷链接的删除图标由
`text-zinc-400 dark:text-zinc-500` 改为 `text-content-muted`，**深色下由 `#71717a` 提到
`#a1a1aa`** —— 原来那档在深色面板上对比度不足。


> ①–⑮ 都在 `@import "./tokens.css"` 那一刻（或对应规则被使用的那一刻）生效，
> 每条都已用真实浏览器读取计算值确认。
> 若要完全零变化：①改回 `var(--surface-panel)`；②深色块里改回 `#27272a`；
> ③④改回上表原值（但 ③ 会重新跌破 AA）；⑤改回三档 rgba（但深色会再坏）；
> ⑥⑦改回原写法（⑥ 已被 ⑨ 取代）；⑧改回把 `--reader-accent` 挂在外壳上
> （但 69 处强调色会重新变灰）；⑨⑩改回原写法（但 ⑨ 会退回 2.4:1，⑩ 会重新引入死声明）；
> ⑪⑫不建议回退（⑫ 会重新出现 1.08:1 的白字按钮）；
> ⑬⑭⑮ 都不建议回退（⑬ 会重新出现深色白条，⑭ 会重新出现看不见的徽标文字，
> ⑮ 会重新引入「同一属性两份真相」的冗余覆写）。
> 建议全部保留：②的旧值 `#27272a` 与 `--surface-sunken`(#0f0f11)/`--surface-panel`(#18181b)
> 太接近，控件描边几乎不可见；③⑨⑫是硬性无障碍要求；⑤是「令牌与代码一致」的前提；
> ⑧是「选项真的生效」的前提。

### 4.4 App.tsx 外壳迁移带来的 1 处深色侧位移（有意接受）

App.tsx 的主内容列原写作 `bg-white dark:bg-[var(--chrome-surface-1)]` —— 浅色取 **panel** 档、
深色取 **app** 档，**浅深语义不一致**。后果是深色下主内容列（`#09090b`）与它包裹的内容滚动区
（`bg-zinc-50 dark:bg-[var(--chrome-surface-1)]`，同为 `#09090b`）**同色，层级消失**。

| 位置 | 原值 | 新值 | 浅色 | 深色 | 判定 |
|---|---|---|---|---|---|
| App.tsx 主内容列底色 | `bg-white dark:bg-[var(--chrome-surface-1)]` | `bg-surface-panel` | 不变（`#ffffff`） | `#09090b → #18181b` | **接受**。改后深色下主内容列比内容区亮一档，「宿主 > 内容」的层级与浅色一致。 |

同批 6 处映射，其余 5 处经规则级探针（§11.3）实测**逐项等价**：内容滚动区
（`bg-zinc-50 dark:bg-[…]` → `bg-surface-app`，两态零变化）、tab 右键菜单的描边
（`border-zinc-200 dark:border-zinc-800` → `border-border-subtle`）、底
（`bg-white/95 dark:bg-zinc-900/95` → `bg-surface-panel/95`）、菜单项文字
（`text-zinc-700 dark:text-zinc-300` → `text-content-secondary`）、加载提示
（`text-zinc-500 dark:text-zinc-400` → `text-content-muted`）。

### 4.5 ⑯ `dark:` 配对迁移的位移（有意接受）

2026-10-04 分三批把全仓 **470 处** `dark:` 中性色配对迁到 0（详见
`docs/token-migration-map.md` §7）。用规则级探针（§11.3）在浅深两态逐项比对：
**36 个态出现位移，其余全部逐值等价**。所有位移均已逐条核对并接受，
`Δ` 记录保留在 `scripts/design-diff/cases/dark-migration.json`。

**第 1 批（58 处）** —— 迁完 `Sidebar` / `Tabs` / `ContextMenu` / `MarkdownViewer`：

| 映射 | 位移（Δ/255） | 判定 |
|---|---|---|
| `text-zinc-400 dark:text-zinc-500` → `text-content-muted` | 浅 46 · 深 48 | **接受，且是修正**：原浅色 `#a1a1aa` 在白底上只有 **2.5:1**（不到 AA），新值 `#71717a` 是 **4.6:1**；深色 4.0 → 7.2 |
| `text-zinc-600 dark:text-zinc-400` → `text-content-secondary` | 浅 19 · 深 53 | **接受**。原深色下与分组标题（`muted`）同色、层级丢失；改后侧栏项比分组标题亮，层级恢复 |
| `text-zinc-800 dark:text-zinc-200` → `text-content-primary` | 浅 15 · 深 16 | **接受**。原写法是「介于 primary 与 secondary 之间」的凑合档，归到 primary 后更强调 |
| `text-white dark:text-zinc-900` → `text-content-inverse` | 深 15 | **接受**。与 Markdown 按钮统一（见 §3.3），反相更纯粹 |
| `hover:bg-zinc-100 dark:hover:bg-zinc-800` → `hover:bg-surface-hover` | 浅 16 | **接受**。深色零变化；浅色 hover 略明显 |
| `disabled:bg-zinc-300 dark:disabled:bg-zinc-800` → `disabled:bg-surface-hover` | 浅 16 | **接受**。深色零变化 |
| `disabled:text-zinc-500 dark:disabled:text-zinc-500` → `disabled:text-content-muted` | 深 48 | **接受**。原写法浅深同值，深色下偏暗 |
| `bg-zinc-100 dark:bg-zinc-950` → `bg-surface-sunken` | 深 6 | **接受**。原写法浅色取内凹档、深色取应用档，属浅深不对称；归到 sunken 后统一 |
| `bg-white dark:bg-zinc-800`（favicon 衬底）→ `bg-surface-panel` | 深 15 | **接受**。深色下衬底由 `#27272a` 归到 `#18181b`，与标签底同色，那个淡方框消失 |
| `hover:bg-zinc-100 dark:hover:bg-zinc-800/50` → `hover:bg-surface-hover/50` | 浅 16 + alpha | **接受** |

> 规律：**最大两处位移（46 / 48）都出现在 `zinc-400 ↔ zinc-500` 这一对上，而它是修正而非退步。**
> 换句话说，是这些随手写的中间档一直在拖低对比度 —— 不是因为收敛才变差的。

**第 2 / 3 批（153 + 214 处）** —— 迁完 `WebBrowser` / `Library` / `Whiteboards` /
`WhiteboardCanvas` / `PDFViewer`。新增 23 个位移态，**全部 ≤ 22/255**，其中几条值得记：

| 映射 | 位移（Δ/255） | 判定 |
|---|---|---|
| `bg-zinc-200/50 dark:bg-zinc-950/50`（画布底）→ `bg-surface-sunken/50` | 浅 16 · 深 6 | **接受**。跨档（浅色取 hover 档、深色取应用档），取中间档 |
| `bg-surface-panel/60 dark:bg-zinc-950/60`（加载遮罩）→ `bg-surface-panel/60` | 深 15 | **接受**。遮罩与它所盖的面板同色更合理 |
| `bg-zinc-100 dark:bg-zinc-800/80`（选中缩略图底）→ `bg-surface-hover/80` | 浅 17 | **接受**。选中态统一走 hover 档 |
| `bg-zinc-50 dark:bg-zinc-900`（卡片内引用块）→ `bg-surface-sunken` | 浅 6 · 深 9 | **接受**，极细微 |
| `border-zinc-900/75 dark:border-zinc-100` → `border-content-primary/75` | 深 alpha 0.25 | **接受**。原来深色是纯色、浅色带 75%，统一为带 alpha |
| `bg-zinc-300 dark:bg-zinc-700`（竖分隔线）→ `bg-border-default` | **0** | 逐值精确 |
| `bg-surface-panel dark:bg-zinc-900` → `bg-surface-panel` | **0** | 逐值精确（深色两侧都是 `#18181b`） |
| `focus:ring-zinc-400 dark:focus:ring-zinc-600` → `focus:ring-border-strong` | **0** | 逐值精确（为此补回第三档描边，见 §3.2） |

> **第 3 批还单独处理了 16 处「单值中性色」**（无 `dark:` 配对，规则 4 扫不到）。
> 其中两处是**真缺陷**，不是风格问题：
> 缩略图骨架 `bg-zinc-100` 在深色下是一块近白方块；保存批注按钮的 `text-white`
> 坐在 `var(--reader-accent)` 上，深色 + zinc 时白字完全不可见（改为 `text-accent-on`）。
> 这次发现直接催生了**闸门 5**（见 §14 与 `token-migration-map.md` §8）。

> **唯一保留的「令牌级 `dark:`」**：`ToolButton` 激活态写 `bg-surface-panel
> dark:bg-surface-active` —— 浅色靠「白 + shadow」表示浮起、深色靠「#3f3f46」表示填亮，
> 两种主题的区分手段不同，无法用单一令牌表达。守卫只拦 `dark:` + zinc/white/black，
> 故它能通过；彻底消掉需要先设计「激活填充」语义令牌，且浅色会从白变灰（可见变更）。

### 4.1 ⑤⑥ 的 CSS 陷阱（都踩过，别再踩）

**陷阱一：自定义属性在声明它的元素上就完成 `var()` 代入，继承下去的是已解析的值。**

```css
:root { --a: var(--b, FALLBACK); }   /* --b 在 :root 上未设 → --a 烧成 FALLBACK */
.child { --b: CHILD; }               /* 子元素拿到的是 FALLBACK，不是 CHILD */
```

实测确认。**这条规则本身没错，但当年的结论错了。** 当年看到「在 `:root` 包一层就变灰」，
得出的结论是「不要包，改在使用处直接写 `var(--reader-accent, …)`」—— 治的是症状。
真正的病因是**注入点放在了声明点的后代上**：`--reader-accent` 被写在 `#root > div`，
而所有派生值都在 `:root` 求值，`:root` 当然看不到后代上的值。

**正确结论（⑧⑨ 修法）**：

| 目标 | 做法 |
|---|---|
| 想要「`:root` 派生、全应用引用」这种干净结构 | **把注入点也放到 `:root`**（`documentElement`），然后放心在 `:root` 派生一次 |
| 注入点必须在某个后代上（例如按子树切换主题） | 那就在**同一棵子树的根**上派生，让声明点与注入点同层；**绝不能**跨层引用 |

判据只有一句：**声明 `var()` 的元素，必须是那个被引用变量的定义域之内（含自身）的元素。**
违反它的表现是静默的 —— 不报错、不报缺失，只是永远取兜底值，而且
**深浅两种主题下取的是同一个兜底值**，所以从截图上看起来像「这个颜色本来就该是灰的」。

**陷阱二：元素的 `transition-colors` 会把 `outline-color` 也纳入过渡。**

`transition-colors` 的 `transition-property` 里含 `outline-color`，所以键盘聚焦后
**立刻**读 `getComputedStyle(el).outlineColor` 会拿到过渡中间值（常常恰好等于
`currentColor`），看起来像「焦点环颜色没生效」。核对时要么等 ≥ 帧时长，要么临时
`transition: none`。这一条曾让我误判焦点环实现有问题。

**陷阱三（本轮新踩）：自定义属性的值不能用 `getComputedStyle` 的字符串差分来判定。**
`tokens.css` 的令牌产出 `rgb(...)`，Tailwind v4 的工具类产出 `oklch(...)`；同一个颜色
会有两种序列化。逐元素差分必须先归一化（塞进 1×1 canvas 读 `getImageData`，
把 `oklch` / `color()` / 命名色统一成 sRGB 字节），否则「换了颜色来源」会被报成
几百处差异，把真回归埋掉。且 Tailwind v4 的 `zinc-*` 与 `tokens.css` 的 v3 hex 值
**不是同一个字节**（`oklch(0.705 0.015 286.067)` 实测为 `#9f9fa9`，而令牌写的是
`#a1a1aa`），归一化后仍会剩 ±1~2/255 的「端点舍入差」——这些是同一颜色的两种写法，
不是回归。

### 4.2 一并清理的死样式表

本次删除了 7 个**全仓零 import、从未进过构建**的样式表，共 3477 行：

`App.css`(877) · `Sidebar.css`(1334) · `LibraryPanel.css`(615) · `MarkdownEditor.css`(340)
· `Settings.css`(147) · `Toolbar.css`(71) · `ContextMenu.css`(93)

它们的类名（`rail-btn` / `edge-item` / `topbar-*` / `library-page` …）在 TSX 源码里出现
**0 次** —— 这些组件早已用 Tailwind 工具类重写。删除后，守卫的扫描范围自动收敛到
真正进构建的 5 个样式表；基线也从「708 处 / 15 个文件」修正为「10 处 / 1 个文件」。

> 为防复发，守卫新增规则 3：src 下的每个 `.css` 必须被某个模块 import，否则硬失败。
> 备份：`/Users/yinyin/test/dead-css-backup-20261003-1812.tar.gz`（含删除前的工作区版本）；
> 也可用 `git checkout HEAD -- <path>` 取回提交版本。

### 4.6 进构建的文件里的规则级死代码（2026-10-04）

§4.2 删的是**文件级**死代码。这一节删的是**进构建的文件里的规则级**死代码 ——
更隐蔽，因为守卫规则 3（孤儿样式表）看不到它：文件确实被 import 了，
但里面大部分规则的类名早已没有任何消费者。

| 文件 | 行数 | 唯一选择器 | 删除 |
|---|---|---|---|
| `PDFViewer.css` | 1569 → 260 | 120 → 35 | 删 85，增 0 |
| `WebViewPanel.css` | 540 → 38 | 58 → 2 | 删 56，增 0 |

（选择器按「唯一选择器串」去重计数；行数是工作区本轮清理前后。）

成因：`StartPage.tsx` 等组件早已改用 Tailwind 工具类重写，留在 `.css` 里的
`home-*` 系列规则成了「样式已定义、消费者为零」。**存活判据是双源的**：

> 一个类算活着，当且仅当它出现在 `src/**/*.{tsx,ts}` 的标识符里，**或**出现在
> `dist/assets/*.js` 的产物文本里（覆盖 `classList.add` 这类运行时拼接）。
> 唯一的白名单是 pdf.js 自己注入的类名（`endOfContent` / `markedContent` / `selecting`，
> 以及本项目用 `classList.add` 动态加的 `pdf-assist-text-active`）。

**「只删死规则、没动活规则」有机械证明，不靠肉眼。** 把清理前的中间态备份与清理后逐一对比：
在**两边都存在**的选择器上，属性值差异为 **0 处**（对更早一份备份则是 3 处，
且全部是 §2 那批别名换名）。也就是：本次只删掉了零消费者的规则，
**没有改动任何存活规则的一个声明**。

> ⚠️ 这一步的失败模式是「同特异度更宽泛兄弟规则接管」：删掉
> `[data-theme="dark"] .home-recent-item.missing{background:…}` 后，同层的
> `[data-theme="dark"] .home-recent-item{background:中性灰}` 会立刻顶上来，颜色就变了。
> 判据：**若存在一条深色规则，其选择器类名集合是待删规则的真子集，则该声明不能删。**
> 只看「选择器是否还在」的差分脚本发现不了这类回归。

> 一起必须改掉的地方：`scripts/design-diff/cases/surfaces.json` 原来断言的 8 个目标
> （`home-hero-card` / `home-address-card` / `home-address-bar` / `home-content` /
> `pdf-status-bar` / `snapshot-handle` / `snapshot-actions` / `page-image-debug-badge`）
> **正是这批被删掉的死类**。规则一没，探针 28/28 全部量到 `rgba(0, 0, 0, 0)` ——
> 那不是「值不对」，是「选择器压根不在页面上」。这类失败**必须在当轮修掉**，
> 否则门禁会长期红着，然后被当成噪声忽略（已重写，见 §11.3）。

### 4.7 自定义属性链的静默失效（2026-10-04 排查产物）

§4.6 的存活判据是「类名有没有消费者」。**它有一条盲区**：如果待删规则的作用是
**定义自定义属性**，那么它的真正消费者可能是一个**后代元素**通过 `var()` 去引用 ——
按类名 grep 永远找不到，因为后代上根本不带这个类名。

通则：

> 判定一条「定义自定义属性」的规则能否删，必须**顺着 `var()` 链查到最远端的后代消费者**，
> 而不是只看有没有元素带这个类名。

本仓实例：HEAD 的 `PDFViewer.css` 中有

```css
.page-stack { position: relative; isolation: isolate;
  --scale-factor: 1; --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit)); }
```

- `.page-stack` **从未被应用**，三处独立确认：`src` 标识符零命中、`dist` 产物零命中、
  以及真实页面探针 `document.querySelector('.page-stack') === null`。
  ⇒ 该规则从未生效，**删除它是真正的空操作**，不是回归。
- 但它引出的下游链路是真的：`.textLayer` 消费 `--total-scale-factor`（拼进内联
  `round(down, var(--total-scale-factor) * 612px, …)` 与 `font-size` 的 calc）。
  而 pdf.js v5 **只在 `PDFPageView.update()` 里、且 `_isStandalone` 为真时**才注入
  `--scale-factor`（`pdf_viewer.mjs:6731`）；本项目只用 `TextLayerBuilder`，
  所以这条链**从头到尾没有源**。

实测（工作区与 HEAD 数值**逐项相同** ⇒ 既有问题，非本轮引入）：

| 探针读到的量 | 实际值 | 应为 |
|---|---|---|
| `--scale-factor` / `--user-unit` / `--total-scale-factor` / `--text-scale-factor` / `--scale-round-x` | 全部为空 | 有值 |
| `.textLayer` 内联 `width/height` | 无效（回退到 `inset:0`） | 612×792 |
| span 内联 `--font-height` | `18.00px` | — |
| span 计算 `font-size` | **16px**（calc 无效 → 回退） | 18px |
| span / layer 实测尺寸 | 211×16 / 610×790 | 237×18 / 612×792 |

后果：**透明文本层的字形盒子比画布小约 11%**，选区与 hover 的命中精度整体偏一点。
不是本轮清理造成的。修法：按页给 `--scale-factor`
（= 渲染后页面宽 / 612）、`--user-unit: 1`、`--scale-round-x|y: 1px`。
补上后实测 `font-size` 16px → 18px、layer 盒子 610×790 → **612×792**（恰好等于页面真实尺寸）。

#### 4.7.1 已修复（2026-10-04）—— 落地时又踩了三个坑

修法落在两处：

- `PDFViewer.css` 的 `.page-text-overlay` 声明 5 个变量（`--scale-factor` / `--user-unit` /
  `--total-scale-factor` / `--scale-round-x` / `--scale-round-y`）；
- `PageCanvas.tsx` 用 `canvas.clientWidth / baseViewport.width` 求出本页真实缩放，
  写入文本层宿主的 `--scale-factor`，并用 `ResizeObserver` 观察 canvas 尺寸兜底。

**坑一：这 5 个变量必须和 `--scale-factor` 声明在「同一个元素」上。**
`var()` 的替换发生在**声明它的元素**上，继承下去的是已算好的值。
若把 `--total-scale-factor` 声明在 `.page-text-overlay` 的**祖先**上，
它就吃不到 canvas 注入的 `--scale-factor`（注入点在后代），整条链照样断。
这与 §4.1 陷阱一是同一条规律的另一面。

**坑二：基准不能取 `renderZoomScale`，只能取 `canvas.clientWidth / 页面固有宽`。**
`.pdf-page-block` 带 `border`，而 Tailwind preflight 把 `box-sizing` 设为 `border-box`，
所以内容盒 = `round(pageWidth × scale) − 2px`。画布与文本层宿主**同宽**、都等于内容盒。
用 `renderZoomScale` 会让文本层比画布**宽 2px**，命中区整体右移。

**坑三：两轴无法同时精确，这是数学上的必然，不要试图抹平。**
单一 `--total-scale-factor` 喂给 `round(down, … * 612px)` 与 `* 792px`，
而画布因 1px 边框导致横纵比略异（610/612 vs 790/792）。

修复后实测（`dpr=1`，同一探针）：

| 量 | 修复前 | 修复后 |
|---|---|---|
| `--scale-factor`（文本层宿主） | `""` | `0.9967320261437909` |
| `--text-scale-factor` | `""` | `calc(calc(0.9967… * 1) * 1)` |
| span 计算 `font-size` | **16px** | **17.9412px** |
| span 盒子 | 210.74 × 16 | 236.29 × 17.94 |
| `.textLayer` 尺寸 | 610 × 790 | 610 × **789** |
| `layer − canvas` 宽 / 高 | — | **0** / −1 |

宽向已精确对齐（差 0）；高向差 1px 是 `round(down, 0.9967 × 792, 1px)` 的必然结果。
相对原先 `font-size` 差 12.5%，这已是可达极限 —— **记下来，避免后来者把这一 px 当 bug 去修。**

> 另：修这条**不会**让 E2E 变绿（实测修后仍 0/3），两件事必须分开归因，见 §11.5。

---

## 5. 排版

家族（`@theme`，定义在 `index.css`）：

| 令牌 | 家族 | 用途 |
|---|---|---|
| `--font-sans` | Inter, Noto Sans SC | 全部 UI |
| `--font-serif` | EB Garamond, Noto Serif SC | 论文正文阅读 |
| `--font-mono` | JetBrains Mono | 代码、路径、数值 |

**禁止**在组件里写第二套 UI 字体栈。三个家族已覆盖全部场景：
`--font-sans` 管 UI，`--font-serif` 管论文正文，`--font-mono` 管代码与路径。
（迁移前 `App.css` 与启动屏用过 `"Segoe UI", "PingFang SC", "Microsoft YaHei"`，
前者已作为死样式表删除，后者已改为与 `--font-sans` 一致的栈。）

字号：手写 CSS 用语义别名，值仍取 Tailwind 刻度，**不新增字号**。

| 别名 | 等价 Tailwind | 值 | 用途 |
|---|---|---|---|
| `--text-caption` | `text-xs` | 12px | 元信息、分组标签 |
| `--text-ui` | `text-sm` | 14px | 控件与正文默认 |
| `--text-body` | `text-base` | 16px | 阅读正文 |

> 只保留这 3 个别名 —— 曾经的 `--text-title`(20px) / `--text-body-leading` /
> `--leading-reading`(1.7) 在代码里**没有任何对应实例**，属于「想当然的刻度」，已删。
> 加别名前先确认真有引用；日后再需要时再加，而不是先备着。

行高：界面手写 CSS 用 `--leading-ui: 1.45`；阅读正文的行高在 TSX 侧用
`leading-6` / `leading-7` 等 Tailwind 工具类表达，不额外造令牌。

**硬规则**：最小字号 11px。实测 live CSS 现有 1 处 `10.5px`（需上调到 11px）；
`13px` 有 4 处，不在别名表内，按就近吸附到 `12px` 或 `14px` 处理；
另有 `22px`(1) 与 `24px`(1) 两个展示级字号（首页 hero 与 Web 面板），
不在别名表内是**有意的** —— 字号别名只覆盖 UI 三档，展示级字号直接写值。
（迁移前曾在 `Sidebar.css` 有 20 处 `10px`、2 处 `9px`，那个文件已作为死代码删除。）

字重：界面用 400 / 500；600 仅限页面与区块标题；700 仅限品牌字标。

> 启动屏（`index.html`）**不**使用 `--font-*` 令牌 —— 它必须在 `tokens.css` 加载前
> 就能排版，因此内联了一份与 `--font-sans` 一致的字体栈。这是唯一豁免处，
> 改动字体时两处需同步。

---

## 6. 圆角

沿用 Tailwind 的 `--radius-*` 刻度，**不重定义**（重定义会改动所有 `rounded-*` 的既有尺寸）。

| 档位 | 值 | 用途 |
|---|---|---|
| `rounded-xs` | 2px | 标签内描边 |
| `rounded-sm` | 4px | 密集行内元素 |
| `rounded-md` | 6px | 小控件、缩略图 |
| `rounded-lg` | 8px | **默认**：按钮、菜单项、输入框 |
| `rounded-xl` | 12px | 面板、下拉、卡片 |
| `rounded-2xl` | 16px | 浮层、模态 |
| `--radius-pill` | 999px | 胶囊、圆点 |

**禁止**临时数值。实测 live CSS 现有 5 个越界值：`5px`(1) / `10px`(1) / `11px`(1)
—— 依次就近吸附到 `4px`(sm) / `8px`(lg) / `12px`(xl)。
（迁移做完全局字体栈与圆角前，`7px` / `9px` / `14px` 等越界值共 36 处，随 7 个死样式表一并消失。）

---

## 7. 间距

**没有 `--space-*` 令牌集，这是刻意的。**

- TSX 侧走 Tailwind 默认刻度（`p-1` = 4px，`gap-3` = 12px），不需要第二套。
- 手写 CSS 侧需要算的时候用 `calc(var(--spacing) * N)`，再包一层 `--space-N`
  只是同义反复。
- 实际情况也收不进 4px 令牌集：手写 CSS 的尺度是 **2px 半步**
  （实测 179 处间距声明里 83 处不在 4px 刻度上，高频值是 8px×31、12px×28、10px×24、6px×19）。

**硬规则**：间距是「评审时看刻度」的事，不是「用变量包起来」的事 —— 新写间距时
从 `2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 32` 里取，不要发明 `7px` `9px` `13px`。

---

## 8. 高度与阴影

四档，全部定义在 `src/tokens.css`，且全部锚定在 `--content-primary` 上。
**TSX 侧不暴露 `shadow-*` 工具类** —— 仓库里 15 处 `box-shadow` 全部写在手写 CSS 里，
真正的消费者是 CSS 属性而非 class。需要工具类时用任意值：`shadow-[var(--elev-sm)]`。

| 令牌 | 值（浅色解析后） | 用途 |
|---|---|---|
| `--elev-sm` | `0 1px 2px <content-primary> 14%` | 贴片、缩略图底、hover 抬起 |
| `--elev-md` | `0 4px 12px <content-primary> 15%` | 浮动工具条、局部操作组 |
| `--elev-lg` | `0 10px 24px <content-primary> 16%` | 下拉菜单、右键菜单、浮动面板 |
| `--elev-xl` | `0 18px 48px <content-primary> 22%` | 主浮层（阅读助手） |

写法是 `color-mix(in srgb, var(--content-primary) N%, transparent)`，不是固定 rgba：

- `--content-primary` 在深色下是 `#f4f4f5`，阴影自动从「暗投影」翻成「浅色辉光」，
  因此**深色块里不需要任何 `--elev-*` 覆写**。
- 改前的 `--elev-raised` 写死 `rgba(24,24,27,.06)`，在 `#18181b` 上几乎看不见 ——
  同一组件内一半位置用辉光、一半用死黑影，这才是要修的病根。

规则：**能用描边解决的层级不要用阴影**。阴影只用于真正浮起的层；不要写任意值阴影。
调用点清单见 `docs/token-migration-map.md`。

### 8.1 焦点环

全应用**唯一**的键盘焦点视觉，只由 `:focus-visible` 触发（鼠标点击不显示）：

```css
/* src/index.css · @layer base */
:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}
```

| 令牌 | 值 | 定义处 | 说明 |
|---|---|---|---|
| `--focus-ring-width` | `2px` | `tokens.css` | |
| `--focus-ring-offset` | `2px` | `tokens.css` | 环与元素边缘的间隙 |
| `--focus-ring-color` | `var(--reader-accent, var(--accent))` | `tokens.css` 的 `:root` | 在 `:root` 派生一次即可，**前提是 `--reader-accent` 的注入点也在 `:root`**（现状如此，见 §4 ⑧⑨）。若把注入点挪回后代元素，这一行会静默退化成兜底色 —— 判据见 §4.1 陷阱一。 |

颜色取用户强调色 ⇒ 浅色下是深色环（`#18181b`）、深色下是浅色环（`#f4f4f5`），
在两种主题下都保持对比。实测：键盘 Tab 走过 11 个控件，全部为 `solid 2px <accent> offset 2px`。

**不会出现双环**：本规则在 `@layer base`，Tailwind 工具类在 `@layer utilities`，
后者永远压过前者。带 `focus:outline-none focus:ring-*` 的元素由组件自己的环接管。

---

## 9. 层级 z-index

**没有 `--z-*` 令牌集，也是刻意的。**

实测 live CSS 里 19 处 `z-index`，其中 **11 处是页面内部的局部层叠上下文**
（`0/1/2/4/5/7/8/9` —— 页基线、贴片、文字层、链接层），这些**绝不能**抽成全局阶梯；
剩下 8 处跨组件的值本身还不一致（`20 / 100 / 120 / 130` 都在充当「浮层」，
另有 pdf.js 自带图层固定的 `999 / 1000 / 1001`）。

**正确顺序是：先把那 4 个浮层值收敛成一个档位，再谈 token 化。**
在那之前建一套 `--z-*` 只是把不一致命名下来（`--z-topbar: 3000` 之类的值与实际
80/90/120/130 全不符，已删除）。

---

## 10. 动效

| 令牌 | 值 | 用途 |
|---|---|---|
| `--duration-fast` | 120ms | hover / 按压反馈 |
| `--duration-base` | 160ms | 状态与面板切换 |
| `--duration-slow` | 240ms | 浮层进出 |
| `--ease-standard` | `cubic-bezier(.2,0,0,1)` | 默认 |
| `--ease-out` | `cubic-bezier(0,0,.2,1)` | 入场 |

`prefers-reduced-motion: reduce` 时三个时长统一归零（令牌层处理，组件无需判断）。

**★「组件无需判断」只成立于消费 CSS 令牌的动画。** 手写 rAF 循环（逐帧逼近目标值的
那种，见下）与 CSS 令牌没有任何连接 —— 令牌归零影响不到它，所以它必须自己判断
`prefers-reduced-motion` 并直接落到目标值。实例：`PDFViewer.tsx` 的 `animateZoomToTarget`，
由 `check-pdf-virtualization` 的一条守卫盯着（该守卫是弱证据：挡得住整条判断被删，
挡不住条件被改成永假而函数名还在）。

**缩放刻意不用 duration + easing。** PDF 缩放是逐帧指数逼近（每帧走剩余距离的 32%，
60fps 下约 133ms 收敛到 95% —— 与 `--duration-base` 同一量级，但只是巧合，没有任何联动）。
理由：手势跟随的**目标值每帧都在变**，而 duration + easing 描述的是「从 A 到 B 的一次性
过渡」，目标变化就得重启 tween，重启会产生顿挫。它的本质是「收敛速度」而不是「时长」，
所以不进 `--duration-*` 刻度 —— 刻度里放一个没有时长语义的数字只是同义反复。
`ZOOM_RENDER_COMMIT_DELAY_MS`（160ms，视觉预览到重渲染提交之间的延迟）数值上等于
`--duration-base`，同样是硬编码，改令牌不会联动 —— 这是已知的影子副本，不是漏迁。

待清理：实测 live CSS 里 `80ms`×2、`110ms`×1、`170ms`×1、`180ms`×1、`880ms`×1
不在刻度上（`120ms`×11 已在刻度上）。`--ease-in` 曾定义但零引用，已删除。

**★ 动效刻度目前没有门禁。** `check-design-tokens` 只管颜色，`--duration-*` /
`--ease-*` 零守卫 —— 上面那批离群值没有任何东西拦着继续新增。也就是说这一节
（连同 §10.1）是**没有牙**的，全靠自觉。
补守卫的前提是先决定那 5 个离群值各自的归属：进刻度 / 登记为豁免 / 就地改成刻度值。
那是产品与实现的共同决定（880ms 大概率是个加载动画，不该被压进 240ms），
不是顺手能加的 —— **在决定之前，不要在验收清单里勾选「动效已合规」。**

### 10.1 光标与输入分工

**光标描述的是「这个按键在这块区域上实际会发生什么」，不是「这个工具叫什么」。**
判据是去看 handler 做了什么 —— 工具名会骗人。本仓两个真实反例（都已修）：

| 反例 | 光标承诺 | 代码实际做的 |
|---|---|---|
| 右键拖拽配 `cursor-ns-resize` | 上下调尺寸 | `moveRightGesture` 改的是 `scrollLeft` / `scrollTop` —— **平移** |
| hand 工具配 `cursor-grab` | 左键按住能拖 | 拖拽只认右键（`handleViewerPointerDown` 的 `button === 2`），左键按下拖不动 |

**PDF 阅读区的输入分工**（光标必须逐条对应这张表）：

| 输入 | 行为 | 光标 |
|---|---|---|
| 左键 · select 工具 | 原生选中（批注 overlay 让路 `pointer-events: none`） | `text` |
| 左键 · hand 工具 | 点已有批注、打开笔记（overlay 收事件） | `default` |
| 左键 · 批注工具 | 画批注 | `crosshair` |
| 右键按下拖拽 | 平移 + 圈定缩放锚点页 | `grabbing` |
| 右键 + 滚轮 | 缩放（**增量**） | — |
| 触控板捏合 | 缩放（**倍率**，`wheel` + `ctrlKey`） | — |

两条硬约束：

1. **判定要与「左键归谁」同源。** 用 `isAnnotationTool(activeTool)` 而不是逐个列工具名 ——
   与 `handleAnnotationPointerDown` 首行判定同一个来源。同理，PDFViewer 里
   「文本层渲不渲染」与「批注 overlay 让不让路」是同一个判定的两个消费方，
   必须抽成 `textSelectionEnabled` 共用：只改一处会得到「文本层渲染了、但被 overlay 挡住」，
   **看得见却选不中，且不报任何错** —— 两个症状都不指向「判定不一致」，最难归因。
2. **光标要加在能触发该交互的最外层容器上。** 只在页块上改，页块之间的留白处光标不会变，
   看起来像「按下没生效」。滚动容器与页块都要给，子元素覆盖祖先，两者一致不冲突。

★ **滚轮与捏合是两种语义，参数不共用**：滚轮是离散的一步（增量），
捏合是连续位移（倍率 `exp(-k × 位移)`）。实测捏合单次 `|deltaY|` 只有 3~14 而滚轮是几十上百，
套滚轮参数会被 `MIN_STEP` 兜底成 +7%/事件，一个窗口 13~15 个事件 ⇒ 一次捏合缩放翻倍。
标定依据与重标条件见 `src/services/pdfZoomGesture.ts`。

---

## 11. 组件层

**设计系统的载体是组件，不是散落的 className。** 这一层**已建立**在 `src/ui/`：

| 文件 | 导出 | 说明 |
|---|---|---|
| `cn.ts` | `cn(...values)` | 零依赖 className 拼接。只做「基类 + 变体 + 调用方类」的合并，**不是** tailwind-merge，不做冲突消解（见下方「刻意不建」）。 |
| `Button.tsx` | `Button` | `variant: accent / neutral / outline / danger`，`size: sm / md`。 |
| `IconButton.tsx` | `IconButton` | `tone: muted / danger / accent`。**`label` 是必填 prop**（映射到 `aria-label` + `title`）。 |
| `TextInput.tsx` / `Textarea.tsx` | 同名的 `forwardRef` 组件 | 表单控件需要外部拿 ref 聚焦，React 18 里必须显式转发。 |
| `Select.tsx` | `Select` | 原生 `<select>`，配色走令牌。 |
| `Card.tsx` | `Card` | 面板内分块容器（`bg-surface-app` + `border-border-subtle` + `rounded-xl`）。 |
| `fieldStyles.ts` | `FIELD` | 输入类控件的共享基类。**刻意不含宽度**，理由见下。 |
| `index.ts` | 统一出口 | 使用方一律 `import { Button } from "../ui"`。 |

规则：

- 组件只消费令牌，不内联颜色、圆角、时长。
- 组件不写 `dark:` 变体 —— 令牌已经处理深浅色。**`dark:` 只允许出现在确实需要结构性差异的少数位置。**
  迁移后 `Settings.tsx` 的 `dark:` 出现次数为 **0**。
- 变体用 props 表达，不用拼接 className 字符串。`className` 只描述**布局**（宽度、外边距、flex 伸缩），
  不要用它覆盖颜色。
- 变体里**不要写 `text-white`**。主按钮写 `bg-accent text-accent-on` —— `--accent-on` 是
  「强调色之上的前景色」，会随强调色在深浅主题间反相（§4 ⑫），写死白色在深色 + zinc 下只有 1.08:1。

### 11.1 两个已踩过的坑

**① 基类里不要写宽度。** Tailwind 里 `w-full` 与 `w-72` 是**同一属性的两个工具类**，
产物里谁靠后谁赢 —— 把 `w-full` 写进 `FIELD` 会让调用方传的 `w-72` **静默失效**。
已实测：`w-72` 的输入框被拉到 918px。宽度一律由调用方给：表单里 `w-full`，定宽控件 `w-72` / `w-20`。
**通则：基类只放「不会与调用方冲突」的属性；同一属性的取值属于调用方。**

**② 不要用「在文件里再抄一份调色板」的方式做局部主题。** 已知未处理：
`WhiteboardCanvas.tsx:34-38` 与 `Whiteboards.tsx:275-279` 各自定义了一份**完全相同**的白板节点
调色板（zinc / stone / slate / olive / blue），两处仅有 `fill` 的 alpha 差 0.02（0.98 vs 0.96）——
典型的「改一处漏一处」漂移。且它们用了 `stone` / `slate` / `olive` 三个非 zinc 中性色阶，
与 §14「一个界面不能有两种灰」直接冲突。**待决策**（抽成单模块 + 收敛到 zinc 是两种不同代价的改法）。

### 11.2 刻意不建的 primitive

`Dialog` / `MenuItem` / `Tooltip` / `EmptyState` **暂不建立**，因为没有真实消费者：
- 本应用目前没有浮层菜单（右键菜单是 DOM 自绘）与 tooltip。
- **先建令牌集、再让代码去凑**这条老路已经栽过三次（`--space-*` / `--z-*` / `--elev-raised`）。
  没有消费者的刻度会被后来者当成必须遵守的规范，反而制造新的不一致。
- 若将来要建，浮层类组件必须一并解决 **portal 挂载点的令牌继承**问题：浮层常挂在 `body` 下，
  而 `body` 在 `.dark` 之外时拿不到深色令牌，会渲染成浅色。这是本项目的已知结构性风险，
  写在这里是为了让建它的人不要漏。

`cn.ts` 也**刻意不引入 `tailwind-merge`**：它会（正确地）消解同属性冲突，
那会**掩盖** §11.1 ① 那类「基类与调用方抢同一属性」的错误 —— 冲突应该被看见并修掉，
而不是被工具静默仲裁。

### 11.3 验证工具：三件套 + 规则级探针

设计系统的每次改动都必须有实测证据 —— 截图比对对亚像素、字体度量、滚动位置噪声极敏感，
**计算样式**才是硬证据（离散、确定、能直接指出「哪个节点、哪个属性、从什么变成什么」）。
`scripts/design-diff/` 下四个工具，都在 `npm run design:*` 里：

| 工具 | 用途 | 它抓到过的真问题 |
|---|---|---|
| `snapshot.mjs` | 整页计算样式快照（445 节点 × 3 状态 × 25 属性） | `FIELD` 基类里的 `w-full` 盖掉了调用方的 `w-72`，输入框从 288px 被拉到 918px |
| `normalize.mjs` | 颜色归一化（oklch / oklab → sRGB 字节） | 不归一化时 2726 处差异绝大多数是同色异写 |
| `diff.mjs` | 按「状态 × 属性 × 取值变化」归并输出 | 把 1631 处差异压成可逐类判定的一页 |
| `probe.mjs` | **规则级**探针（见下） | 深色下 `.pdf-status-bar` 是纯白横条；`.page-image-debug-badge` 白字不可见（这两个类后来因消费者归零被删，见 §4.6 —— 它们当时是真缺陷） |

**`probe.mjs` 补的是快照的盲区。** 快照只能采到**当前挂载视图**的节点，而设计系统里大量规则
属于「样式已定义、此刻不在 DOM 里」—— 首页卡片、PDF 状态栏、快照浮层。改这些规则时，
快照给你的是「零差异」，一个假的安全感。探针的做法是：起 prod 静态服务器 → 让真实应用加载
真实令牌 → 往页面里注入只带目标 class 的最小元素 → 读计算样式。

两种模式（`cases/*.json` 里可同时存在）：

- **断言（`targets`）**：某个 class 的实际值必须等于期望值。
- **等价性（`comparisons`）**：给定「迁移前 class 串 → 迁移后 class 串」，逐属性比对。
  这是把「a → b 这处迁移是否等价」变成**可执行断言**的手段 —— `dark:` 批次的迁移靠它逐批验收。

**伪类不是盲区。** `hover:` / `disabled:` / `group-hover:` 只加**激活条件**、不改声明值，
所以只要比较**去掉伪类前缀**的等价类（`bg-surface-hover` 对 `bg-zinc-200 dark:bg-zinc-800`），
就能证明 `hover:` 那处等价。2026-10 那批 58 处迁移里，靠这个方法覆盖了 8 处伪类映射。

四个必须内置的降噪措施（都是踩过才加的）：

1. **颜色归一化**：Tailwind v4 工具类产出 `oklch(...)` / `oklab(...)`，令牌产出 `rgb(...)`。
   不归一化，第一次跑就报 9 处 DRIFT，其中 8 处是 `oklch(0.985 0 0)` vs `rgb(250, 250, 250)`
   这种同色异写。
2. **容差 ≤2/255**：归一化后仍会差 1~2 —— `oklch(0.37 0.013 285.805)` → `rgb(63, 63, 71)`，
   而令牌写死 `#3f3f46` = `rgb(63, 63, 70)`。两者是同一个 zinc-700，差值来自 oklch 端点舍入。
3. **CSS chunk 要全量注入**：`PDFViewer.css` 被 vite 拆成独立产物
   （`assets/PDFViewer-<hash>.css`），只有对应组件被渲染时才进页面。探针注的是游离元素、
   不触发任何组件加载 —— 于是目标 class 一条规则都命中不了，量到的全是 `rgba(0, 0, 0, 0)`
   这种「看起来像没生效」的噪声（第一次跑 10 个目标全 FAIL 就是这个原因）。
4. **已审阅位移要显式标记（`acceptedDrift`），而不是删掉用例。** 收敛中间档（令牌层没有
   对应值的 zinc 档位）必然产生位移。这类位移一旦经人确认，就在用例里标记 `acceptedDrift`：
   探针**照样把它打印成 `Δ`**，只是不再让门禁失败。为什么要打印而不是删掉 —— 它记录了
   「这里视觉变过、变多少、是哪个决定造成的」，半年后比「测试是绿的」值钱。
   反过来，**没标记的 DRIFT 一律当回归处理**，门禁必须红。

**用例本身也会腐烂，而且腐烂方式很安静。** 2026-10-04 清理死规则后才发现：
`surfaces.json` 的断言目标全是已删的死类，探针 28/28 量到 `rgba(0, 0, 0, 0)`。
它读起来像「28 处值不对」，实际是「28 个选择器都不存在」。重写时把断言收敛到
6 条各自独立的**决策**上，每条只问一件事：

| 目标 | 它锁住的决策 |
|---|---|
| `.pdf-page-block` | 纸张**不随主题翻转**（深色下也是白纸）—— 谁给 `--surface-paper` 加深色覆写就红 |
| `.reading-assist-menu` | 浮层主体取 `--surface-panel` + `--border-default` |
| `.reading-assist-excerpt` | 同一浮层内的层次：panel → **app** → sunken。摘录取 app 而非 panel/sunken，是为了拉开底色差且不与按钮撞色 |
| `.reading-assist-submit` | ★ 唯一一处断言**手写 CSS 规则能取到运行时注入的强调色**。注入点一旦被挪到后代元素，这条立刻变灰 —— 正是本仓踩过的 P0（强调色点了界面不变，且深浅两态同一个灰，截图上看不出来） |
| `.web-loading-overlay` | `color-mix(…, transparent)` 就地派生半透明面的 alpha 保真 |
| `.reading-assist-action` | 按钮底取 `--surface-sunken` |

**别把守卫断言绑在零消费者的规则上。** 同一轮里发现
`check-pdf-virtualization.mjs` 的一条断言是
`assert(styles.includes("isolation: isolate"), "Native text selection must be isolated…")`，
而全仓 `isolation: isolate` 只有一处实例、宿主是 `.page-stack` ——
该类在 HEAD 的 src、清理后的 src、dist 产物**三处都零消费者**（含 `classList.add` 动态拼接的可能）。
也就是说，这条断言一直在**用一条永不生效的规则做担保**：它过去打印「绿」不代表选择域真被隔离，
它今天变红也不代表功能回归。（另注：`isolation` 是层叠上下文属性，与选择行为没有因果关系。）
已作废，并换成一条**存活断言** —— 它防的正是这个坑本身：

```js
assert(styles.includes(".pdf-selection-scope") && viewer.includes("pdf-selection-scope"),
  "PDF selection scope must stay bound to a live consumer, not to orphan CSS.");
```

真正的选择隔离由绑在活规则上的相邻断言承担（`.pdf-selection-scope .textLayer span::selection`、
禁止页面级 `::selection`、`.page-text-overlay.is-selectable .textLayer *`、禁止 `span`/`br`
成为独立选择岛、禁止在文本层祖先上 `user-select:none`），故这次作废**不降低任何活约束**。

**守卫短路会掩盖后续失败。** 本仓 4 条契约的 `assert` 都是「第一条失败即抛」，
于是「只报 1 条失败」完全不能推出「只有 1 条失败」。排查时用「assert 收集不抛」的临时副本
一次性拿到全部失败清单：`check-pdf-virtualization` 实际是 **14 条**失败，不是 1 条。
批量改守卫前先这样全量求值一次，比逐条修快得多。

### 11.4 阅读器模块：5509 行单文件 → 1 + 4

`src/components/PDFViewer.tsx` 原为 **5509 行**单文件，2026-10-04 按职责拆分：

| 文件 | 行数 | 职责 |
|---|---|---|
| `PDFViewer.tsx` | 3684 | 主体（保留原名，仍是入口） |
| `pdfReader/readerCore.ts` | 1166 | 共享类型 + 纯函数（无 React 依赖） |
| `pdfReader/PageCanvas.tsx` | 541 | 逐页画布渲染（含唯一一处 `classList` 用法） |
| `pdfReader/PageThumbnail.tsx` | 197 | 缩略图 |
| `pdfReader/ToolButton.tsx` | 32 | 工具条按钮 |

拆分纪律：

1. **依赖方向单向**：`readerCore ← {PageCanvas, PageThumbnail, ToolButton, PDFViewer}`。
   `readerCore` 不 import 任何一个组件，因此不存在循环依赖。
2. **纯搬运，零逻辑改动。** 正确性判据用编译器的严格档就够了 ——
   `tsconfig` 开了 `noUnusedLocals` / `noUnusedParameters`，把「搬走后遗留的未使用 import」
   和「漏搬的符号」都变成硬错误。迭代法：改完即跑 `tsc --noEmit`，按报错收敛
   （本次 277 条 → 9 条 → 0 条）。**不要靠读代码判断拆干净没有。**
3. **先迁令牌，再拆文件。** `dark:` 配对迁移（214 处）与拆分是两件独立的事，
   而且要**先迁后拆**：若先拆，拆出的新组件里仍带着旧 class 串，反而增加核对面。
   （这条推翻了此前「必须捆绑做，因为读代码的成本只付一次」的判断 ——
   门禁 4 立起来之后捆绑就不必要了。**捆绑决策的时效性取决于门禁是否已存在。**）

**契约守卫怎么读这个模块：`scripts/lib/reader-view.mjs`。**

有 4 条契约守卫断言的对象分布在这个模块里（`pdf-virtualization` / `image-index` /
`reading-assist` / `translation-race`）。拆分后若各自写 `readFileSync("PDFViewer.tsx")`，
就会有 **31 条断言**因为「目标换了文件」而变红 —— 与功能是否回归完全无关。

解法是把模块当**一个整体**读：

```js
import { readerView, fileView } from "./lib/reader-view.mjs";
const viewer = readerView();                      // 模块并集，80+ 条断言一行不用改
const pageCanvas = fileView(FILE_PAGE_CANVAS);    // 只有需要「相对顺序」的断言点名文件
```

两个设计决定：

- **自动发现**，不维护文件清单：`PDFViewer.tsx` + `pdfReader/` 下所有 `.ts`/`.tsx`。
  写死清单的话，下次再拆就会有人忘记登记，而症状是**正断言静默变红、负断言静默变弱**。
- 并集让负断言**变强**（在更多文件里找禁止写法），这是想要的方向；
  但必须先核对「所有负断言的针在模块里都不存在」，否则会凭空多出失败。

**只有两类断言能点名文件：** ① 依赖 `indexOf` 先后顺序的（如
「`if (!active)` 必须在 `doc.getPage()` 之前」）；② 逐文件语义的（如
「两个渲染点各清理一次」的计数）。此外要注意 `viewer.raw.slice(a, b)` 一类切片
也必须切在**同一个文件**里，否则区间会跨文件错位。

---

### 11.5 E2E 的失败归因：时序，不是回归（2026-10-04）

`npm run test:e2e`（`scripts/smoke-e2e.mjs`）是一条约 350 行的单链路浏览器脚本，
对着 `tauri dev` 的 Vite 地址跑，长期偶发红。**判定「时序 vs 真实回归」的可复用手法：**

1. **失败位置漂移 = 时序。** 同一构建连跑，位置不停换：拖选超时（L183）
   → `Expected visible: translation paragraph highlight`（L275）
   → `Translation hover does not cover all text spans {"spans":0,"covered":0}`（L290）
   → `text span has no selectable geometry {"textBox":{0,0,0,0}}`（L176）。
   确定性回归会**稳定停在同一条**上。
2. **量到的是「元素已经不在了」，不是「值不对」。** `spans:0` 与 `textBox:{0,0,0,0}`
   是 detached / 未布局元素的特征（detached 元素 `getBoundingClientRect()` 全零）。
   上一个断言刚通过「几何稳定」，下一个就量到 0 ⇒ 中间发生了重建。
3. **机制在代码里查得到：** `PageCanvas` 的渲染 effect 依赖 `renderZoomScale` /
   `enableTextLayer`，重建时执行 `textHost.replaceChildren(builder.div)`，旧 span 立即 detach。
   而测试的「稳定」判据只要求**连续 3 帧**看到同一个可见 span —— 旧层在被替换前完全满足它，
   **护栏会在旧层上误判为稳定**。模式切换处另有一个固定 `waitForTimeout(360)`。
4. **用 HEAD 做 A/B：** `git worktree add --detach`＋`node_modules` 软链，
   两侧跑**同一份**测试脚本、各自全新 dev server、**串行**跑（并行会因 CPU 争抢制造假 flake）。
5. **探针 dump 运行时值，不要读代码判断。** 「`.page-stack` 有没有消费者」这种问题，
   读代码会得出错误结论；`document.querySelector('.page-stack')` 一行就能定案。

本轮实测（串行，各自全新 dev server）：

| 对象 | 结果 |
|---|---|
| 工作区 ×3 | 红（拖选超时）／红（白板空状态）／**绿（整条链路通过）** |
| HEAD ×3 | 红 ×3，且**稳定停在同一处**：L148 点「添加第一条笔记」被 `svg.absolute.inset-0` 拦截 |

**结论：本轮的拆分与清理不是 PDF 交互失败的原因**，三条独立证据：
(a) 文本层运行时数值与 HEAD **逐项相同**（§4.7 表）；
(b) `.page-stack` 从未被应用，删除是空操作；
(c) 工作区**能跑通整条链路**，含全部 PDF 交互断言。
并且 HEAD 在**更早一步**就稳定卡住（白板 SVG 遮挡空状态按钮，`elementFromPoint`
在按钮中心取到的是那层 svg、`pointer-events:auto`；工作区已无此层）——
也就是说这一点上工作区是**更好**的，不可能由它引入。

> 修法（测试侧，宜另开一条）：把固定 `waitForTimeout(360)` 换成「等层重建完成」；
> 把「连续 3 帧稳定」改成「同一元素集合稳定**且**不处于替换中」；给几何/选区断言加有界重试。
> 另注意 §4.7：文本层缩放链路曾经整条失效（已在 §4.7.1 修复），
> 但修它**不会**让 E2E 变绿 —— 实测修后仍 0/3。两件事要分开归因，别互相背锅。

---

### 11.6 Pattern 层（L3 组合层）的先例对照

`src/ui` 是**组件层**（L2，回答「按钮该长什么样」），它没有回答「这一屏该怎么拼」。
本仓缺的是**组合层**（L3）—— 判据是同一语义的手写重复：
`border-dashed` 空状态 **15 处**散成 6 种圆角 / 2 种描边档 / 8 种内边距。

Pattern 层的落地前先做了**外部先例调研**，避免把别人已经验证过的约束重新发明一遍。
**调研结论不在此处复述**，见单一来源：

> **`docs/pattern-precedents.md`** —— 8 个 Pattern（EmptyState / SectionCard /
> WorkbenchToolbar / SidePanel / ListRow / CollectionHeader / ReaderShell / OverlayMenu）
> 各自的先例、采纳项、拒绝项与可机械验证的判据，以及从多来源提炼的 5 条跨 Pattern 通用规则。
> 同文件另有一节「阅读中的原位辅助」，为 §11.7 的伴读 Agent 提供先例 —— 那一节覆盖
> PDF 阅读器、Markdown 阅读器与侧栏/划词翻译三类产品形态。

两条与本文件其它章节强相关的结论，在此处交叉引用以免漏读：

- **任何把控件藏起来的设计都要自报状态**（Carbon Filtering）→ 与 §4.7 的「静默失效」同源：
  用户看不到的东西必须有可见代理。
- **Pattern 层是唯一该注入运行时变量的地方**（ReaderShell）→ §4.1 陷阱一与 §4.7 坑一
  的成因都是「注入点与消费点不在同一个定义域」。

### 11.7 伴读 Agent：主动提示的原位对话（提案，未实现）

**触发**：阅读 PDF / Markdown 时，按「当前可见段落 + 停留时长」判断读者可能卡住的位置，
在原文旁挂一条轻量气泡 —— 一句候选疑问 + 一两句预览，读者可「展开解释 / 追问 / 暂不提示」。
这一节只定**约束**，不定视觉；视觉稿出来前先读外部先例（`docs/pattern-precedents.md`
的「阅读中的原位辅助」一节）。

#### 本仓已有的零件（**必须复用，不要再写一份**）

| 能力 | 现有位置 | 新功能怎么用 |
|---|---|---|
| 段落锚点 | `findReadingBlockIdForRect` / `PDF_TEXT_BEARING_BLOCK_KINDS` | 气泡挂**块 id**，不挂像素坐标 |
| 选区弹层 | `ReadingAssistMenu.tsx` 的 `inline-toolbar` 变体 | 气泡是它的**主动建议态**，不是第二个面板 |
| 问 AI | `readingAssistant.ts`（abort / 超时 / 响应体上限） | 直接调用，不要另写 fetch |
| 模型配置 | Settings 的 `normalizeConfig` / `isModelEndpointConfigured` | 未配置时**不得**显示气泡 |
| 翻译 | `setSidePanelView("translation")` | 追问里的「翻译这句」走它 |
| 批注持久化 | annotation 已存可选 `blockId` | 伴读记录走同一条路径 |
| 弹层定位钳制 | `services/overlayPlacement.ts` 的 `resolveOverlayPoint` / `clampOverlayPoint` | 尺寸由 DOM 实测传入；**不要再引入尺寸常量，也不要另写一套碰撞逻辑** |

#### 硬约束

1. **不得新建第二套内联表面。** 现状已有一个划词弹层（触发 = 用户划词）。再加一个独立
   气泡组件，就会出现两个「AI 在这儿说话」的位置，锚点解析、位置钳制、abort 生命周期
   各写一份 —— 即 §14 的「第二处真相」。做法：把气泡做进 `ReadingAssistMenu`，
   用状态区分「建议态」与「应答态」。
2. **不得仅凭鼠标经过触发。** 触发条件是「可见 + 停留」，不是 hover 事件。
3. **不得连续弹出。** 同一屏同时最多一个气泡；被「暂不提示」的块在本次会话内不再提示。
4. **气泡必须自报「为什么在这儿」**（一行理由，如「这段含 3 个未定义缩写」）——
   与 §11.6 的「收起来的控件要自报状态」、§4.7 的「静默失效」同源：
   用户无法解释的主动行为会被读成干扰。
5. **不得在快速滚动时发起请求。** 可以为附近段落预生成候选，但**先缓存、不弹**。
6. **不得遮挡正文。** 气泡贴边、避开当前段落行盒；关闭主动提示后不留任何痕迹。
7. **必须可整体关闭**（设置项）并记住「频率」偏好；关闭态不得静默继续请求。
8. **颜色不得成为唯一语义载体**（§12 第 3 条）：高亮 + 图标 + 气泡缺一不可。

#### 最小可验证版本（MVP）

只做 PDF；只跟踪可见段落与停留时长；按需生成**一条**候选提示；点击展开可追问的气泡；
`blockId` 落库可回跳。三个验收数：**锚点准确率**（高亮是否落在真正那一段）、
**打扰度**（阅读 10 分钟弹出几次）、**采纳率**（展开后是否追问 / 复制）。
三项合格前不扩展到 Markdown 与网页。

#### 控件归属：伴读是叠加层，不是第四个阅读模式（2026-10-04 决定）

阅读界面有两个**互相独立**的三态开关，容易被当成一个：

| 开关 | 取值 | 作用域 | 位置 |
|---|---|---|---|
| `readerMode` | `reader` / `translation` / `image-label` | 主区**叠加哪一层**（三选一互斥） | 顶栏图标段 |
| `sidePanelView` | `notes` / `translation` / `resources` | 右栏**显示哪一份内容** | 右栏 3 标签 |

三条结论，都可机械核对：

1. **伴读不得做成 `readerMode` 的第 4 个取值。** `readerMode` 是单选值，任一刻只能落在三者之一；
   而伴读在 `reader` 与 `translation` 下都需要 —— 波浪线与锚点在两个视角下都存在：
   阅读块由 `PageCanvas.tsx:421` 的 `enableTextLayer` 决定，**不受 `readerMode` 影响**
   （`enableAssistBlocks` 只门控块级选区交互与 `is-assist` 样式，不门控块数据）。
   做进模式，就必然与「双语」二选一。
   > 对照 §4.6 的色板收敛：那里删掉 3 个只差一根 1px 描边的色板项，理由是「伪选择」。
   > 一个只翻转一层叠加的模式位，是同一种错误在**模式层**的版本。

2. **汇总面放进 `sidePanelView` 的 `notes` 标签内** —— 既不新增第 4 个标签，也不塞进 `translation`。
   - 不新增标签：自动标注本身就是批注（共用同一份 `ReaderAnnotation`、同一个 `blockId` 锚点）。
     独立成标签会让同一批标注同时出现在两处，即 §14 的「第二处真相」。
   - 不放 `translation`：翻译是「全量译文」（每段都有内容），伴读是「每页最多 1 条」的稀疏提示。
     密度差一个量级；用户得主动去翻，就违背了「跟随阅读」。

3. **`image-label` 态自动收起，且不需要用户手动关。** 用户正在导出图片，气泡在此处无意义；
   把「要不要关」推给用户，会被读成「这个功能坏了」。

**已知限制**（是当前形状，不是缺陷）：文本层只在 `activeTool === "select"` 或翻译态开启
（`PDFViewer.tsx:2975`）。用手形 / 批注工具时没有阅读块，伴读只能退化为手动划词唤出。
要让它在前述工具下也工作，需先让 `enableTextLayer` 与 `activeTool` 解耦 —— 属于另一轮。

**视觉稿**：Ardot 画布「④ 控件归属」一屏。

### 11.8 AI 自动标注：三种形态 × 四档强度（提案，未实现）

**触发**：与 §11.7 共用同一套阅读态信号（可见段落 + 停留 + 划词 / 批注历史）。差别在产出物
—— 11.7 产出**一次对话**，本节产出**留在纸面上的痕迹**。两者是上下游关系，见本节末。
界面稿见 Ardot「r0nix 伴读 Agent + AI 自动标注 界面稿」（3 屏：组合效果 / 三态 / 形态与强度）。

#### 三种形态：形状承载语义，颜色只承载强度

| 形态 | 语义 | 取值 | 与 agent 联动 |
|---|---|---|---|
| 荧光笔（底带） | 关键结论：读完之后应该记住的那一句 | `--state-warn-border` `#FDE68A` @ 55% | 否，纯记录 |
| 下划线（实线） | 论点、定义、方法要件：支撑结论的骨架 | `--content-primary` `#18181B`，2px | 否，纯记录 |
| 波浪线 | AI 判断你可能卡住 | `--state-danger-fg` `#B91C1C`，1.6px | **是** —— 唯一带伴读锚点的形态 |

**为什么形状优先于颜色**：三种标注在灰度或色盲模式下必须仍然可分（§12 第 3 条）。
若把语义压在色相上，去掉颜色就只剩「三条线」，形态再相同即彻底不可读。

**这是一处刻意的调色板豁免。** 本仓规定「唯一允许的彩色入口是状态色」，而这里让阅读内容
带上暖黄 / 红。理由与 `--surface-paper` 完全同源（§3.6 同款逻辑）：标注属于**纸面内容**，
不是界面 chrome；它的颜色需求由阅读习惯决定，不由 UI 主题决定。
豁免范围**仅限纸面上的标注本身** —— 侧栏、气泡、控件一律回到令牌。

#### 四档强度：只改密度，不改类型

`关 / 轻 / 中 / 重`，默认「中」。界面稿所用的口径：关 0 处；轻只标最关键 1–2 处；
中 = 结论 + 论点；重再加疑难句与铺垫。**上限是正文 60%**，再高会打断阅读节奏。
这个上限要写进实现，不能只写文档（§11.7 同款纪律）。

改档位**只影响之后翻到的页**，不重算已生成标注 —— 否则读者会看到页面在眼前重排。

#### 硬约束

1. **手动删除优先。** 读者删掉某处标注后，AI 不得在同一句重新标注。这条不进设置项，
   必须是默认行为 —— 「我刚删掉它又长回来」会直接摧毁信任，且事后无法挽回。
2. **密度上限写进实现**，不是文档约定。
3. **只有波浪线可以带伴读锚点。** 三种形态全联动 = 满页弹窗，直接违反 §11.7 约束 3。
4. **强度档位不得只靠颜色深浅区分**，见上文的形状优先原则。
5. **不得在滚动 / 翻页途中增量写入标注**，避免逐帧重排；标注应随该页首次进入时一次性落定。
6. 标注与既有 annotation 同表持久化（该模型已有可选 `blockId`），**不新建第二套「AI 标注」存储**。

#### 与 §11.7 的依赖顺序

自动标注是伴读的**上游**：波浪线给出「这里有疑问」的位置，伴读气泡才有稳定锚点可挂。
因此实现顺序应为「先标注层、后气泡层」；反过来做，气泡会在没有锚点的地方找锚点。

#### 接口契约（实现看这里，本节不复制）

> **`docs/companion-reading-plan.md`** —— §11.7 与 §11.8 两个提案的**实现契约与施工执行单**。
> 内容：已存在零件清单（带 `file:line`）、真实缺口 5 项、逐条 `(期望原文, 新值)` 三元组、
> 加一个标注 kind 的 6 个接触点（**标注了哪 2 个 `tsc` 抓不到**）、气泡状态机、
> LLM 解析纪律、`clampToolbarPosition` 的尺寸失配、防回归守卫与变异测试、
> 负向边界、验收判据、7 批施工顺序。
>
> 已拍板的前置决定（写在那儿，这里不复述以免两处漂移）：行为信号**只在本机永不上传**、
> **不新增 Rust 命令**、只做 PDF。
> 本节只描述**设计意图**；接口以该文件为单一来源。

---

## 12. 无障碍

1. 所有可交互元素必须有可见的 `:focus-visible` 环，由 §8.1 的一条全局规则统一提供
   （颜色 = 用户强调色，2px + 2px 偏移）。
   实测：键盘 Tab 走过 11 个控件全部有环；带 `focus:outline-none focus:ring-*` 的
   元素由组件自己的环接管，不产生双环。
   迁移前有 **2 处裸的 `focus:outline-none`**（无任何替代环，`Whiteboards.tsx` 的
   卡片标题输入框与内容文本域）—— 已直接删掉那两处 opt-out。
   **新增可交互元素时不要再写 `focus:outline-none` 而不给替代环。**
2. `--content-muted` 与 `--content-disabled` 若用于正文，必须验证对比度 ≥ 4.5:1。
   `#71717a` 落在 `--surface-sunken` 上约 4.39:1，低于阈值 —— 只可用于非关键元信息。
3. 状态色不得作为唯一的信息载体，需配图标或文案。
4. 图标按钮必须带 `aria-label` 或可见文字。
   **已由类型系统兜住**：`src/ui/IconButton.tsx` 的 `label` 是必填 prop
   （`Omit<ButtonHTMLAttributes, "aria-label">`），漏写直接编译失败，不靠自觉。
5. 状态必须**看得见**：禁用/不可用的控件要有可区分的视觉。
   迁移前 Settings 的输入框没有禁用态样式 —— 代理关闭时代理字段仍是白底黑字，
   看起来可用。现在统一由 `FIELD` 提供 `disabled:bg-surface-sunken
   disabled:text-content-disabled disabled:cursor-not-allowed`。
6. 原生控件配色（滚动条、`input`、下拉）跟随主题：`App.tsx` 的主题副作用写
   `documentElement.style.colorScheme = theme`，`index.html` 内联脚本只做首帧优化。
   两者都不可省 —— 少了内联脚本会闪一帧浅色，少了 React 那行会与主题分叉（见 §4 ⑦）。
7. `--accent-on` 是「强调色之上的前景色」，**不要用固定色代替**。
   实测反例：`.home-open-btn` 曾写 `color: white`，深色 + zinc 时强调色是 `#f4f4f5`，
   对比度 **1.08:1** —— 文字基本不可见。改用 `--accent-on` 后 **16.12:1**。

---

## 13. 验收清单

提交 UI 变更前逐条确认：

- [ ] 没有新增字面色值（`#hex` / `rgb()` / `rgba()`，也包括 `white` / `black` 关键字）
- [ ] 没有使用非 zinc 的 Tailwind 调色板类（`blue-*` / `slate-*` / `gray-*` …）
- [ ] 新增/保留的 `.css` 都真的被 import（守卫规则 3：孤儿样式表会让迁移进度失真）
- [ ] 强调色位置全部走 `--accent`，切换强调色后无残留
- [ ] 状态色走 `--state-*` 三段式，未借用调色板类；`border` 与「半透明派生」没有混用
- [ ] 深色模式通过令牌自动生效，没有新增 `[data-theme="dark"]` 块
- [ ] 圆角取自允许档位；间距取 2px 刻度；字号 ≥ 11px
- [ ] 阴影只用 `--elev-sm / md / lg / xl`，没有新增字面量阴影
- [ ] 引用运行时变量时，**声明 `var()` 的元素在注入点定义域之内**（见 §4.1 陷阱一）
- [ ] 动效只用了 `--duration-*` 与 `--ease-*`（**注意：这条目前没有门禁**，见 §10）
- [ ] 光标描述的是该按键**实际会发生的动作** —— 判据看 handler 不看工具名；
      改了输入行为就要同步改光标（见 §10.1）
- [ ] 同一行为判定没有在 JSX 里抄第二份（如「文本层渲不渲染」与「overlay 让不让路」）；
      多个消费方要共用一个变量（见 §10.1 约束 1）
- [ ] 新增的手写 rAF / 逐帧动画自己判断了 `prefers-reduced-motion`
      （令牌归零影响不到它，见 §10）
- [ ] 未新增裸的 `focus:outline-none`（要 opt-out 就配一个 `focus:ring-*`）
- [ ] 「刻意不随主题翻转」的颜色走具名令牌（如 `--surface-paper`），**不留字面量** ——
      字面量与「忘了迁移」在代码里长得一样，会让基线掩盖真缺陷（见 §3.1 第 6 档）
- [ ] 新界面优先用 `src/ui/` 的 primitive；没有在 TSX 里新写一份「带 `dark:` 配对」的颜色组合
- [ ] 常见控件（按钮/输入框/下拉/卡片）已改用 primitive，`dark:` 出现次数在下降
- [ ] 改的是**手写 CSS 规则**（不是 TSX 类名）时，跑 `npm run design:probe -- <cases.json>`
      确认目标态 —— 整页快照看不到未挂载视图的规则（见 §11.3）
- [ ] 迁移映射（旧 class 串 → 新令牌类）已用探针的 `comparisons` 验证逐项等价；
      不等价处已登记到 §4 或 §4.3 / §4.4 / §4.5
- [ ] `hover:` / `disabled:` 这类伪类映射，已用**去掉伪类前缀**的等价类覆盖
      （伪类只加条件、不改值，见 §11.3）；位移处标 `acceptedDrift`，不要删掉用例
- [ ] TSX 里没有新增 `dark:` + zinc/white/black 的颜色配对（守卫规则 4，棘轮；当前已归零）
- [ ] TSX/TS 里没有出现任何 zinc / white / black 工具类，**包括只有一份值的**
      （守卫规则 5，零容忍 —— 「一份值」在深色下会变成近白块，见 §4.5 第 3 批）
- [ ] 改 TSX 类名时跑 `npm run design:probe:all`（**一键跑全部用例**；
      分批迁移时漏跑一个用例 = 漏掉一整块盲区，见 §11.3）
- [ ] `node scripts/check-design-tokens.mjs` 通过（无新增违规）
- [ ] `npm run check:contracts` 通过（**不要因为「反正一直是红的」而跳过**）
- [ ] 若刚删过 CSS 规则：用**双源存活判据**确认被删类确实零消费者，并跑一遍
      「清理前备份 vs 现在」的声明级对比，确认**存活规则一个声明都没变**（见 §4.6）
- [ ] 若改过 `src/components/pdfReader/**` 或 `PDFViewer.tsx`：确认 4 条相关契约守卫
      走的是 `readerView()`（模块并集），而不是写死 `PDFViewer.tsx`（见 §11.4）
- [ ] 若改了探针用例的目标：确认目标 class 在 `dist` 里真的有规则。
      「量到 `rgba(0, 0, 0, 0)`」= 选择器不存在，不是值不对（见 §11.3）
- [ ] 改动白板色板或色值读取时：确认 `CardColor` 仍只有 `zinc` / `blue`，
      且旧值只经 `normalizeCardColor()` 收敛（`npm run check:whiteboard` 会拦，见 §3.6）

---

## 14. 禁止清单

| 禁止 | 原因 |
|---|---|
| 字面色值（含 `white` / `black` 关键字） | 破坏深浅色与强调色切换 |
| 第二套 UI 字体栈 | 破坏排版一致性，跨平台字形漂移 |
| 非 zinc 中性色阶 | 一个界面不能有两种「灰」 |
| 渐变 / 光晕 / 拟物装饰 | Swiss 零装饰条款 |
| 新增 `[data-theme="dark"]` 块 | 深色由令牌派生，手工块必然漂移 |
| 新写 `dark:` + zinc/white/black 颜色配对 | 同一个语义写两份深浅值，两处必然对不齐（守卫规则 4 会拦）；用随主题翻转的语义令牌 |
| 在 TSX/TS 里写任何 zinc / white / black 工具类（哪怕**只有一份值**） | 一份值意味着浅深共用，必然在某一侧不成立 —— 实测抓到「深色下近白方块」与「白字坐在近白强调色上不可见」（守卫规则 5 会拦，零容忍）；确需「不随主题翻转的白」请补语义令牌（如 `--surface-paper`），**不要开豁免** |
| 为让门禁变绿而「删掉用例 / 改写注释」 | 位移与色值说明是证据，不是噪声；门禁绿不等于质量达标（见 §9 教训） |
| 临时圆角 / 时长 / 阴影值 | 刻度外的数值是碎片化的起点 |
| 在组件里写死强调色 | 切换到其他强调色时会残留 |
| 把运行时注入的变量（`--reader-accent*`）的**注入点放在引用它的派生声明之后代元素上** | 代入发生在声明处，拿到的是兜底值；不报错、不报缺失，只是深浅两种主题下都取同一个灰色（见 §4.1 陷阱一） |
| 用固定色代替 `--accent-on`（如 `text-white`） | 强调色在深色 + zinc 时是近白色，固定白字实测 1.08:1 |
| 先建令牌集、再让代码去凑（`--space-*` / `--z-*` / `--elev-raised` 都栽在这） | 令牌与代码不一致时，令牌只是第二处需要维护的谎言；刻度要**从代码实测归纳** |
| 无人 import 的样式表 | 3477 行死 CSS 曾长期污染迁移进度的判断 |
| 在多个文件里各抄一份同一套调色板 | 改一处漏一处必然漂移（白板节点调色板已出现 0.02 alpha 的漂移，见 §11.1 ②） |
| primitive 基类里写会与调用方冲突的属性（宽度、颜色） | 同属性的两个 Tailwind 类靠产物顺序决胜，调用方的值会被静默盖掉（见 §11.1 ①） |
| 契约守卫用逐字符精确匹配源码（`src.includes("a = b")`） | 格式化器一动空格，正断言静默失败、负断言静默放行；本仓 16 条契约曾有 6 条因此失效。统一走 `scripts/lib/source-view.mjs` 的 `view()` |
| 把守卫的**基线计数**当成「质量已达标」 | 数字会掩盖「同类里混着真缺陷」：令牌基线从 10 降到 9 时看起来只剩豁免，逐行核对却发现里面藏着 1 处对比度缺陷 + 4 处漏迁（见 §4 第三批） |
| 让守卫在**原始文本**上匹配（把注释里的色值也算作违规） | 注释不参与渲染。这样会逼着人删掉注释里解释原因的色值 —— 本仓真实发生过：为压低基线把「实测对比度 1.08:1」写得含糊（见 §4 ⑯） |
| 把守卫/探针断言绑在**零消费者**的规则上 | 那等于用一条永不生效的规则做担保：绿了不代表机制在，红了也不代表功能退化。本仓真实发生过 —— `isolation: isolate` 的唯一宿主 `.page-stack` 三处零消费者（见 §11.3） |
| 删 CSS 规则时不看「同特异度更宽泛兄弟规则」 | 删掉更具体的那条后，同层更宽泛的规则会立刻接管，颜色就变了；只看「选择器是否还在」的差分脚本发现不了（见 §4.6） |
| 把守卫的**文件清单写死**（而不是自动发现目录） | 下次再拆文件时有人会忘记登记，症状是正断言静默变红、负断言静默变弱（见 §11.4） |
| 把 Tailwind 扫描范围收成只扫 `src/` | `scripts/design-diff/cases/*.json` 的 before/after class 串必须被扫描，否则探针的 `comparisons` 全量退化成 `rgba(0, 0, 0, 0)`（见 §2.1） |
| 移除 `index.css` 里的 `@source not "../docs"` | 一旦移除，本文档里为说明「迁移前长什么样」而写的类名会被重新编进产物，甚至生成指向已删令牌的死声明（见 §2.1） |
| 白板卡片再引入非 zinc 的中性色阶（stone / slate / olive） | 已收敛为 zinc + blue。四个中性的 border 色度全 ≤0.036（都是灰），差异只落在 1px 描边上、卡片纸面像素级同色（见 §3.6）；`check-whiteboard-contract` 会拦 |
| 为「主动提示」类功能新建第二套内联浮层 / 锚点解析 | 会出现两个「AI 在这儿说话」的位置，锚点、位置钳制、abort 生命周期各写一份；应把建议态做进 `ReadingAssistMenu`（见 §11.7） |
| 让主动提示只凭 `hover` 触发，或不做自报理由 | hover 会被读成误触；无法解释「为什么弹在这儿」的主动行为等同于干扰（见 §11.7 约束 2 与 4） |
| 把 AI 自动标注的语义编码成颜色（三种形态同形、只靠色相区分） | 灰度 / 色盲模式下三种标注退化成一模一样的线，语义全丢；形状才是主语义载体（见 §11.8） |
| 让 AI 在被读者手动删除的句子上重新标注 | 「刚删掉又长回来」直接摧毁信任，且事后无法通过设置项挽回（见 §11.8 约束 1） |
| 光标承诺的动作与实际发生的不一致（如 pan 配 `ns-resize`、拖不动的配 `grab`） | 光标是对动作的承诺，说谎的光标比没有光标更误导 —— 用户会照它去按。判据是 handler 做了什么，不是工具名叫什么（见 §10.1） |
| 把同一个行为判定在多个消费点各写一份 | 改一处漏一处会产生「看得见却用不了」的静默失效：不报错、两个症状都不指向真正的原因（见 §10.1 约束 1） |
| 把触控板捏合接进滚轮缩放的参数 | 两种输入语义不同（离散增量 vs 连续倍率）。实测捏合 `\|deltaY\|` 仅 3~14，套滚轮参数一次捏合就翻倍（见 §10.1） |
| 重新打开 React Flow 的署名隐藏（`proOptions={{ hideAttribution: true }}`） | 依赖内 `Attribution` 组件的 `data-message` 明写「Please only hide this attribution when you are subscribed to React Flow Pro」—— 这是**需要订阅的请求**，不是 MIT 义务（MIT 不带署名条款）。本仓未订阅，故显式写 `false`；`check-whiteboard-contract` 会拦（见 `WhiteboardCanvas.tsx` 该行注释） |
