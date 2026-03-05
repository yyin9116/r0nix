# PDF Reader - Tauri + React

基于Swiss Design设计稿的跨平台PDF阅读器，使用Tauri + React + TypeScript构建。

## 技术栈

- **前端**: React 18 + TypeScript + Vite
- **桌面框架**: Tauri 2.0
- **后端**: Python (FastAPI) - 用于PDF处理
- **设计**: Swiss Design风格

## 项目结构

```
pdf-reader-tauri/
├── src/                    # React前端代码
│   ├── components/         # React组件
│   │   ├── Sidebar.tsx    # 侧边栏（文件列表）
│   │   ├── Toolbar.tsx    # 工具栏（视图切换、操作按钮）
│   │   ├── PDFViewer.tsx  # PDF查看器
│   │   └── MarkdownEditor.tsx  # Markdown编辑器
│   ├── App.tsx            # 主应用组件
│   ├── main.tsx           # React入口
│   └── index.css          # 全局样式（Swiss Design）
├── src-tauri/             # Tauri Rust后端
│   ├── src/
│   │   └── main.rs        # Rust主程序
│   ├── Cargo.toml         # Rust依赖
│   └── tauri.conf.json    # Tauri配置
├── package.json           # Node.js依赖
├── vite.config.ts         # Vite配置
└── tsconfig.json          # TypeScript配置
```

## 功能特性

### 已实现（UI）
- ✅ Swiss Design风格界面
- ✅ 侧边栏文件管理
- ✅ 工具栏（视图切换、操作按钮）
- ✅ PDF查看器界面
- ✅ Markdown编辑器界面（分屏预览）
- ✅ 响应式布局
- ✅ 侧边栏显示/隐藏
- ✅ 主题切换按钮

### 待实现
- ⏳ PDF渲染（集成Python后端）
- ⏳ Markdown实时编辑
- ⏳ 文件打开对话框
- ⏳ 全屏模式
- ⏳ 搜索功能
- ⏳ 缩放功能
- ⏳ 深色主题

## 开发环境要求

### 前端
- Node.js 18+
- npm 或 yarn

### Tauri
- Rust 1.70+
- 系统依赖（根据操作系统）:
  - **Windows**: Microsoft Visual Studio C++ Build Tools
  - **macOS**: Xcode Command Line Tools
  - **Linux**: 参考 [Tauri Prerequisites](https://tauri.app/start/prerequisites/)

### Python后端（可选）
- Python 3.9+
- PyMuPDF (fitz)
- FastAPI

## 安装依赖

### 1. 安装Node.js依赖
```bash
cd pdf-reader-tauri
npm install
```

### 2. 安装Rust（如果未安装）
```bash
# Windows/macOS/Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 3. 安装Python依赖（后端）
```bash
cd ../pdf_reader
pip install -r requirements.txt
```

## 运行项目

### 开发模式
```bash
# 前端开发（仅UI，无Tauri）
npm run dev

# Tauri开发（完整应用）
npm run tauri dev
```

### 构建生产版本
```bash
npm run tauri build
```

构建产物位置：
- **Windows**: `src-tauri/target/release/pdf-reader.exe`
- **macOS**: `src-tauri/target/release/bundle/macos/PDF Reader.app`
- **Linux**: `src-tauri/target/release/pdf-reader`

## 设计规范

### 颜色系统
```css
--bg-primary: #ffffff        /* 主背景 */
--text-primary: #18181b      /* 主文本 */
--text-secondary: #71717a    /* 次要文本 */
--text-tertiary: #a1a1aa     /* 第三级文本 */
--accent-primary: #2563eb    /* 强调色（蓝色） */
--accent-light: #eff6ff      /* 浅蓝色背景 */
--border-default: #e4e4e7    /* 边框颜色 */
```

### 间距系统
- xs: 4px
- sm: 8px
- md: 12px
- lg: 16px
- xl: 20px
- 2xl: 24px
- 3xl: 32px

### 圆角
- sm: 6px
- md: 8px

### 边框
- 统一使用 1.5px 边框

### 字体
- 主字体: Inter
- 代码字体: Monaco, Menlo, Consolas

## 快捷键

- `Ctrl+B` - 切换侧边栏
- `F11` - 全屏模式
- `Ctrl+O` - 打开文件
- `Ctrl+T` - 切换主题
- `Ctrl+S` - 保存文件（Markdown）

## 架构设计

### 前后端通信
```
┌─────────────────────────────────────┐
│   Tauri Frontend (React)            │
│   - UI渲染                           │
│   - 用户交互                         │
│   - 状态管理                         │
└──────────────┬──────────────────────┘
               │ Tauri Commands / HTTP
┌──────────────▼──────────────────────┐
│   Python Backend (FastAPI)          │
│   - PDF渲染 (PyMuPDF)               │
│   - 图片提取                         │
│   - Markdown处理                    │
│   - 文件操作                         │
└─────────────────────────────────────┘
```

## 下一步计划

1. **集成Python后端**
   - 创建FastAPI服务
   - 实现PDF渲染API
   - 实现图片提取API

2. **实现核心功能**
   - PDF页面渲染
   - Markdown实时编辑
   - 文件系统操作

3. **优化体验**
   - 添加加载状态
   - 错误处理
   - 性能优化

4. **跨平台测试**
   - macOS测试
   - Windows测试
   - Linux测试

## 许可证

MIT

## 贡献

欢迎提交Issue和Pull Request！
