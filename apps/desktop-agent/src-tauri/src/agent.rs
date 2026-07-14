use crate::{
    cdp::DesktopBridge,
    config::RuntimeConfig,
    protocol::{
        decode_message, encode_message, encode_response_frames, AgentMessage, AgentRequestMethod,
        AgentResponseError, AGENT_PROTOCOL_VERSION,
    },
};
use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::async_runtime::JoinHandle;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderValue},
        Message,
    },
};
use url::Url;

const COMPLETED_RESPONSE_CACHE_MAX_ENTRIES: usize = 512;
const COMPLETED_RESPONSE_CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;
const COMPLETED_RESPONSE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

struct CachedResponse {
    frames: Vec<String>,
    bytes: usize,
    expires_at: Instant,
}

struct CompletedResponseCache {
    entries: HashMap<String, CachedResponse>,
    order: VecDeque<String>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
    ttl: Duration,
}

impl CompletedResponseCache {
    fn new(max_entries: usize, max_bytes: usize, ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_entries,
            max_bytes,
            ttl,
        }
    }

    fn production() -> Self {
        Self::new(
            COMPLETED_RESPONSE_CACHE_MAX_ENTRIES,
            COMPLETED_RESPONSE_CACHE_MAX_BYTES,
            COMPLETED_RESPONSE_CACHE_TTL,
        )
    }

    fn get(&mut self, id: &str, now: Instant) -> Option<&[String]> {
        self.remove_expired(now);
        self.entries.get(id).map(|entry| entry.frames.as_slice())
    }

    fn insert(&mut self, id: String, frames: Vec<String>, now: Instant) {
        self.remove_expired(now);
        self.remove(&id);
        let bytes = frames.iter().map(String::len).sum::<usize>();
        if self.max_entries == 0 || bytes > self.max_bytes {
            return;
        }
        while self.entries.len() >= self.max_entries
            || self.bytes.saturating_add(bytes) > self.max_bytes
        {
            if !self.remove_oldest() {
                return;
            }
        }
        self.bytes += bytes;
        self.order.push_back(id.clone());
        self.entries.insert(
            id,
            CachedResponse {
                frames,
                bytes,
                expires_at: now + self.ttl,
            },
        );
    }

    fn remove_expired(&mut self, now: Instant) {
        loop {
            let Some(id) = self.order.front() else { return };
            let expired = self
                .entries
                .get(id)
                .map(|entry| entry.expires_at <= now)
                .unwrap_or(true);
            if !expired {
                return;
            }
            self.remove_oldest();
        }
    }

    fn remove_oldest(&mut self) -> bool {
        let Some(id) = self.order.pop_front() else {
            return false;
        };
        if let Some(entry) = self.entries.remove(&id) {
            self.bytes = self.bytes.saturating_sub(entry.bytes);
        }
        true
    }

    fn remove(&mut self, id: &str) {
        if let Some(entry) = self.entries.remove(id) {
            self.bytes = self.bytes.saturating_sub(entry.bytes);
            self.order.retain(|existing| existing != id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub state: String,
    pub server_url: String,
    pub device_id: String,
    pub attempt: u32,
    pub connected_at_iso: Option<String>,
    pub error: Option<String>,
}

impl Default for AgentStatus {
    fn default() -> Self {
        Self {
            state: "stopped".into(),
            server_url: String::new(),
            device_id: String::new(),
            attempt: 0,
            connected_at_iso: None,
            error: None,
        }
    }
}

#[derive(Clone)]
pub struct AgentController {
    bridge: DesktopBridge,
    status: Arc<RwLock<AgentStatus>>,
    task: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl AgentController {
    pub fn new(bridge: DesktopBridge) -> Self {
        Self {
            bridge,
            status: Arc::new(RwLock::new(AgentStatus::default())),
            task: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn status(&self) -> AgentStatus {
        self.status.read().await.clone()
    }

    pub async fn start(&self, config: RuntimeConfig, agent_version: String) {
        self.stop().await;
        let status = self.status.clone();
        let bridge = self.bridge.clone();
        let handle = tauri::async_runtime::spawn(async move {
            run_reconnecting(config, agent_version, bridge, status).await;
        });
        *self.task.lock().await = Some(handle);
    }

    pub async fn stop(&self) {
        if let Some(handle) = self.task.lock().await.take() {
            handle.abort();
        }
        let mut status = self.status.write().await;
        status.state = "stopped".into();
        status.attempt = 0;
        status.connected_at_iso = None;
        status.error = None;
    }
}

async fn run_reconnecting(
    config: RuntimeConfig,
    agent_version: String,
    bridge: DesktopBridge,
    status: Arc<RwLock<AgentStatus>>,
) {
    let delays = [1_u64, 2, 5, 10, 30];
    let mut attempt = 0_usize;
    loop {
        {
            let mut current = status.write().await;
            current.state = "connecting".into();
            current.server_url = redact_url(&config.config.server_url);
            current.device_id = config.config.device_id.clone();
            current.attempt = (attempt + 1) as u32;
            current.connected_at_iso = None;
            current.error = None;
        }
        match run_session(&config, &agent_version, &bridge, status.clone()).await {
            Ok(()) => {
                attempt = 0;
            }
            Err(error) => {
                tracing::warn!(error = %error, "Agent session ended");
                let mut current = status.write().await;
                current.state = "error".into();
                current.connected_at_iso = None;
                current.error = Some(error.to_string());
            }
        }
        let delay = delays[attempt.min(delays.len() - 1)];
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}

async fn run_session(
    config: &RuntimeConfig,
    agent_version: &str,
    bridge: &DesktopBridge,
    status: Arc<RwLock<AgentStatus>>,
) -> Result<()> {
    let ws_url = agent_websocket_url(&config.config.server_url)?;
    let mut request = ws_url.as_str().into_client_request()?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", config.token))
            .context("pairing token contains invalid header characters")?,
    );
    let (socket, _) = connect_async(request)
        .await
        .context("agent WebSocket connection failed")?;
    let (mut writer, mut reader) = socket.split();
    send(
        &mut writer,
        &AgentMessage::Hello {
            version: AGENT_PROTOCOL_VERSION,
            device_id: config.config.device_id.clone(),
            device_name: config.config.device_name.clone(),
            agent_version: agent_version.into(),
            capabilities: vec!["rpc".into(), "events".into(), "bridge/status".into()],
        },
    )
    .await?;

    let acknowledgement = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let incoming = reader
                .next()
                .await
                .ok_or_else(|| anyhow!("agent server closed before authentication"))??;
            if let Some(message) = decode_ws_message(incoming)? {
                return Ok::<AgentMessage, anyhow::Error>(message);
            }
        }
    })
    .await
    .context("agent authentication timed out")??;
    match acknowledgement {
        AgentMessage::HelloAck { accepted: true, .. } => {}
        AgentMessage::HelloAck { error, .. } => {
            bail!(
                "agent authentication rejected: {}",
                error.unwrap_or_default()
            )
        }
        _ => bail!("agent server did not return hello/ack"),
    }
    {
        let mut current = status.write().await;
        current.state = "connected".into();
        current.attempt = 0;
        current.connected_at_iso = Some(Utc::now().to_rfc3339());
        current.error = None;
    }

    let mut bridge_events = bridge.subscribe();
    let (response_sender, mut response_receiver) = mpsc::channel::<(String, AgentMessage)>(128);
    let mut completed = CompletedResponseCache::production();
    let mut in_flight: HashMap<String, usize> = HashMap::new();
    let mut event_sequence = 0_u64;

    loop {
        tokio::select! {
            incoming = reader.next() => {
                let Some(incoming) = incoming else { bail!("agent WebSocket closed") };
                let Some(message) = decode_ws_message(incoming?)? else { continue };
                match message {
                    AgentMessage::Ping { nonce, .. } => {
                        send(&mut writer, &AgentMessage::Pong { version: 1, nonce }).await?;
                    }
                    AgentMessage::Request { id, method, params, .. } => {
                        if let Some(frames) = completed.get(&id, Instant::now()).map(<[String]>::to_vec) {
                            for frame in &frames {
                                writer.send(Message::Text(frame.clone().into())).await?;
                            }
                            continue;
                        }
                        if let Some(waiters) = in_flight.get_mut(&id) {
                            *waiters += 1;
                            continue;
                        }
                        in_flight.insert(id.clone(), 1);
                        let sender = response_sender.clone();
                        let bridge = bridge.clone();
                        tauri::async_runtime::spawn(async move {
                            let response = execute_request(&bridge, &id, method, params).await;
                            let _ = sender.send((id, response)).await;
                        });
                    }
                    _ => {}
                }
            }
            Some((id, response)) = response_receiver.recv() => {
                let frames = encode_response_frames(&response)?;
                let response_count = in_flight.remove(&id).unwrap_or(1);
                for _ in 0..response_count {
                    for frame in &frames {
                        writer.send(Message::Text(frame.clone().into())).await?;
                    }
                }
                completed.insert(id, frames, Instant::now());
            }
            event = bridge_events.recv() => {
                match event {
                    Ok(event) => {
                        event_sequence += 1;
                        send(&mut writer, &AgentMessage::Event {
                            version: 1,
                            sequence: event_sequence,
                            event,
                        }).await?;
                    }
                    Err(broadcast_error) => {
                        tracing::warn!("Desktop event stream lagged: {broadcast_error}");
                    }
                }
            }
        }
    }
}

async fn execute_request(
    bridge: &DesktopBridge,
    id: &str,
    method: AgentRequestMethod,
    params: Value,
) -> AgentMessage {
    let result = match method {
        AgentRequestMethod::BridgeStatus => {
            serde_json::to_value(bridge.status().await).map_err(anyhow::Error::from)
        }
        AgentRequestMethod::Rpc => {
            let rpc_method = params
                .get("method")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("RPC request is missing method"));
            match rpc_method {
                Ok(rpc_method) => {
                    bridge
                        .rpc(
                            rpc_method,
                            params.get("params").cloned().unwrap_or(Value::Null),
                        )
                        .await
                }
                Err(error) => Err(error),
            }
        }
    };
    match result {
        Ok(result) => AgentMessage::Response {
            version: 1,
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => AgentMessage::Response {
            version: 1,
            id: id.into(),
            ok: false,
            result: None,
            error: Some(AgentResponseError {
                code: "RPC_FAILED".into(),
                message: bounded_agent_error(&error.to_string()),
            }),
        },
    }
}

fn bounded_agent_error(value: &str) -> String {
    const MAX_UTF16_UNITS: usize = 1_000;
    let trimmed = value.trim();
    if trimmed.encode_utf16().count() <= MAX_UTF16_UNITS {
        return if trimmed.is_empty() {
            "Desktop RPC failed.".into()
        } else {
            trimmed.into()
        };
    }

    let mut result = String::new();
    let mut units = 0;
    for character in trimmed.chars() {
        let width = character.len_utf16();
        if units + width >= MAX_UTF16_UNITS {
            break;
        }
        result.push(character);
        units += width;
    }
    result.push('…');
    result
}

async fn send<S>(writer: &mut S, message: &AgentMessage) -> Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    writer
        .send(Message::Text(encode_message(message)?.into()))
        .await?;
    Ok(())
}

fn decode_ws_message(message: Message) -> Result<Option<AgentMessage>> {
    match message {
        Message::Text(text) => Ok(Some(decode_message(text.as_bytes())?)),
        Message::Binary(bytes) => Ok(Some(decode_message(&bytes)?)),
        Message::Close(Some(frame)) => bail!(
            "agent WebSocket closed with code {}: {}",
            u16::from(frame.code),
            frame.reason
        ),
        Message::Close(None) => bail!("agent WebSocket closed without a close frame"),
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Ok(None),
    }
}

pub fn agent_websocket_url(server_url: &str) -> Result<Url> {
    let mut url = Url::parse(server_url).context("server URL is invalid")?;
    let host = url.host_str().unwrap_or_default().to_owned();
    let loopback =
        host.eq_ignore_ascii_case("localhost") || host == "::1" || host.starts_with("127.");
    match url.scheme() {
        "https" => url
            .set_scheme("wss")
            .map_err(|_| anyhow!("invalid WSS URL"))?,
        "http" if loopback => url
            .set_scheme("ws")
            .map_err(|_| anyhow!("invalid WS URL"))?,
        _ => bail!("remote agent servers must use HTTPS"),
    }
    url.set_query(None);
    url.set_fragment(None);
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/codex-api/agent/ws"));
    Ok(url)
}

fn redact_url(value: &str) -> String {
    Url::parse(value)
        .map(|mut url| {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string().trim_end_matches('/').to_owned()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_only_secure_or_loopback_server_urls() {
        assert_eq!(
            agent_websocket_url("https://codex.example.com/base/")
                .unwrap()
                .as_str(),
            "wss://codex.example.com/base/codex-api/agent/ws"
        );
        assert_eq!(
            agent_websocket_url("http://127.0.0.1:5900")
                .unwrap()
                .as_str(),
            "ws://127.0.0.1:5900/codex-api/agent/ws"
        );
        assert!(agent_websocket_url("http://codex.example.com").is_err());
    }

    #[test]
    fn websocket_control_frames_do_not_end_the_agent_session() {
        assert!(decode_ws_message(Message::Ping(Vec::new().into()))
            .unwrap()
            .is_none());
        assert!(decode_ws_message(Message::Pong(Vec::new().into()))
            .unwrap()
            .is_none());
    }

    #[test]
    fn agent_errors_are_bounded_using_javascript_string_length() {
        let message = bounded_agent_error(&"测试".repeat(600));
        assert_eq!(message.encode_utf16().count(), 1_000);
        assert!(message.ends_with('…'));
        assert_eq!(bounded_agent_error("  short error  "), "short error");
    }

    #[test]
    fn completed_response_cache_enforces_byte_budget_and_ttl() {
        let started = std::time::Instant::now();
        let mut cache = CompletedResponseCache::new(4, 10, Duration::from_secs(5));

        cache.insert("first".into(), vec!["123456".into()], started);
        cache.insert("second".into(), vec!["abcdef".into()], started);

        assert!(cache.get("first", started).is_none());
        assert_eq!(cache.get("second", started), Some(&["abcdef".to_owned()][..]));

        cache.insert("too-large".into(), vec!["x".repeat(11)], started);
        assert!(cache.get("too-large", started).is_none());
        assert!(cache
            .get("second", started + Duration::from_secs(6))
            .is_none());
    }
}
