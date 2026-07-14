use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
use url::Url;
use uuid::Uuid;

const ADAPTER_GLOBAL: &str = "__codexMobileCdpBridgeV1";
const ADAPTER_PROTOCOL: u8 = 1;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub state: String,
    pub process_id: Option<u32>,
    pub app_version: Option<String>,
    pub protocol: Option<u8>,
    pub handshake_fingerprint: Option<String>,
    pub connected_at_iso: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexProcess {
    process_id: u32,
    executable_path: String,
    command_line: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevToolsTarget {
    #[serde(rename = "type")]
    target_type: String,
    url: String,
    web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Clone)]
struct RendererTarget {
    process_id: u32,
    app_version: Option<String>,
    web_socket_debugger_url: String,
}

struct Session {
    connection: CdpConnection,
}

struct BridgeInner {
    session: Mutex<Option<Session>>,
    status: RwLock<BridgeStatus>,
    events: broadcast::Sender<Value>,
}

#[derive(Clone)]
pub struct DesktopBridge {
    inner: Arc<BridgeInner>,
}

impl DesktopBridge {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(2048);
        Self {
            inner: Arc::new(BridgeInner {
                session: Mutex::new(None),
                status: RwLock::new(BridgeStatus {
                    state: "disconnected".into(),
                    ..BridgeStatus::default()
                }),
                events,
            }),
        }
    }

    pub async fn status(&self) -> BridgeStatus {
        self.inner.status.read().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.inner.events.subscribe()
    }

    pub fn start_keep_alive(&self) {
        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            let delays = [1_u64, 2, 5, 10, 30];
            let mut attempt = 0_usize;
            loop {
                match bridge.connect().await {
                    Ok(()) => {
                        attempt = 0;
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        if bridge.is_connected().await {
                            continue;
                        }
                    }
                    Err(error) => {
                        bridge.set_error(error.to_string()).await;
                    }
                }
                let delay = delays[attempt.min(delays.len() - 1)];
                attempt = attempt.saturating_add(1);
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
        });
    }

    pub async fn connect(&self) -> Result<()> {
        let mut guard = self.inner.session.lock().await;
        if guard
            .as_ref()
            .is_some_and(|session| session.connection.is_open())
        {
            return Ok(());
        }
        *guard = None;
        {
            let mut status = self.inner.status.write().await;
            status.state = "connecting".into();
            status.error = None;
        }

        let target = discover_renderer().await?;
        let (raw_event_sender, mut raw_event_receiver) = mpsc::unbounded_channel();
        let connection =
            CdpConnection::connect(&target.web_socket_debugger_url, raw_event_sender).await?;
        connection
            .call("Runtime.enable", None, Duration::from_secs(10))
            .await?;
        let binding_name = format!("__codexTauriEvent_{}", Uuid::new_v4().simple());
        connection
            .call(
                "Runtime.addBinding",
                Some(json!({"name": binding_name})),
                Duration::from_secs(10),
            )
            .await?;
        let handshake = evaluate(
            &connection,
            &renderer_bootstrap_source(&binding_name),
            Duration::from_secs(15),
        )
        .await?;
        validate_handshake(&handshake)?;
        let fingerprint = handshake_fingerprint(&handshake);

        let events = self.inner.events.clone();
        let expected_binding = binding_name.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = raw_event_receiver.recv().await {
                if event.get("method").and_then(Value::as_str) != Some("Runtime.bindingCalled") {
                    continue;
                }
                let Some(params) = event.get("params") else {
                    continue;
                };
                if params.get("name").and_then(Value::as_str) != Some(expected_binding.as_str()) {
                    continue;
                }
                let Some(payload) = params.get("payload").and_then(Value::as_str) else {
                    continue;
                };
                if let Ok(value) = serde_json::from_str::<Value>(payload) {
                    let _ = events.send(value);
                }
            }
        });

        *guard = Some(Session { connection });
        let mut status = self.inner.status.write().await;
        *status = BridgeStatus {
            state: "ready".into(),
            process_id: Some(target.process_id),
            app_version: target.app_version,
            protocol: Some(ADAPTER_PROTOCOL),
            handshake_fingerprint: Some(fingerprint),
            connected_at_iso: Some(Utc::now().to_rfc3339()),
            error: None,
        };
        Ok(())
    }

    pub async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        validate_rpc_method(method)?;
        self.connect().await?;
        let guard = self.inner.session.lock().await;
        let session = guard
            .as_ref()
            .filter(|session| session.connection.is_open())
            .ok_or_else(|| anyhow!("Codex Desktop CDP bridge is disconnected"))?;
        let expression = format!(
            "(async()=>{{const a=globalThis[{global_name}];if(!a||a.protocol!=={protocol})throw new Error('Codex Desktop CDP adapter is not installed.');return a.rpc({method},{params});}})()",
            global_name = serde_json::to_string(ADAPTER_GLOBAL)?,
            protocol = ADAPTER_PROTOCOL,
            method = serde_json::to_string(method)?,
            params = serde_json::to_string(&params)?,
        );
        evaluate(&session.connection, &expression, Duration::from_secs(35)).await
    }

    async fn is_connected(&self) -> bool {
        self.inner
            .session
            .lock()
            .await
            .as_ref()
            .is_some_and(|session| session.connection.is_open())
    }

    async fn set_error(&self, error: String) {
        let mut status = self.inner.status.write().await;
        status.state = "error".into();
        status.error = Some(error);
    }
}

#[derive(Clone)]
struct CdpConnection {
    commands: mpsc::Sender<CdpCommand>,
    open: Arc<AtomicBool>,
}

struct CdpCommand {
    method: String,
    params: Option<Value>,
    response: oneshot::Sender<Result<Value, String>>,
}

impl CdpConnection {
    async fn connect(url: &str, events: mpsc::UnboundedSender<Value>) -> Result<Self> {
        let (socket, _) = connect_async_with_config(url, Some(cdp_websocket_config()), false)
            .await
            .context("CDP WebSocket connection failed")?;
        let (mut writer, mut reader) = socket.split();
        let (commands, mut command_receiver) = mpsc::channel::<CdpCommand>(128);
        let open = Arc::new(AtomicBool::new(true));
        let task_open = open.clone();
        tauri::async_runtime::spawn(async move {
            let mut pending: HashMap<u64, oneshot::Sender<Result<Value, String>>> = HashMap::new();
            let next_id = AtomicU64::new(0);
            loop {
                tokio::select! {
                    command = command_receiver.recv() => {
                        let Some(command) = command else { break };
                        let id = next_id.fetch_add(1, Ordering::Relaxed) + 1;
                        let mut payload = json!({"id": id, "method": command.method});
                        if let Some(params) = command.params {
                            payload["params"] = params;
                        }
                        if writer.send(Message::Text(payload.to_string().into())).await.is_err() {
                            let _ = command.response.send(Err("CDP WebSocket send failed".into()));
                            break;
                        }
                        pending.insert(id, command.response);
                    }
                    incoming = reader.next() => {
                        let Some(Ok(message)) = incoming else { break };
                        let text = match message {
                            Message::Text(text) => text.to_string(),
                            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                            Message::Close(_) => break,
                            _ => continue,
                        };
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                        if let Some(id) = value.get("id").and_then(Value::as_u64) {
                            if let Some(response) = pending.remove(&id) {
                                let result = if let Some(error) = value.get("error") {
                                    Err(format!("CDP request failed: {error}"))
                                } else {
                                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = response.send(result);
                            }
                        } else {
                            let _ = events.send(value);
                        }
                    }
                }
            }
            task_open.store(false, Ordering::Release);
            for (_, response) in pending {
                let _ = response.send(Err("CDP connection closed".into()));
            }
        });
        Ok(Self { commands, open })
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }

    async fn call(&self, method: &str, params: Option<Value>, timeout: Duration) -> Result<Value> {
        if !self.is_open() {
            bail!("CDP connection is closed");
        }
        let (response_sender, response_receiver) = oneshot::channel();
        self.commands
            .send(CdpCommand {
                method: method.into(),
                params,
                response: response_sender,
            })
            .await
            .map_err(|_| anyhow!("CDP command queue is closed"))?;
        let response = tokio::time::timeout(timeout, response_receiver)
            .await
            .map_err(|_| anyhow!("CDP {method} timed out"))?
            .map_err(|_| anyhow!("CDP response channel closed"))?;
        response.map_err(anyhow::Error::msg)
    }
}

fn cdp_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(256 << 20))
        .max_frame_size(Some(256 << 20))
}

async fn evaluate(
    connection: &CdpConnection,
    expression: &str,
    timeout: Duration,
) -> Result<Value> {
    let response = connection
        .call(
            "Runtime.evaluate",
            Some(json!({
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true
            })),
            timeout,
        )
        .await?;
    if let Some(exception) = response.get("exceptionDetails") {
        bail!("Codex Desktop renderer evaluation failed: {exception}");
    }
    Ok(response
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

async fn discover_renderer() -> Result<RendererTarget> {
    let processes = tauri::async_runtime::spawn_blocking(read_codex_processes)
        .await
        .map_err(|error| anyhow!("process discovery task failed: {error}"))??;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()?;
    let mut last_error = None;
    for process in processes.into_iter().filter(is_official_codex_process) {
        let Some(port) = parse_remote_debugging_port(&process.command_line) else {
            continue;
        };
        let result = async {
            let targets = client
                .get(format!("http://127.0.0.1:{port}/json/list"))
                .send()
                .await?
                .error_for_status()?
                .json::<Vec<DevToolsTarget>>()
                .await?;
            let endpoint = select_renderer_target(port, &targets)?;
            Ok::<_, anyhow::Error>(RendererTarget {
                process_id: process.process_id,
                app_version: read_app_version(&process.executable_path),
                web_socket_debugger_url: endpoint,
            })
        }
        .await;
        match result {
            Ok(target) => return Ok(target),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("Codex Desktop renderer is unavailable")))
}

fn read_codex_processes() -> Result<Vec<CodexProcess>> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let script = process_discovery_script();
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = command
        .output()
        .context("PowerShell process discovery failed")?;
    if !output.status.success() {
        bail!(
            "PowerShell process discovery failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let raw = String::from_utf8(output.stdout)?.trim().to_owned();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(&raw)?;
    if value.is_array() {
        Ok(serde_json::from_value(value)?)
    } else {
        Ok(vec![serde_json::from_value(value)?])
    }
}

fn process_discovery_script() -> String {
    concat!(
        "$ErrorActionPreference='Stop';",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);",
        "@(Get-CimInstance Win32_Process | ",
        "Where-Object { $_.Name -in @('ChatGPT.exe','Codex.exe') } | ",
        "ForEach-Object { [pscustomobject]@{ ",
        "processId=[int]$_.ProcessId; ",
        "executablePath=[string]$_.ExecutablePath; ",
        "commandLine=[string]$_.CommandLine } }) | ConvertTo-Json -Compress"
    )
    .to_owned()
}

fn is_official_codex_process(process: &CodexProcess) -> bool {
    let path = process
        .executable_path
        .replace('/', "\\")
        .to_ascii_lowercase();
    path.contains("\\windowsapps\\openai.codex_") && path.ends_with("\\app\\chatgpt.exe")
}

fn parse_remote_debugging_port(command_line: &str) -> Option<u16> {
    let parts: Vec<&str> = command_line.split_whitespace().collect();
    for (index, part) in parts.iter().enumerate() {
        if let Some(value) = part.strip_prefix("--remote-debugging-port=") {
            return value.parse::<u16>().ok().filter(|port| *port > 0);
        }
        if *part == "--remote-debugging-port" {
            return parts
                .get(index + 1)
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|port| *port > 0);
        }
    }
    None
}

fn select_renderer_target(port: u16, targets: &[DevToolsTarget]) -> Result<String> {
    let target = targets
        .iter()
        .find(|target| target.target_type == "page" && target.url == "app://-/index.html")
        .ok_or_else(|| anyhow!("Codex Desktop renderer target app://-/index.html was not found"))?;
    let endpoint = target
        .web_socket_debugger_url
        .as_ref()
        .ok_or_else(|| anyhow!("Codex Desktop renderer has no WebSocket endpoint"))?;
    let parsed = Url::parse(endpoint)?;
    if parsed.scheme() != "ws"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port() != Some(port)
    {
        bail!("Codex Desktop CDP WebSocket is not an exact IPv4 loopback endpoint");
    }
    Ok(endpoint.clone())
}

fn read_app_version(path: &str) -> Option<String> {
    let marker = "OpenAI.Codex_";
    let start = path.find(marker)? + marker.len();
    let value = path[start..].split('_').next()?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn validate_handshake(value: &Value) -> Result<()> {
    if value.get("protocol").and_then(Value::as_u64) != Some(ADAPTER_PROTOCOL as u64)
        || value.get("hostId").and_then(Value::as_str) != Some("local")
    {
        bail!("Codex Desktop CDP adapter handshake is incompatible");
    }
    let capabilities = value
        .get("capabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Codex Desktop CDP capabilities are missing"))?;
    for required in ["rpc", "turn/start", "turn/interrupt", "events"] {
        if !capabilities
            .iter()
            .any(|value| value.as_str() == Some(required))
        {
            bail!("Codex Desktop CDP capability {required} is missing");
        }
    }
    Ok(())
}

fn handshake_fingerprint(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.to_string().as_bytes());
    hex::encode(hasher.finalize())[..16].to_owned()
}

fn validate_rpc_method(method: &str) -> Result<()> {
    if method.is_empty()
        || method.len() > 160
        || !method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
    {
        bail!("Codex Desktop RPC method is invalid");
    }
    Ok(())
}

fn renderer_bootstrap_source(binding_name: &str) -> String {
    let methods = serde_json::to_string(&vec![
        "error",
        "thread/name/updated",
        "thread/settings/updated",
        "thread/status/changed",
        "thread/tokenUsage/updated",
        "turn/started",
        "turn/completed",
        "turn/diff/updated",
        "turn/plan/updated",
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/plan/delta",
        "item/reasoning/delta",
        "item/reasoning/summaryTextDelta",
        "item/commandExecution/outputDelta",
        "item/commandExecution/terminalInteraction",
        "item/fileChange/outputDelta",
        "item/fileChange/patchUpdated",
        "serverRequest/resolved",
    ])
    .unwrap();
    format!(
        r#"(async()=>{{
const protocol={protocol},globalName={global_name},bindingName={binding_name},notificationMethods={methods};
const root=globalThis.__codexRoot&&globalThis.__codexRoot._internalRoot?globalThis.__codexRoot._internalRoot.current:null;
if(!root)throw new Error('Codex renderer React root is unavailable.');
const isManager=v=>v&&typeof v==='object'&&['getHostId','getConversation','sendRequest','addNotificationCallback','addTurnCompletedListener','addStreamRoleStateCallback'].every(k=>typeof v[k]==='function');
const stack=[root],seen=new Set();let manager=null;
while(stack.length){{const fiber=stack.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);let hook=fiber.memoizedState;for(let i=0;hook&&i<160;i++,hook=hook.next){{const c=hook.memoizedState;if(!isManager(c))continue;let host=null;try{{host=c.getHostId();}}catch{{}}if(host==='local'){{manager=c;break;}}}}if(manager)break;if(fiber.child)stack.push(fiber.child);if(fiber.sibling)stack.push(fiber.sibling);}}
if(!manager||manager.getHostId()!=='local')throw new Error('Codex local AppServerManager was not found.');
const previous=globalThis[globalName];if(previous&&typeof previous.dispose==='function')previous.dispose();
let sequence=0,disposed=false;const disposers=[];
const emit=(kind,payload)=>{{if(disposed)return;const binding=globalThis[bindingName];if(typeof binding!=='function')return;try{{binding(JSON.stringify({{protocol,kind,sequence:++sequence,payload}}));}}catch{{}}}};
const add=value=>{{if(typeof value==='function')disposers.push(value);}};
add(manager.addNotificationCallback(notificationMethods,event=>emit('notification',event)));
add(manager.addTurnCompletedListener(event=>emit('turnCompleted',event)));
add(manager.addStreamRoleStateCallback((threadId,state)=>emit('streamRole',{{threadId,state}})));
if(typeof manager.addConversationStateCallback==='function')add(manager.addConversationStateCallback((threadId,state)=>emit('conversationState',{{threadId,active:typeof manager.isConversationStreaming==='function'?manager.isConversationStreaming(threadId):null,runtimeStatus:state&&state.threadRuntimeStatus?state.threadRuntimeStatus:null,updatedAt:state&&typeof state.updatedAt==='number'?state.updatedAt:null}})));
  const isMissingRollout=e=>{{let current=e;for(let depth=0;current&&depth<4;depth++){{const text=current instanceof Error?current.message:String(current);if(text.toLowerCase().includes('no rollout found for thread id'))return true;current=current&&typeof current==='object'?current.cause:null;}}return false;}};
  const threadMethodsWithTurns=new Set(['thread/read','thread/resume','thread/fork','thread/rollback']);
  const trimThreadResult=(method,result)=>{{if(!threadMethodsWithTurns.has(method)||!result||typeof result!=='object')return result;const thread=result.thread,turns=thread&&Array.isArray(thread.turns)?thread.turns:null;if(!turns||turns.length<=10)return result;const start=turns.length-10,previousStart=Number.isFinite(result.threadTurnStartIndex)?Math.max(0,Math.floor(result.threadTurnStartIndex)):0;return{{...result,threadTurnStartIndex:previousStart+start,thread:{{...thread,turns:turns.slice(start)}}}};}};
  const adapter={{protocol,async rpc(method,params){{if(typeof method!=='string'||!/^[A-Za-z0-9._\/-]{{1,160}}$/.test(method))throw new Error('Desktop RPC method is invalid.');if(method==='turn/start'){{const threadId=params&&typeof params.threadId==='string'?params.threadId.trim():'';if(!threadId)throw new Error('turn/start requires threadId.');try{{await manager.sendRequest('thread/resume',{{threadId}},{{priority:'critical'}});}}catch(error){{if(!isMissingRollout(error))throw error;}}}}const result=await manager.sendRequest(method,params??null,{{priority:'critical'}});return trimThreadResult(method,result);}},dispose(){{if(disposed)return;disposed=true;for(const fn of disposers.splice(0))try{{fn();}}catch{{}}if(globalThis[globalName]===adapter)delete globalThis[globalName];}}}};
globalThis[globalName]=adapter;return{{protocol,hostId:manager.getHostId(),capabilities:['rpc','turn/start','turn/interrupt','events'],rendererUrl:globalThis.location&&globalThis.location.href?globalThis.location.href:'app://-/index.html'}};
}})()"#,
        protocol = ADAPTER_PROTOCOL,
        global_name = serde_json::to_string(ADAPTER_GLOBAL).unwrap(),
        binding_name = serde_json::to_string(binding_name).unwrap(),
        methods = methods,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_remote_debugging_port_forms() {
        assert_eq!(
            parse_remote_debugging_port("ChatGPT.exe --remote-debugging-port=60068"),
            Some(60068)
        );
        assert_eq!(
            parse_remote_debugging_port("ChatGPT.exe --remote-debugging-port 60100"),
            Some(60100)
        );
        assert_eq!(parse_remote_debugging_port("ChatGPT.exe"), None);
    }

    #[test]
    fn enforces_exact_renderer_and_loopback_endpoint() {
        let target = DevToolsTarget {
            target_type: "page".into(),
            url: "app://-/index.html".into(),
            web_socket_debugger_url: Some("ws://127.0.0.1:60068/devtools/page/main".into()),
        };
        assert!(select_renderer_target(60068, std::slice::from_ref(&target)).is_ok());
        let mut invalid = target;
        invalid.web_socket_debugger_url = Some("ws://192.168.1.2:60068/devtools/page/main".into());
        assert!(select_renderer_target(60068, &[invalid]).is_err());
    }

    #[test]
    fn bootstrap_contains_no_global_input_automation() {
        let source = renderer_bootstrap_source("bridgeBinding");
        for forbidden in [
            "SendKeys",
            "SetForegroundWindow",
            "mouse_event",
            "navigator.clipboard",
            ".click(",
        ] {
            assert!(!source.contains(forbidden));
        }
        assert!(source.contains("manager.sendRequest"));
        assert!(source.contains("no rollout found for thread id"));
    }

    #[test]
    fn bootstrap_trims_thread_snapshots_before_relaying_them() {
        let source = renderer_bootstrap_source("bridgeBinding");
        assert!(source.contains("trimThreadResult"));
        assert!(source.contains("threadTurnStartIndex"));
        assert!(source.contains("turns.slice(start)"));
    }

    #[test]
    fn process_discovery_forces_utf8_stdout() {
        let script = process_discovery_script();
        assert!(
            script.contains("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)")
        );
    }

    #[test]
    fn cdp_socket_supports_large_bounded_thread_histories() {
        let config = cdp_websocket_config();
        assert_eq!(config.max_message_size, Some(256 << 20));
        assert_eq!(config.max_frame_size, Some(256 << 20));
    }
}
