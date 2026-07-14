use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const AGENT_PROTOCOL_VERSION: u8 = 1;
pub const MAX_AGENT_MESSAGE_BYTES: usize = 1024 * 1024;
pub const AGENT_RESPONSE_CHUNK_BYTES: usize = 512 * 1024;
pub const MAX_AGENT_RESPONSE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_AGENT_RESPONSE_CHUNKS: usize = MAX_AGENT_RESPONSE_BYTES / AGENT_RESPONSE_CHUNK_BYTES;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum AgentMessage {
    #[serde(rename = "hello")]
    Hello {
        version: u8,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "deviceName")]
        device_name: String,
        #[serde(rename = "agentVersion")]
        agent_version: String,
        capabilities: Vec<String>,
    },
    #[serde(rename = "hello/ack")]
    HelloAck {
        version: u8,
        accepted: bool,
        #[serde(rename = "serverTimeIso")]
        server_time_iso: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "request")]
    Request {
        version: u8,
        id: String,
        method: AgentRequestMethod,
        params: Value,
    },
    #[serde(rename = "response")]
    Response {
        version: u8,
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<AgentResponseError>,
    },
    #[serde(rename = "response/chunk")]
    ResponseChunk {
        version: u8,
        id: String,
        index: u16,
        total: u16,
        encoding: String,
        data: String,
    },
    #[serde(rename = "event")]
    Event {
        version: u8,
        sequence: u64,
        event: Value,
    },
    #[serde(rename = "ping")]
    Ping { version: u8, nonce: String },
    #[serde(rename = "pong")]
    Pong { version: u8, nonce: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentRequestMethod {
    #[serde(rename = "rpc")]
    Rpc,
    #[serde(rename = "bridge/status")]
    BridgeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentResponseError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("desktop agent frame is too large")]
    TooLarge,
    #[error("desktop agent frame is invalid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("desktop agent protocol version is unsupported")]
    UnsupportedVersion,
    #[error("desktop agent message field is invalid: {0}")]
    InvalidField(&'static str),
}

pub fn encode_message(message: &AgentMessage) -> Result<String, ProtocolError> {
    validate_message(message)?;
    let encoded = serde_json::to_string(message)?;
    if encoded.len() > MAX_AGENT_MESSAGE_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    Ok(encoded)
}

pub fn encode_response_frames(message: &AgentMessage) -> Result<Vec<String>, ProtocolError> {
    validate_message(message)?;
    let payload = serde_json::to_vec(message)?;
    if payload.len() <= MAX_AGENT_MESSAGE_BYTES {
        return Ok(vec![
            String::from_utf8(payload).expect("JSON is valid UTF-8")
        ]);
    }
    if !matches!(message, AgentMessage::Response { .. }) || payload.len() > MAX_AGENT_RESPONSE_BYTES
    {
        return Err(ProtocolError::TooLarge);
    }
    let id = match message {
        AgentMessage::Response { id, .. } => id,
        _ => unreachable!(),
    };
    let total = payload.len().div_ceil(AGENT_RESPONSE_CHUNK_BYTES);
    let mut frames = Vec::with_capacity(total);
    for (index, chunk) in payload.chunks(AGENT_RESPONSE_CHUNK_BYTES).enumerate() {
        frames.push(encode_message(&AgentMessage::ResponseChunk {
            version: AGENT_PROTOCOL_VERSION,
            id: id.clone(),
            index: index as u16,
            total: total as u16,
            encoding: "base64-json".into(),
            data: BASE64_STANDARD.encode(chunk),
        })?);
    }
    Ok(frames)
}

pub fn decode_message(bytes: &[u8]) -> Result<AgentMessage, ProtocolError> {
    if bytes.len() > MAX_AGENT_MESSAGE_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    let message: AgentMessage = serde_json::from_slice(bytes)?;
    validate_message(&message)?;
    Ok(message)
}

fn validate_message(message: &AgentMessage) -> Result<(), ProtocolError> {
    let version = match message {
        AgentMessage::Hello { version, .. }
        | AgentMessage::HelloAck { version, .. }
        | AgentMessage::Request { version, .. }
        | AgentMessage::Response { version, .. }
        | AgentMessage::ResponseChunk { version, .. }
        | AgentMessage::Event { version, .. }
        | AgentMessage::Ping { version, .. }
        | AgentMessage::Pong { version, .. } => *version,
    };
    if version != AGENT_PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    match message {
        AgentMessage::Hello {
            device_id,
            device_name,
            agent_version,
            capabilities,
            ..
        } => {
            validate_id(device_id, "deviceId")?;
            validate_text(device_name, 160, "deviceName")?;
            validate_text(agent_version, 80, "agentVersion")?;
            if capabilities.is_empty() || capabilities.len() > 32 {
                return Err(ProtocolError::InvalidField("capabilities"));
            }
        }
        AgentMessage::Request { id, .. } => {
            validate_id(id, "id")?;
        }
        AgentMessage::Response { id, error, .. } => {
            validate_id(id, "id")?;
            if let Some(error) = error {
                validate_text(&error.code, 80, "error.code")?;
                validate_text(&error.message, 1_000, "error.message")?;
            }
        }
        AgentMessage::ResponseChunk {
            id,
            index,
            total,
            encoding,
            data,
            ..
        } => {
            validate_id(id, "id")?;
            if *total == 0
                || usize::from(*total) > MAX_AGENT_RESPONSE_CHUNKS
                || *index >= *total
                || encoding != "base64-json"
                || data.is_empty()
                || data.len() > AGENT_RESPONSE_CHUNK_BYTES.div_ceil(3) * 4
            {
                return Err(ProtocolError::InvalidField("response chunk"));
            }
            let decoded = BASE64_STANDARD
                .decode(data)
                .map_err(|_| ProtocolError::InvalidField("response chunk data"))?;
            if decoded.is_empty()
                || decoded.len() > AGENT_RESPONSE_CHUNK_BYTES
                || BASE64_STANDARD.encode(&decoded) != *data
            {
                return Err(ProtocolError::InvalidField("response chunk data"));
            }
        }
        AgentMessage::Event { sequence, .. } if *sequence == 0 => {
            return Err(ProtocolError::InvalidField("sequence"));
        }
        AgentMessage::Ping { nonce, .. } | AgentMessage::Pong { nonce, .. } => {
            validate_id(nonce, "nonce")?;
        }
        _ => {}
    }
    Ok(())
}

fn validate_id(value: &str, field: &'static str) -> Result<(), ProtocolError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || !value.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(ProtocolError::InvalidField(field));
    }
    Ok(())
}

fn validate_text(value: &str, max_len: usize, field: &'static str) -> Result<(), ProtocolError> {
    if value.trim().is_empty() || value.encode_utf16().count() > max_len {
        return Err(ProtocolError::InvalidField(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_server_compatible_messages() {
        let message = AgentMessage::Request {
            version: 1,
            id: "req:123".into(),
            method: AgentRequestMethod::Rpc,
            params: serde_json::json!({"method":"thread/list","params":{"limit":20}}),
        };
        let encoded = encode_message(&message).unwrap();
        assert_eq!(decode_message(encoded.as_bytes()).unwrap(), message);
        assert!(encoded.contains("\"type\":\"request\""));
        assert!(encoded.contains("\"method\":\"rpc\""));
    }

    #[test]
    fn rejects_large_or_untrusted_identifiers() {
        assert!(matches!(
            decode_message(&vec![b' '; MAX_AGENT_MESSAGE_BYTES + 1]),
            Err(ProtocolError::TooLarge)
        ));
        let bad = br#"{"type":"ping","version":1,"nonce":"../bad"}"#;
        assert!(matches!(
            decode_message(bad),
            Err(ProtocolError::InvalidField("nonce"))
        ));
    }

    #[test]
    fn rejects_response_errors_that_exceed_server_bounds() {
        let response = AgentMessage::Response {
            version: 1,
            id: "req:123".into(),
            ok: false,
            result: None,
            error: Some(AgentResponseError {
                code: "RPC_FAILED".into(),
                message: "x".repeat(1_001),
            }),
        };
        assert!(matches!(
            encode_message(&response),
            Err(ProtocolError::InvalidField("error.message"))
        ));
    }

    #[test]
    fn splits_large_responses_into_bounded_frames() {
        let response = AgentMessage::Response {
            version: 1,
            id: "req-large".into(),
            ok: true,
            result: Some(serde_json::json!({"text": "x".repeat(MAX_AGENT_MESSAGE_BYTES + 64)})),
            error: None,
        };
        let frames = encode_response_frames(&response).unwrap();
        assert!(frames.len() > 1);
        assert!(frames
            .iter()
            .all(|frame| frame.len() <= MAX_AGENT_MESSAGE_BYTES));
        assert!(matches!(
            decode_message(frames[0].as_bytes()).unwrap(),
            AgentMessage::ResponseChunk { .. }
        ));
    }
}
