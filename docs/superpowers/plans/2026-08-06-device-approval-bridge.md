# Device Approval Bridge Implementation Plan

**Goal:** Mirror device-scoped Codex Desktop approval requests to Web and return Web decisions through the authenticated Tauri Agent and loopback CDP bridge.

**Architecture:** The renderer adapter subscribes to Desktop's native approval listener and exposes pending/respond local RPC operations. Existing Agent RPC transports those operations. Server endpoints select the active device, while the Web client derives `deviceId` from the preserved hash route.

**Tech stack:** Vue 3, TypeScript, Node HTTP bridge, WebSocket Agent protocol, Tauri 2/Rust, CDP, Vitest.

## Task 1: Renderer Approval Contract

**Files:**
- Modify: `src/server/codexDesktopCdp/rendererBootstrap.ts`
- Modify: `src/server/codexDesktopCdp/rendererBootstrap.test.ts`

1. Add failing tests for capture, pending snapshots, approve/reject replies, stale replies, and disposal restoration.
2. Subscribe to the feature-detected Desktop manager approval listener and recover the raw request from the conversation state.
3. Restore approvals that were already pending when the adapter was injected.
4. Add adapter-local pending/respond RPC methods backed by Desktop's native `electronBridge.sendMessageFromView` commands.
5. Emit normalized `server/request` and `server/request/resolved` notifications.
6. Run the focused renderer bootstrap tests.

## Task 2: Tauri Adapter Parity

**Files:**
- Modify: `apps/desktop-agent/src-tauri/src/cdp.rs`

1. Update the generated Rust renderer bootstrap with the same capture and response contract.
2. Require the `server-requests` handshake capability.
3. Add Rust source-contract tests for direct response handling and absence of UI automation.
4. Run focused Rust tests.

## Task 3: Device-Scoped Web API

**Files:**
- Modify: `src/api/codexRpcClient.ts`
- Add/modify focused API tests.

1. Add failing tests proving pending/respond requests include the active route device.
2. Append `deviceId` to the pending query and response payload.
3. Preserve the existing behavior when no device is active.

## Task 4: Server Routing

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Add/modify focused route tests or extract a testable dispatcher.

1. Add failing tests for Agent routing, local fallback, invalid IDs, offline devices, and stale requests.
2. In Agent mode, dispatch pending/respond to `codex-web/local/server-requests/*` on the selected device.
3. In local mode, retain `AppServerProcess` pending/respond behavior.
4. Convert expected validation and transport failures to clear HTTP responses.

## Task 5: UI State Verification

**Files:**
- Modify only if tests reveal a gap: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

1. Test device-originated `server/request` insertion and resolved removal.
2. Test snapshot restoration after reload.
3. Test response failures leave the request visible and show the existing error path.
4. Test route-device changes rebuild the notification subscription and clear stale requests.
5. Test slow pending snapshots cannot overwrite newer approval or resolution events.
6. Test Desktop/Web simultaneous responses preserve first-wins semantics.

## Task 6: End-to-End Verification and Release

**Files:**
- Modify release/version files together for Web and Desktop.

1. Run focused Vitest suites, then all unit tests.
2. Run Rust tests, TypeScript checks, frontend build, and CLI build.
3. Start the local server and Tauri Agent.
4. Trigger and resolve a harmless approval from Web, then repeat from Desktop.
5. Verify device isolation with a wrong/absent device ID.
6. Bump Web and Desktop to `0.1.101`, regenerate artifacts, package the Windows installer, and verify versions/checksums.
7. Commit, push, create the GitHub release, and deploy the Web build only after all checks pass.
