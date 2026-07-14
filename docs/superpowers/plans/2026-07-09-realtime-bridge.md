# Realtime Bridge Implementation Plan

## Phase 1: Local Browser Sync

1. Add browser identity and `turn/start` metadata.
   - Generate a stable browser `clientId`.
   - Attach `submissionId`, user text, image URLs, skills, and file attachments under `__codexWebBridge`.

2. Add server-side bridge notification support.
   - Create an in-process notification bus.
   - Merge bridge bus events into existing WS/SSE subscriptions.
   - Strip `__codexWebBridge` before forwarding RPC params to Codex app-server.

3. Broadcast submitted user messages.
   - On successful `turn/start`, normalize metadata into `bridge/user-message-submitted`.
   - Include `turnId` when Codex app-server returns it.

4. Render bridge submissions in frontend state.
   - Handle `bridge/user-message-submitted` in `useDesktopState`.
   - Insert it as `userMessage.optimistic`.
   - Dedupe equivalent local optimistic messages.
   - Let the existing `thread/read` merge replace optimistic messages when persisted history arrives.

5. Verify.
   - Unit tests for metadata attachment, server stripping/normalization, and frontend event handling.
   - Build the frontend and CLI.

## Phase 1b: Local Codex Desktop Sync

1. Watch session files for opened threads.
   - Extract `thread.id` and `thread.path` from successful thread snapshot RPC results.
   - Use one watcher per session file, keyed by absolute path.
   - Debounce file changes before notifying browsers.

2. Broadcast desktop-originated session updates.
   - Emit `bridge/thread-session-updated` with `threadId`, session path, mtime, and size.
   - Reuse the existing bridge notification bus so WS/SSE clients receive the event.

3. Force active-thread message refresh in the frontend.
   - Treat `bridge/thread-session-updated` as an authoritative external change.
   - Bypass the recent message-load cache for that active thread.
   - Keep ordinary notification-driven loads cached.

4. Verify.
   - Unit test session watch target extraction.
   - Unit test file watcher notification.
   - Unit test frontend forced reload after the desktop session update event.

## Phase 1c: Minimal Desktop UI Driver

1. Add a Windows-only Desktop Codex driver.
   - Enable it only when `CODEXUI_DESKTOP_DRIVER=desktop-ui` or another explicit enabled value is set.
   - Find the visible Codex Desktop window.
   - Focus the window, click near the bottom composer area, paste prompt text through the clipboard, and press Enter.
   - Read prompt text from a temporary UTF-8 file so user input is not embedded in the PowerShell command line.

2. Route text-only web submissions to Codex Desktop.
   - Intercept `turn/start` in the local bridge when the desktop driver is enabled.
   - Reject image, skill, or file-attachment submissions in the minimal driver path.
   - Broadcast `bridge/user-message-submitted` so other browser sessions show the pending user row.
   - Let the session watcher bring Codex Desktop's persisted response back into the browser.

3. Verify.
   - Unit test the driver enable switch and script generation.
   - Unit test the text-only turn extraction.
   - Typecheck, build frontend, build CLI.

## Phase 1d: Enhanced Desktop UI Driver

1. Add current-thread validation.
   - Read the browser-selected `threadId`.
   - Inspect Codex Desktop visible title or app state before sending.
   - Refuse to send if the Desktop window is not on the expected thread.

2. Add thread navigation.
   - Prefer a supported Codex deep link or internal navigation hook if one is available.
   - Fall back to UI automation only after a visible state check.
   - Confirm the target thread is selected before sending.

3. Add send-result tracking.
   - Wait for the target session file to change after Desktop send.
   - Surface a clear error in the web UI if Desktop did not accept the message.
   - Keep the current browser optimistic row only after Desktop acceptance.

## Phase 2: Server Release Architecture

1. Implement Desktop Bridge/Agent with outbound WebSocket to cloud Relay.
2. Add cloud users/devices/pairing.
3. Route browser RPCs to the selected `deviceId`.
4. Forward bridge notifications back to all browser sessions for that device.
5. Add access control, reconnect, idempotency, and device presence state.
