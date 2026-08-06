# Device Approval Bridge Design

## Goal

Mirror Codex Desktop server requests, especially command, file-change, and permission approvals, into the Web client. A response from either Codex Desktop or Web must resolve the same request on both surfaces without UI automation.

## Constraints

- Codex Desktop remains the source of truth for pending requests and resolution.
- Every request and response is scoped by `deviceId` and JSON-RPC request `id`.
- The bridge must fail closed when the Desktop internal API is unavailable, the device is offline, or the request is no longer pending.
- Existing local CLI/app-server approval handling must keep working when no Desktop Agent is selected.
- No mouse, keyboard, clipboard, foreground-window, or accessibility automation is allowed.

## Considered Approaches

### 1. Mirror the Desktop manager approval channel (selected)

The CDP adapter subscribes to the manager's native `addApprovalRequestListener`, records the pending request, and emits a normalized `server/request` event. Web responses use the same `electronBridge.sendMessageFromView` commands as the Codex Desktop approval UI.

This preserves the native Desktop prompt, uses the same request identifier as Codex, and requires no duplicate Codex process.

### 2. Start a second local `codex app-server`

The Agent could own a separate app-server and expose its approvals. This is stable at the protocol level, but it would not be the same Desktop task or execution state and therefore cannot provide true Desktop/Web mirroring.

### 3. Drive the Desktop prompt through UI automation

This can visually click approve or reject, but it can target the wrong window, interferes with other applications, and cannot reliably preserve request identity. It is rejected.

## Architecture

```text
Codex app-server
  -> AppServerManager approval event
  -> CDP adapter pending-request map
  -> Tauri Agent WSS event (deviceId attached by relay)
  -> Web server notification bus
  -> Web approval card

Web approval response
  -> HTTP response endpoint + deviceId
  -> Desktop Agent RPC for that device
  -> CDP adapter validates pending request id
  -> electronBridge.sendMessageFromView
  -> Codex app-server continues or rejects the operation
```

## Desktop Capture and Response

The renderer adapter feature-detects `manager.addApprovalRequestListener` and subscribes without replacing any Desktop function. Approval events provide the conversation ID, request ID, request kind, and reason. The adapter reads the matching raw JSON-RPC request from `manager.getConversation(conversationId).requests` so the Web client receives the original method and parameters.

The adapter stores pending requests in a map keyed by integer request ID. Each stored row contains `id`, `method`, `params`, and `receivedAtIso`. It emits:

- `server/request` when a new request is captured.
- `server/request/resolved` after a Web response is accepted or when Desktop emits `serverRequest/resolved`.

After registering the live listener, the adapter scans the currently loaded recent conversations and restores any approval requests still present in each conversation's pending request list. This covers Agent restarts and reconnects that happen after the Desktop prompt is already visible.

Two adapter-local RPC methods are added:

- `codex-web/local/server-requests/pending`
- `codex-web/local/server-requests/respond`

The response method requires a pending ID and either `result` or `error`. It maps the request to Codex Desktop's native command-execution, file-change, or permission-response IPC message, then calls `electronBridge.sendMessageFromView`. While that call is in flight, the adapter tracks Desktop-side resolution separately. A failed Web response restores the request only when Desktop still reports the same request as pending. Duplicate or stale responses fail explicitly.

Adapter disposal unregisters the native listener. If the required manager methods are unavailable, the adapter reports that approval mirroring is unsupported.

## Server and Device Routing

The existing endpoints remain stable:

- `GET /codex-api/server-requests/pending`
- `POST /codex-api/server-requests/respond`

When desktop bridge mode is `agent`, both endpoints require or resolve a `deviceId` and dispatch the adapter-local RPC to exactly that Agent. Without agent mode, they continue using the server-local `AppServerProcess` implementation.

Web obtains `deviceId` from the preserved `#/device/<deviceId>/...` route and includes it in both requests. The relay already attaches `deviceId` to live events, so approval notifications use the existing device-filtered notification connection. Changing the route device tears down the old notification subscription, clears device-local pending state, and creates a new subscription before refreshing that device.

Pending snapshots are reconciled with notifications received after the snapshot request started. Per-request mutation revisions act as tombstones for resolved requests, so a slow snapshot cannot hide a newer approval or resurrect one that was already resolved.

## Resolution Semantics

- Desktop approves first: Codex emits the resolved notification; Web removes its card.
- Web approves first: the adapter submits the response; both Desktop and Web remove the request.
- Both respond simultaneously: the first response wins; the second receives a stale-request error.
- Agent disconnects: Web retains no authority to approve and shows the transport error.
- Web reloads: it requests the pending snapshot for the active route device.

## Security

- The public server never connects directly to CDP; only the authenticated Agent can access loopback CDP.
- A Web request cannot choose another device implicitly. Ambiguous routing is rejected.
- Request payloads are bounded by the existing Agent protocol limits.
- The implementation never auto-approves. User intent must arrive as an explicit Web or Desktop response.

## Verification

1. Unit test adapter capture, pending snapshot, approve/reject response, duplicate response, and disposal restoration.
2. Unit test adapter startup recovery for an approval that predates injection.
3. Unit test Web requests include the route `deviceId`.
4. Unit/integration test server endpoints route to the selected Agent and preserve local app-server behavior.
5. Run TypeScript tests, Rust tests, frontend build, CLI build, and Tauri package build.
6. Trigger a harmless real Desktop approval, approve it from Web, verify execution continues and the prompt disappears on both surfaces.
7. Repeat with rejection and with Desktop resolving first.
