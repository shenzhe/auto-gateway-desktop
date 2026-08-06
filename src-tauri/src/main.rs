#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod codex_app;
mod codex_config;
mod desktop_auth;
mod http_client;

use codex_app::{
    install as install_codex_app, is_installed_app_running, local_status as local_codex_app_status,
    open_installed_app, status as codex_app_status, CodexAppStatus, CodexInstallResult,
};
use codex_config::{
    apply_configuration, default_codex_paths, restore_latest_backups, CodexStatus,
    ConfigurationResult, RestoreResult,
};
use desktop_auth::{
    bootstrap_desktop_key, clear_desktop_session, clear_stored_desktop_api_key,
    create_desktop_console_ticket, desktop_account_summary, exchange_desktop_authorization,
    installation_id, refresh_desktop_state, restore_desktop_state, save_desktop_api_key,
    save_desktop_session, DesktopAccountSummary, DesktopBootstrapKey, DesktopSession,
    StoredDesktopState,
};
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Size, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
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
async fn get_local_codex_app_status() -> CodexAppStatus {
    tauri::async_runtime::spawn_blocking(local_codex_app_status)
        .await
        .unwrap_or_else(|_| local_codex_app_status())
}

#[tauri::command]
async fn install_codex(
    app: AppHandle,
    force_update: bool,
    force_redownload: bool,
) -> Result<CodexInstallResult, String> {
    install_codex_app(&app, force_update, force_redownload).await
}

#[tauri::command]
fn open_codex() -> Result<(), String> {
    open_installed_app()
}

#[tauri::command]
async fn is_codex_running() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(is_installed_app_running)
        .await
        .map_err(|error| format!("wait for the Codex process check: {error}"))?
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
async fn exchange_desktop_authorization_command(
    app: AppHandle,
    code: String,
    code_verifier: String,
    state: String,
) -> Result<DesktopSession, String> {
    let session = exchange_desktop_authorization(&code, &code_verifier, &state).await?;
    save_desktop_session(&app, &session)?;
    Ok(session)
}

#[tauri::command]
async fn open_desktop_sign_in_command(
    app: AppHandle,
    challenge: String,
    state: String,
) -> Result<(), String> {
    let challenge = challenge.trim();
    let state = state.trim();
    if challenge.is_empty() || state.is_empty() {
        return Err("desktop sign-in challenge is missing".to_string());
    }
    let mut sign_in_url = Url::parse("https://autogateway.cc/login")
        .map_err(|error| format!("build desktop sign-in URL: {error}"))?;
    sign_in_url
        .query_pairs_mut()
        .append_pair("desktopCodeChallenge", challenge)
        .append_pair("desktopState", state);

    if let Some(window) = app.get_webview_window("auth") {
        window
            .navigate(sign_in_url)
            .map_err(|error| format!("load the sign-in page: {error}"))?;
        window
            .show()
            .map_err(|error| format!("show the sign-in window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("focus the sign-in window: {error}"))?;
        return Ok(());
    }

    let app_handle = app.clone();
    WebviewWindowBuilder::new(&app, "auth", WebviewUrl::External(sign_in_url))
        .title("Connect AUTO Gateway")
        .inner_size(520.0, 760.0)
        .min_inner_size(420.0, 640.0)
        .center()
        .resizable(true)
        .on_navigation(move |url| {
            let is_callback = url.scheme() == "autogateway"
                && url.host_str() == Some("auth")
                && url.path() == "/callback";
            if is_callback {
                let _ = app_handle.emit("desktop-open-url", vec![url.as_str().to_string()]);
                if let Some(window) = app_handle.get_webview_window("auth") {
                    let _ = window.close();
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|error| format!("open the in-app sign-in window: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn bootstrap_desktop_key_command(
    app: AppHandle,
    access_token: String,
    rotate_existing: bool,
) -> Result<DesktopBootstrapKey, String> {
    let id = installation_id(&app)?;
    let key = bootstrap_desktop_key(&access_token, &id, rotate_existing).await?;
    save_desktop_api_key(&app, &key.api_key)?;
    Ok(key)
}

#[tauri::command]
async fn restore_desktop_state_command(
    app: AppHandle,
) -> Result<Option<StoredDesktopState>, String> {
    restore_desktop_state(&app).await
}

#[tauri::command]
async fn refresh_desktop_state_command(
    app: AppHandle,
    failed_access_token: String,
) -> Result<Option<StoredDesktopState>, String> {
    refresh_desktop_state(&app, &failed_access_token).await
}

#[tauri::command]
fn clear_desktop_session_command(app: AppHandle) -> Result<(), String> {
    clear_desktop_session(&app)
}

#[tauri::command]
fn sign_out_desktop_command(app: AppHandle) -> Result<(), String> {
    clear_desktop_session(&app)?;
    app.emit("desktop-session-cleared", ())
        .map_err(|error| format!("notify desktop windows about sign-out: {error}"))
}

#[tauri::command]
fn close_desktop_sign_in_command(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("auth") {
        window
            .close()
            .map_err(|error| format!("close the sign-in window: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn get_desktop_account_summary_command(
    access_token: String,
) -> Result<DesktopAccountSummary, String> {
    desktop_account_summary(&access_token).await
}

#[tauri::command]
fn update_tray_status_command(
    app: AppHandle,
    username: String,
    balance: String,
) -> Result<(), String> {
    let tooltip = format!(
        "AUTO Gateway — {}\n{}: {}",
        username.trim(),
        "Balance",
        balance.trim()
    );
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "the AUTO Gateway tray icon is unavailable".to_string())?;
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| format!("update the tray status: {error}"))
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the AUTO Gateway main window is unavailable".to_string())?;
    let _ = window.unminimize();
    window
        .show()
        .map_err(|error| format!("show the AUTO Gateway main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("focus the AUTO Gateway main window: {error}"))
}

#[tauri::command]
fn get_desktop_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn fit_main_window_to_work_area(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let work_area = monitor.work_area();
    let margin = 16_u32;
    let max_width = work_area.size.width.saturating_sub(margin * 2);
    let max_height = work_area.size.height.saturating_sub(margin * 2);
    let Ok(current_size) = window.inner_size() else {
        return;
    };
    let width = current_size.width.min(max_width);
    let height = current_size.height.min(max_height);
    if width != current_size.width || height != current_size.height {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }
    let _ = window.center();
}

fn show_tray_popup(app: &AppHandle, tray_rect: Rect) {
    let Some(window) = app.get_webview_window("tray-popup") else {
        return;
    };

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let (tray_x, tray_y, tray_width, tray_height) = match (tray_rect.position, tray_rect.size) {
        (Position::Physical(position), Size::Physical(size)) => (
            position.x as f64,
            position.y as f64,
            size.width as f64,
            size.height as f64,
        ),
        (Position::Logical(position), Size::Logical(size)) => (
            position.x * scale_factor,
            position.y * scale_factor,
            size.width * scale_factor,
            size.height * scale_factor,
        ),
        _ => return,
    };
    let popup_width = 360.0 * scale_factor;
    let popup_height = 300.0 * scale_factor;
    let mut x = tray_x - popup_width + tray_width;
    let mut y = if cfg!(target_os = "windows") {
        tray_y - popup_height - (10.0 * scale_factor)
    } else {
        tray_y + tray_height + (10.0 * scale_factor)
    };

    if let Ok(Some(monitor)) = window.current_monitor() {
        let work_area = monitor.work_area();
        let margin = 8.0 * scale_factor;
        let left = work_area.position.x as f64 + margin;
        let right =
            (work_area.position.x + work_area.size.width as i32) as f64 - popup_width - margin;
        let top = work_area.position.y as f64 + margin;
        let bottom =
            (work_area.position.y + work_area.size.height as i32) as f64 - popup_height - margin;
        x = x.clamp(left, right.max(left));
        y = y.clamp(top, bottom.max(top));
    }

    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn clear_stored_desktop_api_key_command(app: AppHandle) -> Result<(), String> {
    clear_stored_desktop_api_key(&app)
}

#[tauri::command]
async fn open_console(
    app: AppHandle,
    access_token: String,
    section: Option<String>,
) -> Result<(), String> {
    let ticket = create_desktop_console_ticket(&access_token).await?;
    let mut console_url =
        Url::parse("https://autogateway.cc/console").map_err(|error| error.to_string())?;
    console_url
        .query_pairs_mut()
        .append_pair("desktopTicket", &ticket.ticket);
    if section.as_deref() == Some("billing") {
        console_url
            .query_pairs_mut()
            .append_pair("section", "billing");
    }
    if let Some(window) = app.get_webview_window("console") {
        window
            .navigate(console_url)
            .map_err(|error| error.to_string())?;
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

#[tauri::command]
fn open_devtools(app: AppHandle) -> Result<(), String> {
    let mut opened = 0;
    for label in ["main", "console"] {
        if let Some(window) = app.get_webview_window(label) {
            window.open_devtools();
            opened += 1;
        }
    }
    if opened == 0 {
        return Err("no desktop window is available for debugging".to_string());
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            fit_main_window_to_work_area(app.handle());
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("AUTO Gateway")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        show_tray_popup(tray.app_handle(), rect);
                    }
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
        .on_window_event(|window, event| match (window.label(), event) {
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            ("tray-popup", WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_codex_status,
            get_codex_app_status,
            get_local_codex_app_status,
            install_codex,
            open_codex,
            is_codex_running,
            configure_codex,
            restore_latest_codex_backups,
            get_installation_id,
            exchange_desktop_authorization_command,
            open_desktop_sign_in_command,
            bootstrap_desktop_key_command,
            restore_desktop_state_command,
            refresh_desktop_state_command,
            clear_desktop_session_command,
            sign_out_desktop_command,
            close_desktop_sign_in_command,
            get_desktop_account_summary_command,
            update_tray_status_command,
            show_main_window,
            get_desktop_app_version,
            clear_stored_desktop_api_key_command,
            open_console,
            open_devtools
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AUTO Gateway Desktop");
}
