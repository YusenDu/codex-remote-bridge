# 命令活动卡片与实时状态中文化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将连续命令改造成中文“命令活动”卡片，并在不修改原始记录的前提下中文化实时状态和常见 reasoning 摘要。

**Architecture:** 新增纯函数本地化模块，组件只消费展示文本。命令分组继续使用现有消息分组和展开状态，新增确定性的数量、类型和聚合状态辅助函数，并替换分组模板与样式。

**Tech Stack:** Vue 3、TypeScript、Vitest、Tailwind CSS、Vite、Tauri 2

---

### Task 1: 实时状态本地化

**Files:**
- Create: `src/utils/liveActivityLocalization.ts`
- Create: `src/utils/liveActivityLocalization.test.ts`
- Modify: `src/components/content/ThreadConversation.vue`

- [ ] **Step 1: 写固定状态与摘要翻译失败测试**

测试要求：`Running command` 输出 `正在运行命令`；常见动作和技术短语被翻译；中文、反引号代码、路径与未知文本保持安全回退。

- [ ] **Step 2: 运行测试确认因模块缺失而失败**

Run: `pnpm vitest run src/utils/liveActivityLocalization.test.ts --reporter=dot`

- [ ] **Step 3: 实现纯展示层翻译器**

导出：

```ts
export function localizeLiveActivityLabel(value: string): string
export function localizeLiveReasoningText(value: string): string
```

翻译器逐行处理，先保护反引号片段，再执行完整短语和常见词组映射；无法确认的内容保留原文。

- [ ] **Step 4: 将聊天实时区域接入翻译器**

模板使用：

```vue
{{ localizeLiveActivityLabel(liveOverlay.activityLabel) }}
<div v-html="renderMarkdownBlocksAsHtml(localizeLiveReasoningText(liveOverlay.reasoningText))" />
```

- [ ] **Step 5: 运行本地化和组件契约测试**

Run: `pnpm vitest run src/utils/liveActivityLocalization.test.ts src/components/content/ThreadConversation.liveReasoning.test.ts --reporter=dot`

### Task 2: 命令活动卡片

**Files:**
- Modify: `src/components/content/ThreadConversation.vue`
- Create: `src/components/content/ThreadConversation.commandActivity.test.ts`

- [ ] **Step 1: 写命令活动结构失败测试**

契约覆盖“命令活动”、`commandGroupCountLabel`、`commandGroupCompositionLabel`、聚合状态、终端图标和每行 Shell 标签。

- [ ] **Step 2: 运行测试确认旧模板失败**

Run: `pnpm vitest run src/components/content/ThreadConversation.commandActivity.test.ts --reporter=dot`

- [ ] **Step 3: 实现分组汇总函数**

```ts
function commandGroupCountLabel(message: UiMessage): string
function commandGroupCompositionLabel(message: UiMessage): string
function commandGroupStatusLabel(message: UiMessage): string
function commandGroupStatusClass(message: UiMessage): string
```

状态优先级为失败、运行中、已停止、成功。

- [ ] **Step 4: 替换分组模板和深色样式**

标题行包含终端图标、中文标题、数量、`Shell N`、状态点、中文状态和箭头。展开体内每条命令保持原有输出展开功能。

- [ ] **Step 5: 运行组件测试和生产构建**

Run: `pnpm vitest run src/components/content/ThreadConversation.commandActivity.test.ts src/components/content/ThreadConversation.liveReasoning.test.ts --reporter=dot`

Run: `pnpm run build:frontend`

### Task 3: 浏览器视觉验证

**Files:**
- No repository files

- [ ] **Step 1: 在本地开发页验证命令活动折叠和展开**

检查中文标题、状态颜色、长命令截断、输出展开、文本不溢出和控制台。

- [ ] **Step 2: 验证实时状态中文化**

检查固定状态中文、已知英文摘要中文化和未知摘要回退。

- [ ] **Step 3: 验证桌面与移动宽度**

桌面使用当前浏览器视口；移动使用 390px 宽视口，确认标题、数量和状态可换行或截断且不重叠。

### Task 4: 版本与发布

**Files:**
- Modify: `package.json`
- Modify: `apps/desktop-agent/package.json`
- Modify: `apps/desktop-agent/src-tauri/Cargo.toml`
- Modify: `apps/desktop-agent/src-tauri/Cargo.lock`
- Modify: `apps/desktop-agent/src-tauri/tauri.conf.json`
- Modify: `apps/desktop-agent/web/app.js`
- Modify: `apps/desktop-agent/web/index.html`
- Modify: `src/releaseVersionConsistency.test.ts`

- [ ] **Step 1: Web 与桌面端统一升级为 0.1.94**

- [ ] **Step 2: 运行完整验证**

Run: `pnpm vitest run --reporter=dot`

Run: `pnpm run build`

Run: `cargo test --manifest-path apps/desktop-agent/src-tauri/Cargo.toml`

- [ ] **Step 3: 构建桌面安装包与发布资产**

Run: `pnpm run package:agent`

- [ ] **Step 4: 部署公网 Web 并验证版本、交互和控制台**

- [ ] **Step 5: 提交、推送、创建 v0.1.94 标签与 GitHub Release**
