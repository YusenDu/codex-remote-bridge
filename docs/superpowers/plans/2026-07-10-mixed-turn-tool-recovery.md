# Mixed Turn Tool Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and display shell, MCP/plugin, and Browser calls in historical turns that also contain file changes.

**Architecture:** Extend the JSONL recovery pass to produce ordered, individually deduplicated command/file/tool slots while keeping app-server items authoritative. Normalize MCP items into a bounded generic UI payload and render them with a compact collapsible row alongside existing command rows.

**Tech Stack:** TypeScript, Vue 3, Vitest, generated Codex app-server DTOs, JSONL session logs.

---

### Task 1: Mixed-Turn Recovery Regression

**Files:**
- Modify: `src/server/codexAppServerBridge.realtimeBridge.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`

- [ ] **Step 1: Add a failing mixed-turn fixture**

Create one turn containing an existing canonical `fileChange`, assistant messages, a legacy `function_call(exec_command)`, a `custom_tool_call(exec)`, a namespaced MCP/plugin function call, a Browser `mcp__node_repl/js` call, outputs, and a duplicate canonical `mcpToolCall`. Assert ordered types and stable ids, and assert that the canonical MCP call is not duplicated.

- [ ] **Step 2: Run the regression and verify RED**

Run: `pnpm exec vitest run src/server/codexAppServerBridge.realtimeBridge.test.ts -t "recovers mixed turn tools"`

Expected: FAIL because the current `alreadyHasRecoveredItems` whole-turn guard returns before command/tool recovery.

- [ ] **Step 3: Replace the whole-turn guard with per-item deduplication**

Extend `SessionItemSlot`:

```ts
type SessionItemSlot = {
  type: 'agentMessage' | 'commandExecution' | 'fileChange' | 'mcpToolCall'
  item?: Record<string, unknown>
  signature?: string
}
```

Build existing-id and conservative-signature sets. During interleave, append a recovered item only when neither set contains it. Preserve every canonical non-user item in its original relative order; do not append all canonical items at the end after recovered slots.

- [ ] **Step 4: Parse raw MCP/plugin and Browser pairs**

Map namespaced function calls and outputs to standard-shaped items:

```ts
{
  type: 'mcpToolCall',
  id: `session-mcp-${callId}`,
  server,
  tool,
  status: 'completed' | 'failed' | 'inProgress',
  arguments,
  result,
  error,
  durationMs,
}
```

Recognize `namespace`, `mcp__<server>` names, Browser `mcp__node_repl/js`, and current raw call/output variants. Bound arguments and result strings before returning them to `thread/read`.

- [ ] **Step 5: Run the regression and verify GREEN**

Run: `pnpm exec vitest run src/server/codexAppServerBridge.realtimeBridge.test.ts`

Expected: all recovery tests PASS, including mixed-turn order and dedupe.

- [ ] **Step 6: Commit server recovery**

```powershell
git add src/server/codexAppServerBridge.ts src/server/codexAppServerBridge.realtimeBridge.test.ts
git commit -m "fix: recover tools from mixed historical turns"
```

### Task 2: Generic Tool Call UI Model and Normalizer

**Files:**
- Modify: `src/types/codex.ts`
- Modify: `src/api/normalizers/v2.ts`
- Modify: `src/api/normalizers/v2.test.ts`

- [ ] **Step 1: Write failing normalizer tests**

Cover completed, failed, and in-progress `mcpToolCall`; structured result content; invalid arguments; server/tool labels; Browser title extraction from `arguments.title`; and bounded serialized payloads.

- [ ] **Step 2: Run normalizer tests and verify RED**

Run: `pnpm exec vitest run src/api/normalizers/v2.test.ts -t "mcp tool call"`

Expected: FAIL because `normalizeV2ThreadItem` currently reaches the final empty return for `mcpToolCall`.

- [ ] **Step 3: Add the typed UI payload**

```ts
export type ToolCallData = {
  server: string
  tool: string
  title: string
  status: 'inProgress' | 'completed' | 'failed'
  argumentsText: string
  outputText: string
  errorText: string
  durationMs: number | null
}
```

Add `toolCall?: ToolCallData` to `UiMessage` and normalize app-server `mcpToolCall` to `messageType: 'toolCall'`. Prefer a non-empty `arguments.title` for Browser display, otherwise use `server / tool`.

- [ ] **Step 4: Bound and redact serialized values**

Use one deterministic serializer that caps argument and result output, handles circular/invalid values, and does not stringify descriptor tokens or authorization headers when present in generic payloads.

- [ ] **Step 5: Run normalizer tests and verify GREEN**

Run: `pnpm exec vitest run src/api/normalizers/v2.test.ts`

Expected: all normalizer tests PASS.

- [ ] **Step 6: Commit the model and normalizer**

```powershell
git add src/types/codex.ts src/api/normalizers/v2.ts src/api/normalizers/v2.test.ts
git commit -m "feat: normalize MCP and Browser tool calls"
```

### Task 3: Collapsible Tool Rows

**Files:**
- Modify: `src/components/content/ThreadConversation.vue`
- Create: `src/components/content/ThreadConversation.test.ts`

- [ ] **Step 1: Write failing component tests**

Mount a conversation with completed, failed, and running tool calls. Assert a stable compact row, server/tool/title text, status label, collapsed details by default, click-to-expand arguments/output/error, keyboard activation, and no layout shift from long unbroken content.

- [ ] **Step 2: Run component tests and verify RED**

Run: `pnpm exec vitest run src/components/content/ThreadConversation.test.ts -t "tool call"`

Expected: FAIL because `messageType: 'toolCall'` has no renderer.

- [ ] **Step 3: Add the compact row renderer**

Use the existing command row group styling and disclosure interaction. Render familiar status icons already available in the project, keep the row height stable, and show `<pre>` blocks only when expanded. Do not create a nested card.

- [ ] **Step 4: Run component tests and verify GREEN**

Run: `pnpm exec vitest run src/components/content/ThreadConversation.test.ts`

Expected: all component tests PASS.

- [ ] **Step 5: Commit the renderer**

```powershell
git add src/components/content/ThreadConversation.vue src/components/content/ThreadConversation.test.ts
git commit -m "feat: render collapsible tool call rows"
```

### Task 4: Real Session and Browser Verification

**Files:**
- Modify: `tests/chat-composer-rendering/realtime-bridge-message-sync.md`

- [ ] **Step 1: Run focused and full automated checks**

Run:

```powershell
pnpm exec vitest run src/server/codexAppServerBridge.realtimeBridge.test.ts src/api/normalizers/v2.test.ts src/components/content/ThreadConversation.test.ts
pnpm run build
```

Expected: focused tests and full build exit 0.

- [ ] **Step 2: Start or reuse the current 5900 server safely**

Verify the listener process cwd before reuse. Rebuild/restart only the 5900 process owned by this repository when required; do not stop unrelated persistent development servers.

- [ ] **Step 3: Verify a real mixed historical turn**

Open the known historical thread that contains file changes, custom exec, plugin/MCP, and Browser calls. Assert nonzero counts for `.cmd-row-group` and the new tool-call rows, confirm the known PowerShell marker is visible, expand one Browser call and one plugin call, and confirm zero console errors or framework overlays.

- [ ] **Step 4: Capture performance and visual evidence**

Record `thread/read` count, response bytes, parse duration, duplicate item ids, and initial render duration. Save a screenshot under `output/playwright/` showing file changes plus command/tool rows without overlap.

- [ ] **Step 5: Update the manual test**

Document setup, exact historical thread, actions, expected command/MCP/Browser rows, failure behavior, and cleanup/rollback.

- [ ] **Step 6: Commit verification documentation**

```powershell
git add tests/chat-composer-rendering/realtime-bridge-message-sync.md
git commit -m "test: cover mixed turn tool rendering"
```
