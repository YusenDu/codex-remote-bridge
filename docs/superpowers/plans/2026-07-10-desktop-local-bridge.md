# Desktop Local Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver text from the local web bridge to the addressed Codex Desktop thread through an authenticated loopback endpoint and return success only after the user message is persisted.

**Architecture:** Patch the installed Electron main process with a loopback listener that forwards a validated request into Desktop's existing thread-resume/turn-start path. Codex Mobile reads an ephemeral descriptor server-side, invokes that endpoint, then confirms the exact new user message from the addressed rollout JSONL before acknowledging `turn/start`.

**Tech Stack:** Electron/Node.js ASAR patching, Windows PowerShell/MSIX tooling, TypeScript, Vitest, Codex app-server JSONL.

---

### Task 1: Desktop Bridge ASAR Patcher

**Files:**
- Create: `scripts/windows-desktop-bridge/patch-desktop-local-bridge-asar.cjs`
- Create: `scripts/windows-desktop-bridge/patch-desktop-local-bridge-asar.test.cjs`

- [ ] **Step 1: Write failing patcher fixture tests**

Use `node:test` fixtures containing the current `app-main` listener bootstrap and app-server manager markers. Assert that the patcher injects exactly one `desktop_local_bridge_v1` marker, binds `127.0.0.1`, writes the descriptor atomically, requires `Authorization: Bearer`, caps the body, and calls the existing thread dispatch function with `{ threadId, text, submissionId }`. Add a second-run assertion proving idempotence and a missing-marker assertion proving fail-closed behavior.

- [ ] **Step 2: Run the fixture tests and verify RED**

Run: `node --test scripts/windows-desktop-bridge/patch-desktop-local-bridge-asar.test.cjs`

Expected: FAIL because the patcher module does not exist.

- [ ] **Step 3: Implement the minimal marker-driven patcher**

Export this testable contract and keep the CLI wrapper thin:

```js
module.exports = {
  patchDesktopLocalBridge(asarRoot) {},
  patchAppMainSource(source) {},
  patchRendererDispatchSource(source) {},
}
```

The injected main-process handler must validate loopback address, bearer token with `timingSafeEqual`, JSON body length, thread id, text, and submission id. It must send one request through the existing Desktop dispatch path and return JSON `{ ok, threadId, turnId }`. Write `%CODEX_HOME%/desktop-bridge.json` or `%USERPROFILE%/.codex/desktop-bridge.json` with a temp-file-plus-rename sequence.

- [ ] **Step 4: Run the fixture tests and verify GREEN**

Run: `node --test scripts/windows-desktop-bridge/patch-desktop-local-bridge-asar.test.cjs`

Expected: all patcher and idempotence tests PASS.

- [ ] **Step 5: Commit the patcher**

```powershell
git add scripts/windows-desktop-bridge/patch-desktop-local-bridge-asar.cjs scripts/windows-desktop-bridge/patch-desktop-local-bridge-asar.test.cjs
git commit -m "feat: add Codex Desktop loopback bridge patcher"
```

### Task 2: Reproducible Windows Package Installer

**Files:**
- Create: `scripts/windows-desktop-bridge/install-desktop-local-bridge.ps1`
- Create: `scripts/windows-desktop-bridge/verify-desktop-local-bridge.ps1`

- [ ] **Step 1: Write dry-run verification assertions**

The installer must expose `-DryRun`, `-Install`, `-Launch`, and `-OutputRoot`. Dry-run must stop before changing the installed package and fail unless the extracted ASAR contains one bridge marker, the listener is loopback-only, ASAR integrity in `Codex.exe` matches, the MSIX can be repacked, and the package can be signed with the existing local developer certificate.

- [ ] **Step 2: Run dry-run before implementation and verify RED**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-desktop-bridge/install-desktop-local-bridge.ps1 -DryRun`

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement the installer using the Windows patch workflow**

The script must:

```powershell
# 1. Resolve Get-AppxPackage -Name OpenAI.Codex.
# 2. Copy the installed package into a timestamped staging root.
# 3. Extract app.asar into staging, never into the repository root.
# 4. Run patch-desktop-local-bridge-asar.cjs.
# 5. Repack app.asar and update Codex.exe's ASAR SHA256 marker.
# 6. Pack and sign a new MSIX.
# 7. Install only when -Install is supplied; relaunch only with -Launch.
```

Reuse the certificate and integrity conventions documented by `codex-windows-fast-patch`. Never modify `WindowsApps` in place. Preserve the skill-created Desktop backup.

- [ ] **Step 4: Implement strict live verification**

`verify-desktop-local-bridge.ps1` must assert that the live package contains exactly one marker, `desktop-bridge.json` belongs to the running Codex process, the port listens only on `127.0.0.1`, unauthenticated health/message requests are rejected, and authenticated health returns the current pid/protocol.

- [ ] **Step 5: Run dry-run and verify GREEN**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-desktop-bridge/install-desktop-local-bridge.ps1 -DryRun`

Expected: marker, integrity, pack, and signing checks PASS with no package install.

- [ ] **Step 6: Commit the installer**

```powershell
git add scripts/windows-desktop-bridge/install-desktop-local-bridge.ps1 scripts/windows-desktop-bridge/verify-desktop-local-bridge.ps1
git commit -m "build: add Desktop bridge MSIX installer"
```

### Task 3: Server-Side Desktop Bridge Client

**Files:**
- Create: `src/server/desktopCodexBridgeClient.ts`
- Create: `src/server/desktopCodexBridgeClient.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`

- [ ] **Step 1: Write failing client tests**

Cover descriptor discovery from `CODEX_HOME`, protocol validation, stale pid rejection, bearer header, URL-encoded thread id, text/body limits, timeout/abort, and token redaction from thrown errors. Inject filesystem, fetch, pid lookup, and clock dependencies so tests never contact the installed app.

- [ ] **Step 2: Run client tests and verify RED**

Run: `pnpm exec vitest run src/server/desktopCodexBridgeClient.test.ts`

Expected: FAIL because `createDesktopCodexBridgeClient` does not exist.

- [ ] **Step 3: Implement the client contract**

```ts
export type DesktopBridgeAccepted = {
  threadId: string
  turnId: string | null
}

export function createDesktopCodexBridgeClient(deps = defaultDeps) {
  return {
    async send(input: { threadId: string; text: string; submissionId: string }): Promise<DesktopBridgeAccepted> {},
  }
}
```

Read and validate `desktop-bridge.json` for every send or when its mtime changes. Use `AbortSignal.timeout`, `Authorization: Bearer`, and a JSON response validator. Never include the token in logs or error messages.

- [ ] **Step 4: Replace coordinate dispatch in the RPC route**

In `codexAppServerBridge.ts`, keep the existing text-only validation but replace `sendMessageToCodexDesktop(text)` with the new client `send({ threadId, text, submissionId })`. Do not fall back to `desktopCodexDriver.ts` after an IPC failure.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run src/server/desktopCodexBridgeClient.test.ts src/server/desktopCodexDriver.test.ts src/server/codexAppServerBridge.realtimeBridge.test.ts`

Expected: all focused tests PASS; coordinate driver tests remain unchanged but the RPC path no longer imports it.

- [ ] **Step 6: Commit the client**

```powershell
git add src/server/desktopCodexBridgeClient.ts src/server/desktopCodexBridgeClient.test.ts src/server/codexAppServerBridge.ts
git commit -m "feat: send web prompts through Desktop loopback bridge"
```

### Task 4: Exact Session Persistence Confirmation

**Files:**
- Create: `src/server/threadSessionConfirmation.ts`
- Create: `src/server/threadSessionConfirmation.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`

- [ ] **Step 1: Write failing confirmation tests**

Create temporary JSONL files and cover: baseline content ignored, matching appended `response_item` user message accepted, another thread/text ignored, partial final line retried, timeout, abort, CRLF normalization, and two same-text sends serialized by thread.

- [ ] **Step 2: Run confirmation tests and verify RED**

Run: `pnpm exec vitest run src/server/threadSessionConfirmation.test.ts`

Expected: FAIL because `createThreadSessionConfirmation` does not exist.

- [ ] **Step 3: Implement an offset-based condition waiter**

```ts
export function createThreadSessionConfirmation(deps = defaultDeps) {
  return {
    async capture(threadId: string): Promise<{ path: string; offset: number }> {},
    async waitForUserMessage(
      baseline: { path: string; offset: number },
      expectedText: string,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<void> {},
  }
}
```

Parse only bytes appended after the captured offset, retain a partial-line buffer, accept only `response_item` user messages, normalize newlines/trim exactly as the send path does, poll by condition with bounded backoff, and release the per-thread lock in `finally`.

- [ ] **Step 4: Wire capture -> Desktop send -> confirmation -> response**

Capture the baseline before calling Desktop. Emit `bridge/user-message-submitted` and return HTTP 200 only after `waitForUserMessage` succeeds. Use the Desktop turn id when returned; otherwise use `desktop-ipc:${submissionId}`. Return 504 for persistence timeout and 502 for transport/descriptor failures.

- [ ] **Step 5: Run confirmation and route tests**

Run: `pnpm exec vitest run src/server/threadSessionConfirmation.test.ts src/server/codexAppServerBridge.realtimeBridge.test.ts src/composables/useDesktopState.test.ts`

Expected: all tests PASS, including a route assertion that success is not written before the JSONL append.

- [ ] **Step 6: Commit confirmation**

```powershell
git add src/server/threadSessionConfirmation.ts src/server/threadSessionConfirmation.test.ts src/server/codexAppServerBridge.ts src/server/codexAppServerBridge.realtimeBridge.test.ts
git commit -m "fix: confirm Desktop prompt persistence before RPC success"
```

### Task 5: Install and End-to-End Verify

**Files:**
- Modify: `tests/chat-composer-rendering/realtime-bridge-message-sync.md`

- [ ] **Step 1: Back up Desktop and run the ASAR fixture tests**

Run the `codex-windows-fast-patch` backup helper, then run `node --test scripts/windows-desktop-bridge/patch-desktop-local-bridge-asar.test.cjs`.

Expected: backup path printed; all patcher tests PASS.

- [ ] **Step 2: Build and install the patched MSIX**

Run the installer with `-Install -Launch`, wait for Codex Desktop to relaunch, then run `verify-desktop-local-bridge.ps1`.

Expected: package signature valid, live ASAR marker present, descriptor pid current, loopback-only listener healthy, unauthenticated request rejected.

- [ ] **Step 3: Build Codex Mobile**

Run: `pnpm run build`

Expected: `vue-tsc`, Vite, and `tsup` exit 0.

- [ ] **Step 4: Perform the real web-to-Desktop send**

With the in-app browser still open at `http://127.0.0.1:5900`, send a unique marker to a known thread. Assert HTTP success occurs after the target rollout contains the same marker, the Desktop task shows the message, and the web task refreshes without a duplicate optimistic row.

- [ ] **Step 5: Record manual test and performance evidence**

Update the manual test with the exact marker flow and rollback. Record baseline offset bytes read, confirmation latency, `thread/read` request count, and duplicate request count.

- [ ] **Step 6: Commit verification documentation**

```powershell
git add tests/chat-composer-rendering/realtime-bridge-message-sync.md
git commit -m "test: document Desktop bridge end-to-end flow"
```
