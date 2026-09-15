use crate::http_client::{
    client_with_timeout as desktop_http_client, client_with_timeouts,
    client_with_timeouts_and_read_timeout,
};
use crate::runtime::AUTO_GATEWAY_API_BASE_URL;
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(any(target_os = "windows", test))]
use std::io::{Read, Seek, SeekFrom};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Output;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Stdio;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::sync::Mutex;
use std::sync::OnceLock;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::thread;
use std::time::{Duration, Instant};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
#[cfg(any(target_os = "windows", test))]
use url::Url;

#[cfg(target_os = "macos")]
const MACOS_DOWNLOAD_URL: &str = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PREFERRED_DIRECT_DOWNLOAD_URL: &str = "https://codexapp.agentsmirror.com/latest/mac-arm64";
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const PREFERRED_DIRECT_DOWNLOAD_URL: &str = "https://codexapp.agentsmirror.com/latest/mac-intel";
#[cfg(any(target_os = "windows", test))]
const TRUSTED_WINDOWS_DOWNLOAD_HOSTS: &[&str] = &[
    "codexapp.agentsmirror.com",
    "codexapp-r2.agentsmirror.com",
    "cdn.autogateway.cc",
    "ag.guangla.com",
];
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const WINDOWS_MSIX_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
#[cfg(target_os = "windows")]
const WINDOWS_QUIT_GRACE_PERIOD: Duration = Duration::from_secs(8);
#[cfg(target_os = "windows")]
const WINDOWS_QUIT_FORCE_PERIOD: Duration = Duration::from_secs(12);
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_SOURCE_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_SOURCE_PROBE_BYTES: usize = 512 * 1024;
const CODEX_VERSION_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const DOWNLOAD_SOURCE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const CODEX_INSTALLER_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
#[cfg(target_os = "macos")]
const MACOS_ATTACH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(target_os = "macos")]
const MACOS_COPY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
#[cfg(target_os = "macos")]
const MACOS_SIGNATURE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
#[cfg(target_os = "macos")]
const MACOS_DETACH_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(target_os = "macos")]
const MACOS_QUIT_GRACE_PERIOD: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const MACOS_QUIT_FORCE_PERIOD: Duration = Duration::from_secs(10);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const CODEX_UPDATE_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

#[cfg(any(target_os = "macos", target_os = "windows"))]
static CODEX_UPDATE_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppStatus {
    pub installed: bool,
    pub cached_installer_available: bool,
    pub path: Option<String>,
    pub local_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: Option<bool>,
    pub update_check_error: Option<String>,
    pub platform_message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInstallResult {
    pub installed: bool,
    pub path: Option<String>,
    pub message: String,
    pub awaiting_installation: bool,
    pub can_retry_cached_installer: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUpdateDownloadResult {
    pub downloaded: bool,
    pub version: String,
    pub message: String,
    pub target_path: Option<String>,
    pub target_version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexInstallProgress {
    stage: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
    source: Option<String>,
    speed_bytes_per_second: Option<u64>,
    estimated_remaining_seconds: Option<u64>,
}

struct DownloadProbe {
    index: usize,
    url: String,
    elapsed: Duration,
}

struct LocalInstallation {
    path: PathBuf,
    version: Option<String>,
}

enum InstallerResult {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Complete,
}

#[derive(Deserialize)]
struct CodexVersionSnapshot {
    #[cfg(target_os = "macos")]
    macos: PlatformVersion,
    #[cfg(target_os = "windows")]
    windows: PlatformVersion,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlatformVersion {
    version: String,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    download_urls: Vec<String>,
    #[cfg(target_os = "macos")]
    #[serde(default)]
    fallback_url: Option<String>,
    #[serde(default)]
    artifacts: HashMap<String, PlatformArtifact>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlatformArtifact {
    #[serde(default)]
    direct_url: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    download_urls: Vec<String>,
    #[cfg(target_os = "macos")]
    #[serde(default)]
    fallback_url: Option<String>,
}

struct CachedCodexRelease {
    fetched_at: Instant,
    release: PlatformVersion,
}

struct CachedDownloadSources {
    measured_at: Instant,
    key: String,
    ranked_urls: Vec<String>,
}

struct CachedInstaller {
    path: PathBuf,
    version: String,
}

static CODEX_RELEASE_CACHE: OnceLock<tokio::sync::Mutex<Option<CachedCodexRelease>>> =
    OnceLock::new();
static DOWNLOAD_SOURCE_CACHE: OnceLock<tokio::sync::Mutex<Option<CachedDownloadSources>>> =
    OnceLock::new();

pub fn local_status() -> CodexAppStatus {
    let Some(installation) = update_target_installation() else {
        return CodexAppStatus {
            installed: false,
            cached_installer_available: completed_installer_available(),
            path: None,
            local_version: None,
            latest_version: None,
            update_available: None,
            update_check_error: None,
            platform_message: missing_message(),
        };
    };

    CodexAppStatus {
        installed: true,
        cached_installer_available: completed_installer_available(),
        path: Some(installation.path.display().to_string()),
        local_version: installation.version,
        latest_version: None,
        update_available: None,
        update_check_error: None,
        platform_message:
            "The official ChatGPT desktop application is installed. It includes Codex.".to_string(),
    }
}

pub async fn status() -> CodexAppStatus {
    let mut local = tauri::async_runtime::spawn_blocking(local_status)
        .await
        .unwrap_or_else(|_| local_status());
    if !local.installed {
        return local;
    }

    let latest_result = latest_release().await;
    let (latest_version, update_available, update_check_error) = match latest_result {
        Ok(latest) => {
            let available = local
                .local_version
                .as_deref()
                .map(|local| compare_versions(&latest.version, local) == Ordering::Greater);
            (Some(latest.version), available, None)
        }
        Err(error) => (None, None, Some(error)),
    };

    local.latest_version = latest_version;
    local.update_available = update_available;
    local.update_check_error = update_check_error;
    local
}

pub async fn install(
    app: &AppHandle,
    force_update: bool,
    force_redownload: bool,
) -> Result<CodexInstallResult, String> {
    let existing_installation = update_target_installation();
    if let Some(installation) = existing_installation.as_ref().filter(|_| !force_update) {
        return Ok(CodexInstallResult {
            installed: true,
            path: Some(installation.path.display().to_string()),
            message: "The official ChatGPT desktop application is already installed.".to_string(),
            awaiting_installation: false,
            can_retry_cached_installer: false,
        });
    }

    // The version service provides the preferred upstream mirror, CDN, and
    // configured acceleration sources.
    let latest_release = latest_release().await.ok();
    let download_urls = match download_urls(latest_release.as_ref()) {
        Ok(urls) => urls,
        Err(error) => {
            #[cfg(target_os = "windows")]
            return Err(with_codex_update_log_location(error));
            #[cfg(not(target_os = "windows"))]
            return Err(error);
        }
    };
    let extension = download_extension(&download_urls);
    let download_path = resumable_download_path(
        latest_release
            .as_ref()
            .map(|release| release.version.as_str()),
        extension,
    );
    if force_redownload && download_path.is_file() {
        let _ = fs::remove_file(&download_path);
        let _ = fs::remove_file(completed_download_marker(&download_path));
    }
    let preferred_destination = existing_installation
        .as_ref()
        .map(|installation| installation.path.clone());
    emit_install_progress(app, "preparing", 0, None);
    let mut installer_result = None;
    if download_path.is_file() {
        let cached_download_complete = completed_download_marker(&download_path).is_file();
        match install_downloaded_path(app, &download_path, preferred_destination.as_deref()).await {
            Ok(result) => installer_result = Some(result),
            Err(error) => {
                if !cached_download_complete {
                    let _ = fs::remove_file(completed_download_marker(&download_path));
                } else {
                    #[cfg(target_os = "windows")]
                    return Err(with_codex_update_log_location(format!(
                        "reinstall the completed ChatGPT installer: {error}"
                    )));
                    #[cfg(not(target_os = "windows"))]
                    return Err(error);
                }
            }
        }
    }

    if installer_result.is_none() {
        if let Err(error) = download_installer(app, &download_urls, &download_path).await {
            #[cfg(target_os = "windows")]
            return Err(with_codex_update_log_location(error));
            #[cfg(not(target_os = "windows"))]
            return Err(error);
        }
        match install_downloaded_path(app, &download_path, preferred_destination.as_deref()).await {
            Ok(result) => installer_result = Some(result),
            Err(error) => {
                #[cfg(target_os = "windows")]
                return Err(with_codex_update_log_location(error));
                #[cfg(not(target_os = "windows"))]
                return Err(error);
            }
        }
    }

    let installer_result = installer_result.expect("installer result should be available");
    let _ = installer_result;

    emit_install_progress(app, "verifying", 0, None);
    let status = status().await;
    if !status.installed {
        let error =
            "the official ChatGPT installer finished, but the application could not be found";
        #[cfg(target_os = "windows")]
        return Err(with_codex_update_log_location(error.to_string()));
        #[cfg(not(target_os = "windows"))]
        return Err(format!(
            "{error}. Open the installer once, then return here and check again."
        ));
    }
    let _ = fs::remove_file(completed_download_marker(&download_path));
    if force_update {
        let expected_version = status.latest_version.as_deref();
        let installed_version = status.local_version.as_deref();
        if let (Some(expected), Some(installed)) = (expected_version, installed_version) {
            if compare_versions(installed, expected) == Ordering::Less {
                return Err(format!("the update finished, but version {installed} is still installed; expected {expected}"));
            }
        }
        open_installed_app_at(
            existing_installation
                .as_ref()
                .map(|installation| installation.path.as_path()),
        )?;
    }
    emit_install_progress(app, "complete", 0, None);
    Ok(CodexInstallResult {
        installed: true,
        path: status.path,
        message: if force_update {
            "ChatGPT and Codex were updated successfully.".to_string()
        } else {
            "ChatGPT and Codex are installed and ready for the next step.".to_string()
        },
        awaiting_installation: false,
        can_retry_cached_installer: false,
    })
}

/// Download an update without touching a running Codex process. The frontend
/// can therefore show real download progress and ask for shutdown approval
/// only after the installer is ready.
pub async fn download_update(
    app: &AppHandle,
    force_redownload: bool,
) -> Result<CodexUpdateDownloadResult, String> {
    let target_installation = update_target_installation();
    let target_path = target_installation
        .as_ref()
        .map(|installation| installation.path.display().to_string());
    let target_version = target_installation
        .as_ref()
        .and_then(|installation| installation.version.clone());
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    log_codex_update(
        "info",
        "download_requested",
        format!(
            "forceRedownload={force_redownload}; targetPath={}; targetVersion={}",
            target_path.as_deref().unwrap_or("unknown"),
            target_version.as_deref().unwrap_or("unknown"),
        ),
    );
    let latest_release = latest_release().await.ok();
    let extension = download_extension(&[]);
    let latest_version = latest_release
        .as_ref()
        .map(|release| release.version.as_str());
    if !force_redownload {
        if let Some(cached) =
            latest_version.and_then(|version| cached_installer_for_version(version, extension))
        {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            log_codex_update(
                "info",
                "cached_installer_selected",
                format!("version={}; path={}", cached.version, cached.path.display()),
            );
            emit_cached_download_progress(app, &cached);
            return Ok(CodexUpdateDownloadResult {
                downloaded: true,
                version: cached.version,
                message: "The cached Codex installer is ready to install.".to_string(),
                target_path: target_path.clone(),
                target_version: target_version.clone(),
            });
        }
        if latest_version.is_none() {
            if let Some(cached) = newest_cached_installer(extension) {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                log_codex_update(
                    "warning",
                    "offline_cached_installer_selected",
                    format!("version={}; path={}", cached.version, cached.path.display()),
                );
                emit_cached_download_progress(app, &cached);
                return Ok(CodexUpdateDownloadResult {
                    downloaded: true,
                    version: cached.version,
                    message: "The cached Codex installer is ready to install.".to_string(),
                    target_path: target_path.clone(),
                    target_version: target_version.clone(),
                });
            }
        }
    }

    let download_urls = download_urls(latest_release.as_ref())?;
    let download_path = resumable_download_path(latest_version, extension);
    if force_redownload {
        let _ = fs::remove_file(&download_path);
        let _ = fs::remove_file(completed_download_marker(&download_path));
    }

    emit_install_progress(app, "preparing", 0, None);
    download_installer(app, &download_urls, &download_path)
        .await
        .map_err(with_codex_update_log_location)?;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    log_codex_update(
        "info",
        "download_completed",
        format!(
            "path={}; version={}",
            download_path.display(),
            latest_version.unwrap_or("latest")
        ),
    );

    Ok(CodexUpdateDownloadResult {
        downloaded: true,
        version: latest_release
            .map(|release| release.version)
            .unwrap_or_else(|| "latest".to_string()),
        message: "The verified Codex installer is ready to install.".to_string(),
        target_path,
        target_version,
    })
}

fn emit_cached_download_progress(app: &AppHandle, cached: &CachedInstaller) {
    let downloaded_bytes = fs::metadata(&cached.path)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    emit_download_progress(
        app,
        "downloading",
        downloaded_bytes,
        Some(downloaded_bytes),
        "cached installer",
        None,
        None,
    );
}

/// Install a previously downloaded update, then launch the refreshed app.
pub async fn apply_update(
    app: &AppHandle,
    downloaded_version: String,
    target_path: Option<String>,
) -> Result<CodexInstallResult, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    log_codex_update(
        "info",
        "apply_requested",
        format!(
            "downloadedVersion={downloaded_version}; targetPath={}",
            target_path.as_deref().unwrap_or("automatic"),
        ),
    );
    let download_path =
        resumable_download_path(Some(downloaded_version.as_str()), download_extension(&[]));
    if !download_path.is_file() || !completed_download_marker(&download_path).is_file() {
        return Err(
            "the Codex installer is no longer available; download the update again".to_string(),
        );
    }

    let preferred_destination = target_path
        .map(PathBuf::from)
        .or_else(|| update_target_installation().map(|installation| installation.path));
    if let Err(error) =
        install_downloaded_path(app, &download_path, preferred_destination.as_deref()).await
    {
        #[cfg(target_os = "windows")]
        log_codex_update("error", "direct_msix_update_failed", &error);
        #[cfg(target_os = "windows")]
        return Err(with_codex_update_log_location(error));
        #[cfg(not(target_os = "windows"))]
        return Err(with_codex_update_log_location(error));
    }
    emit_install_progress(app, "verifying", 0, None);
    let status = status().await;
    if !status.installed {
        return Err(
            "the Codex installer finished, but the application could not be found".to_string(),
        );
    }
    let installed_version = preferred_destination
        .as_deref()
        .and_then(installed_version_at_path)
        .or_else(|| status.local_version.clone());
    if let (Some(expected), Some(installed)) = (
        (downloaded_version != "latest").then_some(downloaded_version.as_str()),
        installed_version.as_deref(),
    ) {
        if compare_versions(installed, expected) == Ordering::Less {
            return Err(format!(
                "the update finished, but version {installed} is still installed; expected {expected}"
            ));
        }
    }
    let _ = fs::remove_file(completed_download_marker(&download_path));
    emit_install_progress(app, "opening", 0, None);
    open_installed_app_at(preferred_destination.as_deref())?;
    emit_install_progress(app, "complete", 0, None);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    log_codex_update(
        "info",
        "update_completed",
        format!(
            "installedVersion={}; targetPath={}",
            installed_version.as_deref().unwrap_or("unknown"),
            preferred_destination
                .as_deref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "automatic".to_string()),
        ),
    );
    Ok(CodexInstallResult {
        installed: true,
        path: preferred_destination
            .as_ref()
            .map(|path| path.display().to_string())
            .or(status.path),
        message: "ChatGPT and Codex were updated successfully.".to_string(),
        awaiting_installation: false,
        can_retry_cached_installer: false,
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn install_downloaded_path(
    app: &AppHandle,
    download_path: &Path,
    preferred_destination: Option<&Path>,
) -> Result<InstallerResult, String> {
    emit_install_progress(app, "installing", 0, None);
    #[cfg(target_os = "windows")]
    emit_install_progress(app, "windows-installing", 0, None);
    let installer_path = download_path.to_path_buf();
    let preferred_destination = preferred_destination.map(Path::to_path_buf);
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_downloaded_app(
            &app_handle,
            &installer_path,
            preferred_destination.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("wait for the official ChatGPT installer: {error}"))?
}

async fn download_installer(
    app: &AppHandle,
    download_urls: &[String],
    download_path: &Path,
) -> Result<(), String> {
    let mut errors = Vec::new();
    emit_install_progress(app, "selecting-source", 0, None);
    let ranked_urls = rank_download_sources(download_urls).await;
    for download_url in &ranked_urls {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        log_codex_update(
            "info",
            "download_source_started",
            format!("source={}", download_source_label(download_url)),
        );
        match download_installer_from_url(app, download_url, download_path).await {
            Ok(()) => {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                log_codex_update(
                    "info",
                    "download_source_completed",
                    format!("source={}", download_source_label(download_url)),
                );
                return Ok(());
            }
            Err(error) => {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                log_codex_update(
                    "error",
                    "download_source_failed",
                    format!(
                        "source={}; error={error}",
                        download_source_label(download_url)
                    ),
                );
                errors.push(format!("{download_url}: {error}"));
            }
        }
    }
    Err(format!(
        "download the ChatGPT installer from the mirror, CDN, and acceleration sources: {}",
        errors.join("; ")
    ))
}

async fn download_installer_from_url(
    app: &AppHandle,
    download_url: &str,
    download_path: &Path,
) -> Result<(), String> {
    let source = download_source_label(download_url);
    let _ = fs::remove_file(completed_download_marker(download_path));
    let existing_bytes = fs::metadata(download_path)
        .map(|metadata| metadata.len())
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(0)
            } else {
                Err(error)
            }
        })
        .map_err(|error| format!("inspect the partial ChatGPT installer: {error}"))?;
    let client = client_with_timeouts_and_read_timeout(
        None,
        Some(DOWNLOAD_CONNECT_TIMEOUT),
        Some(DOWNLOAD_READ_TIMEOUT),
    )
    .map_err(|error| format!("prepare the ChatGPT download: {error}"))?;
    let mut request = client.get(download_url);
    if existing_bytes > 0 {
        request = request.header("Range", format!("bytes={existing_bytes}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("download the ChatGPT installer: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download the ChatGPT installer: {error}"))?;
    #[cfg(target_os = "windows")]
    if !is_trusted_windows_download_url(response.url().as_str()) {
        return Err("the ChatGPT installer redirected to an untrusted download source".to_string());
    }
    let append = existing_bytes > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let starting_bytes = append.then_some(existing_bytes).unwrap_or(0);
    let total_bytes = response
        .content_length()
        .map(|content_length| content_length.saturating_add(starting_bytes));
    let mut stream = response.bytes_stream();
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(download_path)
        .map_err(|error| format!("create the ChatGPT installer file: {error}"))?;
    let mut downloaded_bytes = starting_bytes;
    let mut last_reported_percent = None;
    let mut last_reported_bytes = 0_u64;
    let started = Instant::now();
    emit_download_progress(app, "downloading", 0, total_bytes, &source, None, None);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("read the ChatGPT installer: {error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("save the ChatGPT installer: {error}"))?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        let percent = total_bytes
            .filter(|total| *total > 0)
            .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8);
        if percent != last_reported_percent
            || downloaded_bytes.saturating_sub(last_reported_bytes) >= 4 * 1024 * 1024
        {
            let elapsed_seconds = started.elapsed().as_secs_f64();
            let transferred_bytes = downloaded_bytes.saturating_sub(starting_bytes);
            let speed_bytes_per_second = (elapsed_seconds > 0.1)
                .then(|| (transferred_bytes as f64 / elapsed_seconds) as u64)
                .filter(|speed| *speed > 0);
            let estimated_remaining_seconds = speed_bytes_per_second.and_then(|speed| {
                total_bytes.map(|total| total.saturating_sub(downloaded_bytes).div_ceil(speed))
            });
            emit_download_progress(
                app,
                "downloading",
                downloaded_bytes,
                total_bytes,
                &source,
                speed_bytes_per_second,
                estimated_remaining_seconds,
            );
            last_reported_percent = percent;
            last_reported_bytes = downloaded_bytes;
        }
    }
    file.sync_all()
        .map_err(|error| format!("finish saving the ChatGPT installer: {error}"))?;
    fs::write(completed_download_marker(download_path), b"complete")
        .map_err(|error| format!("mark the ChatGPT installer as complete: {error}"))?;
    Ok(())
}

fn resumable_download_path(version: Option<&str>, extension: &str) -> PathBuf {
    let normalized_version = version
        .unwrap_or("latest")
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '.' || *character == '-'
        })
        .collect::<String>();
    let version = if normalized_version.is_empty() {
        "latest"
    } else {
        normalized_version.as_str()
    };
    env::temp_dir().join(format!(
        "autogateway-chatgpt-{}-{}-{version}.{extension}",
        std::env::consts::OS,
        native_architecture(),
    ))
}

fn completed_download_marker(download_path: &Path) -> PathBuf {
    let mut marker = download_path.as_os_str().to_os_string();
    marker.push(".complete");
    PathBuf::from(marker)
}

fn cached_installer_from_path(path: PathBuf, version: String) -> Option<CachedInstaller> {
    let marker = completed_download_marker(&path);
    let marker_age = marker.metadata().ok()?.modified().ok()?.elapsed().ok()?;
    if path.is_file() && marker.is_file() && marker_age <= CODEX_INSTALLER_CACHE_TTL {
        return Some(CachedInstaller { path, version });
    }

    if marker.exists() || path.exists() {
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_file(&path);
    }
    None
}

fn cached_installer_for_version(version: &str, extension: &str) -> Option<CachedInstaller> {
    cached_installer_from_path(
        resumable_download_path(Some(version), extension),
        version.to_string(),
    )
}

fn newest_cached_installer(extension: &str) -> Option<CachedInstaller> {
    let prefix = format!(
        "autogateway-chatgpt-{}-{}-",
        std::env::consts::OS,
        native_architecture()
    );
    let suffix = format!(".{extension}.complete");
    let entries = fs::read_dir(env::temp_dir()).ok()?;
    let mut candidates = entries
        .flatten()
        .filter_map(|entry| {
            let marker = entry.path();
            let name = marker.file_name()?.to_str()?;
            let version = name.strip_prefix(&prefix)?.strip_suffix(&suffix)?;
            let installer = marker.with_file_name(name.trim_end_matches(".complete"));
            cached_installer_from_path(installer, version.to_string())
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| compare_versions(&left.version, &right.version));
    candidates.pop()
}

fn completed_installer_available() -> bool {
    newest_cached_installer(download_extension(&[])).is_some()
}

async fn rank_download_sources(download_urls: &[String]) -> Vec<String> {
    let cache = DOWNLOAD_SOURCE_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    let mut cache = cache;
    let cache_key = download_urls.join("\n");
    if let Some(cached) = cache.as_ref().filter(|cached| {
        cached.key == cache_key && cached.measured_at.elapsed() < DOWNLOAD_SOURCE_CACHE_TTL
    }) {
        return cached.ranked_urls.clone();
    }

    let probe_count = download_urls.len().max(1);
    let mut responsive = stream::iter(
        download_urls
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, url)| async move { probe_download_source(index, url).await.ok() }),
    )
    .buffer_unordered(probe_count)
    .filter_map(|result| async move { result })
    .collect::<Vec<_>>()
    .await;
    responsive.sort_by_key(|probe| (probe.elapsed, probe.index));

    let mut ranked = responsive
        .iter()
        .map(|probe| probe.url.clone())
        .collect::<Vec<_>>();
    for download_url in download_urls {
        if !ranked.iter().any(|url| url == download_url) {
            ranked.push(download_url.clone());
        }
    }
    *cache = Some(CachedDownloadSources {
        measured_at: Instant::now(),
        key: cache_key,
        ranked_urls: ranked.clone(),
    });
    ranked
}

async fn probe_download_source(index: usize, url: String) -> Result<DownloadProbe, String> {
    let client = client_with_timeouts(
        Some(DOWNLOAD_SOURCE_PROBE_TIMEOUT),
        Some(DOWNLOAD_CONNECT_TIMEOUT),
    )?;
    let started = Instant::now();
    let response = client
        .get(&url)
        .header(
            "Range",
            format!("bytes=0-{}", DOWNLOAD_SOURCE_PROBE_BYTES - 1),
        )
        .send()
        .await
        .map_err(|error| format!("connect to {url}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("connect to {url}: {error}"))?;
    #[cfg(target_os = "windows")]
    if !is_trusted_windows_download_url(response.url().as_str()) {
        return Err(
            "the ChatGPT installer probe redirected to an untrusted download source".to_string(),
        );
    }
    let mut stream = response.bytes_stream();
    let mut sampled_bytes = 0_usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("read from {url}: {error}"))?;
        sampled_bytes = sampled_bytes.saturating_add(chunk.len());
        if sampled_bytes >= DOWNLOAD_SOURCE_PROBE_BYTES {
            break;
        }
    }
    if sampled_bytes == 0 {
        return Err(format!("read from {url}: the source returned no bytes"));
    }
    Ok(DownloadProbe {
        index,
        url,
        elapsed: started.elapsed(),
    })
}

fn download_source_label(download_url: &str) -> String {
    reqwest::Url::parse(download_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "download source".to_string())
}

fn emit_install_progress(
    app: &AppHandle,
    stage: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    log_codex_update(
        "info",
        "progress_stage",
        format!("stage={stage}; downloadedBytes={downloaded_bytes}; totalBytes={total_bytes:?}"),
    );
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8);
    let _ = app.emit(
        "codex-install-progress",
        CodexInstallProgress {
            stage: stage.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
            source: None,
            speed_bytes_per_second: None,
            estimated_remaining_seconds: None,
        },
    );
}

fn emit_download_progress(
    app: &AppHandle,
    stage: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    source: &str,
    speed_bytes_per_second: Option<u64>,
    estimated_remaining_seconds: Option<u64>,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8);
    let _ = app.emit(
        "codex-install-progress",
        CodexInstallProgress {
            stage: stage.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
            source: Some(source.to_string()),
            speed_bytes_per_second,
            estimated_remaining_seconds,
        },
    );
}

pub fn open_installed_app() -> Result<(), String> {
    open_installed_app_at(None)
}

pub fn open_installed_app_at(target_path: Option<&Path>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = target_path
            .map(Path::to_path_buf)
            .or_else(|| update_target_installation().map(|installation| installation.path))
            .ok_or_else(|| "ChatGPT is not installed yet.".to_string())?;
        log_codex_update(
            "info",
            "opening_application",
            format!("path={}", app.display()),
        );
        Command::new("open")
            .arg(&app)
            .spawn()
            .map_err(|error| format!("open ChatGPT: {error}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        let target = target_path
            .map(Path::to_path_buf)
            .or_else(|| update_target_installation().map(|installation| installation.path))
            .ok_or_else(|| "ChatGPT is not installed yet.".to_string())?;
        let app_user_model_id = windows_app_user_model_id(Some(&target))?;
        let shell_target = format!("shell:AppsFolder\\{app_user_model_id}");
        log_codex_update(
            "info",
            "opening_application",
            format!(
                "appUserModelId={app_user_model_id}; targetPath={}",
                target.display()
            ),
        );
        Command::new("explorer.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .arg(shell_target)
            .spawn()
            .map_err(|error| format!("open ChatGPT from Windows Apps: {error}"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("This desktop build supports macOS and Windows only.".to_string());
    Ok(())
}

pub fn is_installed_app_running() -> Result<bool, String> {
    is_installed_app_running_at(None)
}

fn is_installed_app_running_at(_target_path: Option<&str>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let Some(installation) = update_target_installation() else {
            return Ok(false);
        };
        return Ok(macos_app_is_running(&installation.path));
    }
    #[cfg(target_os = "windows")]
    {
        let inferred_target_path = _target_path
            .is_none()
            .then(|| {
                update_target_installation()
                    .map(|installation| installation.path.display().to_string())
            })
            .flatten();
        let process_target_path = _target_path.or(inferred_target_path.as_deref());
        let script = format!(
            "{}\nif ($processes.Count -eq 0) {{ exit 1 }}; $processes | ForEach-Object {{ Write-Output ($_.Id.ToString() + '|' + $_.ProcessName + '|' + $_.Path) }}; exit 0",
            windows_codex_process_selector(process_target_path),
        );
        let output = Command::new("powershell.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|error| format!("check whether ChatGPT is open: {error}"))?;
        return match output.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(format!(
                "check whether ChatGPT is open: PowerShell exited with {}",
                output.status
            )),
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("This desktop build supports macOS and Windows only.".to_string())
}

pub fn close_installed_app_at(target_path: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_paths = target_path
            .map(PathBuf::from)
            .map(|path| vec![path])
            .unwrap_or_else(|| {
                update_target_installation()
                    .map(|installation| vec![installation.path])
                    .unwrap_or_default()
            });
        log_codex_update(
            "info",
            "closing_application",
            format!(
                "paths={}",
                app_paths
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        );
        let result = close_macos_app_processes(&app_paths);
        match &result {
            Ok(()) => log_codex_update("info", "application_closed", "success"),
            Err(error) => log_codex_update("error", "application_close_failed", error),
        }
        return result;
    }

    #[cfg(target_os = "windows")]
    {
        if !is_installed_app_running_at(target_path.as_deref())? {
            log_codex_update("info", "application_closed", "already stopped");
            return Ok(());
        }
        log_codex_update(
            "info",
            "closing_application",
            format!(
                "targetPath={}",
                target_path.as_deref().unwrap_or("automatic")
            ),
        );
        let script = format!(
            "{}\nforeach ($process in $processes) {{ if ($process.MainWindowHandle -ne 0) {{ $closed = $process.CloseMainWindow(); Write-Output ('close-window|' + $process.Id + '|' + $process.ProcessName + '|' + $closed) }} else {{ Write-Output ('background-process|' + $process.Id + '|' + $process.ProcessName) }} }}",
            windows_codex_process_selector(target_path.as_deref()),
        );
        let output = Command::new("powershell.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|error| format!("request ChatGPT to close: {error}"))?;
        log_codex_update(
            if output.status.success() {
                "info"
            } else {
                "error"
            },
            "application_close_requested",
            format!(
                "status={}; stdout={:?}; stderr={:?}",
                output.status,
                compact_command_output(&output.stdout),
                compact_command_output(&output.stderr),
            ),
        );
        let deadline = Instant::now() + WINDOWS_QUIT_GRACE_PERIOD;
        while Instant::now() < deadline {
            if !is_installed_app_running_at(target_path.as_deref())? {
                log_codex_update("info", "application_closed", "success");
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }

        let force_script = format!(
            "{}\nforeach ($process in $processes) {{ Write-Output ('force-stop|' + $process.Id + '|' + $process.ProcessName + '|' + $process.Path); Stop-Process -Id $process.Id -Force -ErrorAction Continue }}",
            windows_codex_process_selector(target_path.as_deref()),
        );
        let mut force_command = Command::new("powershell.exe");
        force_command.creation_flags(CREATE_NO_WINDOW).args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &force_script,
        ]);
        run_windows_command_with_timeout(
            &mut force_command,
            Duration::from_secs(30),
            "force remaining ChatGPT processes to stop",
        )?;
        log_codex_update(
            "warning",
            "application_force_close_requested",
            format!(
                "targetPath={}",
                target_path.as_deref().unwrap_or("automatic")
            ),
        );

        let deadline = Instant::now() + WINDOWS_QUIT_FORCE_PERIOD;
        while Instant::now() < deadline {
            if !is_installed_app_running_at(target_path.as_deref())? {
                log_codex_update("info", "application_closed", "forced success");
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
        let error = "ChatGPT processes are still running after both graceful and forced shutdown. Close ChatGPT from Task Manager, then try again."
            .to_string();
        log_codex_update("error", "application_close_failed", &error);
        return Err(with_codex_update_log_location(error));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("This desktop build supports macOS and Windows only.".to_string())
}

#[cfg(any(target_os = "windows", test))]
fn windows_codex_process_selector(target_path: Option<&str>) -> String {
    let escaped_target_path = target_path.unwrap_or_default().replace('\'', "''");
    format!(
        r#"$requestedPath = '{escaped_target_path}'
$installRoot = $requestedPath
if ([string]::IsNullOrWhiteSpace($installRoot)) {{
    $package = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {{ $_.Name -match '^(?i:OpenAI\.)?(ChatGPT|Codex)$' }} | Select-Object -First 1
    if ($null -ne $package) {{ $installRoot = $package.InstallLocation }}
}}
if (-not [string]::IsNullOrWhiteSpace($installRoot) -and [System.IO.Path]::GetExtension($installRoot) -eq '.exe') {{
    $installRoot = Split-Path -Parent $installRoot
}}
$rootPrefix = if ([string]::IsNullOrWhiteSpace($installRoot)) {{ '' }} else {{ $installRoot.TrimEnd('\') + '\' }}
$processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {{
    $processPath = try {{ $_.Path }} catch {{ $null }}
    if (-not [string]::IsNullOrWhiteSpace($rootPrefix)) {{
        -not [string]::IsNullOrWhiteSpace($processPath) -and ($processPath.Equals($installRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $processPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase))
    }} else {{
        $false
    }}
}})"#
    )
}

#[cfg(target_os = "windows")]
fn windows_app_user_model_id(target_path: Option<&Path>) -> Result<String, String> {
    let script = windows_app_user_model_id_script(target_path);
    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| format!("query the installed ChatGPT package: {error}"))?;
    if !output.status.success() {
        return Err(with_codex_update_log_location(
            "ChatGPT is not installed yet, or Windows could not find the packaged app at the managed installation path."
                .to_string(),
        ));
    }
    let app_user_model_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if app_user_model_id.is_empty() {
        return Err("Windows returned an empty ChatGPT app identity. Open ChatGPT once from the Start menu, then try again.".to_string());
    }
    Ok(app_user_model_id)
}

#[cfg(any(target_os = "windows", test))]
fn windows_app_user_model_id_script(target_path: Option<&Path>) -> String {
    let escaped_target_path = target_path
        .map(|path| path.display().to_string().replace('\'', "''"))
        .unwrap_or_default();
    format!(
        r#"$requestedPath = '{escaped_target_path}'
$package = Get-AppxPackage -ErrorAction SilentlyContinue |
    Where-Object {{
        $_.Name -match '^(?i:OpenAI\.)?(ChatGPT|Codex)$' -and
        ([string]::IsNullOrWhiteSpace($requestedPath) -or
            $_.InstallLocation.TrimEnd('\') -eq $requestedPath.TrimEnd('\'))
    }} |
    Sort-Object Version -Descending |
    Select-Object -First 1
if ($null -eq $package) {{ exit 1 }}
$manifest = Get-AppxPackageManifest -Package $package
$application = $manifest.Package.Applications.Application | Select-Object -First 1
if ($null -eq $application) {{ exit 1 }}
Write-Output ($package.PackageFamilyName + '!' + $application.Id)"#
    )
}

async fn latest_release() -> Result<PlatformVersion, String> {
    let cache = CODEX_RELEASE_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    let mut cache = cache;
    if let Some(cached) = cache
        .as_ref()
        .filter(|cached| cached.fetched_at.elapsed() < CODEX_VERSION_CACHE_TTL)
    {
        return Ok(cached.release.clone());
    }

    let client = desktop_http_client(Some(Duration::from_secs(10)))
        .map_err(|error| format!("prepare the Codex update check: {error}"))?;

    let snapshot = client
        .get(format!(
            "{AUTO_GATEWAY_API_BASE_URL}/public/api/desktop/codex-version"
        ))
        .send()
        .await
        .map_err(|error| format!("request the AUTO Gateway Codex version service: {error}"))?
        .error_for_status()
        .map_err(|error| format!("request the AUTO Gateway Codex version service: {error}"))?
        .json::<CodexVersionSnapshot>()
        .await
        .map_err(|error| format!("read the AUTO Gateway Codex version response: {error}"))?;

    #[cfg(target_os = "macos")]
    let release = snapshot.macos;

    #[cfg(target_os = "windows")]
    let release = snapshot.windows;

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Codex update checks are available on macOS and Windows only.".to_string());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        *cache = Some(CachedCodexRelease {
            fetched_at: Instant::now(),
            release: release.clone(),
        });
        Ok(release)
    }
}

#[cfg(target_os = "macos")]
fn download_urls(latest: Option<&PlatformVersion>) -> Result<Vec<String>, String> {
    let mut urls = Vec::with_capacity(5);
    append_url(&mut urls, Some(PREFERRED_DIRECT_DOWNLOAD_URL));
    if let Some(latest) = latest {
        append_artifact_urls(&mut urls, latest, native_architecture());
        append_url(&mut urls, latest.download_url.as_deref());
        for candidate in &latest.download_urls {
            append_url(&mut urls, Some(candidate));
        }
        append_url(&mut urls, latest.fallback_url.as_deref());
    }
    let fallback = download_url()?.to_string();
    if !urls.iter().any(|url| url == &fallback) {
        urls.push(fallback);
    }
    Ok(urls)
}

#[cfg(target_os = "windows")]
fn download_urls(latest: Option<&PlatformVersion>) -> Result<Vec<String>, String> {
    windows_download_urls(latest)
}

#[cfg(any(target_os = "windows", test))]
fn windows_download_urls(latest: Option<&PlatformVersion>) -> Result<Vec<String>, String> {
    let mut urls = Vec::with_capacity(8);
    if let Some(latest) = latest {
        append_trusted_windows_artifact_urls(&mut urls, latest, native_architecture());
        append_trusted_windows_download_url(&mut urls, latest.download_url.as_deref());
        append_trusted_windows_download_urls(&mut urls, &latest.download_urls);
    }
    if urls.is_empty() {
        return Err("trusted ChatGPT MSIX mirror and CDN sources are unavailable".to_string());
    }
    Ok(urls)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn download_urls(_latest: Option<&PlatformVersion>) -> Result<Vec<String>, String> {
    Err("This desktop build supports macOS and Windows only.".to_string())
}

#[cfg(target_os = "macos")]
fn append_artifact_urls(urls: &mut Vec<String>, release: &PlatformVersion, architecture: &str) {
    let Some(artifact) = release.artifacts.get(architecture) else {
        return;
    };
    append_url(urls, artifact.direct_url.as_deref());
    append_url(urls, artifact.download_url.as_deref());
    for candidate in &artifact.download_urls {
        append_url(urls, Some(candidate));
    }
    append_url(urls, artifact.fallback_url.as_deref());
}

#[cfg(target_os = "macos")]
fn append_url(urls: &mut Vec<String>, candidate: Option<&str>) {
    let Some(candidate) = candidate.map(str::trim).filter(|url| !url.is_empty()) else {
        return;
    };
    if !urls.iter().any(|url| url == candidate) {
        urls.push(candidate.to_string());
    }
}

#[cfg(any(target_os = "windows", test))]
fn append_trusted_windows_artifact_urls(
    urls: &mut Vec<String>,
    release: &PlatformVersion,
    architecture: &str,
) {
    let Some(artifact) = release.artifacts.get(architecture) else {
        return;
    };
    append_trusted_windows_download_url(urls, artifact.direct_url.as_deref());
    append_trusted_windows_download_url(urls, artifact.download_url.as_deref());
    append_trusted_windows_download_urls(urls, &artifact.download_urls);
}

#[cfg(any(target_os = "windows", test))]
fn append_trusted_windows_download_urls(urls: &mut Vec<String>, candidates: &[String]) {
    for candidate in candidates {
        append_trusted_windows_download_url(urls, Some(candidate));
    }
}

#[cfg(any(target_os = "windows", test))]
fn append_trusted_windows_download_url(urls: &mut Vec<String>, candidate: Option<&str>) {
    let Some(candidate) = candidate.map(str::trim).filter(|url| !url.is_empty()) else {
        return;
    };
    if is_trusted_windows_download_url(candidate) && !urls.iter().any(|url| url == candidate) {
        urls.push(candidate.to_string());
    }
}

#[cfg(any(target_os = "windows", test))]
fn is_trusted_windows_download_url(candidate: &str) -> bool {
    let Ok(url) = Url::parse(candidate) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    let path = url.path();
    let normalized_path = path.to_ascii_lowercase();
    if host == "ag.guangla.com" {
        return url.scheme() == "http"
            && url.port_or_known_default() == Some(80)
            && (normalized_path.starts_with("/desktop-codex/windows-x64/")
                || normalized_path.starts_with("/desktop-codex/windows-arm64/"))
            && normalized_path.ends_with(".msix");
    }
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !TRUSTED_WINDOWS_DOWNLOAD_HOSTS.contains(&host)
    {
        return false;
    }

    if matches!(
        host,
        "codexapp.agentsmirror.com" | "codexapp-r2.agentsmirror.com"
    ) {
        return normalized_path == format!("/latest/win-{}", native_architecture())
            || normalized_path.ends_with(".msix");
    }
    if host == "cdn.autogateway.cc" {
        return normalized_path.ends_with(".msix");
    }
    false
}

#[cfg(target_arch = "aarch64")]
fn native_architecture() -> &'static str {
    "arm64"
}

#[cfg(not(target_arch = "aarch64"))]
fn native_architecture() -> &'static str {
    "x64"
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = numeric_version_parts(left);
    let right_parts = numeric_version_parts(right);
    let count = left_parts.len().max(right_parts.len());
    for index in 0..count {
        let ordering = left_parts
            .get(index)
            .unwrap_or(&0)
            .cmp(right_parts.get(index).unwrap_or(&0));
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

fn numeric_version_parts(version: &str) -> Vec<u64> {
    version
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

#[cfg(target_os = "macos")]
fn local_installation() -> Option<LocalInstallation> {
    installation_candidates()
        .into_iter()
        .filter(|path| path.exists())
        .map(read_macos_installation)
        .max_by(|left, right| match (&left.version, &right.version) {
            (Some(left), Some(right)) => compare_versions(left, right),
            (Some(_), None) => Ordering::Greater,
            (None, Some(_)) => Ordering::Less,
            (None, None) => Ordering::Equal,
        })
}

#[cfg(target_os = "macos")]
fn read_macos_installation(path: PathBuf) -> LocalInstallation {
    let plist = path.join("Contents/Info.plist");
    let version = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleShortVersionString"])
        .arg(plist)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());
    LocalInstallation { path, version }
}

#[cfg(target_os = "macos")]
fn installed_version_at_path(path: &Path) -> Option<String> {
    path.exists()
        .then(|| read_macos_installation(path.to_path_buf()).version)
        .flatten()
}

#[cfg(not(target_os = "macos"))]
fn installed_version_at_path(_path: &Path) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn update_target_installation() -> Option<LocalInstallation> {
    local_installation()
}

#[cfg(not(target_os = "macos"))]
fn update_target_installation() -> Option<LocalInstallation> {
    local_installation()
}

#[cfg(target_os = "windows")]
fn local_installation() -> Option<LocalInstallation> {
    let script = "$package = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(?i:OpenAI\\.)?(ChatGPT|Codex)$' } | Sort-Object Version -Descending | Select-Object -First 1; if ($null -ne $package) { Write-Output $package.Version.ToString(); Write-Output $package.InstallLocation }";
    if let Ok(output) = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
    {
        if output.status.success() {
            let output_text = String::from_utf8_lossy(&output.stdout);
            let mut lines = output_text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string);
            if let (Some(version), Some(path)) = (lines.next(), lines.next()) {
                return Some(LocalInstallation {
                    path: PathBuf::from(path),
                    version: Some(version),
                });
            }
        }
    }

    let path = installation_candidates()
        .into_iter()
        .find(|path| path.exists())?;
    let escaped_path = path.display().to_string().replace('\'', "''");
    let version_script =
        format!("(Get-Item -LiteralPath '{escaped_path}').VersionInfo.ProductVersion");
    let version = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", &version_script])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());
    Some(LocalInstallation { path, version })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn local_installation() -> Option<LocalInstallation> {
    None
}

#[cfg(target_os = "macos")]
fn download_url() -> Result<&'static str, String> {
    Ok(MACOS_DOWNLOAD_URL)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn download_url() -> Result<&'static str, String> {
    Err("This desktop build supports macOS and Windows only.".to_string())
}

#[cfg(target_os = "macos")]
fn download_extension(_download_urls: &[String]) -> &'static str {
    "dmg"
}

#[cfg(target_os = "windows")]
fn download_extension(_download_urls: &[String]) -> &'static str {
    "msix"
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn download_extension(_download_urls: &[String]) -> &'static str {
    "installer"
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn codex_update_log_path() -> Option<PathBuf> {
    #[cfg(test)]
    return None;
    #[cfg(all(not(test), target_os = "macos"))]
    return dirs::home_dir()
        .map(|home| home.join("Library/Logs/AUTO Gateway Desktop/logs/codex-update.jsonl"));
    #[cfg(all(not(test), target_os = "windows"))]
    return dirs::data_local_dir()
        .map(|base| base.join("AUTO Gateway Desktop/logs/codex-update.jsonl"));
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn rotate_codex_update_log_if_needed(path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() < CODEX_UPDATE_LOG_MAX_BYTES {
        return;
    }
    let backup = path.with_extension("jsonl.1");
    let _ = fs::remove_file(&backup);
    let _ = fs::rename(path, backup);
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn log_codex_update(level: &str, event: &str, message: impl AsRef<str>) {
    let message = message.as_ref();
    eprintln!("Codex update [{level}] {event}: {message}");
    let Some(path) = codex_update_log_path() else {
        return;
    };
    let lock = CODEX_UPDATE_LOG_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    rotate_codex_update_log_if_needed(&path);
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let record = serde_json::json!({
        "timestampUnixMs": timestamp_ms,
        "level": level,
        "event": event,
        "message": message,
        "processId": std::process::id(),
        "desktopVersion": env!("CARGO_PKG_VERSION"),
    });
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{record}");
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn with_codex_update_log_location(error: String) -> String {
    log_codex_update("error", "update_failed", &error);
    match codex_update_log_path() {
        Some(path) => format!("{error}. Update log: {}", path.display()),
        None => error,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn with_codex_update_log_location(error: String) -> String {
    error
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn compact_command_output(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 4_000;
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    if text.chars().count() <= MAX_CHARS {
        return text;
    }
    let tail = text
        .chars()
        .rev()
        .take(MAX_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("...{tail}")
}

#[cfg(target_os = "macos")]
fn run_macos_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<Output, String> {
    let command_summary = format!("{command:?}");
    log_codex_update(
        "info",
        "command_started",
        format!(
            "{description}; command={command_summary}; timeout={}s",
            timeout.as_secs()
        ),
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        let message = format!("start {description}: {error}");
        log_codex_update("error", "command_start_failed", &message);
        message
    })?;
    let deadline = Instant::now() + timeout;
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("wait for {description}: {error}"))?
        {
            Some(_) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| format!("read {description} output: {error}"))?;
                log_codex_update(
                    if output.status.success() {
                        "info"
                    } else {
                        "error"
                    },
                    "command_finished",
                    format!(
                        "{description}; status={}; stdout={:?}; stderr={:?}",
                        output.status,
                        compact_command_output(&output.stdout),
                        compact_command_output(&output.stderr),
                    ),
                );
                return Ok(output);
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let message = format!(
                    "{description} timed out after {} seconds",
                    timeout.as_secs()
                );
                log_codex_update("error", "command_timed_out", &message);
                return Err(message);
            }
            None => thread::sleep(Duration::from_millis(250)),
        }
    }
}

#[cfg(target_os = "macos")]
fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

#[cfg(target_os = "macos")]
fn mounted_volume_for_image(image_path: &Path) -> Option<PathBuf> {
    let output = Command::new("hdiutil").arg("info").output().ok()?;
    if !output.status.success() {
        return None;
    }
    mounted_volume_from_hdiutil_info(&String::from_utf8_lossy(&output.stdout), image_path)
}

#[cfg(target_os = "macos")]
fn mounted_volume_from_hdiutil_info(info: &str, image_path: &Path) -> Option<PathBuf> {
    let mut matching_image = false;
    for line in info.lines() {
        if line.starts_with("================================================") {
            matching_image = false;
            continue;
        }
        if let Some(value) = line.strip_prefix("image-path") {
            let value = value.trim_start_matches([' ', ':']).trim();
            matching_image = paths_refer_to_same_file(Path::new(value), image_path);
            continue;
        }
        if matching_image {
            let mount_path = line.split('\t').last().map(str::trim).unwrap_or_default();
            if mount_path.starts_with("/Volumes/") {
                return Some(PathBuf::from(mount_path));
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn install_downloaded_app(
    app: &AppHandle,
    download_path: &Path,
    preferred_destination: Option<&Path>,
) -> Result<InstallerResult, String> {
    log_codex_update(
        "info",
        "installation_started",
        format!(
            "installer={}; destination={}",
            download_path.display(),
            preferred_destination
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "automatic".to_string()),
        ),
    );
    if let Some(stale_mount) = mounted_volume_for_image(download_path) {
        log_codex_update(
            "warning",
            "stale_mount_found",
            format!(
                "detaching stale installer volume at {}",
                stale_mount.display()
            ),
        );
        detach_macos_volume(&stale_mount).map_err(|error| {
            log_codex_update("error", "stale_mount_cleanup_failed", &error);
            error
        })?;
    }
    emit_install_progress(app, "mounting", 0, None);
    let mut attach_command = Command::new("hdiutil");
    attach_command
        .args(["attach", "-nobrowse", "-readonly"])
        .arg(download_path);
    let output = run_macos_command_with_timeout(
        &mut attach_command,
        MACOS_ATTACH_TIMEOUT,
        "mount the official ChatGPT installer",
    )?;
    if !output.status.success() {
        return Err(format!(
            "mount the official ChatGPT installer: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mount_path = match String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split('\t').last())
        .map(str::trim)
        .find(|value| value.starts_with("/Volumes/"))
        .map(PathBuf::from)
    {
        Some(path) => path,
        None => {
            let cleanup_message = if let Some(mount_path) = mounted_volume_for_image(download_path)
            {
                match detach_macos_volume(&mount_path) {
                    Ok(_) => format!("; detached unexpected volume at {}", mount_path.display()),
                    Err(error) => format!("; failed to detach unexpected volume: {error}"),
                }
            } else {
                String::new()
            };
            let error = format!(
                "locate the mounted ChatGPT installer{cleanup_message}. hdiutil stdout: {:?}; stderr: {:?}",
                compact_command_output(&output.stdout),
                compact_command_output(&output.stderr),
            );
            log_codex_update("error", "mount_path_missing", &error);
            return Err(error);
        }
    };
    log_codex_update(
        "info",
        "installer_mounted",
        format!("mountPath={}", mount_path.display()),
    );
    let source = match [mount_path.join("ChatGPT.app"), mount_path.join("Codex.app")]
        .into_iter()
        .find(|path| path.exists())
    {
        Some(source) => source,
        None => {
            let _ = detach_macos_volume(&mount_path);
            return Err("locate ChatGPT in the mounted installer.".to_string());
        }
    };
    emit_install_progress(app, "copying", 0, None);
    let install_result = copy_macos_app(app, &source, preferred_destination);
    emit_install_progress(app, "unmounting", 0, None);
    let detach_result = detach_macos_volume(&mount_path);
    match (install_result, detach_result) {
        (Ok(()), Ok(_)) => {
            let _ = fs::remove_file(download_path);
            log_codex_update(
                "info",
                "installation_completed",
                format!(
                    "destination={}",
                    preferred_destination.map_or_else(
                        || "automatic".to_string(),
                        |path| path.display().to_string()
                    )
                ),
            );
            Ok(InstallerResult::Complete)
        }
        (Err(error), Ok(_)) => {
            log_codex_update("error", "installation_failed", &error);
            Err(error)
        }
        (Err(error), Err(detach_error)) => {
            let combined =
                format!("{error}; additionally failed to unmount installer: {detach_error}");
            log_codex_update("error", "installation_and_cleanup_failed", &combined);
            Err(combined)
        }
        (Ok(()), Err(error)) => {
            log_codex_update("error", "installer_unmount_failed", &error);
            Err(error)
        }
    }
}

#[cfg(target_os = "macos")]
fn detach_macos_volume(mount_path: &Path) -> Result<Output, String> {
    let mut detach_command = Command::new("hdiutil");
    detach_command.arg("detach").arg(mount_path);
    let output = run_macos_command_with_timeout(
        &mut detach_command,
        MACOS_DETACH_TIMEOUT,
        "unmount the official ChatGPT installer",
    )?;
    if output.status.success() {
        log_codex_update(
            "info",
            "installer_unmounted",
            format!("mountPath={}", mount_path.display()),
        );
        return Ok(output);
    }
    log_codex_update(
        "warning",
        "installer_unmount_retry",
        format!(
            "normal detach failed for {}: {}",
            mount_path.display(),
            compact_command_output(&output.stderr),
        ),
    );
    let mut force_command = Command::new("hdiutil");
    force_command.args(["detach", "-force"]).arg(mount_path);
    let force_output = run_macos_command_with_timeout(
        &mut force_command,
        MACOS_DETACH_TIMEOUT,
        "force unmount the official ChatGPT installer",
    )?;
    if !force_output.status.success() {
        return Err(format!(
            "unmount the official ChatGPT installer: {}; forced detach: {}",
            compact_command_output(&output.stderr),
            compact_command_output(&force_output.stderr),
        ));
    }
    log_codex_update(
        "info",
        "installer_force_unmounted",
        format!("mountPath={}", mount_path.display()),
    );
    Ok(force_output)
}

#[cfg(target_os = "macos")]
fn copy_macos_app(
    app: &AppHandle,
    source: &Path,
    preferred_destination: Option<&Path>,
) -> Result<(), String> {
    let destinations = if let Some(destination) = preferred_destination {
        vec![destination.to_path_buf()]
    } else {
        vec![PathBuf::from("/Applications/ChatGPT.app")]
    };
    let mut last_error = String::new();
    for destination in destinations {
        match replace_macos_app_with_progress(Some(app), source, &destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = error;
            }
        }
    }
    Err(format!("install ChatGPT in Applications: {last_error}"))
}

#[cfg(all(target_os = "macos", test))]
fn replace_macos_app(source: &Path, destination: &Path) -> Result<(), String> {
    replace_macos_app_with_progress(None, source, destination)
}

#[cfg(target_os = "macos")]
fn replace_macos_app_with_progress(
    app: Option<&AppHandle>,
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    log_codex_update(
        "info",
        "replacement_started",
        format!(
            "source={}; destination={}",
            source.display(),
            destination.display(),
        ),
    );
    let parent = destination
        .parent()
        .ok_or_else(|| "resolve the ChatGPT installation directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create the ChatGPT installation directory: {error}"))?;
    let operation_id = uuid::Uuid::new_v4();
    let staged = parent.join(format!(".autogateway-chatgpt-{operation_id}.app"));
    let backup = parent.join(format!(".autogateway-chatgpt-{operation_id}.backup.app"));

    if let Some(app) = app {
        emit_install_progress(app, "replacing", 0, None);
    }
    let mut copy_command = Command::new("ditto");
    copy_command.arg(source).arg(&staged);
    let copy_output = match run_macos_command_with_timeout(
        &mut copy_command,
        MACOS_COPY_TIMEOUT,
        "stage ChatGPT in Applications",
    ) {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&staged);
            return Err(error);
        }
    };
    if !copy_output.status.success() {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!(
            "stage ChatGPT in Applications: {}",
            String::from_utf8_lossy(&copy_output.stderr).trim()
        ));
    }

    if let Some(app) = app {
        emit_install_progress(app, "verifying-signature", 0, None);
    }
    let mut verify_command = Command::new("codesign");
    verify_command
        .args(["--verify", "--deep", "--strict"])
        .arg(&staged);
    let verify_output = match run_macos_command_with_timeout(
        &mut verify_command,
        MACOS_SIGNATURE_TIMEOUT,
        "verify the official ChatGPT signature",
    ) {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&staged);
            return Err(error);
        }
    };
    if !verify_output.status.success() {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!(
            "verify the official ChatGPT signature: {}",
            String::from_utf8_lossy(&verify_output.stderr).trim()
        ));
    }

    if destination.exists() {
        if let Err(error) = quit_macos_app(destination) {
            let _ = fs::remove_dir_all(&staged);
            return Err(error);
        }
        if let Err(error) = fs::rename(destination, &backup) {
            let _ = fs::remove_dir_all(&staged);
            return Err(format!(
                "prepare the existing ChatGPT application for replacement: {error}"
            ));
        }
    }
    if let Err(error) = fs::rename(&staged, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        let _ = fs::remove_dir_all(&staged);
        return Err(format!("activate the updated ChatGPT application: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    log_codex_update(
        "info",
        "replacement_completed",
        format!("destination={}", destination.display()),
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn quit_macos_app(app_path: &Path) -> Result<(), String> {
    if !macos_app_is_running(app_path) {
        return Ok(());
    }
    let app_paths = [app_path.to_path_buf()];
    close_macos_app_processes(&app_paths)
}

#[cfg(target_os = "macos")]
fn close_macos_app_processes(app_paths: &[PathBuf]) -> Result<(), String> {
    if !app_paths.iter().any(|path| macos_app_is_running(path)) {
        return Ok(());
    }
    // Signal only processes belonging to the selected bundle. A global
    // AppleScript quit could close a second ChatGPT/Codex installation.
    terminate_macos_app_processes(app_paths, "TERM");
    let deadline = Instant::now() + MACOS_QUIT_GRACE_PERIOD;
    while Instant::now() < deadline {
        if !app_paths.iter().any(|path| macos_app_is_running(path)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }

    terminate_macos_app_processes(app_paths, "TERM");
    let deadline = Instant::now() + MACOS_QUIT_FORCE_PERIOD;
    while Instant::now() < deadline {
        if !app_paths.iter().any(|path| macos_app_is_running(path)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }

    terminate_macos_app_processes(app_paths, "KILL");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !app_paths.iter().any(|path| macos_app_is_running(path)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Codex is still running after the close request. Quit Codex completely, then try the update again.".to_string())
}

#[cfg(target_os = "macos")]
fn terminate_macos_app_processes(app_paths: &[PathBuf], signal: &str) {
    for process_id in macos_app_process_ids(app_paths) {
        let _ = Command::new("kill")
            .args([format!("-{signal}"), process_id.to_string()])
            .output();
    }
}

#[cfg(target_os = "macos")]
fn macos_app_process_ids(app_paths: &[PathBuf]) -> Vec<u32> {
    let prefixes = app_paths
        .iter()
        .map(|path| format!("{}/Contents/", path.display()))
        .collect::<Vec<_>>();
    let Ok(output) = Command::new("ps")
        .args(["ax", "-o", "pid=,command="])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().splitn(2, char::is_whitespace);
            let process_id = fields.next()?.parse::<u32>().ok()?;
            let command = fields.next()?.trim().trim_start_matches('"');
            prefixes
                .iter()
                .any(|prefix| command.starts_with(prefix))
                .then_some(process_id)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_app_is_running(app_path: &Path) -> bool {
    let app_paths = [app_path.to_path_buf()];
    macos_app_process_ids(&app_paths)
        .into_iter()
        .next()
        .is_some()
}

#[cfg(target_os = "windows")]
fn install_downloaded_app(
    _app: &AppHandle,
    download_path: &Path,
    _preferred_destination: Option<&Path>,
) -> Result<InstallerResult, String> {
    install_windows_msix(download_path)?;
    Ok(InstallerResult::Complete)
}

#[cfg(target_os = "windows")]
fn install_windows_msix(download_path: &Path) -> Result<(), String> {
    log_codex_update(
        "info",
        "msix_installation_started",
        format!("path={}", download_path.display()),
    );
    let script = windows_msix_install_script(download_path);
    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW).args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &script,
    ]);
    let output = run_windows_command_with_timeout(
        &mut command,
        WINDOWS_MSIX_INSTALL_TIMEOUT,
        "ChatGPT MSIX installation",
    )?;
    if !output.status.success() {
        let error = format!(
            "install the official ChatGPT MSIX package: status={}; stdout={}; stderr={}",
            output.status,
            compact_command_output(&output.stdout),
            compact_command_output(&output.stderr),
        );
        log_codex_update("error", "msix_installation_failed", &error);
        return Err(error);
    }
    if let Err(error) = fs::remove_file(download_path) {
        log_codex_update("warning", "installer_cleanup_failed", error.to_string());
    }
    log_codex_update("info", "msix_installation_completed", "success");
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_msix_install_script(download_path: &Path) -> String {
    let escaped_path = download_path.display().to_string().replace('\'', "''");
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {{
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead('{escaped_path}')
try {{
    $entry = $archive.GetEntry('AppxManifest.xml')
    if ($null -eq $entry) {{ throw 'the downloaded MSIX package does not contain AppxManifest.xml' }}
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try {{ [xml]$manifest = $reader.ReadToEnd() }} finally {{ $reader.Dispose() }}
    if ($manifest.Package.Identity.Name -notmatch '^(OpenAI\.)?(ChatGPT|Codex)$') {{
        throw 'the downloaded MSIX package is not the official OpenAI.Codex package'
    }}
}} finally {{
    $archive.Dispose()
}}
Write-Output ('msix-registering|' + $manifest.Package.Identity.Name + '|' + $manifest.Package.Identity.Version)
Add-AppxPackage -Path '{escaped_path}' -ForceApplicationShutdown -ErrorAction Stop
Write-Output 'msix-registered'
}} catch {{
    [Console]::Error.WriteLine(($_ | Format-List * -Force | Out-String -Width 240))
    [Console]::Error.WriteLine(('HRESULT=0x{{0:X8}}' -f $_.Exception.HResult))
    exit 1
}}
"#
    )
}

#[cfg(any(target_os = "windows", test))]
fn run_windows_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<Output, String> {
    let command_summary = format!("{command:?}");
    log_codex_update(
        "info",
        "command_started",
        format!(
            "{description}; command={command_summary}; timeout={}s",
            timeout.as_secs()
        ),
    );
    command.stdin(Stdio::null());
    // Capture command output in files instead of pipes. PowerShell and WinGet
    // can spawn descendants that inherit pipe handles, making a reader thread
    // wait for EOF even after the parent command has exited.
    let output_prefix = env::temp_dir().join(format!(
        "autogateway-codex-command-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let stdout_path = output_prefix.with_extension("stdout");
    let stderr_path = output_prefix.with_extension("stderr");
    let stdout_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&stdout_path)
        .map_err(|error| format!("capture standard output from {description}: {error}"))?;
    let stderr_file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&stderr_path)
    {
        Ok(file) => file,
        Err(error) => {
            drop(stdout_file);
            let _ = fs::remove_file(&stdout_path);
            return Err(format!(
                "capture standard error from {description}: {error}"
            ));
        }
    };
    command
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    let spawned = command.spawn();
    // Command retains its handles after spawn; release them before cleanup,
    // especially on Windows where open file handles can prevent removal.
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = spawned.map_err(|error| {
        let message = format!("start {description}: {error}");
        log_codex_update("error", "command_start_failed", &message);
        let _ = fs::remove_file(&stdout_path);
        let _ = fs::remove_file(&stderr_path);
        message
    })?;
    let started_at = Instant::now();
    let deadline = started_at + timeout;
    let mut next_heartbeat = started_at + Duration::from_secs(30);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = read_windows_command_output(&stdout_path, &stderr_path, description);
                let message = format!("wait for {description}: {error}");
                log_codex_update("error", "command_wait_failed", &message);
                return Err(message);
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let (stdout, stderr) =
                    read_windows_command_output(&stdout_path, &stderr_path, description);
                let message = format!(
                    "{description} timed out after {} seconds; stdout={:?}; stderr={:?}",
                    timeout.as_secs(),
                    compact_command_output(&stdout),
                    compact_command_output(&stderr),
                );
                log_codex_update("error", "command_timed_out", &message);
                return Err(message);
            }
            Ok(None) => {
                if Instant::now() >= next_heartbeat {
                    log_codex_update(
                        "info",
                        "command_still_running",
                        format!(
                            "{description}; elapsed={}s; timeout={}s",
                            started_at.elapsed().as_secs(),
                            timeout.as_secs(),
                        ),
                    );
                    next_heartbeat += Duration::from_secs(30);
                }
                thread::sleep(Duration::from_millis(500));
            }
        }
    };
    let (stdout, stderr) = read_windows_command_output(&stdout_path, &stderr_path, description);
    let output = Output {
        status,
        stdout,
        stderr,
    };
    log_codex_update(
        if output.status.success() {
            "info"
        } else {
            "error"
        },
        "command_finished",
        format!(
            "{description}; status={}; elapsed={}s; stdout={:?}; stderr={:?}",
            output.status,
            started_at.elapsed().as_secs(),
            compact_command_output(&output.stdout),
            compact_command_output(&output.stderr),
        ),
    );
    Ok(output)
}

#[cfg(any(target_os = "windows", test))]
fn read_windows_command_output(
    stdout_path: &Path,
    stderr_path: &Path,
    description: &str,
) -> (Vec<u8>, Vec<u8>) {
    let read_stream = |path: &Path| {
        let result = (|| -> std::io::Result<Vec<u8>> {
            let mut file = fs::File::open(path)?;
            let length = file.metadata()?.len();
            let start = length.saturating_sub(64 * 1024);
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = Vec::new();
            file.take(length - start).read_to_end(&mut bytes)?;
            Ok(bytes)
        })();
        result.unwrap_or_else(|error| {
            // Diagnostics must not turn a successful installation into failure.
            log_codex_update(
                "warning",
                "command_output_read_failed",
                format!("{description}; path={}; error={error}", path.display()),
            );
            Vec::new()
        })
    };
    let stdout = read_stream(stdout_path);
    let stderr = read_stream(stderr_path);
    let _ = fs::remove_file(stdout_path);
    let _ = fs::remove_file(stderr_path);
    (stdout, stderr)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_downloaded_app(
    _app: &AppHandle,
    _download_path: &Path,
    _preferred_destination: Option<&Path>,
) -> Result<InstallerResult, String> {
    Err("This desktop build supports macOS and Windows only.".to_string())
}

#[cfg(target_os = "macos")]
fn installation_candidates() -> Vec<PathBuf> {
    // macOS permits user-level duplicate app bundles; keep management scoped
    // to the canonical system installation.
    vec![PathBuf::from("/Applications/ChatGPT.app")]
}

#[cfg(target_os = "windows")]
fn installation_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for variable in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Some(directory) = env::var_os(variable) {
            let directory = PathBuf::from(directory);
            paths.push(directory.join("Programs/ChatGPT/ChatGPT.exe"));
            paths.push(directory.join("OpenAI/ChatGPT/ChatGPT.exe"));
        }
    }
    paths
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn installation_candidates() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn missing_message() -> String {
    "The official ChatGPT desktop application was not found in Applications. Download it to use Codex.".to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        cached_installer_from_path, compare_versions, completed_download_marker,
        is_trusted_windows_download_url, native_architecture, windows_download_urls,
        PlatformVersion,
    };
    use std::cmp::Ordering;
    use std::fs;
    use std::path::Path;
    #[cfg(target_os = "macos")]
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Duration;

    fn test_command(unix_script: &str, windows_script: &str) -> Command {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = unix_script;
            let mut command = Command::new("powershell.exe");
            command.creation_flags(super::CREATE_NO_WINDOW).args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                windows_script,
            ]);
            command
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = windows_script;
            let mut command = Command::new("/bin/sh");
            command.args(["-c", unix_script]);
            command
        }
    }

    #[test]
    fn windows_command_capture_keeps_the_real_failure_and_both_streams() {
        let mut command = test_command(
            "printf before-error; printf deployment-failed >&2; exit 7",
            "[Console]::Out.Write('before-error'); [Console]::Error.Write('deployment-failed'); exit 7",
        );
        let output = super::run_windows_command_with_timeout(
            &mut command,
            Duration::from_secs(10),
            "capture failure test",
        )
        .expect("capture command outcome");
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"before-error");
        assert_eq!(output.stderr, b"deployment-failed");
    }

    #[test]
    fn windows_command_capture_handles_output_larger_than_a_pipe_buffer() {
        let mut command = test_command(
            "i=0; while [ $i -lt 10000 ]; do printf 0123456789abcdef; printf fedcba9876543210 >&2; i=$((i+1)); done",
            "[Console]::Out.Write(('0123456789abcdef' * 10000)); [Console]::Error.Write(('fedcba9876543210' * 10000))",
        );
        let output = super::run_windows_command_with_timeout(
            &mut command,
            Duration::from_secs(15),
            "large output test",
        )
        .expect("large output must not stall the process");
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 64 * 1024);
        assert_eq!(output.stderr.len(), 64 * 1024);
        assert!(output.stdout.ends_with(b"0123456789abcdef"));
        assert!(output.stderr.ends_with(b"fedcba9876543210"));
    }

    #[test]
    fn windows_command_capture_respects_the_timeout() {
        let mut command = test_command("sleep 4", "Start-Sleep -Seconds 4");
        let started = std::time::Instant::now();
        let error = super::run_windows_command_with_timeout(
            &mut command,
            Duration::from_millis(500),
            "timeout test",
        )
        .expect_err("the sleeping process must time out");
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn missing_diagnostic_file_does_not_discard_the_other_output() {
        let root = std::env::temp_dir().join(format!("ag-output-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let stdout = root.join("missing.stdout");
        let stderr = root.join("test.stderr");
        fs::write(&stderr, b"deployment-details").unwrap();
        let (out, err) = super::read_windows_command_output(&stdout, &stderr, "missing file test");
        assert!(out.is_empty());
        assert_eq!(err, b"deployment-details");
        assert!(!stderr.exists());
        fs::remove_dir(&root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn msix_script_parameters_match_the_installed_windows_appx_module() {
        let script =
            super::windows_msix_install_script(Path::new(r"C:\Users\O'Brien\Test [package].msix"));
        let escaped = script.replace('\'', "''");
        let check = format!(
            r#"
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput('{escaped}', [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {{ throw ($errors | Out-String) }}
$parameters = (Get-Command Appx\Add-AppxPackage).Parameters
$commands = $ast.FindAll({{param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-AppxPackage'}}, $true)
if ($commands.Count -ne 1) {{ throw 'expected one package deployment command' }}
foreach ($element in $commands[0].CommandElements) {{
    if ($element -is [System.Management.Automation.Language.CommandParameterAst] -and -not $parameters.ContainsKey($element.ParameterName)) {{
        throw ('Unsupported Appx parameter: ' + $element.ParameterName)
    }}
}}
Write-Output 'parameters-validated'
"#
        );
        let mut command = test_command("", &check);
        let output = super::run_windows_command_with_timeout(
            &mut command,
            Duration::from_secs(30),
            "Appx parameter contract test",
        )
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("parameters-validated"));
    }

    #[test]
    fn compares_numeric_version_segments() {
        assert_eq!(
            compare_versions("26.730.61309", "26.727.51351"),
            Ordering::Greater
        );
        assert_eq!(
            compare_versions("26.730.61309", "26.730.61309"),
            Ordering::Equal
        );
        assert_eq!(
            compare_versions("26.730.61309.0", "26.730.61309"),
            Ordering::Equal
        );
    }

    #[test]
    fn invalid_cached_installer_state_is_removed() {
        let root = std::env::temp_dir().join(format!(
            "autogateway-codex-cache-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create cache test directory");
        let installer = root.join("ChatGPT.dmg");
        let marker = completed_download_marker(&installer);
        fs::write(&marker, b"complete").expect("write stale cache marker");

        assert!(
            cached_installer_from_path(installer.clone(), "26.803.81509".to_string()).is_none()
        );
        assert!(!marker.exists());
        assert!(!installer.exists());

        fs::remove_dir_all(root).expect("remove cache test directory");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_timeout_command_captures_stdout_and_stderr() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf 'mounted-output'; printf 'diagnostic-output' >&2",
        ]);

        let output = super::run_macos_command_with_timeout(
            &mut command,
            Duration::from_secs(2),
            "capture command output test",
        )
        .expect("run command with captured output");

        assert!(output.status.success());
        assert_eq!(output.stdout, b"mounted-output");
        assert_eq!(output.stderr, b"diagnostic-output");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_the_volume_mounted_for_the_requested_disk_image() {
        let info = r#"================================================
image-path      : /tmp/unrelated.dmg
/dev/disk9s1	48465300-0000-11AA-AA11-00306543ECAC	/Volumes/Unrelated
================================================
image-path      : /tmp/ChatGPT.dmg
/dev/disk10s1	48465300-0000-11AA-AA11-00306543ECAC	/Volumes/ChatGPT Installer
"#;

        assert_eq!(
            super::mounted_volume_from_hdiutil_info(info, Path::new("/tmp/ChatGPT.dmg")),
            Some(PathBuf::from("/Volumes/ChatGPT Installer")),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn prefers_the_direct_mirror_before_r2_and_the_official_fallback() {
        let release: super::PlatformVersion = serde_json::from_str(
            r#"{"version":"26.730.61639","downloadUrl":"https://cdn.example.test/codex.dmg","fallbackUrl":"https://official.example.test/ChatGPT.dmg"}"#,
        )
        .expect("decode version service response");
        let urls = super::download_urls(Some(&release)).expect("build installer candidates");
        assert_eq!(urls[0], super::PREFERRED_DIRECT_DOWNLOAD_URL);
        assert_eq!(urls[1], "https://cdn.example.test/codex.dmg");
        assert_eq!(urls[2], "https://official.example.test/ChatGPT.dmg");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn manages_only_the_system_chatgpt_application() {
        assert_eq!(
            super::installation_candidates(),
            [PathBuf::from("/Applications/ChatGPT.app")],
        );
    }

    #[test]
    fn windows_keeps_trusted_mirror_and_cdn_candidates_for_speed_ranking() {
        let architecture = native_architecture();
        let mirror = format!("https://codexapp.agentsmirror.com/latest/win-{architecture}");
        let r2 = "https://cdn.autogateway.cc/downloads/codex/OpenAI.Codex_26.730.8199.0.msix";
        let release: PlatformVersion = serde_json::from_str(&format!(
            r#"{{"version":"26.730.8199.0","artifacts":{{"{architecture}":{{"directUrl":"{mirror}","downloadUrl":"{r2}","fallbackUrl":"https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi"}}}},"downloadUrl":"{r2}","fallbackUrl":"https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi"}}"#,
        ))
        .expect("decode version service response");
        let urls = windows_download_urls(Some(&release)).expect("build installer candidates");
        assert_eq!(urls, [mirror, r2.to_string(),]);
    }

    #[test]
    fn windows_download_sources_reject_untrusted_or_executable_urls() {
        let mirror = format!(
            "https://codexapp.agentsmirror.com/latest/win-{}",
            native_architecture()
        );
        assert!(is_trusted_windows_download_url(&mirror));
        assert!(is_trusted_windows_download_url(
            "https://cdn.autogateway.cc/downloads/codex/OpenAI.Codex.msix"
        ));
        let redirected_mirror =
            mirror.replace("codexapp.agentsmirror.com", "codexapp-r2.agentsmirror.com");
        assert!(is_trusted_windows_download_url(&redirected_mirror));
        assert!(!is_trusted_windows_download_url(
            "https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi"
        ));
        assert!(!is_trusted_windows_download_url(
            "https://cdn.autogateway.cc/downloads/codex/ChatGPT-Installer.exe"
        ));
        assert!(!is_trusted_windows_download_url(
            "https://untrusted.example/OpenAI.Codex.msix"
        ));
        assert!(!is_trusted_windows_download_url(
            "https://get.microsoft.com/installer/download/not-the-chatgpt-product"
        ));
        assert!(!is_trusted_windows_download_url(
            "http://codexapp.agentsmirror.com/latest/win-x64"
        ));
        assert!(is_trusted_windows_download_url(
            "http://ag.guangla.com/desktop-codex/windows-x64/26.908.4834.0/ChatGPT-Installer.msix"
        ));
        assert!(!is_trusted_windows_download_url(
            "http://ag.guangla.com/desktop-codex/windows-x64/26.908.4834.0/ChatGPT-Installer.exe"
        ));
        assert!(!is_trusted_windows_download_url(
            "http://ag.guangla.com/other/ChatGPT-Installer.msix"
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_includes_the_service_returned_acceleration_source() {
        let architecture = native_architecture();
        let acceleration = format!(
            "http://ag.guangla.com/desktop-codex/macos-{architecture}/26.908.70816/ChatGPT.dmg"
        );
        let release: super::PlatformVersion = serde_json::from_str(&format!(
            r#"{{"version":"26.908.70816","artifacts":{{"{architecture}":{{"downloadUrls":["{acceleration}"]}}}}}}"#,
        ))
        .expect("decode acceleration source");
        let urls = super::download_urls(Some(&release)).expect("build macOS candidates");
        assert!(urls.contains(&acceleration));
    }

    #[test]
    fn windows_includes_the_service_returned_acceleration_source() {
        let architecture = native_architecture();
        let acceleration = format!(
            "http://ag.guangla.com/desktop-codex/windows-{architecture}/26.908.4834.0/ChatGPT-Installer.msix"
        );
        let release: super::PlatformVersion = serde_json::from_str(&format!(
            r#"{{"version":"26.908.4834.0","artifacts":{{"{architecture}":{{"downloadUrls":["{acceleration}"]}}}}}}"#,
        ))
        .expect("decode acceleration source");
        let urls = windows_download_urls(Some(&release)).expect("build Windows candidates");
        assert!(urls.contains(&acceleration));
    }

    #[test]
    fn windows_process_selector_targets_the_selected_installation() {
        let script = super::windows_codex_process_selector(Some(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_26.818.8289.0_x64",
        ));

        assert!(script.contains("OpenAI.Codex_26.818.8289.0_x64"));
        assert!(script.contains("StartsWith($rootPrefix"));
        assert!(!script.contains("Get-Process -Name"));
        assert!(!script.contains("$_.ProcessName -eq 'Codex'"));
    }

    #[test]
    fn windows_process_selector_escapes_single_quotes_in_paths() {
        let script =
            super::windows_codex_process_selector(Some(r"C:\Users\O'Brien\Apps\ChatGPT.exe"));

        assert!(script.contains(r"C:\Users\O''Brien\Apps\ChatGPT.exe"));
    }

    #[test]
    fn windows_app_identity_query_is_bound_to_the_selected_installation() {
        let script = super::windows_app_user_model_id_script(Some(Path::new(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_26.903.9818.0_x64",
        )));

        assert!(script.contains("InstallLocation.TrimEnd('\\') -eq $requestedPath.TrimEnd('\\')"));
        assert!(script.contains("Sort-Object Version -Descending"));
        assert!(!script.contains(
            "Where-Object { $_.Name -match '(?i)(chatgpt|codex)' } | Select-Object -First 1"
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replaces_existing_macos_app_after_signature_verification() {
        use super::replace_macos_app;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let root = std::env::temp_dir().join(format!(
            "autogateway-app-replacement-test-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("Source.app");
        let destination = root.join("Destination.app");
        write_test_app(&source, "updated");
        write_test_app(&destination, "existing");
        let signing = Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(&source)
            .output()
            .expect("run codesign for the test application");
        assert!(
            signing.status.success(),
            "codesign failed: {}",
            String::from_utf8_lossy(&signing.stderr)
        );

        replace_macos_app(&source, &destination).expect("replace the test application");
        let executable = fs::read_to_string(destination.join("Contents/MacOS/TestApp"))
            .expect("read the replaced executable");
        assert!(executable.contains("updated"));
        fs::remove_dir_all(root).expect("remove the application replacement fixture");

        fn write_test_app(path: &std::path::Path, marker: &str) {
            let executable_directory = path.join("Contents/MacOS");
            fs::create_dir_all(&executable_directory)
                .expect("create the test application directory");
            fs::write(
                path.join("Contents/Info.plist"),
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TestApp</string>
<key>CFBundleIdentifier</key><string>cc.autogateway.replacement-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
"#,
            )
            .expect("write the test application property list");
            let executable = executable_directory.join("TestApp");
            fs::write(&executable, format!("#!/bin/sh\n# {marker}\nexit 0\n"))
                .expect("write the test application executable");
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
                .expect("make the test application executable");
        }
    }
}

#[cfg(target_os = "windows")]
fn missing_message() -> String {
    "The official ChatGPT desktop application was not found. Microsoft Store installations may not expose a readable path; open ChatGPT once after installing it, then check again.".to_string()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn missing_message() -> String {
    "This desktop build supports macOS and Windows only.".to_string()
}
