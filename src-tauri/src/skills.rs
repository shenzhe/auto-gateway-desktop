use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use url::Url;
use uuid::Uuid;

const SKILL_MANIFEST_FILE: &str = "SKILL.md";
const SYSTEM_SKILLS_DIR: &str = ".system";

// Resource caps for reading a single skill's detail. A skill directory is
// untrusted input, so the recursive walk is bounded and never follows symlinks.
const MAX_DETAIL_FILES: usize = 5000;
const MAX_DETAIL_DEPTH: usize = 32;
const MAX_CHECKSUM_BYTES: u64 = 64 * 1024 * 1024;

/// Where the current user's Codex skills live. Mirrors `default_codex_paths`
/// in `codex_config.rs`, but honors an explicit `$CODEX_HOME` override the way
/// the official Codex tooling does.
pub fn default_skills_dir() -> Result<PathBuf, String> {
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        let codex_home = PathBuf::from(codex_home);
        if !codex_home.as_os_str().is_empty() {
            return Ok(codex_home.join("skills"));
        }
    }
    let home = dirs::home_dir()
        .ok_or_else(|| "unable to determine the current user home directory".to_string())?;
    Ok(home.join(".codex").join("skills"))
}

// `Plugin`/`External`/`Autogateway`/`Team` are classified in later milestones
// (plugin skills, external dirs, remote installs); kept for a stable wire enum.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceType {
    User,
    System,
    Plugin,
    External,
    Autogateway,
    Team,
}

// `SourceManaged` is assigned to plugin-owned skills in a later milestone.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ownership {
    UserManaged,
    SourceManaged,
    ReadOnly,
}

// `Error`/`SourceUnavailable` are surfaced by later milestones (detail scan,
// source health); kept here so the wire enum is stable.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillStatus {
    Enabled,
    Disabled,
    Error,
    SourceUnavailable,
}

// `Verified`/`KnownSource` are assigned once install provenance exists.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrustLevel {
    System,
    Verified,
    KnownSource,
    Unverified,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source_type: SourceType,
    pub source_uri: Option<String>,
    pub install_path: String,
    pub scope: String,
    pub ownership: Ownership,
    pub status: SkillStatus,
    pub version: Option<String>,
    pub checksum: Option<String>,
    pub category_id: Option<String>,
    pub tags: Vec<String>,
    pub trust_level: TrustLevel,
    pub installed_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_scanned_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanResult {
    pub skills: Vec<SkillRecord>,
    pub failed_sources: Vec<ScanFailure>,
    pub categories: Vec<SkillCategory>,
    pub scanned_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillFileKind {
    Markdown,
    Script,
    Reference,
    Asset,
    Agent,
    Other,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub is_executable: bool,
    pub kind: SkillFileKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub record: SkillRecord,
    pub files: Vec<SkillFileEntry>,
    pub scripts: Vec<String>,
    pub markdown_body: Option<String>,
    pub total_size_bytes: u64,
    pub file_count: usize,
    // True when the walk hit a resource cap; checksum is omitted in that case.
    pub truncated: bool,
}

/// Parsed `SKILL.md` YAML frontmatter. Only the fields the app surfaces are
/// modeled; `metadata` is captured as a shallow string map. Intentionally a
/// hand parser (no YAML dependency) — isolated here so it can be swapped for a
/// real YAML crate later without touching callers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

fn strip_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn split_key_value(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some((key.to_string(), value.to_string()))
}

pub fn parse_frontmatter(markdown: &str) -> Result<SkillFrontmatter, String> {
    let content = markdown.trim_start_matches('\u{feff}');
    let mut lines = content.lines();

    // The document must open with a `---` fence.
    match lines.next() {
        Some(first) if first.trim() == "---" => {}
        _ => return Err("SKILL.md is missing the opening frontmatter fence".to_string()),
    }

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut version: Option<String> = None;
    let mut metadata: BTreeMap<String, String> = BTreeMap::new();
    let mut in_metadata = false;
    let mut closed = false;

    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if in_metadata && indented {
            if let Some((key, value)) = split_key_value(line) {
                metadata.insert(key, strip_scalar(&value));
            }
            continue;
        }
        // A non-indented line ends any metadata block.
        in_metadata = false;
        let Some((key, value)) = split_key_value(line) else {
            continue;
        };
        match key.as_str() {
            "name" => name = Some(strip_scalar(&value)),
            "description" => description = Some(strip_scalar(&value)),
            "version" => version = Some(strip_scalar(&value)),
            "metadata" => {
                if strip_scalar(&value).is_empty() {
                    in_metadata = true;
                }
            }
            _ => {}
        }
    }

    if !closed {
        return Err("SKILL.md frontmatter is not terminated with a closing fence".to_string());
    }
    let name = name.filter(|value| !value.is_empty()).ok_or_else(|| {
        "SKILL.md frontmatter is missing a name".to_string()
    })?;
    let description = description
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "SKILL.md frontmatter is missing a description".to_string())?;

    Ok(SkillFrontmatter {
        name,
        description,
        version,
        metadata,
    })
}

/// Stable, machine-local identifier derived from the install path. Survives
/// restarts without an index. Replaced by an index-backed uuid in a later
/// milestone.
fn skill_id_for(install_path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(install_path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn system_time_to_millis(time: SystemTime) -> Option<String> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis().to_string())
}

fn now_millis() -> String {
    system_time_to_millis(SystemTime::now()).unwrap_or_else(|| "0".to_string())
}

fn dir_modified_millis(dir: &Path) -> Option<String> {
    let metadata = fs::metadata(dir).ok()?;
    let modified = metadata.modified().ok()?;
    system_time_to_millis(modified)
}

/// Build one skill record from its directory, or a failure describing why it
/// could not be read. A single bad directory never aborts the whole scan.
fn build_skill_record(
    dir: &Path,
    source_type: SourceType,
    ownership: Ownership,
    trust_level: TrustLevel,
    scanned_at: &str,
) -> Result<SkillRecord, ScanFailure> {
    let install_path = dir.display().to_string();
    let dir_name = dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();

    let manifest_path = dir.join(SKILL_MANIFEST_FILE);
    let manifest = fs::read_to_string(&manifest_path).map_err(|error| ScanFailure {
        path: install_path.clone(),
        reason: format!("read {SKILL_MANIFEST_FILE}: {error}"),
    })?;
    let frontmatter = parse_frontmatter(&manifest).map_err(|reason| ScanFailure {
        path: install_path.clone(),
        reason,
    })?;

    let name = if frontmatter.name.is_empty() {
        dir_name
    } else {
        frontmatter.name
    };
    let modified = dir_modified_millis(dir);

    Ok(SkillRecord {
        id: skill_id_for(dir),
        name,
        description: frontmatter.description,
        source_type,
        source_uri: None,
        install_path,
        scope: "global".to_string(),
        ownership,
        status: SkillStatus::Enabled,
        version: frontmatter.version,
        checksum: None,
        category_id: None,
        tags: Vec::new(),
        trust_level,
        installed_at: modified.clone(),
        updated_at: modified,
        last_scanned_at: scanned_at.to_string(),
    })
}

fn push_skill(
    result: &mut SkillScanResult,
    dir: &Path,
    source_type: SourceType,
    ownership: Ownership,
    trust_level: TrustLevel,
) {
    match build_skill_record(dir, source_type, ownership, trust_level, &result.scanned_at) {
        Ok(record) => result.skills.push(record),
        Err(failure) => result.failed_sources.push(failure),
    }
}

/// Pure scan of a skills directory. Injectable so it can be exercised against a
/// temp fixture in tests (mirrors the test style in `codex_config.rs`).
pub fn scan_skills_in(dir: &Path) -> SkillScanResult {
    let mut result = SkillScanResult {
        skills: Vec::new(),
        failed_sources: Vec::new(),
        categories: Vec::new(),
        scanned_at: now_millis(),
    };

    if !dir.exists() {
        return result;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            result.failed_sources.push(ScanFailure {
                path: dir.display().to_string(),
                reason: format!("read the skills directory: {error}"),
            });
            return result;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();

        if name == SYSTEM_SKILLS_DIR {
            // System skills live one level down and are read-only.
            let system_entries = match fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for system_entry in system_entries.flatten() {
                let system_path = system_entry.path();
                if !system_path.is_dir() {
                    continue;
                }
                push_skill(
                    &mut result,
                    &system_path,
                    SourceType::System,
                    Ownership::ReadOnly,
                    TrustLevel::System,
                );
            }
            continue;
        }

        // Skip other hidden/scratch directories (temp, AUTO Gateway internals).
        if name.starts_with('.') {
            continue;
        }

        push_skill(
            &mut result,
            &path,
            SourceType::User,
            Ownership::UserManaged,
            TrustLevel::Unverified,
        );
    }

    result.skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    result
}

/// Scan the current user's Codex skills directory. Returns an empty result when
/// the directory does not exist (Codex not installed or no skills yet) rather
/// than surfacing an error to the UI.
/// Scan the skills directory and merge in AUTO Gateway index data (stable ids,
/// categories, tags), persisting the index when new skills are discovered.
fn reconciled_scan(app: &tauri::AppHandle) -> Result<SkillScanResult, String> {
    let dir = default_skills_dir()?;
    let index_path = skill_index_path(app)?;
    let mut index = load_index_at(&index_path);
    let mut result = scan_skills_in(&dir);
    let changed = reconcile_index(&mut index, &mut result);
    if changed {
        save_index_at(&index_path, &index)?;
    }
    append_disabled_skills(&index, &mut result);
    result
        .skills
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    result.categories = index.categories.clone();
    Ok(result)
}

/// Disabled skills live in quarantine (outside the scan root), so add them back
/// to the result from the index so the UI can list and re-enable them.
fn append_disabled_skills(index: &SkillIndex, result: &mut SkillScanResult) {
    for entry in index.entries.values() {
        if !entry.disabled || entry.removed {
            continue;
        }
        let Some(quarantine_path) = &entry.quarantine_path else {
            continue;
        };
        let path = Path::new(quarantine_path);
        match build_skill_record(
            path,
            SourceType::User,
            Ownership::UserManaged,
            TrustLevel::Unverified,
            &result.scanned_at,
        ) {
            Ok(mut record) => {
                record.id = entry.id.clone();
                record.status = SkillStatus::Disabled;
                record.category_id = entry.category_id.clone();
                record.tags = entry.tags.clone();
                result.skills.push(record);
            }
            Err(failure) => result.failed_sources.push(failure),
        }
    }
}

#[tauri::command]
pub fn scan_skills(app: tauri::AppHandle) -> Result<SkillScanResult, String> {
    reconciled_scan(&app)
}

fn classify_file_kind(relative_path: &str) -> SkillFileKind {
    if relative_path == SKILL_MANIFEST_FILE {
        return SkillFileKind::Markdown;
    }
    match relative_path.split('/').next().unwrap_or("") {
        "scripts" => SkillFileKind::Script,
        "references" => SkillFileKind::Reference,
        "assets" => SkillFileKind::Asset,
        "agents" => SkillFileKind::Agent,
        _ => SkillFileKind::Other,
    }
}

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    false
}

/// Recursively list a skill's files. Bounded by file count and depth, never
/// follows symlinks (symlinked entries are skipped, not traversed or listed).
fn walk_skill_files(root: &Path) -> (Vec<SkillFileEntry>, u64, bool) {
    let mut files = Vec::new();
    let mut total_size = 0_u64;
    let mut truncated = false;
    walk_dir(root, root, 0, &mut files, &mut total_size, &mut truncated);
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    (files, total_size, truncated)
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    files: &mut Vec<SkillFileEntry>,
    total_size: &mut u64,
    truncated: &mut bool,
) {
    if *truncated {
        return;
    }
    if depth > MAX_DETAIL_DEPTH {
        *truncated = true;
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_DETAIL_FILES {
            *truncated = true;
            return;
        }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            // Never follow or list symlinks in an untrusted skill directory.
            continue;
        }
        if file_type.is_dir() {
            walk_dir(root, &path, depth + 1, files, total_size, truncated);
            if *truncated {
                return;
            }
        } else if file_type.is_file() {
            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let size_bytes = metadata.len();
            *total_size = total_size.saturating_add(size_bytes);
            files.push(SkillFileEntry {
                relative_path: relative_path.clone(),
                size_bytes,
                is_executable: is_executable(&metadata),
                kind: classify_file_kind(&relative_path),
            });
        }
    }
}

/// Deterministic content digest over the skill's files: SHA-256 of each file's
/// relative path and bytes, in sorted path order. Returns `None` when the walk
/// was truncated or the content exceeds the checksum size cap.
fn compute_checksum(
    root: &Path,
    files: &[SkillFileEntry],
    total_size: u64,
    truncated: bool,
) -> Option<String> {
    if truncated || total_size > MAX_CHECKSUM_BYTES {
        return None;
    }
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.relative_path.as_bytes());
        hasher.update([0u8]);
        let bytes = fs::read(root.join(&file.relative_path)).ok()?;
        hasher.update(&bytes);
    }
    let digest = hasher.finalize();
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Extract the human-readable body of a `SKILL.md` (everything after the YAML
/// frontmatter fence). Returns the whole trimmed content when there is no
/// frontmatter, or `None` when empty.
fn frontmatter_body(markdown: &str) -> Option<String> {
    let content = markdown.trim_start_matches('\u{feff}');
    if content.trim_start().starts_with("---") {
        let mut seen_open = false;
        let mut closed = false;
        let mut body_lines: Vec<&str> = Vec::new();
        for line in content.lines() {
            if closed {
                body_lines.push(line);
            } else if !seen_open {
                if line.trim() == "---" {
                    seen_open = true;
                }
            } else if line.trim() == "---" {
                closed = true;
            }
        }
        if !closed {
            return None;
        }
        let body = body_lines.join("\n").trim().to_string();
        return if body.is_empty() { None } else { Some(body) };
    }
    let body = content.trim().to_string();
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

/// Build full detail (file walk + checksum + body) for an already-resolved
/// record. The record's install_path is treated as authoritative.
fn build_skill_detail(mut record: SkillRecord) -> SkillDetail {
    let root = PathBuf::from(&record.install_path);
    let (files, total_size, truncated) = walk_skill_files(&root);
    let file_count = files.len();
    let scripts = files
        .iter()
        .filter(|file| file.kind == SkillFileKind::Script)
        .map(|file| file.relative_path.clone())
        .collect();
    record.checksum = compute_checksum(&root, &files, total_size, truncated);
    let markdown_body = fs::read_to_string(root.join(SKILL_MANIFEST_FILE))
        .ok()
        .and_then(|manifest| frontmatter_body(&manifest));

    SkillDetail {
        record,
        files,
        scripts,
        markdown_body,
        total_size_bytes: total_size,
        file_count,
        truncated,
    }
}

/// Detail located by scan id (path-derived), without an index. Test-only.
#[cfg(test)]
pub fn skill_detail_for(dir: &Path, id: &str) -> Result<SkillDetail, String> {
    let record = scan_skills_in(dir)
        .skills
        .into_iter()
        .find(|skill| skill.id == id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    Ok(build_skill_detail(record))
}

#[tauri::command]
pub fn get_skill_detail(app: tauri::AppHandle, id: String) -> Result<SkillDetail, String> {
    let record = reconciled_scan(&app)?
        .skills
        .into_iter()
        .find(|skill| skill.id == id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    Ok(build_skill_detail(record))
}

// ---------------------------------------------------------------------------
// AUTO Gateway index (stable ids, categories, tags) — stored in app data dir,
// NEVER written into SKILL.md.
// ---------------------------------------------------------------------------

const SKILL_INDEX_FILE: &str = "skills-index.json";
const SKILL_INDEX_VERSION: u32 = 1;
const UNCATEGORIZED_ID: &str = "uncategorized";
const MAX_CATEGORY_NAME_LEN: usize = 40;
const MAX_TAGS_PER_SKILL: usize = 20;
const MAX_TAG_LEN: usize = 40;

// Preset primary categories (stable id, English fallback name). The frontend
// localizes preset names by id; custom categories use their stored name.
const PRESET_CATEGORIES: &[(&str, &str)] = &[
    ("development", "Development & Engineering"),
    ("design", "Design & Creative"),
    ("data", "Data & Documents"),
    ("web", "Web & Marketing"),
    ("security", "Security & Quality"),
    ("business", "Business & Collaboration"),
    ("automation", "Automation & Media"),
    (UNCATEGORIZED_ID, "Uncategorized"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CategoryType {
    Preset,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCategory {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub category_type: CategoryType,
    pub order: i64,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    pub install_path: String,
    pub name: String,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    // Disabled = moved out of the active skills dir into quarantine.
    #[serde(default)]
    pub disabled: bool,
    // Removed = moved to the recoverable trash.
    #[serde(default)]
    pub removed: bool,
    // Current on-disk location while disabled / removed.
    #[serde(default)]
    pub quarantine_path: Option<String>,
    #[serde(default)]
    pub trash_path: Option<String>,
    // The directory name to restore to under the skills dir.
    #[serde(default)]
    pub original_relative_path: Option<String>,
    #[serde(default)]
    pub removed_at: Option<String>,
    #[serde(default)]
    pub installed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIndex {
    pub version: u32,
    #[serde(default)]
    pub entries: BTreeMap<String, IndexEntry>,
    #[serde(default)]
    pub categories: Vec<SkillCategory>,
}

impl Default for SkillIndex {
    fn default() -> Self {
        let mut index = SkillIndex {
            version: SKILL_INDEX_VERSION,
            entries: BTreeMap::new(),
            categories: Vec::new(),
        };
        ensure_presets(&mut index);
        index
    }
}

/// Make sure every preset category is present (adds any missing on upgrade) and
/// keep categories ordered.
fn ensure_presets(index: &mut SkillIndex) {
    for (order, (id, name)) in PRESET_CATEGORIES.iter().enumerate() {
        if !index.categories.iter().any(|category| category.id == *id) {
            index.categories.push(SkillCategory {
                id: (*id).to_string(),
                name: (*name).to_string(),
                category_type: CategoryType::Preset,
                order: order as i64,
                archived: false,
            });
        }
    }
    index.categories.sort_by_key(|category| category.order);
}

fn source_type_str(source: SourceType) -> String {
    match source {
        SourceType::User => "user",
        SourceType::System => "system",
        SourceType::Plugin => "plugin",
        SourceType::External => "external",
        SourceType::Autogateway => "autogateway",
        SourceType::Team => "team",
    }
    .to_string()
}

fn category_exists(index: &SkillIndex, id: &str) -> bool {
    index.categories.iter().any(|category| category.id == id)
}

fn is_protected_category(index: &SkillIndex, id: &str) -> bool {
    id == UNCATEGORIZED_ID
        || index
            .categories
            .iter()
            .any(|category| category.id == id && category.category_type == CategoryType::Preset)
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for tag in tags {
        let trimmed = tag.trim().to_string();
        if trimmed.is_empty() || trimmed.len() > MAX_TAG_LEN {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            normalized.push(trimmed);
        }
        if normalized.len() >= MAX_TAGS_PER_SKILL {
            break;
        }
    }
    normalized
}

fn skills_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve application data directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("create application data directory: {error}"))?;
    Ok(directory)
}

fn skill_index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(skills_data_dir(app)?.join(SKILL_INDEX_FILE))
}

/// Load the index from disk. Missing → default (seeded). Corrupt → the bad file
/// is preserved as `<name>.corrupt.<ts>` and a fresh index is returned.
fn load_index_at(path: &Path) -> SkillIndex {
    let mut index = match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<SkillIndex>(&text) {
            Ok(parsed) => parsed,
            Err(_) => {
                let corrupt = path.with_extension(format!("corrupt.{}", now_millis()));
                let _ = fs::rename(path, &corrupt);
                SkillIndex::default()
            }
        },
        Err(_) => SkillIndex::default(),
    };
    ensure_presets(&mut index);
    index
}

/// Persist the index: back up the previous version, then write atomically.
fn save_index_at(path: &Path, index: &SkillIndex) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "resolve the skills index directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create the skills index directory: {error}"))?;
    if path.exists() {
        let backup = path.with_extension("json.bak");
        let _ = fs::copy(path, &backup);
    }
    let serialized =
        serde_json::to_string_pretty(index).map_err(|error| format!("serialize the skills index: {error}"))?;
    let temporary = parent.join(format!(".{SKILL_INDEX_FILE}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, serialized.as_bytes())
        .map_err(|error| format!("write the skills index: {error}"))?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("save the skills index: {error}")
    })
}

/// Attach stable ids, categories, and tags from the index to scanned records,
/// creating index entries for newly discovered skills. Returns whether the
/// index changed and must be persisted. Matches by install path, then by name
/// (so an externally renamed folder keeps its id/category), never reusing an
/// entry already claimed this scan.
fn reconcile_index(index: &mut SkillIndex, result: &mut SkillScanResult) -> bool {
    let mut changed = false;
    let mut used: HashSet<String> = HashSet::new();
    for record in &mut result.skills {
        let matched = index
            .entries
            .iter()
            .find(|(id, entry)| {
                !used.contains(id.as_str())
                    && !entry.disabled
                    && !entry.removed
                    && entry.install_path == record.install_path
            })
            .map(|(id, _)| id.clone())
            .or_else(|| {
                index
                    .entries
                    .iter()
                    .find(|(id, entry)| {
                        !used.contains(id.as_str())
                            && !entry.disabled
                            && !entry.removed
                            && entry.name == record.name
                    })
                    .map(|(id, _)| id.clone())
            });
        let id = match matched {
            Some(id) => {
                if let Some(entry) = index.entries.get_mut(&id) {
                    if entry.install_path != record.install_path {
                        entry.install_path = record.install_path.clone();
                        changed = true;
                    }
                    if entry.name != record.name {
                        entry.name = record.name.clone();
                        changed = true;
                    }
                    entry.source_type = Some(source_type_str(record.source_type));
                    record.category_id = entry.category_id.clone();
                    record.tags = entry.tags.clone();
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                index.entries.insert(
                    id.clone(),
                    IndexEntry {
                        id: id.clone(),
                        install_path: record.install_path.clone(),
                        name: record.name.clone(),
                        source_type: Some(source_type_str(record.source_type)),
                        installed_at: record.installed_at.clone(),
                        ..Default::default()
                    },
                );
                changed = true;
                id
            }
        };
        used.insert(id.clone());
        record.id = id;
    }
    changed
}

#[tauri::command]
pub fn set_skill_category(
    app: tauri::AppHandle,
    id: String,
    category_id: Option<String>,
) -> Result<(), String> {
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    if let Some(category) = &category_id {
        if !category_exists(&index, category) {
            return Err("the category does not exist".to_string());
        }
    }
    let entry = index
        .entries
        .get_mut(&id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    entry.category_id = category_id;
    save_index_at(&path, &index)
}

#[tauri::command]
pub fn set_skills_category(
    app: tauri::AppHandle,
    ids: Vec<String>,
    category_id: Option<String>,
) -> Result<(), String> {
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    if let Some(category) = &category_id {
        if !category_exists(&index, category) {
            return Err("the category does not exist".to_string());
        }
    }
    for id in ids {
        if let Some(entry) = index.entries.get_mut(&id) {
            entry.category_id = category_id.clone();
        }
    }
    save_index_at(&path, &index)
}

#[tauri::command]
pub fn set_skill_tags(app: tauri::AppHandle, id: String, tags: Vec<String>) -> Result<(), String> {
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    let entry = index
        .entries
        .get_mut(&id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    entry.tags = normalize_tags(tags);
    save_index_at(&path, &index)
}

#[tauri::command]
pub fn create_category(app: tauri::AppHandle, name: String) -> Result<SkillCategory, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("the category name is required".to_string());
    }
    if trimmed.len() > MAX_CATEGORY_NAME_LEN {
        return Err("the category name is too long".to_string());
    }
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    let order = index
        .categories
        .iter()
        .map(|category| category.order)
        .max()
        .unwrap_or(0)
        + 1;
    let category = SkillCategory {
        id: format!("custom-{}", Uuid::new_v4()),
        name: trimmed,
        category_type: CategoryType::Custom,
        order,
        archived: false,
    };
    index.categories.push(category.clone());
    save_index_at(&path, &index)?;
    Ok(category)
}

#[tauri::command]
pub fn rename_category(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("the category name is required".to_string());
    }
    if trimmed.len() > MAX_CATEGORY_NAME_LEN {
        return Err("the category name is too long".to_string());
    }
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    if is_protected_category(&index, &id) {
        return Err("preset categories cannot be renamed".to_string());
    }
    let category = index
        .categories
        .iter_mut()
        .find(|category| category.id == id)
        .ok_or_else(|| "the category does not exist".to_string())?;
    category.name = trimmed;
    save_index_at(&path, &index)
}

#[tauri::command]
pub fn reorder_categories(app: tauri::AppHandle, ordered_ids: Vec<String>) -> Result<(), String> {
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    for (order, id) in ordered_ids.iter().enumerate() {
        if let Some(category) = index.categories.iter_mut().find(|category| &category.id == id) {
            category.order = order as i64;
        }
    }
    index.categories.sort_by_key(|category| category.order);
    save_index_at(&path, &index)
}

#[tauri::command]
pub fn archive_category(
    app: tauri::AppHandle,
    id: String,
    archived: bool,
) -> Result<(), String> {
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    if is_protected_category(&index, &id) {
        return Err("preset categories cannot be archived".to_string());
    }
    let category = index
        .categories
        .iter_mut()
        .find(|category| category.id == id)
        .ok_or_else(|| "the category does not exist".to_string())?;
    category.archived = archived;
    save_index_at(&path, &index)
}

/// Pure core of category deletion (testable without an app handle): reassigns
/// affected entries to `migrate_to` (or clears them) and removes the category.
fn delete_category_in(
    index: &mut SkillIndex,
    id: &str,
    migrate_to: Option<String>,
) -> Result<(), String> {
    if is_protected_category(index, id) {
        return Err("preset categories cannot be deleted".to_string());
    }
    if !category_exists(index, id) {
        return Err("the category does not exist".to_string());
    }
    let target = match migrate_to {
        Some(target) if target == id => {
            return Err("cannot migrate a category into itself".to_string());
        }
        Some(target) => {
            if !category_exists(index, &target) {
                return Err("the migration target category does not exist".to_string());
            }
            Some(target)
        }
        None => None,
    };
    for entry in index.entries.values_mut() {
        if entry.category_id.as_deref() == Some(id) {
            entry.category_id = target.clone();
        }
    }
    index.categories.retain(|category| category.id != id);
    Ok(())
}

#[tauri::command]
pub fn delete_category(
    app: tauri::AppHandle,
    id: String,
    migrate_to: Option<String>,
) -> Result<(), String> {
    let path = skill_index_path(&app)?;
    let mut index = load_index_at(&path);
    delete_category_in(&mut index, &id, migrate_to)?;
    save_index_at(&path, &index)
}

// ---------------------------------------------------------------------------
// Enable / disable / remove / restore — move a skill directory between the
// active skills dir and AUTO Gateway-managed quarantine/trash areas. Effect
// takes place on the next Codex session (surfaced as pending reload in the UI).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableSkill {
    pub id: String,
    pub name: String,
    pub removed_at: Option<String>,
}

fn quarantine_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(skills_data_dir(app)?.join("skills-quarantine"))
}

fn trash_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(skills_data_dir(app)?.join("skills-trash"))
}

fn dir_name_of(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err("refusing to operate on a symlinked skill directory".to_string());
        }
    }
    Ok(())
}

fn require_user_managed(entry: &IndexEntry) -> Result<(), String> {
    if entry.source_type.as_deref() == Some("user") {
        Ok(())
    } else {
        Err("only user-installed skills can be changed here".to_string())
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("create the destination directory: {error}"))?;
    for entry in
        fs::read_dir(from).map_err(|error| format!("read the source directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("read a directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect a directory entry: {error}"))?;
        let target = to.join(entry.file_name());
        if file_type.is_symlink() {
            // Do not copy symlinks out of an untrusted skill directory.
            continue;
        }
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)
                .map_err(|error| format!("copy a skill file: {error}"))?;
        }
    }
    Ok(())
}

/// Move a directory, falling back to copy+remove across volumes. On a failed
/// copy the partial destination is cleaned up.
fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create the destination directory: {error}"))?;
    }
    if to.exists() {
        return Err("the destination path already exists".to_string());
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Err(error) = copy_dir_all(from, to) {
        let _ = fs::remove_dir_all(to);
        return Err(error);
    }
    fs::remove_dir_all(from).map_err(|error| format!("remove the original directory: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn disable_skill(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let index_path = skill_index_path(&app)?;
    let mut index = load_index_at(&index_path);
    let entry = index
        .entries
        .get(&id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    require_user_managed(entry)?;
    if entry.disabled {
        return Ok(());
    }
    let dir_name =
        dir_name_of(&entry.install_path).ok_or_else(|| "the skill path is invalid".to_string())?;
    let skills_dir = default_skills_dir()?;
    let source = skills_dir.join(&dir_name);
    reject_symlink(&source)?;
    if !source.is_dir() {
        return Err("the skill directory was not found".to_string());
    }
    let quarantine = quarantine_root(&app)?.join(&id).join(&dir_name);
    move_dir(&source, &quarantine)?;

    let entry = index.entries.get_mut(&id).unwrap();
    entry.disabled = true;
    entry.quarantine_path = Some(quarantine.to_string_lossy().to_string());
    entry.original_relative_path = Some(dir_name);
    if let Err(error) = save_index_at(&index_path, &index) {
        let _ = move_dir(&quarantine, &source);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn enable_skill(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let index_path = skill_index_path(&app)?;
    let mut index = load_index_at(&index_path);
    let entry = index
        .entries
        .get(&id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    require_user_managed(entry)?;
    if !entry.disabled {
        return Ok(());
    }
    let quarantine_path = entry
        .quarantine_path
        .clone()
        .ok_or_else(|| "the disabled skill location is unknown".to_string())?;
    let dir_name = entry
        .original_relative_path
        .clone()
        .or_else(|| dir_name_of(&quarantine_path))
        .ok_or_else(|| "the skill path is invalid".to_string())?;
    let skills_dir = default_skills_dir()?;
    let target = skills_dir.join(&dir_name);
    if target.exists() {
        return Err("a skill with this name already exists; resolve the conflict first".to_string());
    }
    let quarantine = PathBuf::from(&quarantine_path);
    reject_symlink(&quarantine)?;
    move_dir(&quarantine, &target)?;

    let entry = index.entries.get_mut(&id).unwrap();
    entry.disabled = false;
    entry.quarantine_path = None;
    entry.install_path = target.to_string_lossy().to_string();
    if let Err(error) = save_index_at(&index_path, &index) {
        let _ = move_dir(&target, &quarantine);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn remove_skill(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let index_path = skill_index_path(&app)?;
    let mut index = load_index_at(&index_path);
    let entry = index
        .entries
        .get(&id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    require_user_managed(entry)?;
    if entry.removed {
        return Ok(());
    }
    let source = if entry.disabled {
        PathBuf::from(
            entry
                .quarantine_path
                .clone()
                .ok_or_else(|| "the disabled skill location is unknown".to_string())?,
        )
    } else {
        let dir_name = dir_name_of(&entry.install_path)
            .ok_or_else(|| "the skill path is invalid".to_string())?;
        default_skills_dir()?.join(dir_name)
    };
    reject_symlink(&source)?;
    if !source.is_dir() {
        return Err("the skill directory was not found".to_string());
    }
    let dir_name =
        dir_name_of(&source.to_string_lossy()).unwrap_or_else(|| "skill".to_string());
    let stamp = now_millis();
    let trash = trash_root(&app)?
        .join(format!("{id}-{stamp}"))
        .join(&dir_name);
    move_dir(&source, &trash)?;

    let entry = index.entries.get_mut(&id).unwrap();
    entry.removed = true;
    entry.disabled = false;
    entry.quarantine_path = None;
    entry.trash_path = Some(trash.to_string_lossy().to_string());
    entry.removed_at = Some(stamp);
    entry.original_relative_path = Some(dir_name);
    if let Err(error) = save_index_at(&index_path, &index) {
        let _ = move_dir(&trash, &source);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn restore_skill(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let index_path = skill_index_path(&app)?;
    let mut index = load_index_at(&index_path);
    let entry = index
        .entries
        .get(&id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    if !entry.removed {
        return Ok(());
    }
    let trash_path = entry
        .trash_path
        .clone()
        .ok_or_else(|| "the removed skill location is unknown".to_string())?;
    let dir_name = entry
        .original_relative_path
        .clone()
        .or_else(|| dir_name_of(&trash_path))
        .ok_or_else(|| "the skill path is invalid".to_string())?;
    let skills_dir = default_skills_dir()?;
    let target = skills_dir.join(&dir_name);
    if target.exists() {
        return Err("a skill with this name already exists; resolve the conflict first".to_string());
    }
    let trash = PathBuf::from(&trash_path);
    reject_symlink(&trash)?;
    move_dir(&trash, &target)?;

    let entry = index.entries.get_mut(&id).unwrap();
    entry.removed = false;
    entry.trash_path = None;
    entry.install_path = target.to_string_lossy().to_string();
    if let Err(error) = save_index_at(&index_path, &index) {
        let _ = move_dir(&target, &trash);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn list_recoverable_skills(app: tauri::AppHandle) -> Result<Vec<RecoverableSkill>, String> {
    let index = load_index_at(&skill_index_path(&app)?);
    let mut items: Vec<RecoverableSkill> = index
        .entries
        .values()
        .filter(|entry| entry.removed)
        .map(|entry| RecoverableSkill {
            id: entry.id.clone(),
            name: entry.name.clone(),
            removed_at: entry.removed_at.clone(),
        })
        .collect();
    items.sort_by(|a, b| b.removed_at.cmp(&a.removed_at));
    Ok(items)
}

// ---------------------------------------------------------------------------
// Install from a local directory or ZIP: stage into a temp area, validate the
// package, then place it atomically into the skills dir. An installed skill is
// picked up (and indexed) by the next scan, so install itself never writes the
// index.
// ---------------------------------------------------------------------------

const MAX_ARCHIVE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_INSTALL_FILES: usize = 2000;
const MAX_INSTALL_PATH_DEPTH: usize = 16;
const MAX_INSTALL_FILE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskFinding {
    pub code: String,
    pub severity: String,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub target_name: String,
    pub target_path: String,
    pub file_count: usize,
    pub total_size_bytes: u64,
    pub scripts: Vec<String>,
    pub conflict: bool,
    pub warnings: Vec<RiskFinding>,
}

fn skills_backup_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(skills_data_dir(app)?.join("skills-backup"))
}

fn is_valid_skill_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 || name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Safe ZIP extraction: rejects path traversal, absolute paths, and symlinks,
/// and enforces file-count / depth / per-file / total-size limits with a
/// bounded copy so a lying size header cannot cause a zip bomb.
fn extract_zip_safe(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|error| format!("open the archive: {error}"))?;
    let archive_size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if archive_size > MAX_ARCHIVE_BYTES {
        return Err("the archive is larger than the supported limit".to_string());
    }
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("read the archive: {error}"))?;
    if archive.len() > MAX_INSTALL_FILES {
        return Err("the archive contains too many files".to_string());
    }
    fs::create_dir_all(dest).map_err(|error| format!("create the staging directory: {error}"))?;

    let mut total_unpacked: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read an archive entry: {error}"))?;
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err("the archive contains a symbolic link".to_string());
            }
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "the archive contains an unsafe path".to_string())?;
        if relative.components().count() > MAX_INSTALL_PATH_DEPTH {
            return Err("the archive contains a path that is too deep".to_string());
        }
        let outpath = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&outpath)
                .map_err(|error| format!("create a directory: {error}"))?;
            continue;
        }
        if entry.size() > MAX_INSTALL_FILE_BYTES {
            return Err("the archive contains a file that is too large".to_string());
        }
        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("create a directory: {error}"))?;
        }
        let mut output =
            fs::File::create(&outpath).map_err(|error| format!("write a file: {error}"))?;
        let mut limited = entry.by_ref().take(MAX_INSTALL_FILE_BYTES + 1);
        let written = io::copy(&mut limited, &mut output)
            .map_err(|error| format!("extract a file: {error}"))?;
        if written > MAX_INSTALL_FILE_BYTES {
            return Err("a file in the archive exceeds the size limit".to_string());
        }
        total_unpacked = total_unpacked.saturating_add(written);
        if total_unpacked > MAX_UNPACKED_BYTES {
            return Err("the archive expands beyond the supported size".to_string());
        }
    }
    Ok(())
}

/// Find the skill root: a directory that directly contains SKILL.md, either the
/// base itself or its single top-level subdirectory.
/// Discover installable skills under a base directory: the base itself if it
/// contains SKILL.md, otherwise every immediate subdirectory that contains one.
/// This handles a collection of skills (e.g. a repo of many skills), not just a
/// single skill folder.
fn discover_skill_roots(base: &Path) -> Vec<PathBuf> {
    if base.join(SKILL_MANIFEST_FILE).is_file() {
        return vec![base.to_path_buf()];
    }
    let mut roots = Vec::new();
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if path.join(SKILL_MANIFEST_FILE).is_file() {
                roots.push(path);
            }
        }
    }
    roots.sort();
    roots
}

fn build_install_preview(skill_root: &Path, skills_dir: &Path) -> Result<InstallPreview, String> {
    let manifest = fs::read_to_string(skill_root.join(SKILL_MANIFEST_FILE))
        .map_err(|error| format!("read {SKILL_MANIFEST_FILE}: {error}"))?;
    let frontmatter = parse_frontmatter(&manifest)?;
    if !is_valid_skill_name(&frontmatter.name) {
        return Err("the skill name in SKILL.md is not a valid folder name".to_string());
    }
    let (files, total_size, truncated) = walk_skill_files(skill_root);
    if truncated || files.len() > MAX_INSTALL_FILES {
        return Err("the skill contains too many files".to_string());
    }
    if total_size > MAX_UNPACKED_BYTES {
        return Err("the skill is larger than the supported limit".to_string());
    }
    let scripts: Vec<String> = files
        .iter()
        .filter(|file| file.kind == SkillFileKind::Script)
        .map(|file| file.relative_path.clone())
        .collect();
    let mut warnings = Vec::new();
    if !scripts.is_empty() {
        warnings.push(RiskFinding {
            code: "SCRIPTS_PRESENT".to_string(),
            severity: "warning".to_string(),
            path: None,
            message: format!("{} script file(s) will be installed", scripts.len()),
        });
    }
    for file in &files {
        if file.is_executable {
            warnings.push(RiskFinding {
                code: "EXECUTABLE_FILE".to_string(),
                severity: "warning".to_string(),
                path: Some(file.relative_path.clone()),
                message: "an executable file is included".to_string(),
            });
        }
    }
    let target = skills_dir.join(&frontmatter.name);
    Ok(InstallPreview {
        name: frontmatter.name.clone(),
        description: frontmatter.description,
        version: frontmatter.version,
        target_name: frontmatter.name,
        target_path: target.to_string_lossy().to_string(),
        file_count: files.len(),
        total_size_bytes: total_size,
        scripts,
        conflict: target.exists(),
        warnings,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallProgress {
    stage: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u64>,
}

fn emit_skill_progress(app: &tauri::AppHandle, stage: &str, downloaded: u64, total: Option<u64>) {
    let percent = total.map(|total| {
        if total > 0 {
            (downloaded.saturating_mul(100) / total).min(100)
        } else {
            0
        }
    });
    let _ = app.emit(
        "skill-install-progress",
        SkillInstallProgress {
            stage: stage.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            percent,
        },
    );
}

/// Parse a public GitHub URL into (owner, repo, ref, optional subpath). HTTPS
/// and github.com only, no embedded credentials.
fn parse_github_url(raw: &str) -> Result<(String, String, String, Option<String>), String> {
    let url = Url::parse(raw.trim()).map_err(|error| format!("parse the URL: {error}"))?;
    if url.scheme() != "https" {
        return Err("only HTTPS GitHub URLs are supported".to_string());
    }
    if url.host_str() != Some("github.com") {
        return Err("only github.com URLs are supported".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the URL must not contain credentials".to_string());
    }
    let segments: Vec<String> = url
        .path_segments()
        .map(|parts| {
            parts
                .filter(|part| !part.is_empty())
                .map(|part| part.to_string())
                .collect()
        })
        .unwrap_or_default();
    if segments.len() < 2 {
        return Err("the URL must include an owner and repository".to_string());
    }
    let owner = segments[0].clone();
    let repo = segments[1]
        .strip_suffix(".git")
        .unwrap_or(&segments[1])
        .to_string();
    let mut git_ref = "main".to_string();
    let mut subpath: Option<String> = None;
    if segments.len() > 2 && (segments[2] == "tree" || segments[2] == "blob") {
        if segments.len() < 4 {
            return Err("the URL is missing a branch or path".to_string());
        }
        git_ref = segments[3].clone();
        if segments.len() > 4 {
            subpath = Some(segments[4..].join("/"));
        }
    }
    let safe = |value: &str| {
        !value.is_empty()
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    if !safe(&owner) || !safe(&repo) || !safe(&git_ref) {
        return Err("the URL contains unsupported characters".to_string());
    }
    if let Some(path) = &subpath {
        if path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return Err("the URL path is invalid".to_string());
        }
    }
    Ok((owner, repo, git_ref, subpath))
}

async fn download_codeload_zip(
    app: &tauri::AppHandle,
    owner: &str,
    repo: &str,
    git_ref: &str,
    destination: &Path,
) -> Result<(), String> {
    let url = format!("https://codeload.github.com/{owner}/{repo}/zip/{git_ref}");
    let client = reqwest::Client::builder()
        .user_agent(crate::http_client::desktop_user_agent())
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("create the download client: {error}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("download the repository: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download the repository: {error}"))?;
    let final_host = response.url().host_str().unwrap_or("").to_string();
    if !matches!(final_host.as_str(), "codeload.github.com" | "github.com") {
        return Err("the download was redirected to an untrusted host".to_string());
    }
    let total = response.content_length();
    if total.is_some_and(|length| length > MAX_ARCHIVE_BYTES) {
        return Err("the repository archive is too large".to_string());
    }
    let mut file =
        fs::File::create(destination).map_err(|error| format!("create the download file: {error}"))?;
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("read the download: {error}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_ARCHIVE_BYTES {
            return Err("the repository archive is too large".to_string());
        }
        file.write_all(&chunk)
            .map_err(|error| format!("save the download: {error}"))?;
        if downloaded - last_emit >= 512 * 1024 {
            last_emit = downloaded;
            emit_skill_progress(app, "downloading", downloaded, total);
        }
    }
    file.sync_all()
        .map_err(|error| format!("finish the download: {error}"))?;
    emit_skill_progress(app, "downloading", downloaded, total);
    Ok(())
}

fn single_subdir(base: &Path) -> Result<PathBuf, String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(base).map_err(|error| format!("read the archive: {error}"))? {
        let entry = entry.map_err(|error| format!("read an archive entry: {error}"))?;
        if entry.path().is_dir() {
            dirs.push(entry.path());
        }
    }
    if dirs.len() == 1 {
        Ok(dirs.remove(0))
    } else {
        Err("unexpected repository archive layout".to_string())
    }
}

/// Prepare the base directory to discover skills in: the local dir itself (no
/// copy), the extracted ZIP payload, or the extracted GitHub repo path.
async fn prepare_base(
    app: &tauri::AppHandle,
    kind: &str,
    location: &str,
    staging: &Path,
) -> Result<PathBuf, String> {
    fs::create_dir_all(staging)
        .map_err(|error| format!("create the staging directory: {error}"))?;
    match kind {
        "dir" => {
            let source = Path::new(location);
            reject_symlink(source)?;
            if !source.is_dir() {
                return Err("the source directory was not found".to_string());
            }
            Ok(source.to_path_buf())
        }
        "zip" => {
            let source = Path::new(location);
            if !source.is_file() {
                return Err("the archive file was not found".to_string());
            }
            let payload = staging.join("payload");
            extract_zip_safe(source, &payload)?;
            Ok(payload)
        }
        "git" => {
            emit_skill_progress(app, "resolving", 0, None);
            let (owner, repo, git_ref, subpath) = parse_github_url(location)?;
            let archive = staging.join("repo.zip");
            download_codeload_zip(app, &owner, &repo, &git_ref, &archive).await?;
            emit_skill_progress(app, "extracting", 0, None);
            let payload = staging.join("payload");
            extract_zip_safe(&archive, &payload)?;
            let repo_root = single_subdir(&payload)?;
            Ok(match &subpath {
                Some(path) => repo_root.join(path),
                None => repo_root,
            })
        }
        _ => Err("unsupported install source".to_string()),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkip {
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSummary {
    pub installed: Vec<String>,
    pub skipped: Vec<InstallSkip>,
    pub failed: Vec<InstallSkip>,
}

/// Preview every installable skill found in the source (1 for a single skill,
/// N for a collection directory / repo).
#[tauri::command]
pub async fn validate_skill_source(
    app: tauri::AppHandle,
    kind: String,
    location: String,
) -> Result<Vec<InstallPreview>, String> {
    let skills_dir = default_skills_dir()?;
    let staging = std::env::temp_dir().join(format!("autogateway-skill-stage-{}", Uuid::new_v4()));
    let result = async {
        let base = prepare_base(&app, &kind, &location, &staging).await?;
        let roots = discover_skill_roots(&base);
        if roots.is_empty() {
            return Err(format!(
                "could not find {SKILL_MANIFEST_FILE} in the selected source"
            ));
        }
        let mut previews: Vec<InstallPreview> = roots
            .iter()
            .filter_map(|root| build_install_preview(root, &skills_dir).ok())
            .collect();
        if previews.is_empty() {
            return Err("no valid skills were found in the selected source".to_string());
        }
        previews.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(previews)
    }
    .await;
    let _ = fs::remove_dir_all(&staging);
    result
}

fn install_one(
    app: &tauri::AppHandle,
    root: &Path,
    target_name: &str,
    skills_dir: &Path,
    staging: &Path,
) -> Result<(), String> {
    let target = skills_dir.join(target_name);
    let staged = staging.join(format!("install-{}", Uuid::new_v4()));
    copy_dir_all(root, &staged)?;
    if target.exists() {
        let backup = skills_backup_root(app)?.join(format!("{target_name}-{}", now_millis()));
        move_dir(&target, &backup)?;
        if let Err(error) = move_dir(&staged, &target) {
            let _ = move_dir(&backup, &target);
            return Err(error);
        }
    } else {
        move_dir(&staged, &target)?;
    }
    Ok(())
}

/// Install skills from a source. `names` selects which discovered skills to
/// install (empty = all). Existing skills are skipped unless `replace` is set
/// (which backs up the existing copy first). Returns a per-skill summary.
#[tauri::command]
pub async fn install_skill(
    app: tauri::AppHandle,
    kind: String,
    location: String,
    replace: bool,
    names: Vec<String>,
) -> Result<InstallSummary, String> {
    let skills_dir = default_skills_dir()?;
    fs::create_dir_all(&skills_dir)
        .map_err(|error| format!("create the skills directory: {error}"))?;
    let staging = std::env::temp_dir().join(format!("autogateway-skill-stage-{}", Uuid::new_v4()));
    let outcome = async {
        let base = prepare_base(&app, &kind, &location, &staging).await?;
        let roots = discover_skill_roots(&base);
        if roots.is_empty() {
            return Err(format!(
                "could not find {SKILL_MANIFEST_FILE} in the selected source"
            ));
        }
        emit_skill_progress(&app, "installing", 0, None);
        let select_all = names.is_empty();
        let mut summary = InstallSummary {
            installed: Vec::new(),
            skipped: Vec::new(),
            failed: Vec::new(),
        };
        for root in &roots {
            let Ok(preview) = build_install_preview(root, &skills_dir) else {
                continue;
            };
            if !select_all && !names.contains(&preview.target_name) {
                continue;
            }
            let target = skills_dir.join(&preview.target_name);
            if target.exists() && !replace {
                summary.skipped.push(InstallSkip {
                    name: preview.target_name.clone(),
                    reason: "exists".to_string(),
                });
                continue;
            }
            match install_one(&app, root, &preview.target_name, &skills_dir, &staging) {
                Ok(()) => summary.installed.push(preview.target_name.clone()),
                Err(error) => summary.failed.push(InstallSkip {
                    name: preview.target_name.clone(),
                    reason: error,
                }),
            }
        }
        emit_skill_progress(&app, "complete", 0, None);
        Ok(summary)
    }
    .await;
    let _ = fs::remove_dir_all(&staging);
    outcome
}

// ---------------------------------------------------------------------------
// Export a user skill as a standard ZIP package with a SHA-256 checksum.
// (Import is the existing zip install path — install_skill kind="zip".)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub zip_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub warnings: Vec<RiskFinding>,
}

fn sha256_hex_of_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("read the package: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("hash the package: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn write_skill_zip(root: &Path, files: &[SkillFileEntry], dest: &Path) -> Result<(), String> {
    let file =
        fs::File::create(dest).map_err(|error| format!("create the package file: {error}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    for entry in files {
        writer
            .start_file(&entry.relative_path, options)
            .map_err(|error| format!("add a file to the package: {error}"))?;
        let bytes = fs::read(root.join(&entry.relative_path))
            .map_err(|error| format!("read a skill file: {error}"))?;
        writer
            .write_all(&bytes)
            .map_err(|error| format!("write a file to the package: {error}"))?;
    }
    writer
        .finish()
        .map_err(|error| format!("finish the package: {error}"))?;
    Ok(())
}

/// Light, non-blocking scan for content that a user probably should not
/// distribute: absolute paths pointing at their home directory, or private-key
/// markers. Only small text files are inspected.
fn scan_export_warnings(root: &Path, files: &[SkillFileEntry]) -> Vec<RiskFinding> {
    const TEXT_EXTS: &[&str] = &[
        "md", "txt", "py", "js", "ts", "json", "yaml", "yml", "toml", "sh", "cfg", "ini",
    ];
    const SECRET_MARKERS: &[&str] = &[
        "BEGIN RSA PRIVATE KEY",
        "BEGIN PRIVATE KEY",
        "BEGIN OPENSSH PRIVATE KEY",
        "aws_secret_access_key",
    ];
    let home = dirs::home_dir().map(|path| path.to_string_lossy().to_string());
    let mut findings = Vec::new();
    for entry in files {
        let is_text = Path::new(&entry.relative_path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| TEXT_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !is_text || entry.size_bytes > 1024 * 1024 {
            continue;
        }
        let Ok(content) = fs::read_to_string(root.join(&entry.relative_path)) else {
            continue;
        };
        if let Some(home) = &home {
            if home.len() > 1 && content.contains(home.as_str()) {
                findings.push(RiskFinding {
                    code: "ABSOLUTE_PATH".to_string(),
                    severity: "warning".to_string(),
                    path: Some(entry.relative_path.clone()),
                    message: "contains an absolute path to your home directory".to_string(),
                });
            }
        }
        if SECRET_MARKERS.iter().any(|marker| content.contains(marker)) {
            findings.push(RiskFinding {
                code: "POSSIBLE_SECRET".to_string(),
                severity: "warning".to_string(),
                path: Some(entry.relative_path.clone()),
                message: "may contain a private key or credential".to_string(),
            });
        }
    }
    findings
}

#[tauri::command]
pub fn export_skill(app: tauri::AppHandle, id: String) -> Result<ExportResult, String> {
    let record = reconciled_scan(&app)?
        .skills
        .into_iter()
        .find(|skill| skill.id == id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;
    if record.ownership != Ownership::UserManaged {
        return Err("only user-installed skills can be exported".to_string());
    }
    let root = PathBuf::from(&record.install_path);
    let (files, total_size, truncated) = walk_skill_files(&root);
    if truncated || files.len() > MAX_INSTALL_FILES || total_size > MAX_UNPACKED_BYTES {
        return Err("the skill is too large to export".to_string());
    }
    if files.is_empty() {
        return Err("the skill has no files to export".to_string());
    }
    let warnings = scan_export_warnings(&root, &files);

    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| format!("find the Downloads folder: {error}"))?;
    fs::create_dir_all(&downloads)
        .map_err(|error| format!("create the Downloads folder: {error}"))?;
    let stem = if is_valid_skill_name(&record.name) {
        record.name.clone()
    } else {
        "skill".to_string()
    };
    let mut dest = downloads.join(format!("{stem}.zip"));
    if dest.exists() {
        dest = downloads.join(format!("{stem}-{}.zip", now_millis()));
    }
    write_skill_zip(&root, &files, &dest)?;
    let sha256 = sha256_hex_of_file(&dest)?;
    let size_bytes = fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
    Ok(ExportResult {
        zip_path: dest.to_string_lossy().to_string(),
        sha256,
        size_bytes,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "autogateway-skills-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    fn write_skill(root: &Path, name: &str, manifest: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(dir.join(SKILL_MANIFEST_FILE), manifest).expect("write manifest");
    }

    #[test]
    fn parses_minimal_frontmatter() {
        let md = "---\nname: release-notes\ndescription: Generate release notes.\n---\n\n# Body\n";
        let parsed = parse_frontmatter(md).expect("parse");
        assert_eq!(parsed.name, "release-notes");
        assert_eq!(parsed.description, "Generate release notes.");
        assert_eq!(parsed.version, None);
        assert!(parsed.metadata.is_empty());
    }

    #[test]
    fn parses_quoted_values_and_metadata_block() {
        let md = "---\nname: \"imagegen\"\ndescription: \"Generate images.\"\nversion: 1.2.0\nmetadata:\n  short-description: Make pictures\n---\n";
        let parsed = parse_frontmatter(md).expect("parse");
        assert_eq!(parsed.name, "imagegen");
        assert_eq!(parsed.description, "Generate images.");
        assert_eq!(parsed.version.as_deref(), Some("1.2.0"));
        assert_eq!(
            parsed.metadata.get("short-description").map(String::as_str),
            Some("Make pictures")
        );
    }

    #[test]
    fn rejects_manifest_without_name() {
        let md = "---\ndescription: No name here.\n---\n";
        assert!(parse_frontmatter(md).is_err());
    }

    #[test]
    fn rejects_manifest_without_fence() {
        let md = "name: release-notes\ndescription: Nope.\n";
        assert!(parse_frontmatter(md).is_err());
    }

    #[test]
    fn scan_classifies_user_and_system_and_records_failures() {
        let root = temp_root("scan");
        // A valid user skill.
        write_skill(
            &root,
            "release-notes",
            "---\nname: release-notes\ndescription: Generate release notes.\n---\n",
        );
        // A system skill under .system/ (read-only).
        let system_dir = root.join(SYSTEM_SKILLS_DIR);
        fs::create_dir_all(&system_dir).expect("create .system");
        write_skill(
            &system_dir,
            "imagegen",
            "---\nname: imagegen\ndescription: Generate images.\n---\n",
        );
        // A broken user skill: directory without a SKILL.md.
        fs::create_dir_all(root.join("broken")).expect("create broken");

        let result = scan_skills_in(&root);

        let user = result
            .skills
            .iter()
            .find(|skill| skill.name == "release-notes")
            .expect("user skill present");
        assert_eq!(user.source_type, SourceType::User);
        assert_eq!(user.ownership, Ownership::UserManaged);

        let system = result
            .skills
            .iter()
            .find(|skill| skill.name == "imagegen")
            .expect("system skill present");
        assert_eq!(system.source_type, SourceType::System);
        assert_eq!(system.ownership, Ownership::ReadOnly);
        assert_eq!(system.trust_level, TrustLevel::System);

        assert_eq!(result.failed_sources.len(), 1);
        assert!(result.failed_sources[0].path.ends_with("broken"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_of_missing_directory_is_empty() {
        let dir = std::env::temp_dir().join(format!(
            "autogateway-skills-missing-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let result = scan_skills_in(&dir);
        assert!(result.skills.is_empty());
        assert!(result.failed_sources.is_empty());
    }

    #[test]
    fn frontmatter_body_strips_the_fence() {
        let md = "---\nname: x\ndescription: y\n---\n\n# Title\n\nBody text.\n";
        assert_eq!(frontmatter_body(md).as_deref(), Some("# Title\n\nBody text."));
        let no_fence = "# Just markdown\n";
        assert_eq!(frontmatter_body(no_fence).as_deref(), Some("# Just markdown"));
    }

    #[test]
    fn detail_lists_files_classifies_kinds_and_hashes_content() {
        let root = temp_root("detail");
        write_skill(
            &root,
            "release-notes",
            "---\nname: release-notes\ndescription: Generate release notes.\n---\n\n# Doc\n",
        );
        let skill_dir = root.join("release-notes");
        fs::create_dir_all(skill_dir.join("scripts")).expect("scripts dir");
        fs::write(skill_dir.join("scripts/run.py"), "print('hi')\n").expect("script");
        fs::create_dir_all(skill_dir.join("references")).expect("refs dir");
        fs::write(skill_dir.join("references/notes.md"), "ref\n").expect("ref");

        let id = skill_id_for(&skill_dir);
        let detail = skill_detail_for(&root, &id).expect("detail");

        assert_eq!(detail.file_count, 3);
        assert!(!detail.truncated);
        assert_eq!(detail.scripts, vec!["scripts/run.py".to_string()]);
        assert!(detail.markdown_body.as_deref().unwrap().contains("# Doc"));

        let manifest = detail
            .files
            .iter()
            .find(|file| file.relative_path == "SKILL.md")
            .expect("manifest listed");
        assert_eq!(manifest.kind, SkillFileKind::Markdown);
        let script = detail
            .files
            .iter()
            .find(|file| file.relative_path == "scripts/run.py")
            .expect("script listed");
        assert_eq!(script.kind, SkillFileKind::Script);

        // Checksum is present and stable across identical content.
        let checksum = detail.record.checksum.clone().expect("checksum");
        assert_eq!(checksum.len(), 64);
        let again = skill_detail_for(&root, &id).expect("detail again");
        assert_eq!(again.record.checksum.as_deref(), Some(checksum.as_str()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn detail_of_unknown_id_errors() {
        let root = temp_root("detail-missing");
        assert!(skill_detail_for(&root, "deadbeefdeadbeef").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn index_round_trips_and_seeds_and_recovers_from_corruption() {
        let root = temp_root("index");
        let path = root.join(SKILL_INDEX_FILE);
        let index = load_index_at(&path);
        assert!(index.categories.iter().any(|c| c.id == "development"));
        assert!(index.categories.iter().any(|c| c.id == UNCATEGORIZED_ID));
        assert_eq!(index.categories.len(), PRESET_CATEGORIES.len());
        save_index_at(&path, &index).expect("save");
        assert_eq!(
            load_index_at(&path).categories.len(),
            PRESET_CATEGORIES.len()
        );

        // Corrupt content is quarantined and a fresh seeded index returned.
        fs::write(&path, b"{ not json").expect("corrupt");
        let recovered = load_index_at(&path);
        assert_eq!(recovered.categories.len(), PRESET_CATEGORIES.len());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reconcile_assigns_stable_ids_and_attaches_metadata() {
        let dir = temp_root("reconcile");
        write_skill(
            &dir,
            "release-notes",
            "---\nname: release-notes\ndescription: d.\n---\n",
        );
        let mut index = SkillIndex::default();

        let mut first = scan_skills_in(&dir);
        assert!(reconcile_index(&mut index, &mut first));
        let id = first.skills[0].id.clone();

        // Assign a category, then rescan: id stays stable and metadata attaches.
        let entry_id = index.entries.keys().next().unwrap().clone();
        index.entries.get_mut(&entry_id).unwrap().category_id = Some("development".into());
        let mut second = scan_skills_in(&dir);
        assert!(!reconcile_index(&mut index, &mut second));
        assert_eq!(second.skills[0].id, id);
        assert_eq!(second.skills[0].category_id.as_deref(), Some("development"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_category_migrates_entries_and_protects_presets() {
        let mut index = SkillIndex::default();
        index.categories.push(SkillCategory {
            id: "custom-x".into(),
            name: "X".into(),
            category_type: CategoryType::Custom,
            order: 99,
            archived: false,
        });
        index.entries.insert(
            "e1".into(),
            IndexEntry {
                id: "e1".into(),
                install_path: "/p".into(),
                name: "n".into(),
                category_id: Some("custom-x".into()),
                ..Default::default()
            },
        );

        // Presets are protected.
        assert!(delete_category_in(&mut index, "development", None).is_err());

        // Delete custom with migration → entry reassigned.
        delete_category_in(&mut index, "custom-x", Some("development".into())).expect("delete");
        assert!(!category_exists(&index, "custom-x"));
        assert_eq!(
            index.entries["e1"].category_id.as_deref(),
            Some("development")
        );
    }

    #[test]
    fn move_dir_relocates_a_tree_and_removes_the_source() {
        let root = temp_root("move");
        let from = root.join("from");
        fs::create_dir_all(from.join("nested")).expect("nested");
        fs::write(from.join("SKILL.md"), "x").expect("file");
        fs::write(from.join("nested/inner.txt"), "y").expect("inner");
        let to = root.join("dest").join("from");

        move_dir(&from, &to).expect("move");
        assert!(!from.exists());
        assert!(to.join("SKILL.md").is_file());
        assert!(to.join("nested/inner.txt").is_file());

        // Refuses to overwrite an existing destination.
        let other = root.join("other");
        fs::create_dir_all(&other).expect("other");
        assert!(move_dir(&other, &to).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_dir_all_skips_symlinks() {
        let root = temp_root("copy");
        let from = root.join("from");
        fs::create_dir_all(&from).expect("from");
        fs::write(from.join("real.txt"), "ok").expect("real");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", from.join("link")).expect("symlink");
        }
        let to = root.join("to");
        copy_dir_all(&from, &to).expect("copy");
        assert!(to.join("real.txt").is_file());
        assert!(!to.join("link").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reconcile_skips_disabled_entries_so_new_same_name_gets_new_id() {
        let dir = temp_root("reconcile-disabled");
        write_skill(
            &dir,
            "release-notes",
            "---\nname: release-notes\ndescription: d.\n---\n",
        );
        let mut index = SkillIndex::default();
        // Pre-existing DISABLED entry with the same name but a stale path.
        index.entries.insert(
            "old".into(),
            IndexEntry {
                id: "old".into(),
                install_path: "/gone/release-notes".into(),
                name: "release-notes".into(),
                source_type: Some("user".into()),
                disabled: true,
                quarantine_path: Some("/gone/release-notes".into()),
                ..Default::default()
            },
        );
        let mut result = scan_skills_in(&dir);
        reconcile_index(&mut index, &mut result);
        // The active skill must NOT adopt the disabled entry's id.
        assert_ne!(result.skills[0].id, "old");
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_zip(path: &Path, files: &[(&str, &[u8])], symlink: Option<(&str, &str)>) {
        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in files {
            writer.start_file(*name, options).expect("start file");
            writer.write_all(data).expect("write file");
        }
        if let Some((name, target)) = symlink {
            writer
                .add_symlink(name, target, options)
                .expect("add symlink");
        }
        writer.finish().expect("finish zip");
    }

    #[test]
    fn is_valid_skill_name_rules() {
        assert!(is_valid_skill_name("release-notes"));
        assert!(is_valid_skill_name("imagegen"));
        assert!(!is_valid_skill_name(""));
        assert!(!is_valid_skill_name(".hidden"));
        assert!(!is_valid_skill_name("a/b"));
        assert!(!is_valid_skill_name(".."));
    }

    #[test]
    fn extract_zip_safe_accepts_valid_and_locates_root() {
        let root = temp_root("zip-ok");
        let zip_path = root.join("skill.zip");
        write_zip(
            &zip_path,
            &[(
                "SKILL.md",
                b"---\nname: demo\ndescription: d.\n---\n" as &[u8],
            )],
            None,
        );
        let dest = root.join("out");
        extract_zip_safe(&zip_path, &dest).expect("extract");
        let roots = discover_skill_roots(&dest);
        assert_eq!(roots.len(), 1);
        assert!(roots[0].join(SKILL_MANIFEST_FILE).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_zip_safe_rejects_traversal_and_symlinks() {
        let root = temp_root("zip-bad");

        let traversal = root.join("traversal.zip");
        write_zip(&traversal, &[("../evil.txt", b"x" as &[u8])], None);
        assert!(extract_zip_safe(&traversal, &root.join("t")).is_err());

        let linked = root.join("link.zip");
        write_zip(
            &linked,
            &[(
                "SKILL.md",
                b"---\nname: demo\ndescription: d.\n---\n" as &[u8],
            )],
            Some(("link", "/etc/hosts")),
        );
        assert!(extract_zip_safe(&linked, &root.join("l")).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_skill_zip_roundtrips_and_hashes_stably() {
        let root = temp_root("export");
        let pkg = root.join("pkg");
        fs::create_dir_all(pkg.join("scripts")).expect("scripts");
        fs::write(
            pkg.join(SKILL_MANIFEST_FILE),
            "---\nname: demo\ndescription: d.\n---\n",
        )
        .expect("manifest");
        fs::write(pkg.join("scripts/run.py"), "print('x')\n").expect("script");

        let (files, _size, _truncated) = walk_skill_files(&pkg);
        let zip_a = root.join("a.zip");
        write_skill_zip(&pkg, &files, &zip_a).expect("zip a");
        let zip_b = root.join("b.zip");
        write_skill_zip(&pkg, &files, &zip_b).expect("zip b");

        // Re-open and confirm the manifest is present.
        let file = fs::File::open(&zip_a).expect("open");
        let mut archive = zip::ZipArchive::new(file).expect("archive");
        assert!(archive.by_name(SKILL_MANIFEST_FILE).is_ok());

        // Same content → same checksum.
        assert_eq!(
            sha256_hex_of_file(&zip_a).unwrap(),
            sha256_hex_of_file(&zip_b).unwrap()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_export_warnings_flags_private_key() {
        let root = temp_root("export-warn");
        fs::write(
            root.join(SKILL_MANIFEST_FILE),
            "---\nname: demo\ndescription: d.\n---\n-----BEGIN PRIVATE KEY-----\n",
        )
        .expect("manifest");
        let (files, _s, _t) = walk_skill_files(&root);
        let warnings = scan_export_warnings(&root, &files);
        assert!(warnings.iter().any(|w| w.code == "POSSIBLE_SECRET"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_skill_roots_handles_single_and_collection() {
        let root = temp_root("collection");
        for name in ["alpha", "beta"] {
            let dir = root.join(name);
            fs::create_dir_all(&dir).expect("skill dir");
            fs::write(
                dir.join(SKILL_MANIFEST_FILE),
                format!("---\nname: {name}\ndescription: d.\n---\n"),
            )
            .expect("manifest");
        }
        fs::create_dir_all(root.join(".hidden")).expect("hidden");

        // A collection directory yields one root per contained skill.
        assert_eq!(discover_skill_roots(&root).len(), 2);
        // A single-skill directory yields itself.
        assert_eq!(discover_skill_roots(&root.join("alpha")).len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_github_url_extracts_parts_and_rejects_untrusted() {
        let (owner, repo, git_ref, subpath) =
            parse_github_url("https://github.com/openai/skills").expect("root url");
        assert_eq!((owner.as_str(), repo.as_str(), git_ref.as_str()), ("openai", "skills", "main"));
        assert_eq!(subpath, None);

        let (_, repo, git_ref, subpath) = parse_github_url(
            "https://github.com/openai/skills/tree/main/skills/.curated/release-notes",
        )
        .expect("tree url");
        assert_eq!(repo, "skills");
        assert_eq!(git_ref, "main");
        assert_eq!(subpath.as_deref(), Some("skills/.curated/release-notes"));

        assert!(parse_github_url("http://github.com/o/r").is_err()); // not https
        assert!(parse_github_url("https://example.com/o/r").is_err()); // not github
        assert!(parse_github_url("https://user@github.com/o/r").is_err()); // credentials
        assert!(parse_github_url("https://github.com/only-owner").is_err()); // missing repo
    }

    #[test]
    fn install_preview_flags_conflict_and_scripts() {
        let root = temp_root("preview");
        let pkg = root.join("pkg");
        fs::create_dir_all(pkg.join("scripts")).expect("scripts");
        fs::write(
            pkg.join(SKILL_MANIFEST_FILE),
            "---\nname: release-notes\ndescription: d.\n---\n",
        )
        .expect("manifest");
        fs::write(pkg.join("scripts/run.py"), "print('x')\n").expect("script");

        let skills_dir = root.join("skills");
        fs::create_dir_all(&skills_dir).expect("skills");

        // No conflict yet, but scripts produce a warning.
        let preview = build_install_preview(&pkg, &skills_dir).expect("preview");
        assert_eq!(preview.target_name, "release-notes");
        assert!(!preview.conflict);
        assert_eq!(preview.scripts, vec!["scripts/run.py".to_string()]);
        assert!(preview.warnings.iter().any(|w| w.code == "SCRIPTS_PRESENT"));

        // Create the target → conflict flagged.
        fs::create_dir_all(skills_dir.join("release-notes")).expect("existing");
        let preview = build_install_preview(&pkg, &skills_dir).expect("preview");
        assert!(preview.conflict);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn append_disabled_skills_lists_quarantined_skill() {
        let root = temp_root("append-disabled");
        let quarantine = root.join("q").join("release-notes");
        fs::create_dir_all(&quarantine).expect("quarantine");
        fs::write(
            quarantine.join(SKILL_MANIFEST_FILE),
            "---\nname: release-notes\ndescription: d.\n---\n",
        )
        .expect("manifest");

        let mut index = SkillIndex::default();
        index.entries.insert(
            "e1".into(),
            IndexEntry {
                id: "e1".into(),
                install_path: "/skills/release-notes".into(),
                name: "release-notes".into(),
                source_type: Some("user".into()),
                disabled: true,
                quarantine_path: Some(quarantine.to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        let mut result = SkillScanResult {
            skills: Vec::new(),
            failed_sources: Vec::new(),
            categories: Vec::new(),
            scanned_at: now_millis(),
        };
        append_disabled_skills(&index, &mut result);
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0].id, "e1");
        assert_eq!(result.skills[0].status, SkillStatus::Disabled);
        let _ = fs::remove_dir_all(&root);
    }
}
