### Realtime bridge message sync

#### Feature/Change Name
Messages submitted from one browser session or the local Codex Desktop session are mirrored into other browser sessions connected to the same local Codex bridge.

#### Prerequisites/Setup
1. Build the app with `pnpm run build`.
2. Start the local CLI server with `node dist-cli/index.js <project-path> --port 5900 --no-open --no-tunnel --no-login --no-password`.
3. Open the same thread URL in two browser sessions or tabs.
4. For the minimal Codex Desktop send path, start the server with `CODEXUI_DESKTOP_DRIVER=desktop-ui`, open Codex Desktop, and keep the target thread selected.

#### Steps
1. In browser session A, submit a short prompt in the selected thread.
2. Watch browser session B without manually refreshing the page.
3. Wait for the assistant response to stream and complete.
4. Refresh browser session B after completion.
5. In Codex Desktop, send a new message to the same thread while browser session B stays open.
6. Watch browser session B without manually refreshing the page.
7. With `CODEXUI_DESKTOP_DRIVER=desktop-ui` enabled and Codex Desktop focused on the same thread, submit a text-only message from browser session A.
8. Watch Codex Desktop and browser session B.

#### Expected Results
- Session B shows the submitted user message immediately as a pending user row.
- Session B continues to receive assistant, command, and completion updates through the existing realtime stream.
- When persisted thread history is reloaded, the pending user row is replaced by the real history row without a duplicate.
- Refreshing session B keeps the same final conversation state.
- A message written by Codex Desktop updates the watched session file and causes browser session B to reload that active thread automatically.
- The desktop-originated user message and following assistant state appear in browser session B without a manual refresh.
- In desktop driver mode, the browser-submitted text is pasted into Codex Desktop and sent from the desktop app, so Codex Desktop shows the user message and subsequent visible output.
- The browser then receives the desktop-written session update through the existing watcher.

#### Rollback/Cleanup
- Stop the local CLI server.

---
