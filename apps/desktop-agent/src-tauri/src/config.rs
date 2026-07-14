use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

const CREDENTIAL_SERVICE: &str = "Codex Bridge Agent";
const PUBLIC_BRIDGE_URL: &str = "https://codex-bridge.120.48.173.147.sslip.io";
const LEGACY_LOCAL_URLS: [&str; 2] = ["http://127.0.0.1:5900", "http://127.0.0.1:5912"];
const DEVICE_ID_PREFIX: &str = "desktop-";

pub fn generate_device_id() -> String {
    format!("{DEVICE_ID_PREFIX}{}", Uuid::new_v4().simple())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigInput {
    pub server_url: String,
    pub web_url: String,
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub token: String,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub server_url: String,
    pub web_url: String,
    pub device_id: String,
    pub device_name: String,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PersistedConfig {
    version: u8,
    #[serde(flatten)]
    config: AgentConfig,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub config: AgentConfig,
    pub token: String,
}

pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), ConfigError>;
    fn get(&self, account: &str) -> Result<Option<String>, ConfigError>;
}

pub struct WindowsCredentialStore;

impl SecretStore for WindowsCredentialStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), ConfigError> {
        keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .map_err(|error| ConfigError::Secret(error.to_string()))?
            .set_password(secret)
            .map_err(|error| ConfigError::Secret(error.to_string()))
    }

    fn get(&self, account: &str) -> Result<Option<String>, ConfigError> {
        let entry = keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .map_err(|error| ConfigError::Secret(error.to_string()))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(ConfigError::Secret(error.to_string())),
        }
    }
}

#[derive(Clone)]
pub struct ConfigStore {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
}

impl ConfigStore {
    pub fn new(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self { path, secrets }
    }

    pub fn load(&self) -> Result<Option<AgentConfig>, ConfigError> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let persisted: PersistedConfig =
            serde_json::from_str(&raw).map_err(|error| ConfigError::Invalid(error.to_string()))?;
        if persisted.version != 1 {
            return Err(ConfigError::Invalid("unsupported config version".into()));
        }
        let previous = persisted.config;
        let mut config = previous.clone();
        migrate_legacy_local_urls(&mut config);
        let previous_device_id = config.device_id.clone();
        if !is_generated_device_id(&config.device_id) {
            config.device_id = generate_device_id();
        }
        validate_config(&config)?;
        if config != previous {
            if previous_device_id != config.device_id {
                if let Some(secret) = self.secrets.get(&previous_device_id)? {
                    self.secrets.set(&config.device_id, &secret)?;
                }
            }
            self.persist(&config)?;
        }
        Ok(Some(config))
    }

    pub fn load_runtime(&self) -> Result<Option<RuntimeConfig>, ConfigError> {
        let Some(config) = self.load()? else {
            return Ok(None);
        };
        let token = self
            .secrets
            .get(&config.device_id)?
            .filter(|value| !value.is_empty())
            .ok_or(ConfigError::MissingToken)?;
        Ok(Some(RuntimeConfig { config, token }))
    }

    pub fn has_token(&self, device_id: &str) -> Result<bool, ConfigError> {
        Ok(self
            .secrets
            .get(device_id)?
            .is_some_and(|value| !value.is_empty()))
    }

    pub fn save(&self, input: AgentConfigInput) -> Result<AgentConfig, ConfigError> {
        let config = AgentConfig {
            server_url: input.server_url.trim().trim_end_matches('/').to_owned(),
            web_url: input.web_url.trim().trim_end_matches('/').to_owned(),
            device_id: input.device_id.trim().to_owned(),
            device_name: input.device_name.trim().to_owned(),
            auto_start: input.auto_start,
        };
        validate_config(&config)?;
        if input.token.is_empty() {
            if !self.has_token(&config.device_id)? {
                return Err(ConfigError::MissingToken);
            }
        } else {
            if input.token.len() > 4096 {
                return Err(ConfigError::Invalid("pairing token is too long".into()));
            }
            self.secrets.set(&config.device_id, &input.token)?;
        }

        self.persist(&config)?;
        Ok(config)
    }

    fn persist(&self, config: &AgentConfig) -> Result<(), ConfigError> {
        let persisted = PersistedConfig {
            version: 1,
            config: config.clone(),
        };
        let parent = self
            .path
            .parent()
            .ok_or_else(|| ConfigError::Invalid("config path has no parent".into()))?;
        fs::create_dir_all(parent)?;
        let temp_path = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let payload = serde_json::to_vec_pretty(&persisted)?;
        fs::write(&temp_path, payload)?;
        if let Err(error) = replace_file(&temp_path, &self.path) {
            let _ = fs::remove_file(&temp_path);
            return Err(error.into());
        }
        Ok(())
    }
}

fn migrate_legacy_local_urls(config: &mut AgentConfig) {
    if LEGACY_LOCAL_URLS.contains(&config.server_url.trim_end_matches('/')) {
        config.server_url = PUBLIC_BRIDGE_URL.to_owned();
    }
    if LEGACY_LOCAL_URLS.contains(&config.web_url.trim_end_matches('/')) {
        config.web_url = format!("{PUBLIC_BRIDGE_URL}/");
    }
}

fn is_generated_device_id(device_id: &str) -> bool {
    let Some(value) = device_id.strip_prefix(DEVICE_ID_PREFIX) else {
        return false;
    };
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("agent config is invalid: {0}")]
    Invalid(String),
    #[error("pairing token is not stored in Windows Credential Manager")]
    MissingToken,
    #[error("Windows Credential Manager failed: {0}")]
    Secret(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn validate_config(config: &AgentConfig) -> Result<(), ConfigError> {
    validate_url(&config.server_url, true)?;
    validate_url(&config.web_url, false)?;
    if config.device_id.is_empty()
        || config.device_id.len() > 128
        || !config
            .device_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || !config.device_id.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(ConfigError::Invalid("device id is invalid".into()));
    }
    if config.device_name.is_empty() || config.device_name.len() > 160 {
        return Err(ConfigError::Invalid("device name is invalid".into()));
    }
    Ok(())
}

fn validate_url(value: &str, agent_server: bool) -> Result<(), ConfigError> {
    let url = Url::parse(value).map_err(|_| ConfigError::Invalid("URL is invalid".into()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::Invalid(
            "URL must not contain credentials".into(),
        ));
    }
    let host = url.host_str().unwrap_or_default();
    let loopback =
        host.eq_ignore_ascii_case("localhost") || host == "::1" || host.starts_with("127.");
    let valid_scheme = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !valid_scheme {
        let target = if agent_server { "server" } else { "web" };
        return Err(ConfigError::Invalid(format!(
            "remote {target} URL must use HTTPS"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, String>>);

    impl SecretStore for MemorySecrets {
        fn set(&self, account: &str, secret: &str) -> Result<(), ConfigError> {
            self.0.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }

        fn get(&self, account: &str) -> Result<Option<String>, ConfigError> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
    }

    fn input(token: &str) -> AgentConfigInput {
        AgentConfigInput {
            server_url: "https://codex.example.com/".into(),
            web_url: "https://codex.example.com/".into(),
            device_id: "desktop-0123456789abcdef0123456789abcdef".into(),
            device_name: "Workstation".into(),
            token: token.into(),
            auto_start: true,
        }
    }

    #[test]
    fn stores_secret_outside_atomic_json_config() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::default());
        let store = ConfigStore::new(dir.path().join("nested/config.json"), secrets);
        store.save(input("pairing-secret")).unwrap();
        let raw = fs::read_to_string(dir.path().join("nested/config.json")).unwrap();
        assert!(!raw.contains("pairing-secret"));
        let runtime = store.load_runtime().unwrap().unwrap();
        assert_eq!(runtime.token, "pairing-secret");
        assert_eq!(
            runtime.config.device_id,
            "desktop-0123456789abcdef0123456789abcdef"
        );

        let mut updated = input("");
        updated.device_name = "Updated".into();
        store.save(updated).unwrap();
        assert_eq!(store.load().unwrap().unwrap().device_name, "Updated");
    }

    #[test]
    fn rejects_plain_http_remote_servers_and_missing_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(
            dir.path().join("config.json"),
            Arc::new(MemorySecrets::default()),
        );
        let mut invalid = input("secret");
        invalid.server_url = "http://codex.example.com".into();
        assert!(store.save(invalid).is_err());
        assert!(matches!(
            store.save(input("")),
            Err(ConfigError::MissingToken)
        ));
    }

    #[test]
    fn migrates_legacy_local_urls_to_the_public_bridge() {
        let mut config = AgentConfig {
            server_url: "http://127.0.0.1:5912".into(),
            web_url: "http://127.0.0.1:5912/".into(),
            device_id: "desktop-a".into(),
            device_name: "Workstation".into(),
            auto_start: true,
        };

        migrate_legacy_local_urls(&mut config);

        assert_eq!(config.server_url, PUBLIC_BRIDGE_URL);
        assert_eq!(config.web_url, format!("{PUBLIC_BRIDGE_URL}/"));
    }

    #[test]
    fn migrates_legacy_device_id_once_and_preserves_its_secret() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::default());
        secrets.set("tauri-e2e-v2", "pairing-secret").unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            serde_json::to_vec(&PersistedConfig {
                version: 1,
                config: AgentConfig {
                    server_url: PUBLIC_BRIDGE_URL.into(),
                    web_url: format!("{PUBLIC_BRIDGE_URL}/"),
                    device_id: "tauri-e2e-v2".into(),
                    device_name: "Workstation".into(),
                    auto_start: true,
                },
            })
            .unwrap(),
        )
        .unwrap();
        let store = ConfigStore::new(path, secrets);

        let first = store.load_runtime().unwrap().unwrap();
        let second = store.load_runtime().unwrap().unwrap();

        assert!(is_generated_device_id(&first.config.device_id));
        assert_eq!(first.config.device_id, second.config.device_id);
        assert_eq!(first.token, "pairing-secret");
    }
}
