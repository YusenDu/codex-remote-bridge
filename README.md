# Codex Remote Bridge

[中文文档](README.zh-CN.md)

Codex Remote Bridge is a browser-based control surface for Codex Desktop. It keeps the
web UI, a Windows desktop agent, and the local Codex Desktop application synchronized so
that a phone or another browser can view and control the same Codex work.

## Upstream Attribution

This is a secondary development based on
[friuns2/codex-mobile](https://github.com/friuns2/codex-mobile). The upstream project is
retained as the foundation for the Vue web UI and Codex app-server workflows. Its own
upstream attribution to [pavel-voronin/codex-web-local](https://github.com/pavel-voronin/codex-web-local)
is preserved. See [LICENSE](LICENSE) for licensing terms.

## Architecture

```mermaid
flowchart LR
  Web[Web UI in browser] <-->|HTTPS, WSS| Relay[Node Relay Server]
  Relay <-->|Authenticated outbound WSS| Agent[Tauri Windows Agent]
  Agent <-->|Loopback CDP RPC| Desktop[Codex Desktop]
```

The agent makes an outbound connection to the relay. A phone never connects directly to a
user's computer and no router port forwarding is required.

## Upstream Capabilities Retained

- Vue-based Codex app-server web UI with project and thread browsing.
- Conversation rendering for user messages, assistant responses, reasoning summaries,
  command output, file changes, plans, approvals, and turn state.
- Thread creation, search, rename, archive, fork, rollback, queue, interrupt, and terminal
  workflows.
- Model, reasoning effort, collaboration mode, provider, skills, MCP, and automation views.
- Responsive desktop and mobile layout, file and image context, voice dictation, and local
  file browsing.
- Project ZIP export/import with Codex session history migration.
- Optional Telegram bridge and support for reverse proxies, tunnels, and Tailscale-style
  private access.

## New Capabilities In This Project

- A Windows Tauri tray application named **Codex Bridge Agent**.
- Direct CDP integration with Codex Desktop's internal AppServerManager. The production
  path does not simulate global mouse or keyboard input.
- Authenticated device relay protocol with request/response forwarding, event streaming,
  heartbeat, reconnect, bounded message sizes, and idempotent request handling.
- Per-computer `deviceId` routing and protected pairing tokens. Browser RPC, WebSocket, and
  SSE subscriptions are scoped to the selected computer.
- Public QR access links in the form `https://your-domain/#/device/<deviceId>`. The QR code
  contains no pairing token or LAN address.
- Bidirectional synchronization between Codex Desktop and the web UI for user messages,
  assistant output, reasoning activity, command execution, file changes, active turns, and
  stop operations.
- Immediate optimistic rendering of browser-originated messages, synchronized execution
  status, and a real `turn/interrupt` stop action.
- Agent configuration, connection diagnostics, automatic reconnect, start-at-login, and
  token storage in Windows Credential Manager.

## Requirements

- Node.js 18+ and pnpm for the web and relay service.
- Windows, Rust stable, MSVC build tools, and WebView2 Runtime to build the Tauri agent.
- The official Codex Desktop application running and authenticated on each controlled PC.
- HTTPS/WSS for any public relay deployment.

## Local Development

```bash
pnpm install
pnpm run build
node dist-cli/index.js --port 5900 --no-open --no-tunnel --no-login --no-password
```

`--no-password` disables the web login prompt. On a public deployment, the web UI and
relay APIs are then reachable without a shared password, so access must be restricted by
an upstream identity-aware proxy, VPN, or equivalent network policy. Agent pairing tokens
remain required and must not be removed.

Build the Windows agent:

```bash
pnpm run build:agent
pnpm run package:agent
```

The installer is produced under:

```text
apps/desktop-agent/src-tauri/target/release/bundle/nsis/
```

For agent configuration, protocol details, pairing, security boundaries, and validation,
read [documentation/DESKTOP_AGENT.md](documentation/DESKTOP_AGENT.md).

## Security and Deployment Status

`deviceId` is a routing identifier, not an authorization secret. Pairing tokens stay on the
PC in Windows Credential Manager and should only be stored as hashes on the server.

The current implementation supports isolated devices and token-authenticated agents. Before
opening a public service to multiple users, add normal user authentication and a persistent
`userId -> deviceId` ownership rule to every RPC and event subscription. Do not expose the
relay through plain HTTP or disable authentication on a public host.

## Verification

```bash
pnpm vitest run
pnpm run build
cargo test --manifest-path apps/desktop-agent/src-tauri/Cargo.toml
```
