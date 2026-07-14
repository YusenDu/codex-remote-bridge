# Codex Desktop CDP Bridge and Windows Agent Design

## Goal

Replace all coordinate, clipboard, and SendKeys automation with a direct bridge to the
running Codex Desktop process. The web UI and Codex Desktop must share user messages,
assistant/tool events, active-turn state, completion state, and interruption state.
Package the same bridge core as a Windows tray agent that can start at login and connect
outbound to a configured server.

## Decision

Use Chrome DevTools Protocol (CDP) to enter only the Codex renderer whose URL is exactly
`app://-/index.html`. Inside that renderer, locate the local AppServerManager and call its
existing `sendRequest(method, params)` method. This invokes the Desktop-owned app-server,
so Desktop receives the same notifications and state updates as a native composer send.

Two alternatives were rejected:

- A second `codex app-server` process executes turns but does not update the Desktop UI.
- Patching Codex Desktop with a private loopback HTTP listener is more stable at runtime,
  but requires repacking every Store update. It remains a fallback if CDP compatibility
  becomes impractical.

## Verified Runtime Contract

The installed Windows build starts its Electron main process with a loopback CDP port.
Its renderer target is `app://-/index.html`. The active local manager has `hostId` equal
to `local` and exposes:

```ts
manager.sendRequest(method, params, options?)
manager.addNotificationCallback(methods, callback)
manager.addConversationStateCallback(callback)
manager.addStreamRoleStateCallback(callback)
manager.addTurnCompletedListener(callback)
```

`sendRequest("turn/start", params, { priority: "critical" })` returns the real Desktop
turn. `sendRequest("turn/interrupt", { threadId, turnId }, { priority: "critical" })`
interrupts that turn. These names and method shapes are internal and version-bound, so
the bridge must fail closed when the handshake contract is not present.

## Components

### CDP Transport

`CodexDesktopCdpConnection` owns one WebSocket connection, JSON-RPC request correlation,
timeouts, CDP event delivery, and deterministic shutdown. It never connects to a remote
host.

`WindowsCodexDesktopDiscovery` reads Codex/ChatGPT process command lines, extracts the
debugging port, fetches `/json/list`, and accepts only the exact Codex renderer target.
An environment override exists for tests and managed deployments, but target validation
is never bypassed.

### Renderer Adapter

The adapter installs a versioned bootstrap through `Runtime.evaluate`. It traverses the
React fiber tree only to locate an object with the verified AppServerManager contract and
`hostId === "local"`; it does not click or dispatch DOM input events.

`Runtime.addBinding` creates a one-way event binding. The adapter subscribes to relevant
app-server notifications plus conversation, stream-role, and turn-completed callbacks.
The Node bridge converts binding calls into typed events. Reloading the renderer causes a
fresh handshake and subscription.

### Server Integration

Desktop mode is enabled explicitly with `CODEXUI_DESKTOP_DRIVER=cdp`. In this mode:

- `turn/start` is forwarded to the Desktop manager with the private web metadata removed.
- `turn/interrupt` is forwarded to the same Desktop manager.
- The real Desktop turn id is returned to the browser.
- Desktop notifications are emitted through the existing BridgeNotificationBus.
- Session-file watching remains reconciliation only; it is not the send transport.

The old PowerShell UI driver is removed from the server path and no automatic fallback is
allowed. A CDP failure is visible to the composer as an actionable error.

### Bidirectional State

Web-originated sends produce the normal optimistic bridge message, then Desktop
`turn/started`, item delta, command output, file-change, approval, and `turn/completed`
events. Desktop-originated sends produce the same event stream. Session changes trigger a
bounded authoritative `thread/read` to repair any event missed during reconnect.

Every connection and event carries a monotonically increasing local sequence. The web
state deduplicates by `(threadId, turnId, itemId)` and by submission id for optimistic user
messages.

## Windows Tray Agent

The tray agent is an Electron main-process application so it can reuse the TypeScript CDP
bridge and `ws` protocol implementation. It has no always-open window. Its menu shows
Codex connection, server connection, selected device id, open web, settings, reconnect,
start-at-login, and quit.

Configuration contains the server URL, device id, and user preferences. Device credentials
are encrypted with Electron `safeStorage`; plaintext tokens are never logged. The agent
connects outbound over `wss`, sends heartbeats, reconnects with bounded exponential
backoff, and never exposes the Codex CDP endpoint to the network.

If Codex is running without CDP, the agent reports `restart-required`. With explicit user
consent it relaunches the installed Codex package with a random loopback debugging port.
It never terminates or restarts unrelated processes.

## Relay Protocol

The first protocol version uses JSON envelopes:

```ts
type AgentEnvelope =
  | { type: "hello"; protocol: 1; deviceId: string; credential: string; capabilities: string[] }
  | { type: "command"; requestId: string; method: "turn/start" | "turn/interrupt"; params: unknown }
  | { type: "response"; requestId: string; result?: unknown; error?: BridgeError }
  | { type: "event"; sequence: number; method: string; params: unknown }
  | { type: "heartbeat"; sentAt: string }
```

The server routes only between an authenticated user, one registered `deviceId`, and that
device's active agent connection. Request ids are idempotency keys for reconnect replay.
Local mode uses the same command adapter without a network hop.

## Security and Failure Handling

- Bind and discover CDP on `127.0.0.1` only; reject wildcard or remote endpoints.
- Validate renderer URL, manager host id, required methods, protocol version, and response
  shape before marking the bridge ready.
- Cap prompt, event, and relay message sizes.
- Redact credentials, CDP URLs, and sensitive payloads from logs.
- Use request timeouts, cancellation, heartbeat expiry, and reconnect backoff.
- Fail closed on a Codex update that changes the internal manager contract.
- Never use global cursor, mouse, keyboard, clipboard, or foreground-window APIs.

## Verification

Automated tests cover discovery, target rejection, CDP correlation and timeout, adapter
handshake, `turn/start`, `turn/interrupt`, event normalization, reconnect, route selection,
relay authentication/routing, encrypted config, and tray startup settings.

Live verification uses two unique markers:

1. Web to Desktop: send from `127.0.0.1:5900`, assert the same real turn id and marker in
   Desktop, observe running/stop state, interrupt, and observe interrupted state on both.
2. Desktop to web: submit in Desktop, assert the user message, tool/assistant events, and
   completion appear in the browser without refresh.

The final audit records duplicate notification count, reconnect recovery, event latency,
CPU while idle, memory for the tray process, and the packaged installer path.

## Compatibility and Rollback

Adapters are selected by a tested runtime fingerprint derived from renderer asset names
and handshake capabilities. Unsupported builds remain disconnected instead of guessing.
Rollback disables `CODEXUI_DESKTOP_DRIVER=cdp`, stops the tray agent, and restores normal
Codex and web app-server operation; no session files are rewritten.
