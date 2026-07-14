# Public Device QR Access for Codex Bridge Agent

## Goal

Provide a QR-first home window in the Windows Tauri agent. Scanning the QR opens the
fixed, publicly hosted Codex web application and selects the computer represented by the
agent's stable machine code. The phone can use Wi-Fi or mobile data; it never connects
directly to the computer.

The agent remains an outbound bridge between the public server and the local Codex
Desktop process. It does not host the web UI, expose a local HTTP port, or require router
port forwarding.

## Confirmed Architecture

The public web origin is configured once, for example `https://codex.example.com`. Each
agent has a stable `deviceId` and an authentication token stored in Windows Credential
Manager. The agent opens an authenticated outbound WebSocket connection to
`/codex-api/agent/ws` and registers that `deviceId`.

The QR payload is a public device-selection URL:

```text
https://codex.example.com/#/device/<encoded-device-id>
```

The fixed web application reads the machine code, establishes an authenticated browser
session, and includes the selected `deviceId` in RPC and notification subscriptions. The
server resolves that identifier to the matching live agent connection. Commands and
events therefore follow this route:

```text
Phone Web UI
  <-> HTTPS/WSS <-> Public Codex Web Server
  <-> authenticated device relay <-> Tauri Bridge Agent
  <-> loopback CDP <-> Codex Desktop
```

No LAN address is placed in the QR code. No agent credential is placed in the QR code.

## Security Model

The machine code is a routing identifier, not an authorization secret. Knowing a
`deviceId` must not grant access to that computer.

For the current deployment, the existing authenticated web session is the browser-side
authorization boundary, and the existing per-device agent token authenticates the agent.
The relay accepts browser operations only for a device available to that authenticated
session.

For a later multi-user deployment, the same URL and relay protocol remain valid while the
server authentication layer adds an ownership mapping of `userId -> deviceId`. Initial
ownership can be established with a short-lived, single-use pairing code. Long-lived
agent tokens remain only in Windows Credential Manager and are never returned to the web
application, included in URLs, rendered in the QR code, or written to logs.

## Agent Responsibilities

The Tauri agent has six responsibilities:

1. Persist the stable device identity and protected agent credential.
2. Maintain the outbound authenticated relay connection with heartbeat and reconnect.
3. Discover the local Codex Desktop renderer and establish the loopback CDP bridge.
4. Forward web-originated RPC and interruption requests to the selected Desktop session.
5. Stream Desktop-originated messages, execution events, status, and completion events to
   the relay.
6. Provide tray controls, start-at-login, connection diagnostics, and the QR access window.

The agent must never simulate global mouse or keyboard input, bind CDP to a non-loopback
interface, or accept inbound phone connections.

## QR-First Window

The approved visual direction is layout A, "Focused Scan". The default window contains:

- A compact title bar with `Codex Bridge` and a secondary `设置` action.
- One combined readiness state derived from relay and Codex Desktop status.
- A large QR code for the public device-selection URL.
- The same URL as selectable text with a copy action.
- A primary action to open the public web application on the computer.
- A quiet note that the page is available through the internet.

The default view does not show the server URL, raw `deviceId`, agent token, autostart
control, protocol details, CDP port, or diagnostic payloads.

The existing configuration form becomes a secondary settings view containing server URL,
web URL, device ID, device name, token replacement, autostart, connection details, save,
and back/close actions. The token field remains empty after loading and saving.

## Access Link Generation

The agent derives the access URL only from the configured public `webUrl` and its stored
`deviceId`:

1. Parse and validate `webUrl` with the existing URL parser.
2. Preserve the public origin and any deployment base path.
3. Replace the fragment with `/device/<percent-encoded-device-id>`.
4. Remove URL credentials and reject non-HTTPS remote origins under existing validation.
5. Generate the QR SVG locally so no URL is sent to a third-party QR service.

The result returned to the webview contains the access URL and QR SVG, but never contains
the agent token.

## Web Device Context

The Vue router gains `/device/:deviceId` as a device-selection entry route. Entering the
route validates the identifier, stores it as the active device context, and continues to
the normal home view. The selected device remains active while navigating between home,
thread, skills, and automation routes.

All `/codex-api/rpc` requests include the selected device identifier in a dedicated
request field. WebSocket and SSE notification subscriptions use the existing `deviceId`
query parameter. The server validates both forms with the same safe identifier rules and
routes requests and notifications only to that device.

The server must not infer a device when multiple agents are online. A missing, unauthorized,
or offline selection produces an explicit error instead of falling back to another agent.

## States and Errors

The QR home uses these states:

- `ready`: relay authenticated and Codex Desktop bridge ready; QR and actions enabled.
- `connecting`: either connection is starting; QR remains visible and status explains the
  pending connection.
- `desktop-unavailable`: relay is online but Codex Desktop is unavailable; the public link
  remains copyable while remote execution is disabled.
- `server-offline`: agent cannot reach the public relay; the QR remains visible for later
  use and the status offers reconnect.
- `configuration-required`: public URLs or agent token are missing; open settings instead
  of showing a misleading usable state.

Errors use concise user-facing messages. Raw tokens, internal CDP endpoints, stack traces,
and server response bodies are restricted to redacted diagnostic logs.

## Verification

Automated tests cover:

- Public access URL construction, base-path preservation, and device ID encoding.
- Rejection of credentials and insecure remote URLs through existing validation.
- QR payload equality with the access URL and absence of agent credentials.
- The QR-first HTML structure and the secondary settings structure.
- Router device selection and persistence across normal navigation.
- RPC and notification scoping to the selected device.
- Two connected agents receiving only their own browser commands and events.
- Offline and unauthorized device errors without fallback to another agent.

Live verification covers:

1. Start the Tauri agent and confirm the approved layout A window.
2. Scan the public-style URL and verify the web application selects the expected device.
3. Send and stop a turn from the web UI and observe the same state in Codex Desktop.
4. Send from Codex Desktop and observe messages, execution events, and completion in the
   selected web session.
5. Connect a second synthetic device and verify there is no cross-device event leakage.

## Scope Boundary

This change implements public device links, deterministic device routing, the QR-first
agent window, and tests against the current authenticated server. It does not add a full
multi-tenant account database, billing, push notifications, or internet tunnel. The
future ownership table and one-time pairing flow attach to the defined authorization
boundary without changing the QR URL shape or the agent's outbound-only role.
