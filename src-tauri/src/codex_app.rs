use crate::http_client::client_with_timeout as desktop_http_client;
use futures_util::StreamExt;
use serde::Deserialize;
use serde::Serialize;
use std::cmp::Ordering;
use std::env;
use std::fs;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "macos")]
use std::thread;
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::time::Instant;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
const MACOS_DOWNLOAD_URL: &str = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg";
const CODEX_VERSION_API_URL: &str = "https://api.autogateway.cc/public/api/desktop/codex-version";
#[cfg(target_os = "windows")]
const WINDOWS_DOWNLOAD_URL: &str = "https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppStatus {
    pub installed: bool,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexInstallProgress {
    stage: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
}

struct LocalInstallation {
    path: PathBuf,
    version: Option<String>,
}

enum InstallerResult {
    #[cfg(target_os = "macos")]
    Complete,
    #[cfg(target_os = "windows")]
    AwaitingExternalInstallation,
}

#[derive(Deserialize)]
struct CodexVersionSnapshot {
    #[cfg(target_os = "macos")]
    macos: PlatformVersion,
    #[cfg(target_os = "windows")]
    windows: PlatformVersion,
}

#[derive(Deserialize)]
struct PlatformVersion {
    version: String,
}

pub async fn status() -> CodexAppStatus {
    let Some(installation) = local_installation() else {
        return CodexAppStatus {
            installed: false,
            path: None,
            local_version: None,
            latest_version: None,
            update_available: None,
            update_check_error: None,
            platform_message: missing_message(),
        };
    };

    let latest_result = latest_version().await;
    let (latest_version, update_available, update_check_error) = match latest_result {
        Ok(latest) => {
            let available = installation
                .version
                .as_deref()
                .map(|local| compare_versions(&latest, local) == Ordering::Greater);
            (Some(latest), available, None)
        }
        Err(error) => (None, None, Some(error)),
    };

    CodexAppStatus {
        installed: true,
        path: Some(installation.path.display().to_string()),
        local_version: installation.version,
        latest_version,
        update_available,
        update_check_error,
        platform_message: "The official ChatGPT desktop application is installed. It includes Codex.".to_string(),
    }
}

pub async fn install(app: &AppHandle, force_update: bool) -> Result<CodexInstallResult, String> {
    let existing_installation = local_installation();
    if let Some(installation) = existing_installation.as_ref().filter(|_| !force_update) {
        return Ok(CodexInstallResult {
            installed: true,
            path: Some(installation.path.display().to_string()),
            message: "The official ChatGPT desktop application is already installed.".to_string(),
            awaiting_installation: false,
        });
    }

    let download_url = download_url()?;
    let extension = download_extension();
    let download_path = env::temp_dir().join(format!("autogateway-chatgpt-{}.{}", uuid::Uuid::new_v4(), extension));
    emit_install_progress(app, "preparing", 0, None);
    if let Err(error) = download_installer(app, download_url, &download_path).await {
        let _ = fs::remove_file(&download_path);
        return Err(error);
    }

    let preferred_destination = existing_installation.map(|installation| installation.path);
    emit_install_progress(app, "installing", 0, None);
    let install_result = tauri::async_runtime::spawn_blocking(move || install_downloaded_app(&download_path, preferred_destination.as_deref()))
        .await
        .map_err(|error| format!("wait for the official ChatGPT installer: {error}"))?;
    let installer_result = install_result?;

    #[cfg(not(target_os = "windows"))]
    let _ = installer_result;

    #[cfg(target_os = "windows")]
    if matches!(installer_result, InstallerResult::AwaitingExternalInstallation) {
        return Ok(CodexInstallResult {
            installed: false,
            path: None,
            message: "Microsoft Store has opened the official ChatGPT installer. Finish the installation there; this page will continue automatically.".to_string(),
            awaiting_installation: true,
        });
    }

    emit_install_progress(app, "verifying", 0, None);
    let status = status().await;
    if !status.installed {
        return Err("the official ChatGPT installer finished, but the application could not be found. Open the installer once, then return here and check again.".to_string());
    }
    if force_update {
        let expected_version = status.latest_version.as_deref();
        let installed_version = status.local_version.as_deref();
        if let (Some(expected), Some(installed)) = (expected_version, installed_version) {
            if compare_versions(installed, expected) == Ordering::Less {
                return Err(format!("the update finished, but version {installed} is still installed; expected {expected}"));
            }
        }
        open_installed_app()?;
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
    })
}

async fn download_installer(app: &AppHandle, download_url: &str, download_path: &Path) -> Result<(), String> {
    let response = desktop_http_client(Some(Duration::from_secs(30 * 60)))
        .map_err(|error| format!("prepare the official ChatGPT download: {error}"))?
        .get(download_url)
        .send()
        .await
        .map_err(|error| format!("download the official ChatGPT installer: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download the official ChatGPT installer: {error}"))?;
    let total_bytes = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(download_path).map_err(|error| format!("create the official ChatGPT installer file: {error}"))?;
    let mut downloaded_bytes = 0_u64;
    let mut last_reported_percent = None;
    let mut last_reported_bytes = 0_u64;
    emit_install_progress(app, "downloading", 0, total_bytes);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("read the official ChatGPT installer: {error}"))?;
        file.write_all(&chunk).map_err(|error| format!("save the official ChatGPT installer: {error}"))?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        let percent = total_bytes
            .filter(|total| *total > 0)
            .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(100)) as u8);
        if percent != last_reported_percent || downloaded_bytes.saturating_sub(last_reported_bytes) >= 4 * 1024 * 1024 {
            emit_install_progress(app, "downloading", downloaded_bytes, total_bytes);
            last_reported_percent = percent;
            last_reported_bytes = downloaded_bytes;
        }
    }
    file.sync_all().map_err(|error| format!("finish saving the official ChatGPT installer: {error}"))?;
    Ok(())
}

fn emit_install_progress(app: &AppHandle, stage: &str, downloaded_bytes: u64, total_bytes: Option<u64>) {
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
        },
    );
}

pub fn open_installed_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = local_installation()
            .map(|installation| installation.path)
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

#[cfg(target_os = "windows")]
fn windows_app_user_model_id() -> Result<String, String> {
    let script = "$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -eq $package) { exit 1 }; $manifest = Get-AppxPackageManifest -Package $package; $application = $manifest.Package.Applications.Application | Select-Object -First 1; if ($null -eq $application) { exit 1 }; Write-Output ($package.PackageFamilyName + '!' + $application.Id)";
    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|error| format!("query the installed ChatGPT package: {error}"))?;
    if !output.status.success() {
        return Err("ChatGPT is not installed yet, or Windows could not find its packaged app entry.".to_string());
    }
    let app_user_model_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if app_user_model_id.is_empty() {
        return Err("Windows returned an empty ChatGPT app identity. Open ChatGPT once from the Start menu, then try again.".to_string());
    }
    Ok(app_user_model_id)
}

async fn latest_version() -> Result<String, String> {
    let client = desktop_http_client(Some(Duration::from_secs(10)))
        .map_err(|error| format!("prepare the Codex update check: {error}"))?;

    let snapshot = client
        .get(CODEX_VERSION_API_URL)
        .send()
        .await
        .map_err(|error| format!("request the AUTO Gateway Codex version service: {error}"))?
        .error_for_status()
        .map_err(|error| format!("request the AUTO Gateway Codex version service: {error}"))?
        .json::<CodexVersionSnapshot>()
        .await
        .map_err(|error| format!("read the AUTO Gateway Codex version response: {error}"))?;

    #[cfg(target_os = "macos")]
    return Ok(snapshot.macos.version);

    #[cfg(target_os = "windows")]
    return Ok(snapshot.windows.version);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Codex update checks are available on macOS and Windows only.".to_string())
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = numeric_version_parts(left);
    let right_parts = numeric_version_parts(right);
    let count = left_parts.len().max(right_parts.len());
    for index in 0..count {
        let ordering = left_parts.get(index).unwrap_or(&0).cmp(right_parts.get(index).unwrap_or(&0));
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
    let path = installation_candidates().into_iter().find(|path| path.exists())?;
    let plist = path.join("Contents/Info.plist");
    let version = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleShortVersionString"])
        .arg(plist)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());
    Some(LocalInstallation { path, version })
}

#[cfg(target_os = "windows")]
fn local_installation() -> Option<LocalInstallation> {
    let script = "$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $package) { Write-Output $package.Version.ToString(); Write-Output $package.InstallLocation }";
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
                return Some(LocalInstallation { path: PathBuf::from(path), version: Some(version) });
            }
        }
    }

    let path = installation_candidates().into_iter().find(|path| path.exists())?;
    let escaped_path = path.display().to_string().replace('\'', "''");
    let version_script = format!("(Get-Item -LiteralPath '{escaped_path}').VersionInfo.ProductVersion");
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

#[cfg(target_os = "windows")]
fn download_url() -> Result<&'static str, String> {
    Ok(WINDOWS_DOWNLOAD_URL)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn download_url() -> Result<&'static str, String> {
    Err("This desktop build supports macOS and Windows only.".to_string())
}

#[cfg(target_os = "macos")]
fn download_extension() -> &'static str {
    "dmg"
}

#[cfg(target_os = "windows")]
fn download_extension() -> &'static str {
    "exe"
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn download_extension() -> &'static str {
    "installer"
}

#[cfg(target_os = "macos")]
fn install_downloaded_app(download_path: &Path, preferred_destination: Option<&Path>) -> Result<InstallerResult, String> {
    let output = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly"])
        .arg(download_path)
        .output()
        .map_err(|error| format!("mount the official ChatGPT installer: {error}"))?;
    if !output.status.success() {
        return Err(format!("mount the official ChatGPT installer: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let mount_path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split('\t').last())
        .map(str::trim)
        .find(|value| value.starts_with("/Volumes/"))
        .map(PathBuf::from)
        .ok_or_else(|| "locate the mounted ChatGPT installer.".to_string())?;
    let source = [mount_path.join("ChatGPT.app"), mount_path.join("Codex.app")]
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "locate ChatGPT in the mounted installer.".to_string())?;
    let install_result = copy_macos_app(&source, preferred_destination);
    let detach_result = Command::new("hdiutil")
        .arg("detach")
        .arg(&mount_path)
        .output()
        .map_err(|error| format!("unmount the official ChatGPT installer: {error}"));
    let _ = fs::remove_file(download_path);
    install_result?;
    detach_result?;
    Ok(InstallerResult::Complete)
}

#[cfg(target_os = "macos")]
fn copy_macos_app(source: &Path, preferred_destination: Option<&Path>) -> Result<(), String> {
    let mut destinations = Vec::new();
    if let Some(destination) = preferred_destination {
        destinations.push(destination.to_path_buf());
    }
    let system_destination = PathBuf::from("/Applications/ChatGPT.app");
    if !destinations.contains(&system_destination) {
        destinations.push(system_destination);
    }
    if let Some(home) = dirs::home_dir() {
        let user_destination = home.join("Applications/ChatGPT.app");
        if !destinations.contains(&user_destination) {
            destinations.push(user_destination);
        }
    }
    let mut last_error = String::new();
    for destination in destinations {
        match replace_macos_app(source, &destination) {
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
    let parent = destination.parent().ok_or_else(|| "resolve the ChatGPT installation directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create the ChatGPT installation directory: {error}"))?;
    let operation_id = uuid::Uuid::new_v4();
    let staged = parent.join(format!(".autogateway-chatgpt-{operation_id}.app"));
    let backup = parent.join(format!(".autogateway-chatgpt-{operation_id}.backup.app"));

    let copy_output = Command::new("ditto")
        .arg(source)
        .arg(&staged)
        .output()
        .map_err(|error| format!("stage ChatGPT in Applications: {error}"))?;
    if !copy_output.status.success() {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!("stage ChatGPT in Applications: {}", String::from_utf8_lossy(&copy_output.stderr).trim()));
    }

    let verify_output = Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&staged)
        .output()
        .map_err(|error| format!("verify the official ChatGPT signature: {error}"))?;
    if !verify_output.status.success() {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!("verify the official ChatGPT signature: {}", String::from_utf8_lossy(&verify_output.stderr).trim()));
    }

    if destination.exists() {
        if let Err(error) = quit_macos_app(destination) {
            let _ = fs::remove_dir_all(&staged);
            return Err(error);
        }
        if let Err(error) = fs::rename(destination, &backup) {
            let _ = fs::remove_dir_all(&staged);
            return Err(format!("prepare the existing ChatGPT application for replacement: {error}"));
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
    let _ = Command::new("osascript")
        .args(["-e", "tell application id \"com.openai.codex\" to quit"])
        .output();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if !macos_app_is_running(app_path) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Codex is still running. Quit Codex completely, then try the update again.".to_string())
}

#[cfg(target_os = "macos")]
fn macos_app_is_running(app_path: &Path) -> bool {
    let prefix = format!("{}/Contents/", app_path.display());
    Command::new("ps")
        .args(["ax", "-o", "command="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .any(|command| command.starts_with(&prefix))
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn install_downloaded_app(download_path: &Path, _preferred_destination: Option<&Path>) -> Result<InstallerResult, String> {
    validate_windows_installer(download_path)?;
    Command::new(download_path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("run the official ChatGPT installer: {error}"))?;
    Ok(InstallerResult::AwaitingExternalInstallation)
}

#[cfg(target_os = "windows")]
fn validate_windows_installer(download_path: &Path) -> Result<(), String> {
    let contents = fs::read(download_path)
        .map_err(|error| format!("inspect the official ChatGPT installer: {error}"))?;
    if contents.starts_with(b"MZ") {
        return Ok(());
    }
    let _ = fs::remove_file(download_path);
    Err("the official download service did not return a valid Windows installer; try again later".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_downloaded_app(_download_path: &Path, _preferred_destination: Option<&Path>) -> Result<InstallerResult, String> {
    Err("This desktop build supports macOS and Windows only.".to_string())
}

#[cfg(target_os = "macos")]
fn installation_candidates() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/Applications/ChatGPT.app"), PathBuf::from("/Applications/Codex.app")];
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
    use super::compare_versions;
    use std::cmp::Ordering;

    #[test]
    fn compares_numeric_version_segments() {
        assert_eq!(compare_versions("26.730.61309", "26.727.51351"), Ordering::Greater);
        assert_eq!(compare_versions("26.730.61309", "26.730.61309"), Ordering::Equal);
        assert_eq!(compare_versions("26.730.61309.0", "26.730.61309"), Ordering::Equal);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replaces_existing_macos_app_after_signature_verification() {
        use super::replace_macos_app;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let root = std::env::temp_dir().join(format!("autogateway-app-replacement-test-{}", uuid::Uuid::new_v4()));
        let source = root.join("Source.app");
        let destination = root.join("Destination.app");
        write_test_app(&source, "updated");
        write_test_app(&destination, "existing");
        let signing = Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(&source)
            .output()
            .expect("run codesign for the test application");
        assert!(signing.status.success(), "codesign failed: {}", String::from_utf8_lossy(&signing.stderr));

        replace_macos_app(&source, &destination).expect("replace the test application");
        let executable = fs::read_to_string(destination.join("Contents/MacOS/TestApp")).expect("read the replaced executable");
        assert!(executable.contains("updated"));
        fs::remove_dir_all(root).expect("remove the application replacement fixture");

        fn write_test_app(path: &std::path::Path, marker: &str) {
            let executable_directory = path.join("Contents/MacOS");
            fs::create_dir_all(&executable_directory).expect("create the test application directory");
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
            fs::write(&executable, format!("#!/bin/sh\n# {marker}\nexit 0\n")).expect("write the test application executable");
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).expect("make the test application executable");
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
