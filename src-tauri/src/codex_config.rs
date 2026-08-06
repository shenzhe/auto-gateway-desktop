use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use toml_edit::{value, DocumentMut, Item, Table, Value as TomlValue};

const DEFAULT_MODEL: &str = "gpt-5.6-sol";

#[derive(Clone)]
pub struct CodexPaths {
    config: PathBuf,
    auth: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    config_path: String,
    auth_path: String,
    model_provider: Option<String>,
    config_valid: bool,
    config_exists: bool,
    auth_exists: bool,
    configured: bool,
    config_backup_count: usize,
    auth_backup_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationResult {
    config_path: String,
    auth_path: String,
    config_backup_path: Option<String>,
    auth_backup_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    config_backup_path: Option<String>,
    auth_backup_path: Option<String>,
}

pub fn default_codex_paths() -> Result<CodexPaths, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "unable to determine the current user home directory".to_string())?;
    let codex_directory = home.join(".codex");
    Ok(CodexPaths {
        config: codex_directory.join("config.toml"),
        auth: codex_directory.join("auth.json"),
    })
}

impl CodexPaths {
    pub fn status(&self) -> Result<CodexStatus, String> {
        let (configured, model_provider, config_valid) = match read_optional(&self.config)? {
            Some(content) => match content.parse::<DocumentMut>() {
                Ok(document) => {
                    let model_provider = document
                        .get("model_provider")
                        .and_then(Item::as_str)
                        .map(str::to_string);
                    let config_valid = model_provider
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty());
                    let configured = model_provider.as_deref() == Some("autogateway")
                        && document
                            .get("model_providers")
                            .and_then(Item::as_table)
                            .and_then(|providers| providers.get("autogateway"))
                            .is_some_and(Item::is_table);
                    (configured, model_provider, config_valid)
                }
                Err(_) => (false, None, false),
            },
            None => (false, None, false),
        };
        Ok(CodexStatus {
            config_path: self.config.display().to_string(),
            auth_path: self.auth.display().to_string(),
            model_provider,
            config_valid,
            config_exists: self.config.exists(),
            auth_exists: self.auth.exists(),
            configured,
            config_backup_count: backup_paths(&self.config)?.len(),
            auth_backup_count: backup_paths(&self.auth)?.len(),
        })
    }
}

pub fn apply_configuration(
    paths: &CodexPaths,
    api_key: &str,
    endpoint: &str,
) -> Result<ConfigurationResult, String> {
    let clean_key = normalize_api_key(api_key)?;
    let clean_endpoint = normalize_endpoint(endpoint)?;
    ensure_not_symlink(&paths.config)?;
    ensure_not_symlink(&paths.auth)?;
    let config_before = read_optional(&paths.config)?;
    let auth_before = read_optional(&paths.auth)?;
    let config_after = merge_config(config_before.as_deref(), &clean_endpoint)?;
    let auth_after = merge_auth(auth_before.as_deref(), &clean_key)?;

    let parent = paths
        .config
        .parent()
        .ok_or_else(|| "unable to determine the Codex directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create Codex directory: {error}"))?;
    let config_backup = backup_if_exists(&paths.config)?;
    let auth_backup = backup_if_exists(&paths.auth)?;

    if let Err(error) = atomic_write(&paths.config, config_after.as_bytes()) {
        return Err(with_restore_result(
            format!("write Codex configuration file: {error}"),
            restore_previous(&paths.config, config_before.as_deref()),
        ));
    }
    if let Err(error) = atomic_write(&paths.auth, auth_after.as_bytes()) {
        let config_restore = restore_previous(&paths.config, config_before.as_deref());
        let auth_restore = restore_previous(&paths.auth, auth_before.as_deref());
        return Err(with_restore_result(
            with_restore_result(
                format!("write Codex authentication file: {error}"),
                config_restore,
            ),
            auth_restore,
        ));
    }

    Ok(ConfigurationResult {
        config_path: paths.config.display().to_string(),
        auth_path: paths.auth.display().to_string(),
        config_backup_path: config_backup.map(|path| path.display().to_string()),
        auth_backup_path: auth_backup.map(|path| path.display().to_string()),
    })
}

pub fn restore_latest_backups(paths: &CodexPaths) -> Result<RestoreResult, String> {
    let config_backup = latest_backup_path(&paths.config)?;
    let auth_backup = latest_backup_path(&paths.auth)?;
    if config_backup.is_none() && auth_backup.is_none() {
        return Err("no Codex configuration backups are available".to_string());
    }
    let config_before = read_optional(&paths.config)?;
    let auth_before = read_optional(&paths.auth)?;
    if let Some(backup) = &config_backup {
        restore_from_backup(backup, &paths.config)?;
    }
    if let Some(backup) = &auth_backup {
        if let Err(error) = restore_from_backup(backup, &paths.auth) {
            let config_restore = restore_previous(&paths.config, config_before.as_deref());
            let auth_restore = restore_previous(&paths.auth, auth_before.as_deref());
            return Err(with_restore_result(
                with_restore_result(
                    format!("restore Codex authentication backup: {error}"),
                    config_restore,
                ),
                auth_restore,
            ));
        }
    }
    Ok(RestoreResult {
        config_backup_path: config_backup.map(|path| path.display().to_string()),
        auth_backup_path: auth_backup.map(|path| path.display().to_string()),
    })
}

fn normalize_api_key(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("an AUTO Gateway API key is required".to_string());
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
    {
        return Err("the API key contains unsupported characters".to_string());
    }
    Ok(value.to_string())
}

fn normalize_endpoint(raw: &str) -> Result<String, String> {
    let value = raw.trim().trim_end_matches('/');
    if !value.starts_with("https://") {
        return Err("the gateway endpoint must start with https://".to_string());
    }
    let parsed =
        url::Url::parse(value).map_err(|_| "the gateway endpoint is invalid".to_string())?;
    if parsed.host_str().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "the gateway endpoint must be an origin without a query or fragment".to_string(),
        );
    }
    Ok(value.to_string())
}

fn merge_config(existing: Option<&str>, endpoint: &str) -> Result<String, String> {
    let mut document = match existing {
        Some(content) => content
            .parse::<DocumentMut>()
            .map_err(|error| format!("existing config.toml is invalid: {error}"))?,
        None => DocumentMut::new(),
    };
    document["model_provider"] = value("autogateway");
    document["model"] = value(DEFAULT_MODEL);
    document["review_model"] = value(DEFAULT_MODEL);
    document["model_reasoning_effort"] = value("high");
    document["disable_response_storage"] = value(true);
    document["network_access"] = value("enabled");

    let has_model_providers_table = document.get("model_providers").is_some_and(Item::is_table);
    if !has_model_providers_table {
        document["model_providers"] = Item::Table(Table::new());
    }
    let mut provider = document["model_providers"]
        .as_table()
        .and_then(|providers| providers.get("autogateway"))
        .and_then(Item::as_table)
        .cloned()
        .unwrap_or_else(Table::new);
    provider["name"] = value("AUTO Gateway");
    provider["base_url"] = value(format!("{endpoint}/v1"));
    provider["wire_api"] = value("responses");
    provider["requires_openai_auth"] = value(false);
    let mut headers = toml_edit::InlineTable::new();
    headers.insert(
        "x-openai-actor-authorization",
        TomlValue::from("autogateway.cc"),
    );
    provider["http_headers"] = Item::Value(TomlValue::InlineTable(headers));
    let providers = document["model_providers"]
        .as_table_mut()
        .ok_or_else(|| "model_providers must be a TOML table".to_string())?;
    providers["autogateway"] = Item::Table(provider);
    Ok(document.to_string())
}

fn merge_auth(existing: Option<&str>, api_key: &str) -> Result<String, String> {
    let mut object = match existing {
        Some(content) => match serde_json::from_str::<JsonValue>(content)
            .map_err(|error| format!("existing auth.json is invalid: {error}"))?
        {
            JsonValue::Object(object) => object,
            _ => return Err("existing auth.json must contain a JSON object".to_string()),
        },
        None => Map::new(),
    };
    object.insert(
        "OPENAI_API_KEY".to_string(),
        JsonValue::String(api_key.to_string()),
    );
    serde_json::to_string_pretty(&JsonValue::Object(object))
        .map(|content| format!("{content}\n"))
        .map_err(|error| format!("encode auth.json: {error}"))
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("read {}: {error}", path.display()))
}

fn ensure_not_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "refusing to modify symbolic link {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect {}: {error}", path.display())),
    }
}

fn with_restore_result(message: String, restore: Result<(), String>) -> String {
    match restore {
        Ok(()) => message,
        Err(error) => format!("{message}; automatic restore also failed: {error}"),
    }
}

fn backup_if_exists(path: &Path) -> Result<Option<PathBuf>, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("read system clock: {error}"))?
        .as_nanos();
    let was_present = path.exists();
    let mut backup = PathBuf::from(if was_present {
        format!("{}.bak.{timestamp}", path.display())
    } else {
        format!("{}.bak.{timestamp}.missing", path.display())
    });
    let mut suffix = 0_u32;
    while backup.exists() {
        suffix += 1;
        backup = PathBuf::from(if was_present {
            format!("{}.bak.{timestamp}.{suffix}", path.display())
        } else {
            format!("{}.bak.{timestamp}.{suffix}.missing", path.display())
        });
    }
    if was_present {
        fs::copy(path, &backup).map_err(|error| format!("back up {}: {error}", path.display()))?;
    } else {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
            .map_err(|error| format!("record missing {}: {error}", path.display()))?;
        set_private_permissions(&backup)?;
    }
    Ok(Some(backup))
}

fn backup_paths(path: &Path) -> Result<Vec<PathBuf>, String> {
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return Ok(Vec::new()),
    };
    let filename = match path.file_name().and_then(|name| name.to_str()) {
        Some(filename) => filename,
        None => return Ok(Vec::new()),
    };
    let prefix = format!("{filename}.bak.");
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "list Codex backups in {}: {error}",
                parent.display()
            ))
        }
    };
    let mut backups = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("read Codex backup entry: {error}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(&prefix) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("inspect Codex backup {}: {error}", entry.path().display()))?;
        if metadata.is_file() && !metadata.file_type().is_symlink() {
            backups.push(entry.path());
        }
    }
    backups.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    Ok(backups)
}

fn latest_backup_path(path: &Path) -> Result<Option<PathBuf>, String> {
    Ok(backup_paths(path)?.into_iter().next())
}

fn restore_from_backup(backup: &Path, destination: &Path) -> Result<(), String> {
    ensure_not_symlink(backup)?;
    ensure_not_symlink(destination)?;
    if backup_represents_missing_file(backup) {
        if destination.exists() {
            fs::remove_file(destination).map_err(|error| {
                format!("remove restored file {}: {error}", destination.display())
            })?;
        }
        return Ok(());
    }
    let content =
        fs::read(backup).map_err(|error| format!("read backup {}: {error}", backup.display()))?;
    atomic_write(destination, &content)
        .map_err(|error| format!("write {}: {error}", destination.display()))
}

fn backup_represents_missing_file(backup: &Path) -> bool {
    backup
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".missing"))
}

fn restore_previous(path: &Path, previous: Option<&str>) -> Result<(), String> {
    match previous {
        Some(content) => atomic_write(path, content.as_bytes()),
        None if path.exists() => fs::remove_file(path)
            .map_err(|error| format!("remove incomplete {}: {error}", path.display())),
        None => Ok(()),
    }
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("determine parent for {}", path.display()))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("codex"),
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("create temporary configuration: {error}"))?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("write temporary configuration: {error}"))?;
    set_private_permissions(&temporary)?;
    if let Err(first_error) = fs::rename(&temporary, path) {
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("replace existing configuration: {error}"))?;
            fs::rename(&temporary, path)
                .map_err(|error| format!("replace configuration after {first_error}: {error}"))?;
        } else {
            return Err(format!("replace configuration: {first_error}"));
        }
    }
    set_private_permissions(path)
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("set private permissions for {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        backup_if_exists, backup_paths, merge_auth, merge_config, normalize_endpoint,
        restore_from_backup, CodexPaths,
    };
    use std::fs;
    use toml_edit::Item;

    #[test]
    fn merges_gateway_provider_without_removing_existing_profile_data() {
        let existing = r#"
model = "other-model"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[model_providers.other]
name = "Other"
base_url = "https://example.com/v1"
"#;
        let merged = merge_config(Some(existing), "https://api.autogateway.cc")
            .expect("merge configuration");
        assert!(merged.contains("[mcp_servers.docs]"));
        assert!(merged.contains("[model_providers.other]"));
        assert!(merged.contains("model_provider = \"autogateway\""));
        assert!(merged.contains("base_url = \"https://api.autogateway.cc/v1\""));
    }

    #[test]
    fn merges_gateway_provider_when_model_providers_are_missing() {
        let existing = "model = \"gpt-5.6-sol\"\n";
        let merged = merge_config(Some(existing), "https://api.autogateway.cc")
            .expect("merge configuration");
        let document = merged
            .parse::<toml_edit::DocumentMut>()
            .expect("parse merged configuration");
        assert_eq!(
            document.get("model_provider").and_then(Item::as_str),
            Some("autogateway")
        );
        assert!(document
            .get("model_providers")
            .and_then(Item::as_table)
            .and_then(|providers| providers.get("autogateway"))
            .is_some_and(Item::is_table));
    }

    #[test]
    fn merges_auth_without_removing_other_values() {
        let merged = merge_auth(Some(r#"{ "CUSTOM_FIELD": "kept" }"#), "agk_example_secret")
            .expect("merge auth");
        assert!(merged.contains("CUSTOM_FIELD"));
        assert!(merged.contains("OPENAI_API_KEY"));
        assert!(merged.contains("agk_example_secret"));
    }

    #[test]
    fn accepts_https_origins_only() {
        assert_eq!(
            normalize_endpoint("https://api.autogateway.cc/"),
            Ok("https://api.autogateway.cc".to_string())
        );
        assert!(normalize_endpoint("http://api.autogateway.cc").is_err());
        assert!(normalize_endpoint("https://api.autogateway.cc/?key=value").is_err());
    }

    #[test]
    fn lists_newest_backup_first() {
        let directory = std::env::temp_dir().join(format!(
            "autogateway-codex-backup-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let config = directory.join("config.toml");
        fs::write(directory.join("config.toml.bak.100"), "old").expect("write old backup");
        fs::write(directory.join("config.toml.bak.200"), "new").expect("write new backup");
        let backups = backup_paths(&config).expect("list backups");
        assert_eq!(backups.len(), 2);
        assert!(backups[0].ends_with("config.toml.bak.200"));
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn restores_files_that_did_not_exist_before_configuration() {
        let directory = std::env::temp_dir().join(format!(
            "autogateway-missing-backup-test-{}",
            std::process::id()
        ));
        let config = directory.join("config.toml");
        fs::create_dir_all(&directory).expect("create test directory");
        let backup = backup_if_exists(&config)
            .expect("create missing-file backup")
            .expect("missing-file backup path");
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".missing"));
        fs::write(&config, "generated by AUTO Gateway").expect("write generated configuration");
        restore_from_backup(&backup, &config).expect("restore missing file snapshot");
        assert!(!config.exists());
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn status_handles_configs_without_model_provider_tables() {
        let directory = std::env::temp_dir().join(format!(
            "autogateway-codex-status-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let config = directory.join("config.toml");
        let auth = directory.join("auth.json");
        fs::write(&config, "model = \"gpt-5\"\n").expect("write config");
        let status = CodexPaths { config, auth }.status().expect("read status");
        assert!(!status.configured);
        assert!(!status.config_valid);
        assert_eq!(status.model_provider, None);
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn status_reports_provider_and_rejects_invalid_toml() {
        let directory = std::env::temp_dir().join(format!(
            "autogateway-codex-provider-status-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let config = directory.join("config.toml");
        let auth = directory.join("auth.json");

        fs::write(&config, "model_provider = \"openai\"\n").expect("write config");
        let status = CodexPaths {
            config: config.clone(),
            auth: auth.clone(),
        }
        .status()
        .expect("read valid status");
        assert!(status.config_valid);
        assert_eq!(status.model_provider.as_deref(), Some("openai"));
        assert!(!status.configured);

        fs::write(&config, "model_provider = [\n").expect("write invalid config");
        let status = CodexPaths { config, auth }
            .status()
            .expect("read invalid status");
        assert!(!status.config_valid);
        assert_eq!(status.model_provider, None);
        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
