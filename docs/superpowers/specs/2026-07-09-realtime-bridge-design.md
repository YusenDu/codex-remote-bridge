# Realtime Bridge Design

## Goal

Build Codex Mobile as a browser-based mirror of one user's local Codex app-server. Multiple browser sessions connected to the same local bridge must share the same message state:

- A message submitted from one browser appears immediately in the other browser sessions.
- Assistant deltas, command output, approvals, and completion state continue to flow through the existing app-server notification stream.
- The implementation stays compatible with a future hosted relay and per-computer desktop bridge.

## Current Local Architecture

The project already runs a local Node bridge that exposes:

- HTTP RPC: `POST /codex-api/rpc`
- realtime notifications: `GET /codex-api/events` and `WS /codex-api/ws`
- Codex app-server proxying in `src/server/codexAppServerBridge.ts`
- frontend notification handling in `src/composables/useDesktopState.ts`

The missing piece was that app-server notifications stream assistant and turn events, but a user message submitted by another browser was not shown until a later thread refresh. Codex Desktop also writes directly to the same session JSONL file, so the browser needs a local file-change signal for desktop-originated updates.

## Event Layer

Add a transport-neutral bridge notification:

```json
{
  "method": "bridge/user-message-submitted",
  "params": {
    "threadId": "thread-id",
    "turnId": "turn-id-or-null",
    "submissionId": "client-scoped-id",
    "originClientId": "browser-id",
    "text": "user prompt",
    "imageUrls": [],
    "skills": [],
    "fileAttachments": [],
    "createdAtIso": "2026-07-09T00:00:00.000Z"
  }
}
```

The browser sends metadata in a private `__codexWebBridge` field on `turn/start`. The local Node bridge strips that field before forwarding the RPC to Codex app-server, then broadcasts the normalized bridge event after the turn starts successfully.

For Codex Desktop to browser sync, the local Node bridge watches session files for threads that have been read through the web bridge. A changed session file emits:

```json
{
  "method": "bridge/thread-session-updated",
  "params": {
    "threadId": "thread-id",
    "path": "C:\\Users\\name\\.codex\\sessions\\...",
    "mtimeMs": 1783560001000,
    "size": 1234
  }
}
```

The frontend treats that event as an external authoritative change and forces one active-thread `thread/read`, bypassing the recent-load cache.

## Future Hosted Mode

For multi-user hosting, each computer should run a local Desktop Bridge/Agent. The web app talks to a cloud Relay; the desktop agent connects outbound to that Relay and forwards events/RPC for its own device only.

Routing identity should become:

- `userId`: logged-in cloud user.
- `deviceId`: one installed desktop bridge on one computer.
- `connectionId`: one active browser or desktop-agent socket.
- `threadId`: Codex thread.
- `submissionId`: idempotency key for one submitted message.

The cloud Relay should route and persist connection/session metadata, but should not directly access local files or Codex credentials.
