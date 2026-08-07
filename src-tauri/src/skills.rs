use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
#[tauri::command]
pub fn scan_skills(_app: tauri::AppHandle) -> Result<SkillScanResult, String> {
    let dir = default_skills_dir()?;
    Ok(scan_skills_in(&dir))
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

/// Build the full detail for one skill, located by its scan id so the backend
/// stays authoritative over the install path (no client-supplied paths).
pub fn skill_detail_for(dir: &Path, id: &str) -> Result<SkillDetail, String> {
    let mut record = scan_skills_in(dir)
        .skills
        .into_iter()
        .find(|skill| skill.id == id)
        .ok_or_else(|| "the requested skill was not found".to_string())?;

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

    Ok(SkillDetail {
        record,
        files,
        scripts,
        markdown_body,
        total_size_bytes: total_size,
        file_count,
        truncated,
    })
}

#[tauri::command]
pub fn get_skill_detail(_app: tauri::AppHandle, id: String) -> Result<SkillDetail, String> {
    let dir = default_skills_dir()?;
    skill_detail_for(&dir, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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
}
