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
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Output;
use std::sync::OnceLock;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::thread;
use std::time::{Duration, Instant};
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
    "get.microsoft.com",
];
#[cfg(any(target_os = "windows", test))]
const WINDOWS_STORE_PRODUCT_ID: &str = "9PLM9XGG6VKS";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const WINDOWS_MSIX_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
#[cfg(target_os = "windows")]
const WINDOWS_STORE_COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);
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

    // The version service provides the preferred upstream mirror first, then
    // our R2 replica. Microsoft Store remains the Windows last resort.
    let latest_release = latest_release().await.ok();
    let download_urls = match download_urls(latest_release.as_ref()) {
        Ok(urls) => urls,
        Err(error) => {
            #[cfg(target_os = "windows")]
            {
                return install_with_microsoft_store_fallback(app, force_update, &error).await;
            }
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
                    {
                        return install_with_microsoft_store_fallback(
                            app,
                            force_update,
                            &format!("reinstall the completed ChatGPT installer: {error}"),
                        )
                        .await;
                    }
                    #[cfg(not(target_os = "windows"))]
                    return Err(error);
                }
            }
        }
    }

    if installer_result.is_none() {
        if let Err(error) = download_installer(app, &download_urls, &download_path).await {
            #[cfg(target_os = "windows")]
            {
                return install_with_microsoft_store_fallback(app, force_update, &error).await;
            }
            #[cfg(not(target_os = "windows"))]
            return Err(error);
        }
        match install_downloaded_path(app, &download_path, preferred_destination.as_deref()).await {
            Ok(result) => installer_result = Some(result),
            Err(error) => {
                #[cfg(target_os = "windows")]
                {
                    return install_with_microsoft_store_fallback(app, force_update, &error).await;
                }
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
        {
            return install_with_microsoft_store_fallback(app, force_update, error).await;
        }
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
    let latest_release = latest_release().await.ok();
    let extension = download_extension(&[]);
    let latest_version = latest_release
        .as_ref()
        .map(|release| release.version.as_str());
    if !force_redownload {
        if let Some(cached) =
            latest_version.and_then(|version| cached_installer_for_version(version, extension))
        {
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
    download_installer(app, &download_urls, &download_path).await?;

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
    install_downloaded_path(app, &download_path, preferred_destination.as_deref()).await?;
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
        match download_installer_from_url(app, download_url, download_path).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                errors.push(format!("{download_url}: {error}"));
            }
        }
    }
    Err(format!(
        "download the ChatGPT installer from the mirror, R2, and official source: {}",
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
        Command::new("open")
            .arg(&app)
            .spawn()
            .map_err(|error| format!("open ChatGPT: {error}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        let app_user_model_id = windows_app_user_model_id()?;
        let shell_target = format!("shell:AppsFolder\\{app_user_model_id}");
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
    #[cfg(target_os = "macos")]
    {
        for process_name in ["ChatGPT", "Codex"] {
            if process_name_running(process_name)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    {
        let script = "$process = Get-Process -Name 'ChatGPT','Codex','OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -eq $process) { exit 1 }; exit 0";
        let output = Command::new("powershell.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
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
                running_installation()
                    .map(|installation| vec![installation.path])
                    .unwrap_or_default()
            });
        return close_macos_app_processes(&app_paths);
    }

    #[cfg(target_os = "windows")]
    {
        if !is_installed_app_running()? {
            return Ok(());
        }
        let script = "$processes = @(Get-Process -Name 'ChatGPT','Codex','OpenAI.Codex' -ErrorAction SilentlyContinue); foreach ($process in $processes) { if ($process.MainWindowHandle -ne 0) { $null = $process.CloseMainWindow() } }";
        Command::new("powershell.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|error| format!("request ChatGPT to close: {error}"))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if !is_installed_app_running()? {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
        return Err(
            "ChatGPT is still running. Quit ChatGPT completely, then try the update again."
                .to_string(),
        );
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("This desktop build supports macOS and Windows only.".to_string())
}

#[cfg(target_os = "macos")]
fn process_name_running(process_name: &str) -> Result<bool, String> {
    let output = Command::new("pgrep")
        .args(["-x", process_name])
        .output()
        .map_err(|error| format!("check whether {process_name} is open: {error}"))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(format!(
            "check whether {process_name} is open: pgrep exited with {}",
            output.status
        )),
    }
}

#[cfg(target_os = "windows")]
fn windows_app_user_model_id() -> Result<String, String> {
    let script = "$package = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)(chatgpt|codex)' } | Select-Object -First 1; if ($null -eq $package) { exit 1 }; $manifest = Get-AppxPackageManifest -Package $package; $application = $manifest.Package.Applications.Application | Select-Object -First 1; if ($null -eq $application) { exit 1 }; Write-Output ($package.PackageFamilyName + '!' + $application.Id)";
    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|error| format!("query the installed ChatGPT package: {error}"))?;
    if !output.status.success() {
        return Err(
            "ChatGPT is not installed yet, or Windows could not find its packaged app entry."
                .to_string(),
        );
    }
    let app_user_model_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if app_user_model_id.is_empty() {
        return Err("Windows returned an empty ChatGPT app identity. Open ChatGPT once from the Start menu, then try again.".to_string());
    }
    Ok(app_user_model_id)
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
    let mut urls = Vec::with_capacity(4);
    if let Some(latest) = latest {
        append_trusted_windows_artifact_urls(&mut urls, latest, native_architecture());
        append_trusted_windows_download_url(&mut urls, latest.download_url.as_deref());
        append_trusted_windows_download_url(&mut urls, latest.fallback_url.as_deref());
    }
    if urls.is_empty() {
        return Err(
            "trusted ChatGPT MSIX sources are unavailable; opening Microsoft Store instead"
                .to_string(),
        );
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
    append_trusted_windows_download_url(urls, artifact.fallback_url.as_deref());
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
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !TRUSTED_WINDOWS_DOWNLOAD_HOSTS.contains(&host)
    {
        return false;
    }

    let path = url.path();
    let normalized_path = path.to_ascii_lowercase();
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
    host == "get.microsoft.com" && path == format!("/installer/download/{WINDOWS_STORE_PRODUCT_ID}")
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
fn running_installation() -> Option<LocalInstallation> {
    let output = Command::new("ps")
        .args(["ax", "-o", "command="])
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(macos_main_app_path)
        .map(read_macos_installation)
}

#[cfg(target_os = "macos")]
fn macos_main_app_path(command: &str) -> Option<PathBuf> {
    ["ChatGPT", "Codex"].into_iter().find_map(|executable| {
        let marker = format!("/Contents/MacOS/{executable}");
        let marker_start = command.find(&marker)?;
        let marker_end = marker_start + marker.len();
        if command[marker_end..]
            .chars()
            .next()
            .is_some_and(|character| !character.is_whitespace() && character != '"')
        {
            return None;
        }
        let raw_path = command[..marker_start]
            .trim()
            .trim_start_matches('"')
            .trim_end_matches('/');
        let path = PathBuf::from(raw_path);
        (path.extension().and_then(|extension| extension.to_str()) == Some("app")
            && !raw_path.contains("/Contents/"))
        .then_some(path)
    })
}

#[cfg(target_os = "macos")]
fn update_target_installation() -> Option<LocalInstallation> {
    running_installation().or_else(local_installation)
}

#[cfg(not(target_os = "macos"))]
fn update_target_installation() -> Option<LocalInstallation> {
    local_installation()
}

#[cfg(target_os = "windows")]
fn local_installation() -> Option<LocalInstallation> {
    let script = "$package = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)(chatgpt|codex)' } | Select-Object -First 1; if ($null -ne $package) { Write-Output $package.Version.ToString(); Write-Output $package.InstallLocation }";
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

#[cfg(target_os = "macos")]
fn run_macos_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<Output, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("start {description}: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("wait for {description}: {error}"))?
        {
            Some(_) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("read {description} output: {error}"));
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{description} timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(250)),
        }
    }
}

#[cfg(target_os = "macos")]
fn install_downloaded_app(
    app: &AppHandle,
    download_path: &Path,
    preferred_destination: Option<&Path>,
) -> Result<InstallerResult, String> {
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
            return Err("locate the mounted ChatGPT installer.".to_string());
        }
    };
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
            Ok(InstallerResult::Complete)
        }
        (Err(error), Ok(_)) | (Err(error), Err(_)) => Err(error),
        (Ok(()), Err(error)) => Err(error),
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
    if !output.status.success() {
        return Err(format!(
            "unmount the official ChatGPT installer: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output)
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
        let mut destinations = vec![PathBuf::from("/Applications/ChatGPT.app")];
        if let Some(home) = dirs::home_dir() {
            destinations.push(home.join("Applications/ChatGPT.app"));
        }
        destinations
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

#[cfg(target_os = "macos")]
fn replace_macos_app(source: &Path, destination: &Path) -> Result<(), String> {
    replace_macos_app_with_progress(None, source, destination)
}

#[cfg(target_os = "macos")]
fn replace_macos_app_with_progress(
    app: Option<&AppHandle>,
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
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
fn install_with_winget(force_update: bool) -> Result<(), String> {
    let mut attempts = Vec::new();
    if force_update {
        attempts.push(vec![
            "upgrade",
            "--id",
            WINDOWS_STORE_PRODUCT_ID,
            "--exact",
            "--source",
            "msstore",
        ]);
    }
    attempts.push(vec![
        "install",
        "--id",
        WINDOWS_STORE_PRODUCT_ID,
        "--exact",
        "--source",
        "msstore",
    ]);

    let mut last_error = None;
    for arguments in attempts {
        let mut command = Command::new("winget.exe");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args(arguments.iter().copied().chain([
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
            ]));
        let output = run_windows_command_with_timeout(
            &mut command,
            WINDOWS_STORE_COMMAND_TIMEOUT,
            "Microsoft Store installation command",
        )?;
        if output.status.success() {
            return Ok(());
        }
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        last_error = Some(if details.is_empty() { stdout } else { details });
    }

    Err(last_error
        .filter(|error| !error.is_empty())
        .unwrap_or_else(|| "WinGet could not install the Microsoft Store package".to_string()))
}

#[cfg(target_os = "windows")]
async fn install_with_microsoft_store_fallback(
    app: &AppHandle,
    force_update: bool,
    mirror_error: &str,
) -> Result<CodexInstallResult, String> {
    emit_install_progress(app, "installing", 0, None);
    let winget_result =
        tauri::async_runtime::spawn_blocking(move || install_with_winget(force_update))
            .await
            .map_err(|error| format!("wait for the Microsoft Store installation: {error}"))?;

    if winget_result.is_err() {
        open_microsoft_store()?;
        let reason = mirror_error.trim();
        let message = if reason.is_empty() {
            "Microsoft Store has opened. Finish the ChatGPT installation there; this page will continue automatically.".to_string()
        } else {
            format!(
                "The direct ChatGPT installer could not be completed ({reason}). Microsoft Store has opened; finish the installation there and this page will continue automatically."
            )
        };
        return Ok(CodexInstallResult {
            installed: false,
            path: None,
            message,
            awaiting_installation: true,
            can_retry_cached_installer: completed_installer_available(),
        });
    }

    emit_install_progress(app, "verifying", 0, None);
    let status = status().await;
    if status.installed {
        if force_update {
            if let (Some(expected), Some(installed)) = (
                status.latest_version.as_deref(),
                status.local_version.as_deref(),
            ) {
                if compare_versions(installed, expected) == Ordering::Less {
                    return Err(format!("the update finished, but version {installed} is still installed; expected {expected}"));
                }
            }
            open_installed_app()?;
        }
        emit_install_progress(app, "complete", 0, None);
        return Ok(CodexInstallResult {
            installed: true,
            path: status.path,
            message: if force_update {
                "ChatGPT and Codex were updated successfully.".to_string()
            } else {
                "ChatGPT and Codex are installed and ready for the next step.".to_string()
            },
            awaiting_installation: false,
            can_retry_cached_installer: false,
        });
    }

    Ok(CodexInstallResult {
        installed: false,
        path: None,
        message: if mirror_error.trim().is_empty() {
            "Microsoft Store is installing ChatGPT. This page will continue automatically when the installation finishes.".to_string()
        } else {
            format!(
                "The direct ChatGPT installer could not be completed ({mirror_error}). Microsoft Store is installing ChatGPT; this page will continue automatically when the installation finishes."
            )
        },
        awaiting_installation: true,
        can_retry_cached_installer: completed_installer_available(),
    })
}

#[cfg(target_os = "windows")]
fn open_microsoft_store() -> Result<(), String> {
    let store_uri = format!("ms-windows-store://pdp/?productid={WINDOWS_STORE_PRODUCT_ID}");
    Command::new("explorer.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .arg(store_uri)
        .spawn()
        .map_err(|error| format!("open Microsoft Store: {error}"))?;
    Ok(())
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
    let escaped_path = download_path.display().to_string().replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
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
Add-AppxPackage -LiteralPath '{escaped_path}' -ForceApplicationShutdown -ErrorAction Stop
"#
    );
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
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "install the official ChatGPT MSIX package: {details}"
        ));
    }
    fs::remove_file(download_path)
        .map_err(|error| format!("remove the downloaded ChatGPT MSIX package: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_windows_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<Output, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("start {description}: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("wait for {description}: {error}"))?
        {
            Some(_) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("read {description} output: {error}"));
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait_with_output();
                return Err(format!(
                    "{description} timed out after {} minutes. Try again, or complete the installation in Microsoft Store.",
                    timeout.as_secs() / 60
                ));
            }
            None => thread::sleep(Duration::from_millis(500)),
        }
    }
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
    let mut paths = vec![
        PathBuf::from("/Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
    ];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("Applications/ChatGPT.app"));
        paths.push(home.join("Applications/Codex.app"));
    }
    paths
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
    fn detects_the_running_macos_app_bundle_from_its_main_process() {
        assert_eq!(
            super::macos_main_app_path("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
            Some(std::path::PathBuf::from("/Applications/ChatGPT.app"))
        );
        assert_eq!(
            super::macos_main_app_path(
                "\"/Users/example/Applications/Codex.app/Contents/MacOS/Codex\" --profile"
            ),
            Some(std::path::PathBuf::from(
                "/Users/example/Applications/Codex.app"
            ))
        );
        assert_eq!(
            super::macos_main_app_path(
                "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)"
            ),
            None
        );
    }

    #[test]
    fn windows_keeps_trusted_mirror_and_r2_candidates_for_speed_ranking() {
        let architecture = native_architecture();
        let mirror = format!("https://codexapp.agentsmirror.com/latest/win-{architecture}");
        let r2 = "https://cdn.autogateway.cc/downloads/codex/OpenAI.Codex_26.730.8199.0.msix";
        let microsoft =
            "https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi";
        let release: PlatformVersion = serde_json::from_str(&format!(
            r#"{{"version":"26.730.8199.0","artifacts":{{"{architecture}":{{"directUrl":"{mirror}","downloadUrl":"{r2}","fallbackUrl":"{microsoft}"}}}},"downloadUrl":"{r2}","fallbackUrl":"{microsoft}"}}"#,
        ))
        .expect("decode version service response");
        let urls = windows_download_urls(Some(&release)).expect("build installer candidates");
        assert_eq!(urls, [mirror, r2.to_string(), microsoft.to_string(),]);
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
        assert!(is_trusted_windows_download_url(
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
