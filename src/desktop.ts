import { invoke } from "@tauri-apps/api/core";

export type CodexStatus = {
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  configured: boolean;
  configBackupCount: number;
  authBackupCount: number;
};

export type CodexAppStatus = {
  installed: boolean;
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
};

export type CodexInstallProgress = {
  stage: "preparing" | "downloading" | "installing" | "verifying" | "complete";
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
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

export function getCodexStatus(): Promise<CodexStatus> {
  return invoke<CodexStatus>("get_codex_status");
}

export function getCodexAppStatus(): Promise<CodexAppStatus> {
  return invoke<CodexAppStatus>("get_codex_app_status");
}

export function installCodex(forceUpdate = false): Promise<CodexInstallResult> {
  return invoke<CodexInstallResult>("install_codex", { forceUpdate });
}

export function openCodex(): Promise<void> {
  return invoke<void>("open_codex");
}

export function configureCodex(apiKey: string, endpoint: string): Promise<ConfigurationResult> {
  return invoke<ConfigurationResult>("configure_codex", { apiKey, endpoint });
}

export function restoreLatestCodexBackups(): Promise<RestoreResult> {
  return invoke<RestoreResult>("restore_latest_codex_backups");
}

export function openConsole(accessToken: string, section?: "billing"): Promise<void> {
  return invoke<void>("open_console", { accessToken, section });
}

export function openDevtools(): Promise<void> {
  return invoke<void>("open_devtools");
}

export function getDesktopAccountSummary(accessToken: string): Promise<DesktopAccountSummary> {
  return invoke<DesktopAccountSummary>("get_desktop_account_summary_command", { accessToken });
}

export function updateTrayStatus(username: string, balance: string): Promise<void> {
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

export function exchangeDesktopAuthorization(code: string, codeVerifier: string, state: string): Promise<DesktopSession> {
  return invoke<DesktopSession>("exchange_desktop_authorization_command", { code, codeVerifier, state });
}

export function bootstrapDesktopKey(accessToken: string, rotateExisting = false): Promise<DesktopBootstrapKey> {
  return invoke<DesktopBootstrapKey>("bootstrap_desktop_key_command", { accessToken, rotateExisting });
}

export function restoreDesktopState(): Promise<StoredDesktopState | null> {
  return invoke<StoredDesktopState | null>("restore_desktop_state_command");
}

export function refreshDesktopState(failedAccessToken: string): Promise<StoredDesktopState | null> {
  return invoke<StoredDesktopState | null>("refresh_desktop_state_command", { failedAccessToken });
}

export function clearDesktopSession(): Promise<void> {
  return invoke<void>("clear_desktop_session_command");
}

export function clearStoredDesktopAPIKey(): Promise<void> {
  return invoke<void>("clear_stored_desktop_api_key_command");
}

export function isAuthenticationRequired(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("authentication_required") || message.includes("http 401") || message.includes("http 403") || message.includes("unauthorized") || message.includes("forbidden");
}
