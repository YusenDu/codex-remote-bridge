# Codex Desktop CDP Bridge and Windows Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace simulated Desktop input with direct CDP/AppServerManager calls, synchronize live Desktop state with the web UI, and ship the bridge as a Windows tray agent.

**Architecture:** A reusable TypeScript core discovers the loopback Codex renderer, opens CDP, installs a fail-closed AppServerManager adapter, and exposes turn RPC plus typed events. The local web server can host the core directly; the Electron tray app hosts the same core and forwards commands/events through an authenticated outbound WebSocket.

**Tech Stack:** TypeScript, Node.js, `ws`, Vitest, Vue 3, Electron, electron-builder, Playwright/Browser Use, Windows PowerShell.

---

### Task 1: CDP Discovery and JSON-RPC Transport

**Files:**
- Create: `src/server/codexDesktopCdp/cdpConnection.ts`
- Create: `src/server/codexDesktopCdp/windowsDiscovery.ts`
- Create: `src/server/codexDesktopCdp/types.ts`
- Create: `src/server/codexDesktopCdp/cdpConnection.test.ts`
- Create: `src/server/codexDesktopCdp/windowsDiscovery.test.ts`

- [ ] Write failing tests for request correlation, protocol errors, timeout, close rejection,
  command-line port parsing, loopback enforcement, and exact `app://-/index.html` target selection.
- [ ] Run `pnpm exec vitest run src/server/codexDesktopCdp/cdpConnection.test.ts src/server/codexDesktopCdp/windowsDiscovery.test.ts` and confirm RED.
- [ ] Implement `CodexDesktopCdpConnection` with injected WebSocket factory and clock.
- [ ] Implement Windows process discovery through a hidden PowerShell child process and
  validate every discovered endpoint before connection.
- [ ] Re-run the focused tests and confirm GREEN.

Core contract:

```ts
export interface CdpClient {
  call<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>
  onEvent(listener: (event: CdpEvent) => void): () => void
  close(): Promise<void>
}

export interface CodexRendererTarget {
  port: number
  webSocketDebuggerUrl: string
  processId: number
  appVersion: string | null
}
```

### Task 2: Renderer AppServerManager Adapter

**Files:**
- Create: `src/server/codexDesktopCdp/rendererBootstrap.ts`
- Create: `src/server/codexDesktopCdp/rendererBootstrap.test.ts`
- Create: `src/server/codexDesktopCdp/codexDesktopCdpBridge.ts`
- Create: `src/server/codexDesktopCdp/codexDesktopCdpBridge.test.ts`

- [ ] Write failing handshake tests for missing React root, missing manager, wrong host id,
  missing methods, duplicate bootstrap disposal, and renderer reload.
- [ ] Write failing bridge tests for `turn/start`, `turn/interrupt`, binding events, real turn
  id validation, request timeout, disconnect, and reconnect.
- [ ] Run the four CDP test files and confirm RED.
- [ ] Implement a versioned bootstrap that locates only the verified local manager and stores
  one disposable adapter under `Symbol.for("codex-mobile.cdp-bridge.v1")`.
- [ ] Install a CDP runtime binding and subscribe to app-server notifications, conversation
  state, stream role, and turn completion.
- [ ] Implement `startTurn`, `interruptTurn`, `subscribe`, `getStatus`, and `dispose`.
- [ ] Re-run focused tests and confirm GREEN.

Public bridge contract:

```ts
export interface CodexDesktopCdpBridge {
  startTurn(params: Record<string, unknown>): Promise<{ turn: { id: string; status?: string } }>
  interruptTurn(params: { threadId: string; turnId: string }): Promise<void>
  subscribe(listener: (event: DesktopBridgeEvent) => void): () => void
  getStatus(): DesktopBridgeStatus
  dispose(): Promise<void>
}
```

### Task 3: Replace the Simulated Driver

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/codexAppServerBridge.realtimeBridge.test.ts`
- Delete: `src/server/desktopCodexDriver.ts`
- Delete: `src/server/desktopCodexDriver.test.ts`

- [ ] Add failing route tests proving `CODEXUI_DESKTOP_DRIVER=cdp` sends `turn/start` and
  `turn/interrupt` to the injected CDP bridge and never starts PowerShell UI automation.
- [ ] Add a failing test that legacy values `desktop-ui` and `sendkeys` are rejected with a
  migration error.
- [ ] Run the realtime route tests and confirm RED.
- [ ] Instantiate one shared CDP bridge, forward normalized Desktop events through the
  existing BridgeNotificationBus, and dispose it with server shutdown.
- [ ] Route start/interrupt calls to Desktop and retain session watching for reconciliation.
- [ ] Remove the old driver files and imports.
- [ ] Re-run server and frontend state tests and confirm GREEN.

### Task 4: Bidirectional State and Stop Semantics

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/api/codexGateway.test.ts`
- Modify: `tests/chat-composer-rendering/realtime-bridge-message-sync.md`

- [ ] Add failing tests for Desktop-originated user messages, command/file/tool events,
  running state, real active turn id, interrupted completion, reconnect reconciliation, and
  duplicate suppression.
- [ ] Run focused state tests and confirm RED.
- [ ] Normalize CDP event envelopes into the existing notification model and keep the stop
  button active from `turn/started` until terminal `turn/completed`.
- [ ] Ensure interrupt waits for Desktop acknowledgement and does not clear running state on
  transport failure.
- [ ] Re-run focused tests and confirm GREEN.

### Task 5: Local Live Integration Test

**Files:**
- Create: `scripts/test-codex-desktop-cdp-bridge.cjs`
- Create: `tests/chat-composer-rendering/cdp-desktop-live-sync.md`

- [ ] Add a read-only `health` probe that reports process, target, handshake fingerprint, and
  bridge status without exposing the CDP WebSocket URL.
- [ ] Run all CDP/server/state tests, then `pnpm run build`.
- [ ] Restart the `5900` server with `CODEXUI_DESKTOP_DRIVER=cdp`.
- [ ] Use Browser Use to send a unique web marker, assert it appears in Desktop/session state,
  assert the stop button, interrupt it, and verify interrupted state.
- [ ] Use a Desktop-originated marker and assert it appears in the browser with tool/status
  events without refresh.
- [ ] Record exact commands, marker ids, latency, duplicate count, console status, and cleanup.

### Task 6: Agent Relay Protocol

**Files:**
- Create: `src/desktop-agent/protocol.ts`
- Create: `src/desktop-agent/agentConnection.ts`
- Create: `src/desktop-agent/agentConnection.test.ts`
- Create: `src/server/desktopAgentRelay.ts`
- Create: `src/server/desktopAgentRelay.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`

- [ ] Write failing protocol tests for hello/auth, device ownership, idempotent request ids,
  start/interrupt routing, event sequence, payload caps, heartbeat expiry, and reconnect.
- [ ] Run focused relay tests and confirm RED.
- [ ] Implement the outbound agent connection with bounded backoff and command cancellation.
- [ ] Implement authenticated server routing keyed by user id and device id; keep local mode as
  an in-process adapter using the same command interface.
- [ ] Re-run relay and server tests and confirm GREEN.

### Task 7: Windows Tray Application

**Files:**
- Create: `apps/desktop-agent/package.json`
- Create: `apps/desktop-agent/tsconfig.json`
- Create: `apps/desktop-agent/src/main.ts`
- Create: `apps/desktop-agent/src/configStore.ts`
- Create: `apps/desktop-agent/src/configStore.test.ts`
- Create: `apps/desktop-agent/src/trayMenu.ts`
- Create: `apps/desktop-agent/src/codexLauncher.ts`
- Create: `apps/desktop-agent/src/codexLauncher.test.ts`
- Create: `apps/desktop-agent/assets/tray.ico`
- Modify: `package.json`

- [ ] Add failing tests for encrypted credentials, atomic config writes, login-item settings,
  exact Codex package discovery, CDP-ready detection, and consent-required restart.
- [ ] Add Electron/electron-builder dependencies and isolated agent build scripts.
- [ ] Implement the tray lifecycle, status menu, settings window, reconnect, open-web action,
  start-at-login toggle, and graceful shutdown.
- [ ] Reuse the CDP bridge and relay client without importing the web server.
- [ ] Build with `pnpm run build:agent` and package with `pnpm run package:agent`.
- [ ] Install the generated NSIS artifact, enable login startup, reboot/login smoke-test, and
  verify only the agent and Codex processes are affected.

### Task 8: Final Verification and Documentation

**Files:**
- Create: `documentation/desktop-agent.md`
- Modify: `README.md`
- Modify: `tests.md`

- [ ] Run `pnpm exec vitest run` and `pnpm run build` from a fresh process.
- [ ] Run the packaged agent smoke test, relay reconnect test, and both-direction browser test.
- [ ] Audit source and built output for `SendKeys`, clipboard mutation, `mouse_event`, and
  `SetForegroundWindow`; expected count in runtime code is zero.
- [ ] Measure idle CPU/memory, send-to-event latency, duplicate events, thread/read requests,
  and reconnect recovery.
- [ ] Document installation, pairing, server URL, update compatibility, diagnostics, security,
  and rollback with exact commands and artifact paths.
