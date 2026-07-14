# Desktop Local Bridge and Tool Recovery Design

## Goal

Remove coordinate-based message delivery between Codex Mobile and Codex Desktop, and restore shell, MCP/plugin, and Browser tool calls in mixed historical turns.

The completed flow must satisfy two user-visible guarantees:

- A text message submitted from the web UI is delivered to the addressed Codex Desktop thread even when the in-app browser is open beside the Codex task.
- A historical turn that contains file changes and tool calls shows every supported call in original order instead of dropping the whole tool stream.

## Scope

This increment covers the local Windows setup only:

- Installed Codex Desktop on the same Windows account.
- The local Codex Mobile bridge at `127.0.0.1:5900`.
- Text-only `turn/start` requests in Desktop-driver mode.
- Historical and live display for shell commands, MCP/plugin calls, and Browser calls.

Images, skills, and file attachments remain rejected by the Desktop bridge path until Desktop exposes an equivalent supported input contract. Hosted relay work remains out of scope.

## Desktop Loopback Bridge

Codex Desktop's Electron main process will own a small HTTP server bound explicitly to `127.0.0.1` on an ephemeral port. It will generate a high-entropy bearer token for each app launch and write a descriptor under the current user's Codex home. The descriptor contains the protocol version, port, token, process id, and start time. It is never sent to a browser.

The bridge exposes one message command:

```text
POST /v1/threads/{threadId}/messages
Authorization: Bearer <launch-token>
Content-Type: application/json

{ "text": "...", "submissionId": "..." }
```

The main process validates loopback origin, method, bearer token, thread id, body size, and non-empty text. It forwards the request through Desktop's existing thread-resume and `turn/start`/follow-up path rather than synthesizing mouse or keyboard input. One request receives one structured response with the accepted Desktop turn id when available.

The descriptor is replaced atomically after the listener is ready and removed only when it still belongs to the exiting process. Stale descriptors are rejected by process/start-time and health checks.

## 5900 Delivery and Persistence Confirmation

The local Node bridge replaces `sendMessageToCodexDesktop` coordinate automation with a server-only Desktop bridge client. It reads the descriptor from the same Codex home, calls the loopback endpoint with the bearer token, and never exposes endpoint credentials to Vue code or HTTP clients.

Before dispatch, the Node bridge resolves the addressed thread's rollout path and captures a byte offset. After Desktop accepts the request, it polls only appended JSONL data until it finds a new persisted user message for the same thread whose normalized text equals the submitted text. The poll is condition-based, bounded by timeout, and serialized per thread so concurrent identical messages cannot confirm each other.

The web RPC returns success only after persistence confirmation. Transport rejection, stale descriptor, wrong thread, and persistence timeout return explicit errors. The existing optimistic bridge notification is emitted only after confirmation, with the real Desktop turn id when available and a stable fallback id otherwise.

## Mixed Turn Tool Recovery

The session recovery pass will treat each supported call as an individually deduplicated slot instead of treating a turn as already recovered when any `commandExecution` or `fileChange` exists.

Canonical app-server items remain authoritative. JSONL fallback contributes only missing items, matched by stable item/call identifiers first and a conservative content signature second. Supported fallback shapes are:

- Legacy `function_call` shell commands (`exec_command` and `shell_command`) plus their outputs.
- Current `custom_tool_call(name: "exec")`, including nested `tools.exec_command` calls, plus output and status.
- Standard `mcpToolCall` items returned by app-server.
- Raw MCP/plugin calls recorded as namespaced function calls.
- Browser calls recorded through the `mcp__node_repl` namespace and `js` tool.
- Completed `apply_patch` calls as file changes.

The merge preserves user messages, assistant messages, calls, and file changes in session order. Existing standard items are not duplicated or replaced.

## UI Model

Add a generic tool-call payload to `UiMessage` with server/namespace, tool name, title, arguments, output, status, error, and duration. Shell commands continue to use `commandExecution`; file edits continue to use `fileChange`.

MCP/plugin and Browser calls render as compact collapsible tool rows using the existing command-row visual language. The collapsed label identifies the server/tool and status. Expanded content shows bounded formatted arguments and result/error text. Large payloads are truncated on the server and UI boundary to avoid rendering multi-megabyte session values.

## Failure Handling and Security

- Bind only to IPv4 loopback and reject non-loopback socket addresses.
- Require a per-launch random bearer token and constant-time comparison.
- Cap request body and recovered argument/output sizes.
- Do not log bearer tokens or descriptor contents.
- Reject unsupported attachment-bearing sends before Desktop dispatch.
- Return failures to the existing composer path so the optimistic row can be removed or marked failed.
- Preserve the previous coordinate driver code only as rollback history, not as an automatic fallback.

## Verification

Automated coverage must include:

- Desktop bridge authentication, validation, thread-addressed dispatch, stale descriptor handling, and shutdown cleanup.
- 5900 client dispatch plus matching-session persistence confirmation, including timeout and same-text concurrency cases.
- A mixed turn containing `fileChange`, legacy shell, current custom exec, MCP/plugin, Browser, and assistant messages.
- Deduplication when canonical app-server items already exist.
- Normalizer and component tests for completed, failed, and in-progress generic tool calls.

End-to-end verification must send a unique marker from the web page while the in-app browser remains open, prove the same marker appears in the addressed Desktop session, and verify the web conversation refreshes. A real historical mixed turn must show nonzero command and tool-call counts with no console errors.

Because this changes thread loading and filesystem polling, the performance audit will measure session-read count, bytes parsed after the confirmation offset, duplicate RPCs, and page load request counts before completion.

## Rollback

Keep the pre-patch Codex Desktop backup created by the Windows patch workflow. Rollback reinstalls that package and restores the prior Codex Mobile commit. The Desktop descriptor can be deleted safely after rollback because it contains only ephemeral listener metadata.
