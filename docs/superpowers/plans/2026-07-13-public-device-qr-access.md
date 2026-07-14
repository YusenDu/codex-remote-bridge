# Public Device QR Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a QR-first Tauri window whose public device URL selects one authenticated Desktop agent and keeps web RPC, notifications, execution state, and stop operations scoped to that computer.

**Architecture:** The Tauri agent builds `webUrl#/device/<deviceId>` and renders its QR locally. The Vue app stores the device selected by that route and sends it on every RPC and notification subscription. The server validates the explicit device identifier and routes only to that authenticated agent connection, without LAN addressing or inbound agent ports.

**Tech Stack:** Rust 2021, Tauri 2, `url`, `qrcode`, static HTML/CSS/JavaScript, Vue 3, Vue Router, TypeScript, Vitest, Node WebSocket relay.

---

### Task 1: Public Device URL and Local QR Renderer

**Files:**
- Create: `apps/desktop-agent/src-tauri/src/mobile_access.rs`
- Modify: `apps/desktop-agent/src-tauri/src/lib.rs`
- Modify: `apps/desktop-agent/src-tauri/Cargo.toml`
- Modify: `apps/desktop-agent/src-tauri/Cargo.lock`

- [ ] **Step 1: Write failing Rust tests for the public access URL**

Add tests that require:

```rust
assert_eq!(
    build_device_access_url("https://codex.example.com/app", "desktop-a:b").unwrap(),
    "https://codex.example.com/app#/device/desktop-a:b"
);
assert!(!build_device_access_url("https://codex.example.com", "desktop-a")
    .unwrap()
    .contains("token"));
```

Also test that prior query/fragment state is removed and that invalid URLs or unsafe device IDs fail.

- [ ] **Step 2: Run the focused Rust test and verify red**

Run:

```powershell
cargo test mobile_access --manifest-path apps/desktop-agent/src-tauri/Cargo.toml
```

Expected: failure because `mobile_access` and `build_device_access_url` do not exist.

- [ ] **Step 3: Implement the URL builder and QR SVG renderer**

Create a focused module exposing:

```rust
pub struct MobileAccess {
    pub access_url: String,
    pub qr_svg: String,
    pub is_public: bool,
}

pub fn build_mobile_access(web_url: &str, device_id: &str) -> anyhow::Result<MobileAccess>;
```

Parse with `url::Url`, clear query state, set the fragment to
`/device/<validated-device-id>`, and render the exact URL through `qrcode` as SVG. Treat
remote HTTPS as public and loopback HTTP as local preview; never substitute a LAN IP.

- [ ] **Step 4: Expose Tauri access commands**

Add `get_mobile_access` and `open_mobile_access` commands in `lib.rs`. The serialized view
contains the URL, SVG, public/local-preview mode, device name, configuration state, and
current relay/Desktop state. It never loads or serializes the stored token.

- [ ] **Step 5: Run focused Rust tests and clippy**

Run:

```powershell
cargo test mobile_access --manifest-path apps/desktop-agent/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop-agent/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: all focused tests pass and clippy reports no warning.

### Task 2: QR-First Tauri Window and Secondary Settings

**Files:**
- Modify: `apps/desktop-agent/web/index.html`
- Create: `apps/desktop-agent/web/styles.css`
- Create: `apps/desktop-agent/web/app.js`
- Modify: `apps/desktop-agent/src-tauri/src/lib.rs`
- Modify: `apps/desktop-agent/src-tauri/tauri.conf.json`

- [ ] **Step 1: Replace the old static-label test with failing layout contract tests**

Require the default document to contain `access-view`, `qr-code`, `access-url`,
`open-settings`, and `settings-view`. Require server URL, device ID, token, and autostart
inputs to live only in the settings section. Require external CSS and JavaScript files.

- [ ] **Step 2: Run the focused layout contract test and verify red**

Run:

```powershell
cargo test settings_page --manifest-path apps/desktop-agent/src-tauri/Cargo.toml
```

Expected: failure because the QR-first structure is absent.

- [ ] **Step 3: Implement approved layout A**

Build the default view with a compact title bar, one readiness state, a stable 230px QR
surface, access URL, copy action, primary open action, internet availability note, and a
secondary settings action. Use neutral near-black surfaces, white QR contrast, green only
for ready state, 6-8px radii, no gradients, and no decorative cards.

- [ ] **Step 4: Move configuration into the secondary view**

Keep the existing save/restart behavior, token replacement semantics, and autostart
control. Add back and close actions. Poll status every two seconds and map it to `ready`,
`connecting`, `desktop-unavailable`, `server-offline`, or `configuration-required`.

- [ ] **Step 5: Add deterministic browser preview behavior**

When `window.__TAURI__` is unavailable, return fixed preview data from the command adapter
instead of throwing. This makes the exact packaged HTML testable in a normal browser
without changing Tauri behavior.

- [ ] **Step 6: Run the Rust UI contract tests**

Run:

```powershell
cargo test settings_page --manifest-path apps/desktop-agent/src-tauri/Cargo.toml
```

Expected: all layout contract tests pass.

### Task 3: Persistent Web Device Context

**Files:**
- Create: `src/api/deviceContext.ts`
- Create: `src/api/deviceContext.test.ts`
- Modify: `src/router/index.ts`
- Modify: `src/api/codexRpcClient.ts`
- Create: `src/api/codexRpcClient.deviceRouting.test.ts`

- [ ] **Step 1: Write failing identifier and persistence tests**

Test the same safe identifier rule as the agent/server:

```ts
expect(normalizeDeviceId('desktop-a:b')).toBe('desktop-a:b')
expect(normalizeDeviceId('../desktop-a')).toBeNull()
expect(normalizeDeviceId('')).toBeNull()
```

Test that setting an active device persists it and that clearing it removes the stored
selection.

- [ ] **Step 2: Run focused Vitest tests and verify red**

Run:

```powershell
pnpm vitest run src/api/deviceContext.test.ts src/api/codexRpcClient.deviceRouting.test.ts
```

Expected: failure because the device-context module does not exist and requests are not
scoped.

- [ ] **Step 3: Implement the device context module and route entry**

Expose `normalizeDeviceId`, `getActiveDeviceId`, `setActiveDeviceId`, and
`clearActiveDeviceId`. Add `/device/:deviceId`; a router guard stores a valid identifier
and redirects to the normal home route. Invalid identifiers redirect without changing the
current selection.

- [ ] **Step 4: Scope browser RPC and notifications**

Extend the RPC body to:

```ts
type RpcRequestBody = {
  method: string
  params?: unknown
  deviceId?: string
}
```

Default `rpcCall` and `subscribeRpcNotifications` to the active device. Preserve explicit
subscription overrides for tests and future device switching.

- [ ] **Step 5: Run the focused device tests**

Run the same focused Vitest command and expect all tests to pass.

### Task 4: Server-Side Deterministic Device Routing

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/codexAppServerBridge.realtimeBridge.test.ts`
- Modify: `src/server/desktopAgentRelay.test.ts`

- [ ] **Step 1: Write failing explicit-device routing tests**

Cover a POST body with top-level `deviceId`, an invalid identifier, an offline identifier,
and two simultaneous agents. Assert that a request for `desktop-a` never reaches
`desktop-b`, and that web-originated optimistic events retain `deviceId: desktop-a`.

- [ ] **Step 2: Run the focused relay tests and verify red**

Run:

```powershell
pnpm vitest run src/server/desktopAgentRelay.test.ts src/server/codexAppServerBridge.realtimeBridge.test.ts
```

Expected: at least the top-level device and scoped optimistic-event assertions fail.

- [ ] **Step 3: Validate and route the explicit identifier**

Add `deviceId?: string` to `RpcProxyRequest`, validate it with the protocol-safe ID rule,
and pass it to `dispatchDesktopAgentRpc`. Keep bridge metadata and the single-device
environment variable as compatibility fallbacks, but never fall back after an explicit
device was supplied.

- [ ] **Step 4: Scope web-originated bridge events**

Pass the resolved device ID when emitting `bridge/user-message-submitted` so WebSocket/SSE
subscribers for another device do not receive the optimistic message.

- [ ] **Step 5: Run relay and full Vitest suites**

Run:

```powershell
pnpm vitest run src/server/desktopAgentRelay.test.ts src/server/codexAppServerBridge.realtimeBridge.test.ts
pnpm vitest run
```

Expected: focused tests and the full suite pass without cross-device leakage.

### Task 5: Documentation, Visual QA, and Windows Package

**Files:**
- Modify: `documentation/DESKTOP_AGENT.md`
- Modify: `README.md`
- Verify: `apps/desktop-agent/src-tauri/target/release/bundle/nsis/Codex Bridge Agent_0.1.87_x64-setup.exe`

- [ ] **Step 1: Document the public device link and security boundary**

Explain that the QR contains the fixed public Web URL plus machine code, the agent uses an
outbound WSS connection, the machine code routes but does not authorize, and the long-lived
token remains in Windows Credential Manager.

- [ ] **Step 2: Run the complete static and Rust verification**

Run:

```powershell
pnpm vitest run
pnpm run build
cargo test --manifest-path apps/desktop-agent/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop-agent/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: all commands exit zero.

- [ ] **Step 3: Verify the packaged HTML in the in-app browser**

Serve `apps/desktop-agent/web`, inspect desktop and 390px mobile widths, confirm the QR is
nonblank, text does not overlap, settings are secondary, copy/open actions are stable, and
the console has no errors.

- [ ] **Step 4: Run the two-device browser/relay scenario**

Open `#/device/desktop-a`, send a unique marker, verify only agent A receives it, observe
running/stop/completion states, then emit a Desktop-originated marker from agent A and
verify it appears without refresh. Repeat the isolation assertion with agent B connected.

- [ ] **Step 5: Package the Tauri installer**

Run:

```powershell
pnpm run package:agent
```

Expected: the NSIS installer is rebuilt at the documented bundle path. Record its size and
SHA-256 hash in the completion report.
