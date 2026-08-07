import { invoke } from "@tauri-apps/api/core";

export type CodexStatus = {
  configPath: string;
  authPath: string;
  modelProvider?: string;
  configValid: boolean;
  configExists: boolean;
  authExists: boolean;
  configured: boolean;
  providerStatus: "autogateway" | "openai" | "third-party" | "invalid";
  configBackupCount: number;
  authBackupCount: number;
};

export type CodexAppStatus = {
  installed: boolean;
  cachedInstallerAvailable?: boolean;
  path?: string;
  localVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  updateCheckError?: string;
  platformMessage: string;
};

export type CodexInstallResult = {
  installed: boolean;
  path?: string;
  message: string;
  awaitingInstallation: boolean;
  canRetryCachedInstaller: boolean;
};

export type CodexInstallProgress = {
  stage:
    | "preparing"
    | "selecting-source"
    | "downloading"
    | "installing"
    | "windows-installing"
    | "verifying"
    | "complete";
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  source?: string;
  speedBytesPerSecond?: number;
  estimatedRemainingSeconds?: number;
};

export type ConfigurationResult = {
  configPath: string;
  authPath: string;
  configBackupPath?: string;
  authBackupPath?: string;
};

export type RestoreResult = {
  configBackupPath?: string;
  authBackupPath?: string;
};

export type DesktopSession = {
  token: string;
  refreshToken: string;
  user: {
    id: number;
    username: string;
    email?: string;
    displayName?: string;
    name: string;
    role: string;
  };
};

export type DesktopBootstrapKey = {
  apiKey: string;
  created: boolean;
};

export type StoredDesktopState = {
  session: DesktopSession;
  apiKey: string;
};

export type DesktopAccountSummary = {
  balance: string;
};

export type DesktopNotification = {
  id: number;
  audience: string;
  title: string;
  body: string;
  severity?: string;
  linkUrl?: string;
  sortOrder?: number;
  popupDefault?: boolean;
  enabled?: boolean;
  startsAt?: string;
  endsAt?: string;
  readAt?: string;
  createdAt?: string;
};

export type DesktopNotificationList = {
  items: DesktopNotification[];
  unreadCount?: number;
};

export type SkillSourceType =
  | "user"
  | "system"
  | "plugin"
  | "external"
  | "autogateway"
  | "team";

export type SkillOwnership = "user-managed" | "source-managed" | "read-only";

export type SkillStatus =
  | "enabled"
  | "disabled"
  | "error"
  | "source-unavailable";

export type SkillTrustLevel =
  | "system"
  | "verified"
  | "known-source"
  | "unverified";

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  sourceType: SkillSourceType;
  sourceUri?: string;
  installPath: string;
  scope: string;
  ownership: SkillOwnership;
  status: SkillStatus;
  version?: string;
  checksum?: string;
  categoryId?: string;
  tags: string[];
  trustLevel: SkillTrustLevel;
  installedAt?: string;
  updatedAt?: string;
  lastScannedAt: string;
};

export type SkillScanFailure = {
  path: string;
  reason: string;
};

export type SkillCategoryType = "preset" | "custom";

export type SkillCategory = {
  id: string;
  name: string;
  type: SkillCategoryType;
  order: number;
  archived: boolean;
};

export type SkillScanResult = {
  skills: SkillRecord[];
  failedSources: SkillScanFailure[];
  categories: SkillCategory[];
  scannedAt: string;
};

export type SkillFileKind =
  | "markdown"
  | "script"
  | "reference"
  | "asset"
  | "agent"
  | "other";

export type SkillFileEntry = {
  relativePath: string;
  sizeBytes: number;
  isExecutable: boolean;
  kind: SkillFileKind;
};

export type SkillDetail = SkillRecord & {
  files: SkillFileEntry[];
  scripts: string[];
  markdownBody?: string;
  totalSizeBytes: number;
  fileCount: number;
  truncated: boolean;
};

export type RecoverableSkill = {
  id: string;
  name: string;
  removedAt?: string;
};

export type SkillRiskFinding = {
  code: string;
  severity: string;
  path?: string;
  message: string;
};

export type SkillInstallSourceKind = "dir" | "zip" | "git";

export type SkillInstallProgress = {
  stage:
    | "resolving"
    | "downloading"
    | "extracting"
    | "installing"
    | "complete";
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
};

export type SkillInstallPreview = {
  name: string;
  description: string;
  version?: string;
  targetName: string;
  targetPath: string;
  fileCount: number;
  totalSizeBytes: number;
  scripts: string[];
  conflict: boolean;
  warnings: SkillRiskFinding[];
};

export function getCodexStatus(): Promise<CodexStatus> {
  return invoke<CodexStatus>("get_codex_status");
}

export function scanSkills(): Promise<SkillScanResult> {
  return invoke<SkillScanResult>("scan_skills");
}

export function getSkillDetail(id: string): Promise<SkillDetail> {
  return invoke<SkillDetail>("get_skill_detail", { id });
}

export function setSkillCategory(
  id: string,
  categoryId: string | null,
): Promise<void> {
  return invoke<void>("set_skill_category", { id, categoryId });
}

export function setSkillsCategory(
  ids: string[],
  categoryId: string | null,
): Promise<void> {
  return invoke<void>("set_skills_category", { ids, categoryId });
}

export function setSkillTags(id: string, tags: string[]): Promise<void> {
  return invoke<void>("set_skill_tags", { id, tags });
}

export function createCategory(name: string): Promise<SkillCategory> {
  return invoke<SkillCategory>("create_category", { name });
}

export function renameCategory(id: string, name: string): Promise<void> {
  return invoke<void>("rename_category", { id, name });
}

export function reorderCategories(orderedIds: string[]): Promise<void> {
  return invoke<void>("reorder_categories", { orderedIds });
}

export function archiveCategory(id: string, archived: boolean): Promise<void> {
  return invoke<void>("archive_category", { id, archived });
}

export function deleteCategory(
  id: string,
  migrateTo: string | null,
): Promise<void> {
  return invoke<void>("delete_category", { id, migrateTo });
}

export function enableSkill(id: string): Promise<void> {
  return invoke<void>("enable_skill", { id });
}

export function disableSkill(id: string): Promise<void> {
  return invoke<void>("disable_skill", { id });
}

export function removeSkill(id: string): Promise<void> {
  return invoke<void>("remove_skill", { id });
}

export function restoreSkill(id: string): Promise<void> {
  return invoke<void>("restore_skill", { id });
}

export function listRecoverableSkills(): Promise<RecoverableSkill[]> {
  return invoke<RecoverableSkill[]>("list_recoverable_skills");
}

export type SkillInstallSkip = { name: string; reason: string };

export type SkillInstallSummary = {
  installed: string[];
  skipped: SkillInstallSkip[];
  failed: SkillInstallSkip[];
};

export function validateSkillSource(
  kind: SkillInstallSourceKind,
  location: string,
): Promise<SkillInstallPreview[]> {
  return invoke<SkillInstallPreview[]>("validate_skill_source", {
    kind,
    location,
  });
}

export function installSkill(
  kind: SkillInstallSourceKind,
  location: string,
  replace: boolean,
  names: string[],
): Promise<SkillInstallSummary> {
  return invoke<SkillInstallSummary>("install_skill", {
    kind,
    location,
    replace,
    names,
  });
}

export type SkillExportResult = {
  zipPath: string;
  sha256: string;
  sizeBytes: number;
  warnings: SkillRiskFinding[];
};

export function exportSkill(id: string): Promise<SkillExportResult> {
  return invoke<SkillExportResult>("export_skill", { id });
}

export function getCodexAppStatus(): Promise<CodexAppStatus> {
  return invoke<CodexAppStatus>("get_codex_app_status");
}

export function getLocalCodexAppStatus(): Promise<CodexAppStatus> {
  return invoke<CodexAppStatus>("get_local_codex_app_status");
}

export function installCodex(
  forceUpdate = false,
  forceRedownload = false,
): Promise<CodexInstallResult> {
  return invoke<CodexInstallResult>("install_codex", {
    forceUpdate,
    forceRedownload,
  });
}

export function openCodex(): Promise<void> {
  return invoke<void>("open_codex");
}

export function isCodexRunning(): Promise<boolean> {
  return invoke<boolean>("is_codex_running");
}

export function configureCodex(
  apiKey: string,
  endpoint: string,
): Promise<ConfigurationResult> {
  return invoke<ConfigurationResult>("configure_codex", { apiKey, endpoint });
}

export function restoreLatestCodexBackups(): Promise<RestoreResult> {
  return invoke<RestoreResult>("restore_latest_codex_backups");
}

export function openConsole(
  accessToken: string,
  section?: "billing" | "support",
): Promise<void> {
  return invoke<void>("open_console", { accessToken, section });
}

export function openDevtools(): Promise<void> {
  return invoke<void>("open_devtools");
}

export function getDesktopAccountSummary(
  accessToken: string,
): Promise<DesktopAccountSummary> {
  return invoke<DesktopAccountSummary>("get_desktop_account_summary_command", {
    accessToken,
  });
}

export function getDesktopNotifications(
  accessToken: string,
): Promise<DesktopNotificationList> {
  return invoke<DesktopNotificationList>("get_desktop_notifications_command", {
    accessToken,
  });
}

export function openNotificationWindow(notificationID: number): Promise<void> {
  return invoke<void>("open_notification_window", {
    notificationId: notificationID,
  });
}

export function openNotificationBrowser(url: string): Promise<void> {
  return invoke<void>("open_notification_browser", { url });
}

export function downloadAndOpenDesktopInstaller(
  installerUrl: string,
): Promise<string> {
  return invoke<string>("download_and_open_desktop_installer", {
    installerUrl,
  });
}

export function updateTrayStatus(
  username: string,
  balance: string,
): Promise<void> {
  return invoke<void>("update_tray_status_command", { username, balance });
}

export function showMainWindow(): Promise<void> {
  return invoke<void>("show_main_window");
}

export function getDesktopAppVersion(): Promise<string> {
  return invoke<string>("get_desktop_app_version");
}

export function getInstallationID(): Promise<string> {
  return invoke<string>("get_installation_id");
}

export function exchangeDesktopAuthorization(
  code: string,
  codeVerifier: string,
  state: string,
): Promise<DesktopSession> {
  return invoke<DesktopSession>("exchange_desktop_authorization_command", {
    code,
    codeVerifier,
    state,
  });
}

export function openDesktopSignIn(
  challenge: string,
  state: string,
): Promise<void> {
  return invoke<void>("open_desktop_sign_in_command", { challenge, state });
}

export function closeDesktopSignIn(): Promise<void> {
  return invoke<void>("close_desktop_sign_in_command");
}

export function bootstrapDesktopKey(
  accessToken: string,
  rotateExisting = false,
): Promise<DesktopBootstrapKey> {
  return invoke<DesktopBootstrapKey>("bootstrap_desktop_key_command", {
    accessToken,
    rotateExisting,
  });
}

export function restoreDesktopState(): Promise<StoredDesktopState | null> {
  return invoke<StoredDesktopState | null>("restore_desktop_state_command");
}

export function refreshDesktopState(
  failedAccessToken: string,
): Promise<StoredDesktopState | null> {
  return invoke<StoredDesktopState | null>("refresh_desktop_state_command", {
    failedAccessToken,
  });
}

export function clearDesktopSession(): Promise<void> {
  return invoke<void>("clear_desktop_session_command");
}

export function signOutDesktop(): Promise<void> {
  return invoke<void>("sign_out_desktop_command");
}

export function clearStoredDesktopAPIKey(): Promise<void> {
  return invoke<void>("clear_stored_desktop_api_key_command");
}

export function isAuthenticationRequired(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("authentication_required") ||
    message.includes("http 401") ||
    message.includes("http 403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden")
  );
}
