#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod codex_app;
mod codex_config;
mod desktop_auth;
mod http_client;

use codex_app::{install as install_codex_app, open_installed_app, status as codex_app_status, CodexAppStatus, CodexInstallResult};
use codex_config::{apply_configuration, default_codex_paths, restore_latest_backups, CodexStatus, ConfigurationResult, RestoreResult};
use desktop_auth::{bootstrap_desktop_key, clear_stored_desktop_api_key, create_desktop_console_ticket, desktop_account_summary, exchange_desktop_authorization, installation_id, restore_desktop_state, save_desktop_api_key, save_desktop_session, DesktopAccountSummary, DesktopBootstrapKey, DesktopSession, StoredDesktopState};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

#[tauri::command]
fn get_codex_status() -> Result<CodexStatus, String> {
    let paths = default_codex_paths()?;
    paths.status()
}

#[tauri::command]
async fn get_codex_app_status() -> CodexAppStatus {
    codex_app_status().await
}

#[tauri::command]
async fn install_codex(app: AppHandle, force_update: bool) -> Result<CodexInstallResult, String> {
    install_codex_app(&app, force_update).await
}

#[tauri::command]
fn open_codex() -> Result<(), String> {
    open_installed_app()
}

#[tauri::command]
fn configure_codex(api_key: String, endpoint: String) -> Result<ConfigurationResult, String> {
    let paths = default_codex_paths()?;
    apply_configuration(&paths, &api_key, &endpoint)
}

#[tauri::command]
fn restore_latest_codex_backups() -> Result<RestoreResult, String> {
    let paths = default_codex_paths()?;
    restore_latest_backups(&paths)
}

#[tauri::command]
fn get_installation_id(app: AppHandle) -> Result<String, String> {
    installation_id(&app)
}

#[tauri::command]
async fn exchange_desktop_authorization_command(app: AppHandle, code: String, code_verifier: String, state: String) -> Result<DesktopSession, String> {
    let session = exchange_desktop_authorization(&code, &code_verifier, &state).await?;
    save_desktop_session(&app, &session)?;
    Ok(session)
}

#[tauri::command]
async fn bootstrap_desktop_key_command(app: AppHandle, access_token: String, rotate_existing: bool) -> Result<DesktopBootstrapKey, String> {
    let id = installation_id(&app)?;
    let key = bootstrap_desktop_key(&access_token, &id, rotate_existing).await?;
    save_desktop_api_key(&app, &key.api_key)?;
    Ok(key)
}

#[tauri::command]
async fn restore_desktop_state_command(app: AppHandle) -> Result<Option<StoredDesktopState>, String> {
    restore_desktop_state(&app).await
}

#[tauri::command]
async fn get_desktop_account_summary_command(access_token: String) -> Result<DesktopAccountSummary, String> {
    desktop_account_summary(&access_token).await
}

#[tauri::command]
fn update_tray_status_command(app: AppHandle, username: String, balance: String) -> Result<(), String> {
    let tooltip = format!("AUTO Gateway — {}\n{}: {}", username.trim(), "Balance", balance.trim());
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "the AUTO Gateway tray icon is unavailable".to_string())?;
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| format!("update the tray status: {error}"))
}

#[tauri::command]
fn clear_stored_desktop_api_key_command(app: AppHandle) -> Result<(), String> {
    clear_stored_desktop_api_key(&app)
}

#[tauri::command]
async fn open_console(app: AppHandle, access_token: String, section: Option<String>) -> Result<(), String> {
    let ticket = create_desktop_console_ticket(&access_token).await?;
    let mut console_url = Url::parse("https://autogateway.cc/console").map_err(|error| error.to_string())?;
    console_url.query_pairs_mut().append_pair("desktopTicket", &ticket.ticket);
    if section.as_deref() == Some("billing") {
        console_url.query_pairs_mut().append_pair("section", "billing");
    }
    if let Some(window) = app.get_webview_window("console") {
        window.navigate(console_url).map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "console", WebviewUrl::External(console_url))
        .title("AUTO Gateway Console")
        .inner_size(1280.0, 900.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let open_item = MenuItem::with_id(app, "open-main", "Open AUTO Gateway", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit AUTO Gateway", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("AUTO Gateway")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open-main" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let urls = argv
                .into_iter()
                .filter(|argument| argument.to_ascii_lowercase().starts_with("autogateway://"))
                .collect::<Vec<_>>();
            if urls.is_empty() {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("desktop-open-url", urls);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_codex_status,
            get_codex_app_status,
            install_codex,
            open_codex,
            configure_codex,
            restore_latest_codex_backups,
            get_installation_id,
            exchange_desktop_authorization_command,
            bootstrap_desktop_key_command,
            restore_desktop_state_command,
            get_desktop_account_summary_command,
            update_tray_status_command,
            clear_stored_desktop_api_key_command,
            open_console
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AUTO Gateway Desktop");
}
