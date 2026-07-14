mod agent;
mod cdp;
mod config;
mod local_ops;
mod mobile_access;
mod protocol;

use agent::{AgentController, AgentStatus};
use cdp::{BridgeStatus, DesktopBridge};
use config::{
    generate_device_id, AgentConfig, AgentConfigInput, ConfigStore, WindowsCredentialStore,
};
use mobile_access::build_mobile_access;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow, WindowEvent, Wry,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_opener::OpenerExt;

struct AppState {
    store: ConfigStore,
    default_config: AgentConfig,
    bridge: DesktopBridge,
    agent: AgentController,
    auto_start_item: Mutex<Option<CheckMenuItem<Wry>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigView {
    server_url: String,
    web_url: String,
    device_id: String,
    device_name: String,
    auto_start: bool,
    has_token: bool,
    connection_state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusView {
    connection_state: String,
    desktop_state: String,
    agent: AgentStatus,
    desktop: BridgeStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileAccessView {
    access_url: String,
    qr_svg: String,
    is_public: bool,
    configured: bool,
    has_token: bool,
    device_name: String,
    connection_state: String,
    desktop_state: String,
}

#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<ConfigView, String> {
    let config = state
        .store
        .load()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| state.default_config.clone());
    let has_token = state
        .store
        .has_token(&config.device_id)
        .map_err(|error| error.to_string())?;
    let agent = state.agent.status().await;
    Ok(ConfigView {
        server_url: config.server_url,
        web_url: config.web_url,
        device_id: config.device_id,
        device_name: config.device_name,
        auto_start: config.auto_start,
        has_token,
        connection_state: connection_label(&agent),
    })
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<StatusView, String> {
    let agent = state.agent.status().await;
    let desktop = state.bridge.status().await;
    Ok(StatusView {
        connection_state: connection_label(&agent),
        desktop_state: desktop.state.clone(),
        agent,
        desktop,
    })
}

#[tauri::command]
async fn get_mobile_access(state: State<'_, AppState>) -> Result<MobileAccessView, String> {
    let stored = state.store.load().map_err(|error| error.to_string())?;
    let configured = stored.is_some();
    let config = stored.unwrap_or_else(|| state.default_config.clone());
    let has_token = state
        .store
        .has_token(&config.device_id)
        .map_err(|error| error.to_string())?;
    let agent = state.agent.status().await;
    let desktop = state.bridge.status().await;
    build_mobile_access_view(&config, configured, has_token, &agent, &desktop)
}

#[tauri::command]
fn open_mobile_access(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state
        .store
        .load()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "请先完成连接设置".to_owned())?;
    let access = build_mobile_access(&config.web_url, &config.device_id)
        .map_err(|error| error.to_string())?;
    app.opener()
        .open_url(access.access_url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    mut input: AgentConfigInput,
) -> Result<(), String> {
    input.device_id = state
        .store
        .load()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| state.default_config.clone())
        .device_id;
    let config = state.store.save(input).map_err(|error| error.to_string())?;
    apply_autostart(&app, config.auto_start)?;
    if let Ok(item) = state.auto_start_item.lock() {
        if let Some(item) = item.as_ref() {
            let _ = item.set_checked(config.auto_start);
        }
    }
    restart_agent(&state).await?;
    Ok(())
}

#[tauri::command]
fn hide_settings(app: AppHandle) -> Result<(), String> {
    hide_window(app.get_webview_window("settings").as_ref())
}

#[tauri::command]
fn get_app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

async fn restart_agent(state: &AppState) -> Result<(), String> {
    match state
        .store
        .load_runtime()
        .map_err(|error| error.to_string())?
    {
        Some(runtime) => {
            state
                .agent
                .start(runtime, env!("CARGO_PKG_VERSION").to_owned())
                .await;
            Ok(())
        }
        None => {
            state.agent.stop().await;
            Ok(())
        }
    }
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir()?;
    let store = ConfigStore::new(
        config_dir.join("agent-config.json"),
        Arc::new(WindowsCredentialStore),
    );
    let bridge = DesktopBridge::new();
    bridge.start_keep_alive();
    let agent = AgentController::new(bridge.clone());
    let initial_config = store.load()?;
    let default_config = initial_config.clone().unwrap_or_else(default_config);
    let initial_auto_start = initial_config
        .as_ref()
        .is_some_and(|config| config.auto_start);
    app.manage(AppState {
        store: store.clone(),
        default_config,
        bridge,
        agent,
        auto_start_item: Mutex::new(None),
    });
    if let (Some(window), Some(icon)) = (
        app.get_webview_window("settings"),
        app.default_window_icon(),
    ) {
        window.set_icon(icon.clone())?;
    }
    apply_autostart(app.handle(), initial_auto_start).map_err(std::io::Error::other)?;
    build_tray(app, initial_auto_start)?;

    if initial_config.is_some() {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<AppState>();
            if let Err(error) = restart_agent(&state).await {
                tracing::error!("Failed to start agent: {error}");
            }
        });
    } else {
        show_settings(app.handle());
    }
    Ok(())
}

fn build_tray(app: &tauri::App, auto_start: bool) -> tauri::Result<()> {
    let title = MenuItem::new(app, "Codex Bridge Agent", false, None::<&str>)?;
    let open_web = MenuItem::with_id(app, "open-web", "打开 Codex 网页", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "连接设置...", true, None::<&str>)?;
    let reconnect = MenuItem::with_id(app, "reconnect", "立即重连", true, None::<&str>)?;
    let auto_start_item = CheckMenuItem::with_id(
        app,
        "auto-start",
        "登录 Windows 时启动",
        true,
        auto_start,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &title,
            &PredefinedMenuItem::separator(app)?,
            &open_web,
            &settings,
            &reconnect,
            &auto_start_item,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    if let Some(state) = app.try_state::<AppState>() {
        *state.auto_start_item.lock().unwrap() = Some(auto_start_item.clone());
    }
    let auto_start_for_event = auto_start_item.clone();
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Codex Bridge Agent")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open-web" => open_configured_web(app),
            "settings" => show_settings(app),
            "reconnect" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    if let Err(error) = restart_agent(&state).await {
                        tracing::error!("Reconnect failed: {error}");
                    }
                });
            }
            "auto-start" => {
                if let Ok(enabled) = auto_start_for_event.is_checked() {
                    if let Err(error) = set_auto_start(app, enabled) {
                        tracing::error!("Autostart update failed: {error}");
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_settings(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn open_configured_web(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(Some(config)) = state.store.load() {
        let access_url = build_mobile_access(&config.web_url, &config.device_id)
            .map(|access| access.access_url)
            .unwrap_or(config.web_url);
        if let Err(error) = app.opener().open_url(access_url, None::<&str>) {
            tracing::error!("Failed to open web UI: {error}");
        }
    } else {
        show_settings(app);
    }
}

fn set_auto_start(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let Some(config) = state.store.load().map_err(|error| error.to_string())? else {
        return Ok(());
    };
    let input = AgentConfigInput {
        server_url: config.server_url,
        web_url: config.web_url,
        device_id: config.device_id,
        device_name: config.device_name,
        token: String::new(),
        auto_start: enabled,
    };
    state.store.save(input).map_err(|error| error.to_string())?;
    apply_autostart(app, enabled)
}

fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let current = manager.is_enabled().map_err(|error| error.to_string())?;
    if !should_update_autostart(current, enabled) {
        return Ok(());
    }
    if enabled {
        manager.enable().map_err(|error| error.to_string())
    } else {
        manager.disable().map_err(|error| error.to_string())
    }
}

fn should_update_autostart(current: bool, desired: bool) -> bool {
    current != desired
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_window(window: Option<&WebviewWindow>) -> Result<(), String> {
    window
        .ok_or_else(|| "settings window is unavailable".to_owned())?
        .hide()
        .map_err(|error| error.to_string())
}

fn default_config() -> AgentConfig {
    let device_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".into());
    AgentConfig {
        server_url: "https://codex-bridge.120.48.173.147.sslip.io".into(),
        web_url: "https://codex-bridge.120.48.173.147.sslip.io/".into(),
        device_id: generate_device_id(),
        device_name,
        auto_start: false,
    }
}

fn connection_label(status: &AgentStatus) -> String {
    match status.state.as_str() {
        "connected" => "服务器：已连接".into(),
        "connecting" => "服务器：正在连接".into(),
        "error" => status
            .error
            .as_ref()
            .map(|error| format!("服务器：连接异常 - {error}"))
            .unwrap_or_else(|| "服务器：连接异常".into()),
        _ => "服务器：已停止".into(),
    }
}

fn build_mobile_access_view(
    config: &AgentConfig,
    configured: bool,
    has_token: bool,
    agent: &AgentStatus,
    desktop: &BridgeStatus,
) -> Result<MobileAccessView, String> {
    let access = build_mobile_access(&config.web_url, &config.device_id)
        .map_err(|error| error.to_string())?;
    Ok(MobileAccessView {
        access_url: access.access_url,
        qr_svg: access.qr_svg,
        is_public: access.is_public,
        configured,
        has_token,
        device_name: config.device_name.clone(),
        connection_state: connection_label(agent),
        desktop_state: desktop.state.clone(),
    })
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "codex_bridge_agent=info,codex_bridge_agent_lib=info".into()),
        )
        .with_ansi(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_settings(app);
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_status,
            get_mobile_access,
            get_app_version,
            open_mobile_access,
            save_config,
            hide_settings
        ])
        .setup(setup_app)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Codex Bridge Agent");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_the_public_bridge_server() {
        let config = default_config();

        assert_eq!(
            config.server_url,
            "https://codex-bridge.120.48.173.147.sslip.io"
        );
        assert_eq!(
            config.web_url,
            "https://codex-bridge.120.48.173.147.sslip.io/"
        );
        assert!(config.device_id.starts_with("desktop-"));
        assert_eq!(config.device_id.len(), 40);
    }

    #[test]
    fn autostart_is_only_written_when_the_desired_state_changes() {
        assert!(!should_update_autostart(false, false));
        assert!(!should_update_autostart(true, true));
        assert!(should_update_autostart(false, true));
        assert!(should_update_autostart(true, false));
    }

    #[test]
    fn status_labels_are_readable_chinese() {
        let connected = AgentStatus {
            state: "connected".into(),
            ..AgentStatus::default()
        };
        assert_eq!(connection_label(&connected), "服务器：已连接");

        let connecting = AgentStatus {
            state: "connecting".into(),
            ..AgentStatus::default()
        };
        assert_eq!(connection_label(&connecting), "服务器：正在连接");

        let stopped = AgentStatus::default();
        assert_eq!(connection_label(&stopped), "服务器：已停止");
    }

    #[test]
    fn settings_page_uses_qr_first_layout_with_secondary_configuration() {
        let html = include_str!("../../web/index.html");
        for contract in [
            "id=\"access-view\"",
            "id=\"qr-code\"",
            "id=\"access-url\"",
            "id=\"open-settings\"",
            "id=\"window-minimize\"",
            "id=\"window-maximize\"",
            "id=\"window-close\"",
            "id=\"settings-view\"",
            "src=\"./app-icon.png\"",
            "href=\"./styles.css\"",
            "src=\"./app.js\"",
        ] {
            assert!(
                html.contains(contract),
                "missing QR layout contract: {contract}"
            );
        }

        let access_view = html.find("id=\"access-view\"").unwrap();
        let settings_view = html.find("id=\"settings-view\"").unwrap();
        assert!(access_view < settings_view);
        for input in [
            "serverUrl",
            "webUrl",
            "deviceId",
            "deviceName",
            "token",
            "autoStart",
        ] {
            let position = html
                .find(&format!("id=\"{input}\""))
                .unwrap_or_else(|| panic!("missing settings input: {input}"));
            assert!(
                position > settings_view,
                "{input} must remain in secondary settings"
            );
        }
    }

    #[test]
    fn settings_window_uses_custom_window_controls() {
        let html = include_str!("../../web/index.html");
        let script = include_str!("../../web/app.js");
        assert!(html.matches("data-tauri-drag-region").count() >= 4);
        for control in ["minimize", "maximize", "close"] {
            assert!(script.contains(&format!("controlWindow('{control}')")));
        }
        assert!(script.contains("controlWindow('drag')"));
    }

    #[test]
    fn desktop_surfaces_use_the_shared_icon_and_visible_version() {
        let html = include_str!("../../web/index.html");
        let script = include_str!("../../web/app.js");
        let source = include_str!("lib.rs");
        let config = include_str!("../tauri.conf.json");

        assert!(html.contains("src=\"./app-icon.png\""));
        assert!(html.contains("id=\"app-version\""));
        assert!(script.contains("get_app_version"));
        assert!(source.contains("window.set_icon(icon.clone())"));
        assert!(config.contains("\"installerIcon\": \"icons/icon.ico\""));
        assert!(config.contains("\"uninstallerIcon\": \"icons/icon.ico\""));
    }

    #[test]
    fn copy_action_updates_feedback_before_waiting_for_clipboard_access() {
        let script = include_str!("../../web/app.js");
        let feedback = script
            .find("textContent = '已复制'")
            .expect("copy feedback must be present");
        let clipboard = script
            .find("navigator.clipboard.writeText")
            .expect("clipboard write must be present");

        assert!(feedback < clipboard);
    }

    #[test]
    fn settings_page_disables_the_native_context_menu() {
        let script = include_str!("../../web/app.js");
        assert!(script.contains("addEventListener('contextmenu'"));
        assert!(script.contains("event.preventDefault()"));
    }

    #[test]
    fn mobile_access_view_exposes_routing_state_without_agent_credentials() {
        let config = AgentConfig {
            server_url: "https://codex.example.com".into(),
            web_url: "https://codex.example.com/app".into(),
            device_id: "desktop-a".into(),
            device_name: "Workstation".into(),
            auto_start: true,
        };
        let agent = AgentStatus {
            state: "connected".into(),
            ..AgentStatus::default()
        };
        let desktop = BridgeStatus {
            state: "ready".into(),
            ..BridgeStatus::default()
        };

        let view = build_mobile_access_view(&config, true, true, &agent, &desktop).unwrap();
        let payload = serde_json::to_value(view).unwrap();

        assert_eq!(
            payload["accessUrl"],
            "https://codex.example.com/app#/device/desktop-a"
        );
        assert_eq!(payload["configured"], true);
        assert_eq!(payload["hasToken"], true);
        assert_eq!(payload["desktopState"], "ready");
        assert!(payload["qrSvg"].as_str().unwrap().starts_with("<svg"));
        assert!(payload.get("token").is_none());
        assert!(payload.get("credential").is_none());
    }

    #[test]
    fn single_instance_plugin_is_registered_first() {
        let source = include_str!("lib.rs");
        let single_instance = source
            .find(".plugin(tauri_plugin_single_instance::init")
            .expect("single-instance plugin must be registered");
        let autostart = source
            .find(".plugin(tauri_plugin_autostart")
            .expect("autostart plugin must be registered");
        assert!(single_instance < autostart);
    }
}
