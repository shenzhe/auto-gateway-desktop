use crate::http_client::client as desktop_http_client;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zeroize::Zeroize;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const AUTO_GATEWAY_API_BASE_URL: &str = "https://api.autogateway.cc";
const INSTALLATION_ID_FILE: &str = "installation-id";
const ENCRYPTED_STATE_FILE: &str = "desktop-session.enc.json";
const ENCRYPTED_STATE_FORMAT: &str = "autogateway-desktop-session";
const ENCRYPTED_STATE_VERSION: u8 = 1;
const ENCRYPTION_CONTEXT: &[u8] = b"cc.autogateway.desktop/session-file/v1";
const CREDENTIAL_SERVICE: &str = "cc.autogateway.desktop";
const CREDENTIAL_ACCOUNT: &str = "desktop-session";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUser {
    pub id: i64,
    pub username: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub name: String,
    pub role: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSession {
    pub token: String,
    pub refresh_token: String,
    pub user: DesktopUser,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDesktopState {
    pub session: DesktopSession,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedDesktopState {
    format: String,
    version: u8,
    algorithm: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrapKey {
    #[serde(default)]
    pub api_key: String,
    pub created: bool,
}

#[derive(Deserialize)]
pub struct DesktopConsoleTicket {
    pub ticket: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccountSummary {
    pub balance: String,
}

#[derive(Deserialize)]
struct DesktopPurchaseResponse {
    account: DesktopAccountSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopExchangeRequest<'a> {
    code: &'a str,
    code_verifier: &'a str,
    state: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrapRequest<'a> {
    installation_id: &'a str,
    rotate_existing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshSessionRequest<'a> {
    refresh_token: &'a str,
}

#[derive(Deserialize)]
struct APIErrorResponse {
    error: Option<String>,
}

enum SessionRefreshError {
    Unauthorized,
    Other(String),
}

pub fn installation_id(app: &AppHandle) -> Result<String, String> {
    let directory = application_data_directory(app)?;
    let path = directory.join(INSTALLATION_ID_FILE);
    if path.exists() {
        set_private_file_permissions(&path)?;
        let value = fs::read_to_string(&path)
            .map_err(|error| format!("read desktop installation ID: {error}"))?;
        let value = value.trim().to_string();
        if Uuid::parse_str(&value).is_ok() {
            return Ok(value);
        }
        return Err("desktop installation ID is invalid; remove the application data file and sign in again".to_string());
    }
    let value = Uuid::new_v4().to_string();
    let temporary = directory.join(format!(
        ".{INSTALLATION_ID_FILE}.{}.tmp",
        std::process::id()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("create installation ID file: {error}"))?;
    file.write_all(value.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("write installation ID file: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("save installation ID file: {error}"))?;
    set_private_file_permissions(&path)?;
    Ok(value)
}

pub async fn exchange_desktop_authorization(
    code: &str,
    code_verifier: &str,
    state: &str,
) -> Result<DesktopSession, String> {
    let response = desktop_http_client()?
        .post(format!(
            "{AUTO_GATEWAY_API_BASE_URL}/user/api/desktop/exchange"
        ))
        .json(&DesktopExchangeRequest {
            code,
            code_verifier,
            state,
        })
        .send()
        .await
        .map_err(|error| format!("contact AUTO Gateway: {error}"))?;
    decode_response(response, "exchange desktop authorization").await
}

pub fn save_desktop_session(app: &AppHandle, session: &DesktopSession) -> Result<(), String> {
    save_stored_state(
        app,
        &StoredDesktopState {
            session: session.clone(),
            api_key: String::new(),
        },
    )
}

pub fn clear_desktop_session(app: &AppHandle) -> Result<(), String> {
    delete_stored_state(app)
}

pub async fn restore_desktop_state(app: &AppHandle) -> Result<Option<StoredDesktopState>, String> {
    let Some(mut stored) = load_stored_state(app)? else {
        return Ok(None);
    };
    match refresh_desktop_session(&stored.session.refresh_token).await {
        Ok(session) => {
            stored.session = session;
            save_stored_state(app, &stored)?;
            Ok(Some(stored))
        }
        Err(SessionRefreshError::Unauthorized) => {
            delete_stored_state(app)?;
            Ok(None)
        }
        Err(SessionRefreshError::Other(error)) => {
            drop(error);
            Ok(Some(stored))
        }
    }
}

pub fn save_desktop_api_key(app: &AppHandle, api_key: &str) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Ok(());
    }
    let mut stored =
        load_stored_state(app)?.ok_or_else(|| "desktop session is not stored".to_string())?;
    stored.api_key = api_key.to_string();
    save_stored_state(app, &stored)
}

pub fn clear_stored_desktop_api_key(app: &AppHandle) -> Result<(), String> {
    let Some(mut stored) = load_stored_state(app)? else {
        return Ok(());
    };
    stored.api_key.clear();
    save_stored_state(app, &stored)
}

pub async fn bootstrap_desktop_key(
    access_token: &str,
    installation_id: &str,
    rotate_existing: bool,
) -> Result<DesktopBootstrapKey, String> {
    let response = desktop_http_client()?
        .post(format!(
            "{AUTO_GATEWAY_API_BASE_URL}/user/api/desktop/bootstrap"
        ))
        .bearer_auth(access_token.trim())
        .json(&DesktopBootstrapRequest {
            installation_id,
            rotate_existing,
        })
        .send()
        .await
        .map_err(|error| format!("contact AUTO Gateway: {error}"))?;
    decode_response(response, "create desktop API key").await
}

pub async fn create_desktop_console_ticket(
    access_token: &str,
) -> Result<DesktopConsoleTicket, String> {
    let response = desktop_http_client()?
        .post(format!(
            "{AUTO_GATEWAY_API_BASE_URL}/user/api/desktop/console-ticket"
        ))
        .bearer_auth(access_token.trim())
        .send()
        .await
        .map_err(|error| format!("contact AUTO Gateway: {error}"))?;
    decode_response(response, "create desktop console ticket").await
}

pub async fn desktop_account_summary(access_token: &str) -> Result<DesktopAccountSummary, String> {
    let response = desktop_http_client()?
        .get(format!("{AUTO_GATEWAY_API_BASE_URL}/user/api/purchase"))
        .bearer_auth(access_token.trim())
        .send()
        .await
        .map_err(|error| format!("contact AUTO Gateway: {error}"))?;
    Ok(
        decode_response::<DesktopPurchaseResponse>(response, "read desktop account")
            .await?
            .account,
    )
}

async fn refresh_desktop_session(
    refresh_token: &str,
) -> Result<DesktopSession, SessionRefreshError> {
    let response = desktop_http_client()
        .map_err(SessionRefreshError::Other)?
        .post(format!(
            "{AUTO_GATEWAY_API_BASE_URL}/user/api/session/refresh"
        ))
        .json(&RefreshSessionRequest { refresh_token })
        .send()
        .await
        .map_err(|error| SessionRefreshError::Other(format!("contact AUTO Gateway: {error}")))?;
    let status = response.status();
    if status.is_success() {
        return response.json::<DesktopSession>().await.map_err(|error| {
            SessionRefreshError::Other(format!("decode AUTO Gateway response: {error}"))
        });
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(SessionRefreshError::Unauthorized);
    }
    let error = response
        .json::<APIErrorResponse>()
        .await
        .ok()
        .and_then(|payload| payload.error)
        .unwrap_or_else(|| format!("request failed with HTTP {status}"));
    Err(SessionRefreshError::Other(format!(
        "refresh desktop session: {error}"
    )))
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|error| format!("open the legacy operating-system credential store: {error}"))
}

fn load_stored_state(app: &AppHandle) -> Result<Option<StoredDesktopState>, String> {
    let path = encrypted_state_path(app)?;
    if path.exists() {
        reject_symbolic_link(&path)?;
        set_private_file_permissions(&path)?;
        let value = fs::read(&path)
            .map_err(|error| format!("read the encrypted desktop session file: {error}"))?;
        return decrypt_stored_state(app, &value).map(Some);
    }

    let Some(stored) = load_legacy_stored_state()? else {
        return Ok(None);
    };
    save_stored_state(app, &stored)?;
    if let Err(error) = delete_legacy_stored_state() {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(Some(stored))
}

fn load_legacy_stored_state() -> Result<Option<StoredDesktopState>, String> {
    let entry = credential_entry()?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => {
            return Err(format!(
            "read the desktop session from the legacy operating-system credential store: {error}"
        ))
        }
    };
    let stored = serde_json::from_str::<StoredDesktopState>(&value)
        .map_err(|error| format!("decode the legacy stored desktop session: {error}"))?;
    Ok(Some(stored))
}

fn save_stored_state(app: &AppHandle, stored: &StoredDesktopState) -> Result<(), String> {
    let path = encrypted_state_path(app)?;
    let value = encrypt_stored_state(app, stored)?;
    write_private_file(&path, &value)
}

fn delete_stored_state(app: &AppHandle) -> Result<(), String> {
    let path = encrypted_state_path(app)?;
    if path.exists() {
        reject_symbolic_link(&path)?;
        fs::remove_file(&path)
            .map_err(|error| format!("remove the encrypted desktop session file: {error}"))?;
    }
    delete_legacy_stored_state()
}

fn delete_legacy_stored_state() -> Result<(), String> {
    let entry = credential_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "remove the desktop session from the legacy operating-system credential store: {error}"
        )),
    }
}

fn encrypt_stored_state(app: &AppHandle, stored: &StoredDesktopState) -> Result<Vec<u8>, String> {
    encrypt_stored_state_with_key(stored, encryption_key(app)?)
}

fn encrypt_stored_state_with_key(
    stored: &StoredDesktopState,
    mut key: [u8; 32],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("prepare desktop session encryption: {error}"))?;
    key.zeroize();
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut plaintext = serde_json::to_vec(stored)
        .map_err(|error| format!("encode the desktop session: {error}"))?;
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: &plaintext,
                aad: ENCRYPTION_CONTEXT,
            },
        )
        .map_err(|error| format!("encrypt the desktop session: {error}"))?;
    plaintext.zeroize();
    serde_json::to_vec(&EncryptedDesktopState {
        format: ENCRYPTED_STATE_FORMAT.to_string(),
        version: ENCRYPTED_STATE_VERSION,
        algorithm: "AES-256-GCM".to_string(),
        nonce: STANDARD_NO_PAD.encode(nonce),
        ciphertext: STANDARD_NO_PAD.encode(ciphertext),
    })
    .map_err(|error| format!("encode the encrypted desktop session file: {error}"))
}

fn decrypt_stored_state(app: &AppHandle, value: &[u8]) -> Result<StoredDesktopState, String> {
    decrypt_stored_state_with_key(value, encryption_key(app)?)
}

fn decrypt_stored_state_with_key(
    value: &[u8],
    mut key: [u8; 32],
) -> Result<StoredDesktopState, String> {
    let encrypted = serde_json::from_slice::<EncryptedDesktopState>(value)
        .map_err(|error| format!("decode the encrypted desktop session file: {error}"))?;
    if encrypted.format != ENCRYPTED_STATE_FORMAT
        || encrypted.version != ENCRYPTED_STATE_VERSION
        || encrypted.algorithm != "AES-256-GCM"
    {
        return Err("the encrypted desktop session file uses an unsupported format".to_string());
    }
    let nonce = STANDARD_NO_PAD
        .decode(encrypted.nonce)
        .map_err(|error| format!("decode the desktop session nonce: {error}"))?;
    if nonce.len() != 12 {
        return Err("the encrypted desktop session file contains an invalid nonce".to_string());
    }
    let ciphertext = STANDARD_NO_PAD
        .decode(encrypted.ciphertext)
        .map_err(|error| format!("decode the encrypted desktop session: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("prepare desktop session decryption: {error}"))?;
    key.zeroize();
    let mut plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: ENCRYPTION_CONTEXT,
            },
        )
        .map_err(|_| {
            "decrypt the desktop session: the file is damaged or belongs to another computer user"
                .to_string()
        })?;
    let stored = serde_json::from_slice::<StoredDesktopState>(&plaintext)
        .map_err(|error| format!("decode the decrypted desktop session: {error}"));
    plaintext.zeroize();
    stored
}

fn encryption_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let installation = installation_id(app)?;
    let machine_binding = platform_machine_binding()?;
    let derivation = Hkdf::<Sha256>::new(Some(ENCRYPTION_CONTEXT), machine_binding.as_bytes());
    let mut key = [0_u8; 32];
    derivation
        .expand(installation.as_bytes(), &mut key)
        .map_err(|_| "derive the desktop session encryption key".to_string())?;
    Ok(key)
}

fn application_data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve application data directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("create application data directory: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("protect application data directory: {error}"))?;
    Ok(directory)
}

fn encrypted_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_directory(app)?.join(ENCRYPTED_STATE_FILE))
}

fn write_private_file(path: &Path, value: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "resolve the encrypted desktop session directory".to_string())?;
    let temporary = parent.join(format!(".{ENCRYPTED_STATE_FILE}.{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("create the encrypted desktop session file: {error}"))?;
    if let Err(error) = file.write_all(value).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("write the encrypted desktop session file: {error}"));
    }
    drop(file);
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("replace the encrypted desktop session file: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("save the encrypted desktop session file: {error}"));
    }
    set_private_file_permissions(path)
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    reject_symbolic_link(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("protect private application data: {error}"))?;
    Ok(())
}

fn reject_symbolic_link(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect private application data: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("private application data must be a regular file".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_machine_binding() -> Result<String, String> {
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|error| format!("read the macOS platform identifier: {error}"))?;
    if !output.status.success() {
        return Err("read the macOS platform identifier".to_string());
    }
    let platform_uuid = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.contains("\"IOPlatformUUID\""))
        .and_then(|line| {
            line.split_once('=')
                .map(|(_, value)| value.trim().trim_matches('\"').to_string())
        })
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "locate the macOS platform identifier".to_string())?;
    let user_output = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|error| format!("read the macOS user identifier: {error}"))?;
    if !user_output.status.success() {
        return Err("read the macOS user identifier".to_string());
    }
    let user_id = String::from_utf8_lossy(&user_output.stdout)
        .trim()
        .to_string();
    Ok(format!("macos:{platform_uuid}:uid:{user_id}"))
}

#[cfg(target_os = "windows")]
fn platform_machine_binding() -> Result<String, String> {
    let machine_output = Command::new("reg.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "QUERY",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .map_err(|error| format!("read the Windows machine identifier: {error}"))?;
    if !machine_output.status.success() {
        return Err("read the Windows machine identifier".to_string());
    }
    let machine_text = String::from_utf8_lossy(&machine_output.stdout);
    let machine_id = machine_text
        .lines()
        .find(|line| line.contains("MachineGuid"))
        .and_then(|line| line.split_whitespace().last())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "locate the Windows machine identifier".to_string())?
        .to_string();
    let user_output = Command::new("whoami.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .arg("/user")
        .output()
        .map_err(|error| format!("read the Windows user identifier: {error}"))?;
    if !user_output.status.success() {
        return Err("read the Windows user identifier".to_string());
    }
    let user_text = String::from_utf8_lossy(&user_output.stdout);
    let user_id = user_text
        .split_whitespace()
        .find(|value| value.starts_with("S-1-"))
        .ok_or_else(|| "locate the Windows user identifier".to_string())?
        .to_string();
    Ok(format!("windows:{machine_id}:sid:{user_id}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_machine_binding() -> Result<String, String> {
    Err("encrypted desktop sessions are supported on macOS and Windows only".to_string())
}

async fn decode_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    action: &str,
) -> Result<T, String> {
    let status = response.status();
    if status.is_success() {
        return response
            .json::<T>()
            .await
            .map_err(|error| format!("decode AUTO Gateway response: {error}"));
    }
    let error = response
        .json::<APIErrorResponse>()
        .await
        .ok()
        .and_then(|payload| payload.error)
        .unwrap_or_else(|| format!("request failed with HTTP {status}"));
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("AUTHENTICATION_REQUIRED: {action}: {error}"));
    }
    Err(format!("{action}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        decrypt_stored_state_with_key, encrypt_stored_state_with_key, DesktopSession, DesktopUser,
        StoredDesktopState,
    };

    fn stored_state() -> StoredDesktopState {
        StoredDesktopState {
            session: DesktopSession {
                token: "access-token-that-must-not-appear-in-the-file".to_string(),
                refresh_token: "refresh-token-that-must-not-appear-in-the-file".to_string(),
                user: DesktopUser {
                    id: 42,
                    username: "test-user".to_string(),
                    email: Some("test@example.com".to_string()),
                    display_name: Some("Test User".to_string()),
                    name: "Test User".to_string(),
                    role: "user".to_string(),
                },
            },
            api_key: "gateway-key-that-must-not-appear-in-the-file".to_string(),
        }
    }

    #[test]
    fn encrypted_session_roundtrips_without_plaintext_secrets() {
        let stored = stored_state();
        let encrypted = encrypt_stored_state_with_key(&stored, [7_u8; 32])
            .expect("encrypt the desktop session");
        let file_text =
            String::from_utf8(encrypted.clone()).expect("read the encrypted file as JSON");
        assert!(!file_text.contains(&stored.session.token));
        assert!(!file_text.contains(&stored.session.refresh_token));
        assert!(!file_text.contains(&stored.api_key));

        let decrypted = decrypt_stored_state_with_key(&encrypted, [7_u8; 32])
            .expect("decrypt the desktop session");
        assert_eq!(decrypted.session.token, stored.session.token);
        assert_eq!(
            decrypted.session.refresh_token,
            stored.session.refresh_token
        );
        assert_eq!(decrypted.api_key, stored.api_key);
    }

    #[test]
    fn encrypted_session_rejects_a_different_machine_key() {
        let encrypted = encrypt_stored_state_with_key(&stored_state(), [7_u8; 32])
            .expect("encrypt the desktop session");
        assert!(decrypt_stored_state_with_key(&encrypted, [8_u8; 32]).is_err());
    }
}
