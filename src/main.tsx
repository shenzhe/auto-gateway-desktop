import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowRightIcon,
  ArrowUUpLeftIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  CubeIcon,
  CurrencyDollarIcon,
  GearIcon,
  HouseIcon,
  ChatCircleTextIcon,
  QuestionIcon,
  SignOutIcon,
  UserCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  bootstrapDesktopKey,
  closeDesktopSignIn,
  clearDesktopSession,
  clearStoredDesktopAPIKey,
  configureCodex,
  exchangeDesktopAuthorization,
  getCodexAppStatus,
  getCodexStatus,
  getDesktopAccountSummary,
  getDesktopAppVersion,
  getLocalCodexAppStatus,
  installCodex,
  isCodexRunning,
  isAuthenticationRequired,
  openDesktopSignIn,
  openCodex,
  openConsole,
  openDevtools,
  refreshDesktopState,
  restoreDesktopState,
  restoreLatestCodexBackups,
  signOutDesktop,
  showMainWindow,
  updateTrayStatus,
  type CodexAppStatus,
  type CodexInstallProgress,
  type CodexStatus,
  type DesktopAccountSummary,
  type DesktopSession,
} from "./desktop";
import {
  readLocalePreference,
  resolveLocale,
  translate,
  writeLocalePreference,
  type LocalePreference,
} from "./i18n";
import { applyTheme, readTheme, writeTheme, type ThemeMode } from "./theme";
import "./styles.css";

const defaultEndpoint = "https://api.autogateway.cc";
const pendingAuthorizationStorageKey =
  "autogateway.desktop.pending-authorization";
const setupCompletedStoragePrefix = "autogateway.desktop.setup-completed";
const externalInstallationTimeoutMs = 5 * 60 * 1000;
const designPreviewState = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get("preview")
  : null;

type PendingAuthorization = {
  verifier: string;
  state: string;
};

type WizardStep = 1 | 2 | 3 | 4;
type ConfigurationPhase =
  "idle" | "creatingKey" | "configuring" | "complete" | "error";
type DesktopUpdatePhase =
  "idle" | "checking" | "ready" | "downloading" | "error" | "manual";
type CodexOpenPhase = "closed" | "opening" | "opened";

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function createVerifier(): string {
  const bytes = new Uint8Array(64);
  window.crypto.getRandomValues(bytes);
  return base64URL(bytes);
}

async function createChallenge(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64URL(new Uint8Array(digest));
}

function createState(): string {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return base64URL(bytes);
}

function readPendingAuthorization(): PendingAuthorization | null {
  try {
    const raw = window.sessionStorage.getItem(pendingAuthorizationStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingAuthorization;
    return value.verifier && value.state ? value : null;
  } catch {
    return null;
  }
}

function setupCompletedStorageKey(userID: number): string {
  return `${setupCompletedStoragePrefix}:${userID}`;
}

function hasCompletedSetup(session: DesktopSession): boolean {
  return (
    window.localStorage.getItem(setupCompletedStorageKey(session.user.id)) ===
    "true"
  );
}

function formatSyncTime(
  value: Date | null,
  locale: "en" | "zh",
  fallback: string,
): string {
  if (!value) return fallback;
  return value.toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDownloadSpeed(bytesPerSecond?: number): string {
  if (
    !bytesPerSecond ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  )
    return "";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDataSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatRemainingDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return "";
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  return `${minutes}m ${rounded % 60}s`;
}

function isTrayPopupWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === "tray-popup";
  } catch {
    return false;
  }
}

function useDisableContextMenu(): void {
  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu, true);
    return () =>
      document.removeEventListener("contextmenu", preventContextMenu, true);
  }, []);
}

function TrayPopup() {
  const [desktopSession, setDesktopSession] = useState<DesktopSession | null>(
    null,
  );
  const [accountBalance, setAccountBalance] = useState("");
  const [loading, setLoading] = useState(true);
  const [windowFocused, setWindowFocused] = useState(false);
  const theme = readTheme();
  const localePreference = readLocalePreference();
  const locale = resolveLocale(localePreference);
  const tr = (
    key: Parameters<typeof translate>[1],
    values?: Record<string, string | number>,
  ) => translate(locale, key, values);
  const accountName =
    desktopSession?.user.displayName ||
    desktopSession?.user.name ||
    desktopSession?.user.username ||
    tr("trayLoading");
  const accountDetail =
    desktopSession?.user.email || desktopSession?.user.username || "";

  useDisableContextMenu();

  useEffect(() => {
    document.body.classList.add("tray-popup-body");
    applyTheme(theme);
    return () => document.body.classList.remove("tray-popup-body");
  }, [theme]);

  useEffect(() => {
    const window = getCurrentWebviewWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    void window
      .isFocused()
      .then((focused) => {
        if (active) setWindowFocused(focused);
      })
      .catch(() => undefined);
    void window
      .onFocusChanged(({ payload }) => {
        if (active) setWindowFocused(payload);
      })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!windowFocused) return;
    let active = true;
    let syncing = false;
    async function syncAccount() {
      if (syncing) return;
      syncing = true;
      try {
        const stored = await restoreDesktopState();
        if (!active) return;
        setDesktopSession(stored?.session ?? null);
        if (!stored?.session.token) {
          setAccountBalance(tr("trayUnavailable"));
          return;
        }
        let session = stored.session;
        let summary: DesktopAccountSummary;
        try {
          summary = await getDesktopAccountSummary(session.token);
        } catch (error) {
          if (!isAuthenticationRequired(error)) throw error;
          const refreshed = await refreshDesktopState(session.token);
          if (!refreshed?.session.token) throw error;
          session = refreshed.session;
          if (active) setDesktopSession(session);
          summary = await getDesktopAccountSummary(session.token);
        }
        if (active) setAccountBalance(summary.balance);
      } catch (error) {
        if (isAuthenticationRequired(error)) {
          void clearDesktopSession();
          if (active) setDesktopSession(null);
          if (active) setAccountBalance(tr("trayUnavailable"));
        }
      } finally {
        syncing = false;
        if (active) setLoading(false);
      }
    }
    void syncAccount();
    const interval = window.setInterval(() => void syncAccount(), 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [locale, windowFocused]);

  async function openWorkspace() {
    await showMainWindow();
    await getCurrentWebviewWindow().hide();
  }

  async function quitApplication() {
    await exit(0);
  }

  async function signOut() {
    if (!window.confirm(tr("signOutConfirm"))) return;
    try {
      await signOutDesktop();
      setDesktopSession(null);
      setAccountBalance("");
      await updateTrayStatus("", tr("trayUnavailable"));
      await showMainWindow();
      await getCurrentWebviewWindow().hide();
    } catch {
      setAccountBalance(tr("trayUnavailable"));
    }
  }

  return (
    <main className="trayPopupRoot">
      <section className="trayCard" role="dialog" aria-label={tr("trayTitle")}>
        <header className="trayHeader">
          <img className="trayLogo" src="/site-icon.png" alt="" />
          <div className="trayBrand">
            <strong>{tr("trayTitle")}</strong>
            <span>{loading ? tr("trayLoading") : tr("traySignedInAs")}</span>
          </div>
          <span
            className={`trayOnlineDot ${desktopSession ? "ready" : ""}`}
            aria-hidden="true"
          />
        </header>
        <div className="trayAccount">
          <div className="trayAvatar" aria-hidden="true">
            {accountName.slice(0, 1).toUpperCase()}
          </div>
          <div className="trayAccountInfo">
            <strong>{accountName}</strong>
            <small>{accountDetail || tr("trayUnavailable")}</small>
          </div>
          <div className="trayBalance">
            <span>{tr("trayBalance")}</span>
            <strong>{accountBalance || "—"}</strong>
          </div>
        </div>
        <div className="trayActions">
          <button
            className="trayPrimaryButton"
            type="button"
            onClick={() => void openWorkspace()}
          >
            {tr("trayOpenWorkspace")}
          </button>
          <button
            className="traySecondaryButton"
            type="button"
            onClick={() => void signOut()}
          >
            {tr("signOut")}
          </button>
          <button
            className="traySecondaryButton"
            type="button"
            onClick={() => void quitApplication()}
          >
            {tr("trayQuit")}
          </button>
        </div>
      </section>
    </main>
  );
}

function App() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [appStatus, setAppStatus] = useState<CodexAppStatus | null>(null);
  const [apiKey, setAPIKey] = useState("");
  const [desktopAccessToken, setDesktopAccessToken] = useState("");
  const [desktopSignInUrl, setDesktopSignInUrl] = useState("");
  const [desktopSession, setDesktopSession] = useState<DesktopSession | null>(
    null,
  );
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const [installingCodex, setInstallingCodex] = useState(false);
  const [checkingCodexUpdates, setCheckingCodexUpdates] = useState(false);
  const [awaitingExternalInstallation, setAwaitingExternalInstallation] =
    useState(false);
  const [storeInstallForceUpdate, setStoreInstallForceUpdate] = useState(false);
  const [canRetryCachedInstaller, setCanRetryCachedInstaller] = useState(false);
  const [externalInstallationMessage, setExternalInstallationMessage] =
    useState("");
  const [installationTimedOut, setInstallationTimedOut] = useState(false);
  const externalInstallationStartedAt = useRef<number | null>(null);
  const storeAutoRetryAttempted = useRef(false);
  const [setupCompleted, setSetupCompleted] = useState(false);
  const [accountBalance, setAccountBalance] = useState("");
  const [balanceSyncedAt, setBalanceSyncedAt] = useState<Date | null>(null);
  const [desktopAppVersion, setDesktopAppVersion] = useState("");
  const [installProgress, setInstallProgress] =
    useState<CodexInstallProgress | null>(null);
  const [configurationPhase, setConfigurationPhase] =
    useState<ConfigurationPhase>("idle");
  const [configurationError, setConfigurationError] = useState("");
  const [apiKeyCopied, setAPIKeyCopied] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<Update | null>(null);
  const [desktopUpdatePhase, setDesktopUpdatePhase] =
    useState<DesktopUpdatePhase>("idle");
  const [desktopUpdateProgress, setDesktopUpdateProgress] = useState<
    number | null
  >(null);
  const [desktopUpdateError, setDesktopUpdateError] = useState("");
  const [desktopInstallerUrl, setDesktopInstallerUrl] = useState("");
  const [homeActionError, setHomeActionError] = useState("");
  const [codexOpenPhase, setCodexOpenPhase] =
    useState<CodexOpenPhase>("closed");
  const [selectedStep, setSelectedStep] = useState<WizardStep>(1);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => readTheme());
  const [localePreference, setLocalePreference] = useState<LocalePreference>(
    () => readLocalePreference(),
  );
  const configurationRun = useRef(false);
  const authorizationExchangeInProgress = useRef(false);
  const completedAuthorizationCode = useRef("");
  const locale = resolveLocale(localePreference);
  const tr = (
    key: Parameters<typeof translate>[1],
    values?: Record<string, string | number>,
  ) => translate(locale, key, values);

  useDisableContextMenu();

  const accountConnected = Boolean(desktopAccessToken);
  const appInstalled = Boolean(appStatus?.installed);
  const updateAvailable = appStatus?.updateAvailable === true;
  const installPercent =
    typeof installProgress?.percent === "number" &&
    Number.isFinite(installProgress.percent)
      ? installProgress.percent
      : undefined;
  const downloadSpeed = formatDownloadSpeed(
    installProgress?.speedBytesPerSecond,
  );
  const downloadedSize = formatDataSize(installProgress?.downloadedBytes);
  const totalDownloadSize = formatDataSize(installProgress?.totalBytes);
  const downloadRemaining = formatRemainingDuration(
    installProgress?.estimatedRemainingSeconds,
  );
  const downloadAmountDetails = totalDownloadSize
    ? tr("downloadBytesDetails", {
        downloaded: downloadedSize,
        total: totalDownloadSize,
      })
    : tr("downloadBytesUnknownTotal", { downloaded: downloadedSize });
  const downloadSpeedDetails = downloadSpeed
    ? tr("downloadSpeedDetails", { speed: downloadSpeed })
    : tr("calculatingDownloadSpeed");
  const downloadProgressDetails =
    installProgress?.stage === "downloading" && installProgress.source
      ? downloadSpeed && downloadRemaining
        ? tr("downloadStatusDetails", {
            source: installProgress.source,
            remaining: downloadRemaining,
          })
        : tr("downloadSourceDetails", { source: installProgress.source })
      : "";
  const configured = Boolean(status?.configured);
  const providerStatus = status?.providerStatus ?? "checking";
  const codexDetected = accountConnected && appInstalled;
  const gatewayConfigured =
    codexDetected && (configured || configurationPhase === "complete");
  const backupCount =
    (status?.configBackupCount ?? 0) + (status?.authBackupCount ?? 0);
  const accountName =
    desktopSession?.user.displayName ||
    desktopSession?.user.name ||
    desktopSession?.user.username ||
    "";
  const accountDetail =
    desktopSession?.user.email || desktopSession?.user.username || "";
  const showHome = setupCompleted && Boolean(desktopSession);

  function resetSessionState(nextMessage: string) {
    window.sessionStorage.removeItem(pendingAuthorizationStorageKey);
    configurationRun.current = false;
    authorizationExchangeInProgress.current = false;
    setBusy(false);
    setInstallingCodex(false);
    setCheckingCodexUpdates(false);
    setDesktopAccessToken("");
    setDesktopSignInUrl("");
    setDesktopSession(null);
    setAPIKey("");
    setAPIKeyCopied(false);
    setAccountBalance("");
    setBalanceSyncedAt(null);
    setSetupCompleted(false);
    setConfigurationPhase("idle");
    setConfigurationError("");
    externalInstallationStartedAt.current = null;
    setAwaitingExternalInstallation(false);
    setCanRetryCachedInstaller(false);
    setExternalInstallationMessage("");
    setInstallationTimedOut(false);
    storeAutoRetryAttempted.current = false;
    setSelectedStep(1);
    setHomeActionError("");
    setMessage(nextMessage);
    void updateTrayStatus("", tr("trayUnavailable"));
  }

  async function handleSessionExpired() {
    try {
      await clearDesktopSession();
    } catch {
      // The in-memory state must still be cleared when the local session file cannot be removed.
    }
    resetSessionState(tr("sessionExpired"));
  }

  async function handleSignOut() {
    if (busy || installingCodex || restoringSession) return;
    if (!window.confirm(tr("signOutConfirm"))) return;
    setBusy(true);
    try {
      await signOutDesktop();
      resetSessionState(tr("signedOut"));
    } catch (error) {
      setMessage(tr("signOutFailed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus(updateMessage = true) {
    try {
      const [nextStatus, nextAppStatus] = await Promise.all([
        getCodexStatus(),
        getLocalCodexAppStatus(),
      ]);
      setStatus(nextStatus);
      setAppStatus(nextAppStatus);
      if (updateMessage)
        setMessage(
          nextStatus.configured ? tr("connected") : tr("notConfigured"),
        );
    } catch (error) {
      setMessage(tr("readStatusFailed", { error: String(error) }));
    }
  }

  async function handleCheckCodexUpdates() {
    if (checkingCodexUpdates || installingCodex) return;
    setCheckingCodexUpdates(true);
    setMessage(tr("checkingCodexUpdates"));
    try {
      const nextAppStatus = await getCodexAppStatus();
      setAppStatus(nextAppStatus);
      if (!nextAppStatus.installed) {
        setMessage(tr("notInstalled"));
      } else if (nextAppStatus.updateCheckError) {
        setMessage(tr("updateCheckUnavailable"));
      } else if (nextAppStatus.updateAvailable) {
        setMessage(
          tr("codexUpdateFound", {
            version: nextAppStatus.latestVersion || tr("versionUnavailable"),
          }),
        );
      } else {
        setMessage(tr("codexUpToDate"));
      }
    } catch (error) {
      setMessage(tr("readStatusFailed", { error: String(error) }));
    } finally {
      setCheckingCodexUpdates(false);
    }
  }

  async function checkDesktopUpdate(manual = false) {
    if (
      desktopUpdatePhase === "checking" ||
      desktopUpdatePhase === "downloading"
    )
      return;
    setDesktopUpdatePhase("checking");
    setDesktopUpdateError("");
    setDesktopInstallerUrl("");
    try {
      const nextUpdate = await check();
      setDesktopUpdate(nextUpdate);
      setDesktopUpdatePhase(nextUpdate ? "ready" : "idle");
      if (manual)
        setMessage(
          nextUpdate
            ? tr("desktopUpdateFound", { version: nextUpdate.version })
            : tr("desktopUpToDate"),
        );
    } catch (error) {
      const errorMessage = String(error);
      setDesktopUpdatePhase("error");
      setDesktopUpdateError(errorMessage);
      if (manual) setMessage(tr("desktopUpdateCheckUnavailable"));
    }
  }

  useEffect(() => {
    if (!designPreviewState) return;
    const previewCodexUpdate = designPreviewState === "codex-update";
    const previewComplete = designPreviewState === "configuration-complete";
    setStatus({
      configPath: "/Users/demo/.codex/config.toml",
      authPath: "/Users/demo/.codex/auth.json",
      configExists: previewComplete,
      authExists: previewComplete,
      configured: previewComplete,
      providerStatus: previewComplete ? "autogateway" : "invalid",
      configBackupCount: 1,
      authBackupCount: 1,
    });
    setAppStatus({
      installed: true,
      localVersion: previewCodexUpdate ? "26.727.51351" : "26.730.61309",
      latestVersion: "26.730.61309",
      updateAvailable: previewCodexUpdate,
      platformMessage: "Codex is installed.",
    });
    setDesktopAccessToken("preview-session");
    setDesktopSession({
      token: "preview-session",
      refreshToken: "preview-refresh",
      user: {
        id: 1,
        username: "demo",
        email: "demo@autogateway.cc",
        displayName: "Demo User",
        name: "Demo User",
        role: "user",
      },
    });
    setAPIKey("agk_preview_7Bf32Pd9M4xQ8wR6kT1nY5cV");
    setSelectedStep(previewCodexUpdate ? 2 : 3);
    setConfigurationPhase(previewComplete ? "complete" : "configuring");
    setRestoringSession(false);
  }, []);

  useEffect(() => {
    let active = true;
    void getDesktopAppVersion().then((version) => {
      if (active) setDesktopAppVersion(version);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (designPreviewState) return;
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (designPreviewState || !import.meta.env.PROD) return;
    void checkDesktopUpdate();
    const interval = window.setInterval(
      () => void checkDesktopUpdate(),
      5 * 60 * 1000,
    );
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (designPreviewState) return;
    let unlisten: (() => void) | undefined;
    void listen<CodexInstallProgress>(
      "codex-install-progress",
      ({ payload }) => {
        setInstallProgress(payload);
        if (payload.stage === "preparing") setMessage(tr("preparingDownload"));
        if (payload.stage === "selecting-source")
          setMessage(tr("selectingDownloadSource"));
        if (payload.stage === "downloading")
          setMessage(
            payload.percent === undefined
              ? tr("downloadingCodex")
              : tr("downloadingCodexProgress", { percent: payload.percent }),
          );
        if (payload.stage === "installing") setMessage(tr("replacingCodex"));
        if (payload.stage === "windows-installing")
          setMessage(tr("windowsInstalling"));
        if (payload.stage === "verifying") setMessage(tr("verifyingCodex"));
      },
    ).then((nextUnlisten) => {
      unlisten = nextUnlisten;
    });
    return () => unlisten?.();
  }, [locale, designPreviewState]);

  function completeExternalInstallation(nextAppStatus: CodexAppStatus) {
    externalInstallationStartedAt.current = null;
    setAppStatus(nextAppStatus);
    setAwaitingExternalInstallation(false);
    setInstallingCodex(false);
    setInstallProgress(null);
    setCanRetryCachedInstaller(false);
    setExternalInstallationMessage("");
    setInstallationTimedOut(false);
    setMessage(
      tr(storeInstallForceUpdate ? "updatedReady" : "installedReady"),
    );
  }

  function timeoutExternalInstallation(nextAppStatus: CodexAppStatus) {
    externalInstallationStartedAt.current = null;
    setAppStatus(nextAppStatus);
    setAwaitingExternalInstallation(false);
    setInstallingCodex(false);
    setInstallProgress(null);
    setInstallationTimedOut(true);
    setCanRetryCachedInstaller(
      nextAppStatus.cachedInstallerAvailable || canRetryCachedInstaller,
    );
    setExternalInstallationMessage("");
    setMessage(tr("windowsInstallationTimedOut"));
  }

  useEffect(() => {
    if (!awaitingExternalInstallation || designPreviewState) return;
    let active = true;
    let checking = false;
    async function checkExternalInstallation() {
      if (checking) return;
      checking = true;
      try {
        const nextAppStatus = await getLocalCodexAppStatus();
        if (!active) return;
        const startedAt = externalInstallationStartedAt.current;
        if (nextAppStatus.installed) {
          completeExternalInstallation(nextAppStatus);
        } else if (
          startedAt !== null &&
          Date.now() - startedAt >= externalInstallationTimeoutMs
        ) {
          timeoutExternalInstallation(nextAppStatus);
        } else if (
          nextAppStatus.cachedInstallerAvailable &&
          canRetryCachedInstaller &&
          !storeAutoRetryAttempted.current &&
          !installingCodex
        ) {
          storeAutoRetryAttempted.current = true;
          void handleInstallCodex(storeInstallForceUpdate, true);
        }
      } catch {
        // The user can continue checking after the temporary external installation state changes.
      } finally {
        checking = false;
      }
    }
    void checkExternalInstallation();
    const interval = window.setInterval(
      () => void checkExternalInstallation(),
      4000,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [
    awaitingExternalInstallation,
    designPreviewState,
    installingCodex,
    canRetryCachedInstaller,
    locale,
    storeInstallForceUpdate,
  ]);

  useEffect(() => {
    if (designPreviewState) {
      setRestoringSession(false);
      return;
    }
    let active = true;
    void restoreDesktopState()
      .then((stored) => {
        if (!active) return;
        if (!stored) {
          setDesktopSession(null);
          setDesktopAccessToken("");
          setAPIKey("");
          setSetupCompleted(false);
          setSelectedStep(1);
          return;
        }
        setDesktopSession(stored.session);
        setDesktopAccessToken(stored.session.token);
        setAPIKey(stored.apiKey);
        const setupWasCompleted = hasCompletedSetup(stored.session);
        setSetupCompleted(setupWasCompleted);
        setSelectedStep(setupWasCompleted ? 4 : 2);
        setMessage(
          setupWasCompleted ? tr("workspaceRestored") : tr("sessionRestored"),
        );
      })
      .catch((error) => {
        if (active)
          setMessage(tr("sessionRestoreFailed", { error: String(error) }));
      })
      .finally(() => {
        if (active) setRestoringSession(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (designPreviewState) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen("desktop-session-cleared", () => {
      if (active) resetSessionState(tr("signedOut"));
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [locale]);

  useEffect(() => {
    if (!desktopAccessToken) {
      setAccountBalance("");
      return;
    }
    let active = true;
    let syncing = false;
    async function syncAccountBalance() {
      if (syncing) return;
      syncing = true;
      try {
        let summary: DesktopAccountSummary;
        try {
          summary = await getDesktopAccountSummary(desktopAccessToken);
        } catch (error) {
          if (!isAuthenticationRequired(error)) throw error;
          const refreshed = await refreshDesktopState(desktopAccessToken);
          if (!refreshed?.session.token) {
            await handleSessionExpired();
            return;
          }
          if (!active) return;
          setDesktopSession(refreshed.session);
          setDesktopAccessToken(refreshed.session.token);
          setAPIKey(refreshed.apiKey);
          summary = await getDesktopAccountSummary(refreshed.session.token);
        }
        if (!active) return;
        setAccountBalance(summary.balance);
        setBalanceSyncedAt(new Date());
        void updateTrayStatus(accountName || accountDetail, summary.balance);
      } catch (error) {
        if (!active) return;
        if (isAuthenticationRequired(error)) {
          void handleSessionExpired();
          return;
        }
        // Keep the last confirmed balance for transient network or server failures.
        // Authentication failures are handled above and clear the session explicitly.
      } finally {
        syncing = false;
      }
    }
    void syncAccountBalance();
    const interval = window.setInterval(
      () => void syncAccountBalance(),
      60_000,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [desktopAccessToken, showHome]);

  useEffect(() => {
    if (designPreviewState || !showHome || !appInstalled) return;
    let active = true;
    async function refreshCodexOpenState() {
      try {
        const running = await isCodexRunning();
        if (!active) return;
        setCodexOpenPhase((current) =>
          current === "opening" ? current : running ? "opened" : "closed",
        );
      } catch {
        // Keep the last known state when a process check is temporarily unavailable.
      }
    }
    void refreshCodexOpenState();
    return () => {
      active = false;
    };
  }, [appInstalled, designPreviewState, showHome]);

  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const refreshSystemTheme = () => theme === "system" && applyTheme(theme);
    media?.addEventListener("change", refreshSystemTheme);
    return () => media?.removeEventListener("change", refreshSystemTheme);
  }, [theme]);

  function changeTheme(nextTheme: ThemeMode) {
    setTheme(nextTheme);
    writeTheme(nextTheme);
  }

  function changeLocale(nextLocale: LocalePreference) {
    setLocalePreference(nextLocale);
    writeLocalePreference(nextLocale);
  }

  function toggleLocale() {
    changeLocale(locale === "zh" ? "en" : "zh");
  }

  function cycleTheme() {
    changeTheme(
      theme === "system" ? "light" : theme === "light" ? "dark" : "system",
    );
  }

  useEffect(() => {
    if (designPreviewState) return;
    let unlistenDeepLink: (() => void) | undefined;
    let unlistenSingleInstance: (() => void) | undefined;
    async function receiveDesktopAuthorization(urls: string[]) {
      const callback = urls
        .map((value) => {
          try {
            return new URL(value);
          } catch {
            return null;
          }
        })
        .find(
          (url): url is URL =>
            url?.protocol === "autogateway:" &&
            url.hostname === "auth" &&
            url.pathname === "/callback",
        );
      if (!callback) return;
      const code = callback.searchParams.get("code") ?? "";
      const state = callback.searchParams.get("state") ?? "";
      const pending = readPendingAuthorization();
      if (!code || !pending || pending.state !== state) {
        setMessage(tr("callbackInvalid"));
        return;
      }
      if (
        authorizationExchangeInProgress.current ||
        completedAuthorizationCode.current === code
      )
        return;
      authorizationExchangeInProgress.current = true;
      setBusy(true);
      try {
        const session = await exchangeDesktopAuthorization(
          code,
          pending.verifier,
          pending.state,
        );
        setDesktopAccessToken(session.token);
        setDesktopSession(session);
        setDesktopSignInUrl("");
        const setupWasCompleted = hasCompletedSetup(session);
        setSetupCompleted(setupWasCompleted);
        setSelectedStep(setupWasCompleted ? 4 : 2);
        window.sessionStorage.removeItem(pendingAuthorizationStorageKey);
        completedAuthorizationCode.current = code;
        setMessage(tr("signedIn"));
      } catch (error) {
        setMessage(tr("signInFailed", { error: String(error) }));
      } finally {
        authorizationExchangeInProgress.current = false;
        setBusy(false);
      }
    }
    void onOpenUrl(receiveDesktopAuthorization).then((nextUnlisten) => {
      unlistenDeepLink = nextUnlisten;
    });
    void listen<string[]>("desktop-open-url", ({ payload }) => {
      void receiveDesktopAuthorization(payload);
    }).then((nextUnlisten) => {
      unlistenSingleInstance = nextUnlisten;
    });
    void getCurrent()
      .then((urls) => {
        if (urls) void receiveDesktopAuthorization(urls);
      })
      .catch(() => undefined);
    return () => {
      unlistenDeepLink?.();
      unlistenSingleInstance?.();
    };
  }, [endpoint, designPreviewState]);

  async function handleStartSignIn() {
    setBusy(true);
    try {
      const verifier = createVerifier();
      const challenge = await createChallenge(verifier);
      const state = createState();
      window.sessionStorage.setItem(
        pendingAuthorizationStorageKey,
        JSON.stringify({ verifier, state }),
      );
      const query = new URLSearchParams({
        desktopCodeChallenge: challenge,
        desktopState: state,
      });
      setDesktopSignInUrl(`https://autogateway.cc/login?${query.toString()}`);
      await openDesktopSignIn(challenge, state);
      setMessage(tr("completeInApp"));
    } catch (error) {
      setMessage(tr("startSignInFailed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenSignInFallback() {
    if (!desktopSignInUrl) return;
    try {
      await closeDesktopSignIn();
    } catch {
      // The browser fallback can still be opened if the in-app window is unavailable.
    }
    try {
      await openUrl(desktopSignInUrl);
      setMessage(tr("signInFallbackOpened"));
    } catch (error) {
      setMessage(tr("startSignInFailed", { error: String(error) }));
    }
  }

  async function runAutomaticConfiguration() {
    if (configurationRun.current || !desktopAccessToken || configured) return;
    configurationRun.current = true;
    setConfigurationError("");
    setAPIKeyCopied(false);
    try {
      let configurationKey = apiKey.trim();
      if (!configurationKey) {
        setConfigurationPhase("creatingKey");
        setMessage(tr("creatingAPIKey"));
        const key = await bootstrapDesktopKey(desktopAccessToken, true);
        configurationKey = key.apiKey.trim();
        if (!configurationKey) throw new Error(tr("apiKeyCreationFailed"));
        setAPIKey(configurationKey);
      }
      setConfigurationPhase("configuring");
      setMessage(tr("automaticConfiguring"));
      const result = await configureCodex(configurationKey, endpoint);
      let cleanupWarning = "";
      try {
        await clearStoredDesktopAPIKey();
      } catch {
        cleanupWarning = ` ${tr("credentialCleanupFailed")}`;
      }
      setStatus((current) =>
        current ? { ...current, configured: true } : current,
      );
      setConfigurationPhase("complete");
      setMessage(
        `${tr("configurationWritten", { backup: result.configBackupPath ? tr("backupCreated") : "" })}${cleanupWarning}`,
      );
      await refreshStatus(false);
    } catch (error) {
      const errorMessage = String(error);
      if (isAuthenticationRequired(error)) {
        await handleSessionExpired();
        return;
      }
      setConfigurationPhase("error");
      setConfigurationError(errorMessage);
      setMessage(tr("configurationFailed", { error: errorMessage }));
    } finally {
      configurationRun.current = false;
    }
  }

  useEffect(() => {
    if (designPreviewState) return;
    if (selectedStep !== 3 || showSettings) return;
    if (configured) {
      setConfigurationPhase("complete");
      return;
    }
    void runAutomaticConfiguration();
  }, [selectedStep, showSettings, configured, desktopAccessToken, endpoint]);

  async function handleCopyAPIKey() {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
    } catch {
      const input = document.createElement("textarea");
      input.value = apiKey;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setAPIKeyCopied(true);
    window.setTimeout(() => setAPIKeyCopied(false), 1800);
  }

  function handleConfigurationNext() {
    setAPIKey("");
    setAPIKeyCopied(false);
    selectStep(4);
  }

  function enterWorkspace() {
    if (!desktopSession) return;
    window.localStorage.setItem(
      setupCompletedStorageKey(desktopSession.user.id),
      "true",
    );
    setSetupCompleted(true);
    setMessage(tr("workspaceReady"));
  }

  async function handleInstallCodex(
    forceUpdate = false,
    automaticRetry = false,
    forceRedownload = false,
  ) {
    externalInstallationStartedAt.current = null;
    setAwaitingExternalInstallation(false);
    setStoreInstallForceUpdate(forceUpdate);
    setCanRetryCachedInstaller(false);
    setExternalInstallationMessage("");
    setInstallationTimedOut(false);
    setInstallingCodex(true);
    setInstallProgress({ stage: "preparing", downloadedBytes: 0 });
    setMessage(
      tr(
        automaticRetry
          ? "reinstallingCodex"
        : forceUpdate
            ? "updating"
            : "installing",
      ),
    );
    let waitingForExternalInstallation = false;
    try {
      const result = await installCodex(forceUpdate, forceRedownload);
      if (result.awaitingInstallation) {
        waitingForExternalInstallation = true;
        externalInstallationStartedAt.current = Date.now();
        storeAutoRetryAttempted.current = automaticRetry;
        setAwaitingExternalInstallation(true);
        setCanRetryCachedInstaller(result.canRetryCachedInstaller);
        setExternalInstallationMessage(result.message);
        setInstallProgress({
          stage: "windows-installing",
          downloadedBytes: 0,
        });
        setMessage(result.message);
        return;
      }
      setAwaitingExternalInstallation(false);
      setCanRetryCachedInstaller(false);
      setExternalInstallationMessage("");
      await refreshStatus();
      setMessage(tr(forceUpdate ? "updatedReady" : "installedReady"));
    } catch (error) {
      setMessage(tr("installationFailed", { error: String(error) }));
    } finally {
      if (!waitingForExternalInstallation) {
        setInstallingCodex(false);
        setInstallProgress(null);
      }
    }
  }

  function getManualDesktopInstallerUrl(update: Update): string | null {
    const rawDownloads = update.rawJson.downloads;
    if (!rawDownloads || typeof rawDownloads !== "object") return null;
    const platform = /Windows/i.test(navigator.userAgent) ? "windows" : "macos";
    const candidate = (rawDownloads as Record<string, unknown>)[platform];
    if (!candidate || typeof candidate !== "object") return null;
    const value = (candidate as Record<string, unknown>).url;
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }

  async function openManualDesktopInstaller(update: Update | null) {
    const installerUrl = update ? getManualDesktopInstallerUrl(update) : null;
    setDesktopInstallerUrl(installerUrl || "");
    if (!installerUrl) {
      setMessage(tr("desktopUpdateManualUnavailable"));
      return;
    }
    if (!window.confirm(tr("desktopUpdateManualConfirm"))) return;
    try {
      await openUrl(installerUrl);
      setMessage(tr("desktopUpdateManualOpened"));
    } catch (error) {
      setMessage(tr("desktopUpdateManualOpenFailed", { error: String(error) }));
    }
  }

  async function downloadAndInstallDesktopUpdate(update: Update) {
    setDesktopUpdateProgress(0);
    let contentLength = 0;
    let downloadedBytes = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
        downloadedBytes = 0;
        setDesktopUpdateProgress(contentLength > 0 ? 0 : null);
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        setDesktopUpdateProgress(
          contentLength > 0
            ? Math.min(
                100,
                Math.round((downloadedBytes / contentLength) * 100),
              )
            : null,
        );
      } else if (event.event === "Finished") {
        setDesktopUpdateProgress(100);
      }
    });
  }

  async function handleInstallDesktopUpdate() {
    if (!desktopUpdate) return;
    const initialUpdate = desktopUpdate;
    setDesktopUpdatePhase("downloading");
    setDesktopUpdateError("");
    try {
      await downloadAndInstallDesktopUpdate(initialUpdate);
      await relaunch();
    } catch (error) {
      setMessage(tr("desktopUpdateRetrying"));
      setDesktopUpdateProgress(null);
      let latestUpdate: Update | null = null;
      try {
        latestUpdate = await check();
        if (!latestUpdate) {
          throw new Error("No desktop update was available after retrying.");
        }
        setDesktopUpdate(latestUpdate);
        await downloadAndInstallDesktopUpdate(latestUpdate);
        await relaunch();
      } catch (retryError) {
        const manualUpdate = latestUpdate || initialUpdate;
        setDesktopUpdatePhase("manual");
        setDesktopUpdateProgress(null);
        setDesktopUpdateError(String(retryError));
        setMessage(tr("desktopUpdateManualDescription"));
        await openManualDesktopInstaller(manualUpdate);
      }
    }
  }

  async function checkExternalInstallation() {
    try {
      const nextAppStatus = await getLocalCodexAppStatus();
      if (nextAppStatus.installed) {
        completeExternalInstallation(nextAppStatus);
      } else if (
        externalInstallationStartedAt.current !== null &&
        Date.now() - externalInstallationStartedAt.current >=
          externalInstallationTimeoutMs
      ) {
        timeoutExternalInstallation(nextAppStatus);
      } else {
        setAppStatus(nextAppStatus);
        setMessage(tr("windowsInstalling"));
      }
    } catch (error) {
      setMessage(tr("readStatusFailed", { error: String(error) }));
    }
  }

  async function handleRestoreBackups() {
    if (!window.confirm(tr("restoreConfirm"))) return;
    setBusy(true);
    try {
      await restoreLatestCodexBackups();
      await refreshStatus();
      setMessage(tr("restored"));
    } catch (error) {
      setMessage(tr("restoreFailed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleSwitchBackConfiguration() {
    if (!window.confirm(tr("switchBackConfirm"))) return;
    setBusy(true);
    try {
      await restoreLatestCodexBackups();
      await refreshStatus();
      setMessage(tr("switchedBack"));
    } catch (error) {
      setMessage(tr("restoreFailed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenConsole(section?: "billing" | "support") {
    if (!desktopAccessToken) {
      setMessage(tr("signInRequired"));
      return;
    }
    try {
      await openConsole(desktopAccessToken, section);
    } catch (error) {
      if (isAuthenticationRequired(error)) {
        await handleSessionExpired();
        return;
      }
      setMessage(tr("consoleFailed", { error: String(error) }));
    }
  }

  async function handleOpenDevtools() {
    try {
      await openDevtools();
    } catch (error) {
      setMessage(tr("devtoolsFailed", { error: String(error) }));
    }
  }

  async function handleOpenCodex() {
    setHomeActionError("");
    setCodexOpenPhase("opening");
    try {
      await openCodex();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await isCodexRunning()) {
          setCodexOpenPhase("opened");
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      setCodexOpenPhase("closed");
      setHomeActionError(tr("codexOpenTimeout"));
    } catch (error) {
      setCodexOpenPhase("closed");
      setHomeActionError(tr("openCodexFailed", { error: String(error) }));
    }
  }

  function openSetupFromHome() {
    setSetupCompleted(false);
    setSelectedStep(2);
  }

  function renderHomeContent() {
    const version = appStatus?.localVersion || tr("versionUnavailable");
    const versionStatus = !appInstalled
      ? tr("notInstalled")
      : appStatus?.updateCheckError
        ? tr("updateCheckUnavailable")
        : updateAvailable
          ? tr("updateAvailable")
          : tr("upToDate");
    const ready = accountConnected && appInstalled && configured;
    const providerTone =
      providerStatus === "autogateway" || ready
        ? "ready"
        : providerStatus === "openai"
        ? "official"
        : providerStatus === "third-party"
          ? "thirdParty"
          : providerStatus === "invalid"
            ? "invalid"
            : "checking";
    const providerStatusLabel =
      providerStatus === "autogateway" || ready
        ? tr("configured")
        : providerStatus === "openai"
        ? tr("officialProviderStatus")
        : providerStatus === "third-party"
          ? tr("thirdPartyProviderStatus")
          : providerStatus === "invalid"
            ? tr("invalidProviderStatus")
            : tr("checking");
    const providerTitle =
      providerStatus === "autogateway" || ready
        ? tr("workspaceReadyTitle")
        : providerStatus === "openai"
        ? tr("officialProviderTitle")
        : providerStatus === "third-party"
          ? tr("thirdPartyProviderTitle")
          : providerStatus === "invalid"
            ? tr("invalidProviderTitle")
            : tr("workspaceCheckingTitle");
    const providerDescription =
      providerStatus === "autogateway" || ready
        ? tr("workspaceReadyDescription")
        : providerStatus === "openai"
        ? tr("officialProviderDescription")
        : providerStatus === "third-party"
          ? tr("thirdPartyProviderDescription")
          : providerStatus === "invalid"
            ? tr("invalidProviderDescription")
            : tr("workspaceCheckingDescription");
    return (
      <main className="homeShell">
        <aside className="homeRail">
          <div className="homeBrand">
            <img className="homeBrandLogo" src="/site-icon.png" alt="" />
            <div>
              <strong>AUTO Gateway</strong>
              <div className="homeBrandVersion">
                <small>
                  {tr("desktopAppVersion", {
                    version: desktopAppVersion || "—",
                  })}
                </small>
                <button
                  className="desktopVersionRefresh"
                  type="button"
                  aria-label={tr("desktopUpdateCheckNow")}
                  title={tr("desktopUpdateCheckNow")}
                  disabled={
                    desktopUpdatePhase === "checking" ||
                    desktopUpdatePhase === "downloading"
                  }
                  onClick={() => void checkDesktopUpdate(true)}
                >
                  <ArrowsClockwiseIcon weight="bold" />
                </button>
              </div>
            </div>
          </div>
          <nav className="homeNav" aria-label={tr("homeNavigation")}>
            <button className="selected">
              <HouseIcon weight="bold" />
              {tr("home")}
            </button>
            <button onClick={openSetupFromHome}>
              <CubeIcon />
              {tr("codexSetup")}
            </button>
            <button onClick={() => void handleOpenConsole()}>
              <UserCircleIcon />
              {tr("userConsole")}
            </button>
          </nav>
          <div className="homeSupportLinks">
            <button
              className="homeSupportLink"
              onClick={() => void openUrl("https://autogateway.cc/docs#codex")}
            >
              <QuestionIcon weight="bold" />
              {tr("needHelp")}
            </button>
            <button
              className="homeSupportLink"
              onClick={() => void handleOpenConsole("support")}
            >
              <ChatCircleTextIcon weight="bold" />
              {tr("reportIssue")}
            </button>
          </div>
        </aside>
        <section className="homeWorkspace">
          <header className="topBar homeTopBar">
            <span className="topStatus" aria-live="polite">
              {message}
            </span>
            <button
              className="userIdentity userIdentityButton"
              aria-label={`${tr("signedInAs")}: ${accountDetail || accountName}`}
              onClick={() => void handleOpenConsole()}
            >
              <span className="userAvatar" aria-hidden="true">
                <UserCircleIcon weight="fill" />
              </span>
              <span className="userIdentityText">
                <strong>{accountName}</strong>
                <small>{accountDetail}</small>
              </span>
            </button>
            <div className="headerBalance" aria-label={tr("accountBalance")}>
              <div className="headerBalanceInfo">
                <span>{tr("accountBalance")}</span>
                <strong>{accountBalance || tr("balanceUnavailable")}</strong>
                <small>
                  {tr("lastSyncedAt", {
                    time: formatSyncTime(
                      balanceSyncedAt,
                      locale,
                      tr("notSynced"),
                    ),
                  })}
                </small>
              </div>
              <button
                className="headerTopUpButton"
                onClick={() => void handleOpenConsole("billing")}
              >
                <CurrencyDollarIcon weight="bold" />
                {tr("topUpBalance")}
              </button>
            </div>
            <button
              className="headerActionButton"
              aria-label={tr("language")}
              onClick={toggleLocale}
            >
              {locale === "zh" ? "EN" : "中文"}
            </button>
            <button
              className="headerActionButton"
              aria-label={tr("theme")}
              onClick={cycleTheme}
            >
              {theme === "system"
                ? tr("system")
                : theme === "light"
                  ? tr("light")
                  : tr("dark")}
            </button>
            <button
              className="headerActionButton headerSignOutButton"
              aria-label={tr("signOut")}
              title={tr("signOut")}
              disabled={busy || installingCodex || restoringSession}
              onClick={() => void handleSignOut()}
            >
              <SignOutIcon weight="bold" />
              <span>{tr("signOut")}</span>
            </button>
          </header>
          <section className="homeContent">
            <p className="sectionKicker">{tr("workspace")}</p>
            <h1>{tr("homeTitle")}</h1>
            <p className="lead homeLead">{tr("homeLead")}</p>
            {desktopUpdate && desktopUpdatePhase !== "manual" ? (
              <section className="notice warning desktopUpdateNotice">
                <strong>{tr("desktopUpdateAvailable")}</strong>
                <span>
                  {tr("desktopUpdateDescription", {
                    version: desktopUpdate.version,
                  })}
                </span>
                <button
                  className="secondaryButton"
                  disabled={desktopUpdatePhase === "downloading"}
                  onClick={() => void handleInstallDesktopUpdate()}
                >
                  {desktopUpdatePhase === "downloading"
                    ? tr("desktopUpdating", {
                        percent: desktopUpdateProgress ?? "…",
                      })
                    : tr("desktopUpdateNow")}
                </button>
              </section>
            ) : null}
            {desktopUpdatePhase === "error" ? (
              <section className="notice warning desktopUpdateNotice">
                <strong>{tr("desktopUpdateCheckUnavailable")}</strong>
                <span>
                  {desktopUpdateError || tr("desktopUpdateCheckUnavailable")}
                </span>
                <button
                  className="secondaryButton"
                  onClick={() => void checkDesktopUpdate(true)}
                >
                  {tr("desktopUpdateCheckNow")}
                </button>
              </section>
            ) : null}
            {desktopUpdatePhase === "manual" ? (
              <section className="notice warning desktopUpdateNotice">
                <strong>{tr("desktopUpdateManualTitle")}</strong>
                <span>{tr("desktopUpdateManualDescription")}</span>
                <button
                  className="secondaryButton"
                  disabled={!desktopInstallerUrl}
                  onClick={() => void openManualDesktopInstaller(desktopUpdate)}
                >
                  {tr("desktopUpdateManualOpen")}
                </button>
              </section>
            ) : null}
            {homeActionError ? (
              <p className="homeActionMessage" role="alert">
                {homeActionError}
              </p>
            ) : null}
            <section className="homeStatusPanel">
              <div
                className={`homeHealth ${providerTone}`}
                aria-label={providerStatusLabel}
              >
                <span className={`healthBadge ${providerTone}`}>
                  {providerStatus === "invalid" ? (
                    <WarningIcon weight="fill" />
                  ) : (
                    <CheckCircleIcon weight="fill" />
                  )}
                </span>
                <div>
                  <span className="statusLabel">{providerStatusLabel}</span>
                  <strong>{providerTitle}</strong>
                  <small>{providerDescription}</small>
                  {providerStatus === "invalid" ? (
                    <button
                      className="homeHealthAction"
                      onClick={openSetupFromHome}
                    >
                      {tr("reconfigureCodex")}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="homeMetric">
                <span>{tr("accountBalance")}</span>
                <strong>{accountBalance || tr("balanceUnavailable")}</strong>
                <small>
                  {tr("lastSyncedAt", {
                    time: formatSyncTime(
                      balanceSyncedAt,
                      locale,
                      tr("notSynced"),
                    ),
                  })}
                </small>
                <button onClick={() => void handleOpenConsole("billing")}>
                  {tr("topUpBalance")}
                </button>
              </div>
              <div className="homeMetric">
                <span>{tr("localVersion")}</span>
                <strong>{version}</strong>
                <small>{versionStatus}</small>
                <button
                  className="versionAction"
                  disabled={checkingCodexUpdates || installingCodex}
                  onClick={() =>
                    appInstalled
                      ? void handleCheckCodexUpdates()
                      : openSetupFromHome()
                  }
                >
                  {!appInstalled
                    ? tr("installNow")
                    : checkingCodexUpdates
                      ? tr("checkingCodexUpdates")
                      : tr("checkNow")}
                </button>
                {updateAvailable ? (
                  <button
                    className="versionAction versionUpdateAction"
                    disabled={installingCodex}
                    onClick={() => void handleInstallCodex(true)}
                  >
                    {installingCodex ? tr("updatingCodex") : tr("updateNow")}
                  </button>
                ) : null}
              </div>
              <button
                className="primaryButton homeOpenButton"
                disabled={!appInstalled || codexOpenPhase === "opening"}
                onClick={() => void handleOpenCodex()}
              >
                {codexOpenPhase === "opening"
                  ? tr("openingCodex")
                  : codexOpenPhase === "opened"
                    ? tr("codexOpened")
                    : tr("openCodex")}
              </button>
            </section>
            <section className="homeSection">
              <h2>{tr("quickActions")}</h2>
              <div className="quickActions">
                <button onClick={() => void handleOpenConsole()}>
                  <UserCircleIcon />
                  <span>
                    <strong>{tr("openConsole")}</strong>
                    <small>{tr("openConsoleDescription")}</small>
                  </span>
                  <ArrowRightIcon />
                </button>
                <button
                  onClick={() => void handleCheckCodexUpdates()}
                  disabled={
                    checkingCodexUpdates || installingCodex || !appInstalled
                  }
                >
                  <ArrowsClockwiseIcon />
                  <span>
                    <strong>{tr("checkUpdates")}</strong>
                    <small>{tr("checkUpdatesDescription")}</small>
                  </span>
                  <ArrowRightIcon />
                </button>
                <button
                  onClick={() => void checkDesktopUpdate(true)}
                  disabled={
                    desktopUpdatePhase === "checking" ||
                    desktopUpdatePhase === "downloading"
                  }
                >
                  <ArrowsClockwiseIcon />
                  <span>
                    <strong>
                      {desktopUpdatePhase === "checking"
                        ? tr("desktopCheckingUpdates")
                        : tr("desktopUpdateCheckNow")}
                    </strong>
                    <small>{tr("desktopUpdateCheckDescription")}</small>
                  </span>
                  <ArrowRightIcon />
                </button>
                {updateAvailable ? (
                  <button
                    onClick={() => void handleInstallCodex(true)}
                    disabled={installingCodex}
                  >
                    <ArrowsClockwiseIcon />
                    <span>
                      <strong>
                        {installingCodex
                          ? tr("updatingCodex")
                          : tr("updateNow")}
                      </strong>
                      <small>{tr("updateAvailableDescription")}</small>
                    </span>
                    <ArrowRightIcon />
                  </button>
                ) : null}
                <button onClick={openSetupFromHome}>
                  <GearIcon />
                  <span>
                    <strong>{tr("reconfigureCodex")}</strong>
                    <small>{tr("reconfigureCodexDescription")}</small>
                  </span>
                  <ArrowRightIcon />
                </button>
                <button
                  disabled={busy || backupCount === 0}
                  onClick={() => void handleSwitchBackConfiguration()}
                >
                  <ArrowUUpLeftIcon />
                  <span>
                    <strong>{tr("switchBackConfiguration")}</strong>
                    <small>{tr("switchBackConfigurationDescription")}</small>
                  </span>
                  <ArrowRightIcon />
                </button>
              </div>
            </section>
            <section className="homeSection">
              <h2>{tr("recentSetup")}</h2>
              <div className="recentSetup">
                <div>
                  <CheckIcon weight="bold" />
                  <strong>{tr("connectedAccount")}</strong>
                  <span>{accountDetail}</span>
                </div>
                <div>
                  <CheckIcon weight="bold" />
                  <strong>{tr("codexConfigured")}</strong>
                  <span>
                    {configured ? tr("configured") : tr("notConfigured")}
                  </span>
                </div>
                <div>
                  <CheckIcon weight="bold" />
                  <strong>{tr("versionUpToDate")}</strong>
                  <span>{versionStatus}</span>
                </div>
              </div>
            </section>
          </section>
        </section>
      </main>
    );
  }

  function selectStep(step: WizardStep) {
    const maximumReachableStep: WizardStep = !accountConnected
      ? 1
      : !appInstalled
        ? 2
        : !gatewayConfigured
          ? 3
          : 4;
    if (step > selectedStep + 1 || step > maximumReachableStep) return;
    setShowSettings(false);
    setSelectedStep(step);
  }

  function stepClass(step: WizardStep, complete: boolean): string {
    if (selectedStep === step && !showSettings) return "active";
    return complete ? "complete" : "idle";
  }

  function renderSetupContent() {
    if (selectedStep === 1) {
      return (
        <section className="setupContent">
          <div className="setupBody">
            <p className="sectionKicker">{tr("secureSignIn")}</p>
            <h1>{tr("connectTitle")}</h1>
            <p className="lead">{tr("connectLead")}</p>
            <div
              className={`notice setupNotice ${accountConnected ? "success" : ""}`}
            >
              <strong>
                {accountConnected ? tr("accountConnected") : tr("noAccount")}
              </strong>
              <span>
                {accountConnected ? tr("sessionRestored") : tr("completeInApp")}
              </span>
            </div>
            {!accountConnected ? (
              <div className="signInActionPanel">
                <button
                  className="primaryButton signInHeroButton"
                  disabled={busy || restoringSession}
                  onClick={() => void handleStartSignIn()}
                >
                  {restoringSession
                    ? tr("restoringSession")
                    : busy
                      ? tr("openingSignIn")
                      : tr("continueInApp")}
                </button>
                {desktopSignInUrl ? (
                  <button
                    className="textButton signInFallbackButton"
                    onClick={() => void handleOpenSignInFallback()}
                  >
                    {tr("signInFallback")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {accountConnected ? (
            <div className="buttonRow setupActions">
              <button className="primaryButton" onClick={() => selectStep(2)}>
                {tr("continueToCodex")}
              </button>
            </div>
          ) : null}
        </section>
      );
    }
    if (selectedStep === 2) {
      return (
        <section className="setupContent">
          <div className="setupBody">
            <p className="sectionKicker">{tr("officialDesktopApp")}</p>
            <h1>{tr("installTitle")}</h1>
            <p className="lead">{tr("installLead")}</p>
            <div
              className={
                appInstalled && !updateAvailable
                  ? "notice success installNotice setupNotice"
                  : "notice warning installNotice setupNotice"
              }
            >
              <strong>
                {installationTimedOut
                  ? tr("windowsInstallationTimedOutTitle")
                  : updateAvailable
                    ? tr("updateAvailable")
                    : appInstalled
                      ? appStatus?.updateAvailable === false
                        ? tr("upToDate")
                        : tr("installed")
                      : tr("notInstalled")}
              </strong>
              <span>
                {installationTimedOut
                  ? tr("windowsInstallationTimedOut")
                  : updateAvailable
                    ? tr("updateAvailableDescription")
                    : appInstalled
                      ? appStatus?.updateCheckError
                        ? tr("updateCheckUnavailable")
                        : tr("installedDescription")
                      : appStatus
                        ? tr("notInstalledDescription")
                        : tr("checkingInstallation")}
              </span>
              {installationTimedOut ? (
                <div className="installRecoveryActions">
                  <button
                    className="secondaryButton"
                    onClick={() =>
                      void handleInstallCodex(
                        storeInstallForceUpdate,
                        false,
                        true,
                      )
                    }
                  >
                    {tr("retryCodexInstallation")}
                  </button>
                </div>
              ) : null}
              {appInstalled ? (
                <div className="versionGrid" aria-label={tr("installed")}>
                  <div className="versionItem">
                    <span>{tr("localVersion")}</span>
                    <strong>
                      {appStatus?.localVersion || tr("versionUnavailable")}
                    </strong>
                  </div>
                  <div className="versionItem">
                    <span>{tr("latestVersion")}</span>
                    <strong>
                      {appStatus?.latestVersion || tr("versionUnavailable")}
                    </strong>
                  </div>
                  <button
                    className="secondaryButton updateButton versionUpdateButton"
                    disabled={checkingCodexUpdates || installingCodex}
                    onClick={() => void handleCheckCodexUpdates()}
                  >
                    {checkingCodexUpdates
                      ? tr("checkingCodexUpdates")
                      : tr("checkNow")}
                  </button>
                  {updateAvailable ? (
                    <button
                      className="secondaryButton primaryUpdateButton versionUpdateButton"
                      disabled={installingCodex}
                      onClick={() => void handleInstallCodex(true)}
                    >
                      {installingCodex
                        ? installPercent === undefined
                          ? tr("updatingCodex")
                          : `${tr("updatingCodex")} ${installPercent}%`
                        : tr("updateNow")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {installingCodex &&
              installProgress?.stage === "selecting-source" ? (
                <div className="installProgress" aria-live="polite">
                  <small>{tr("selectingDownloadSource")}</small>
                </div>
              ) : null}
              {installingCodex && installProgress?.stage === "downloading" ? (
                <div
                  className="installProgress downloadProgress"
                  aria-live="polite"
                >
                  <div className="downloadProgressHeader">
                    <strong>{tr("downloadingCodex")}</strong>
                    <span>
                      {installPercent === undefined
                        ? "—"
                        : `${installPercent}%`}
                    </span>
                  </div>
                  <progress max="100" value={installPercent} />
                  <div className="downloadProgressMetrics">
                    <span>{downloadAmountDetails}</span>
                    <span>{downloadSpeedDetails}</span>
                  </div>
                  {downloadProgressDetails ? (
                    <small className="downloadProgressSource">
                      {downloadProgressDetails}
                    </small>
                  ) : null}
                </div>
              ) : null}
              {installingCodex &&
              installProgress?.stage === "windows-installing" ? (
                <div
                  className="installProgress indeterminateProgress"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <div className="progressStatusRow">
                    <span className="progressSpinner" aria-hidden="true" />
                    <small>
                      {externalInstallationMessage || tr("windowsInstalling")}
                    </small>
                  </div>
                  <div
                    className="indeterminateProgressTrack"
                    role="progressbar"
                    aria-label={tr("windowsInstalling")}
                    aria-valuetext={tr("windowsInstalling")}
                  >
                    <span />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="buttonRow setupActions">
            <button className="secondaryButton" onClick={() => selectStep(1)}>
              {tr("previous")}
            </button>
            {appInstalled ? (
              <button
                className="primaryButton"
                disabled={installingCodex}
                onClick={() => selectStep(3)}
              >
                {tr("next")}
              </button>
            ) : awaitingExternalInstallation ? (
              <button
                className="primaryButton"
                onClick={() => void checkExternalInstallation()}
              >
                {tr("checkInstallation")}
              </button>
            ) : (
              <button
                className="primaryButton"
                disabled={installingCodex}
                onClick={() => void handleInstallCodex()}
              >
                {installingCodex
                  ? installPercent === undefined
                    ? tr("installingCodex")
                    : `${tr("installingCodex")} ${installPercent}%`
                  : tr("installAutomatically")}
              </button>
            )}
          </div>
        </section>
      );
    }
    if (selectedStep === 3) {
      const configurationRunning =
        configurationPhase === "creatingKey" ||
        configurationPhase === "configuring";
      const noticeTitle =
        configurationPhase === "creatingKey"
          ? tr("creatingAPIKey")
          : configurationPhase === "configuring"
            ? tr("automaticConfiguring")
            : configurationPhase === "complete"
              ? tr("automaticConfigurationComplete")
              : configurationPhase === "error"
                ? tr("automaticConfigurationFailed")
                : tr("preparingConfiguration");
      const noticeDescription =
        configurationPhase === "creatingKey"
          ? tr("creatingAPIKeyDescription")
          : configurationPhase === "configuring"
            ? tr("automaticConfiguringDescription")
            : configurationPhase === "complete"
              ? tr("automaticConfigurationCompleteDescription")
              : configurationPhase === "error"
                ? tr("automaticConfigurationFailedDescription", {
                    error: configurationError,
                  })
                : tr("preparingConfigurationDescription");
      return (
        <section className="setupContent">
          <div className="setupBody">
            <p className="sectionKicker">{tr("safeConfiguration")}</p>
            <h1>{tr("configureTitle")}</h1>
            <p className="lead">{tr("configureLead")}</p>
            <div
              className={`notice setupNotice configurationNotice ${configurationPhase === "error" ? "warning" : "success"}`}
            >
              <strong>{noticeTitle}</strong>
              <span>{noticeDescription}</span>
              {apiKey ? (
                <div className="apiKeyReveal">
                  <label>{tr("generatedAPIKey")}</label>
                  <div>
                    <code>{apiKey}</code>
                    <button
                      type="button"
                      onClick={() => void handleCopyAPIKey()}
                      aria-label={tr("copyAPIKey")}
                    >
                      {apiKeyCopied ? (
                        <CheckIcon aria-hidden="true" weight="bold" />
                      ) : (
                        <CopyIcon aria-hidden="true" weight="bold" />
                      )}
                      <span>
                        {apiKeyCopied ? tr("copiedAPIKey") : tr("copyAPIKey")}
                      </span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="buttonRow setupActions">
            <button
              className="secondaryButton"
              disabled={configurationRunning}
              onClick={() => selectStep(2)}
            >
              {tr("previous")}
            </button>
            {configurationPhase === "complete" ? (
              <button
                className="primaryButton"
                onClick={handleConfigurationNext}
              >
                {tr("next")}
              </button>
            ) : configurationPhase === "error" ? (
              <button
                className="primaryButton"
                onClick={() => void runAutomaticConfiguration()}
              >
                {tr("retryConfiguration")}
              </button>
            ) : (
              <button
                className="primaryButton configurationLoadingButton"
                disabled
              >
                <CircleNotchIcon aria-hidden="true" weight="bold" />
                {tr("configuring")}
              </button>
            )}
          </div>
        </section>
      );
    }
    return (
      <section className="setupContent">
        <div className="setupBody">
          <p className="sectionKicker">{tr("setupComplete")}</p>
          <h1>{tr("completeTitle")}</h1>
          <p className="lead">{tr("completeLead")}</p>
          <div className="notice success setupNotice">
            <strong>
              {configured ? tr("configured") : tr("readyToVerify")}
            </strong>
            <span>{message}</span>
          </div>
        </div>
        <div className="buttonRow setupActions">
          <button className="secondaryButton" onClick={() => selectStep(3)}>
            {tr("previous")}
          </button>
          <button
            className="primaryButton"
            disabled={!appInstalled || !configured}
            onClick={enterWorkspace}
          >
            {tr("enterWorkspace")}
          </button>
        </div>
      </section>
    );
  }

  if (showHome) return renderHomeContent();

  return (
    <main className="appShell">
      <aside className="wizardRail">
        <nav className="stepNav" aria-label={tr("setupSteps")}>
          <button
            className={stepClass(1, accountConnected)}
            onClick={() => selectStep(1)}
          >
            <span>
              {accountConnected ? (
                <CheckIcon aria-hidden="true" weight="bold" />
              ) : (
                "1"
              )}
            </span>
            <b>{tr("stepConnect")}</b>
          </button>
          <button
            className={stepClass(2, codexDetected)}
            disabled={selectedStep < 2}
            onClick={() => selectStep(2)}
          >
            <span>
              {codexDetected ? (
                <CheckIcon aria-hidden="true" weight="bold" />
              ) : (
                "2"
              )}
            </span>
            <b>{tr("stepInstall")}</b>
          </button>
          <button
            className={stepClass(3, gatewayConfigured)}
            disabled={selectedStep < 3}
            onClick={() => selectStep(3)}
          >
            <span>
              {gatewayConfigured ? (
                <CheckIcon aria-hidden="true" weight="bold" />
              ) : (
                "3"
              )}
            </span>
            <b>{tr("stepConfigure")}</b>
          </button>
          <button
            className={stepClass(4, gatewayConfigured)}
            disabled={selectedStep < 4}
            onClick={() => selectStep(4)}
          >
            <span>
              {gatewayConfigured ? (
                <CheckIcon aria-hidden="true" weight="bold" />
              ) : (
                "4"
              )}
            </span>
            <b>{tr("stepFinish")}</b>
          </button>
        </nav>
      </aside>
      <section className="workspace">
        <header className="topBar">
          <span className="topStatus" aria-live="polite">
            {busy || installingCodex || checkingCodexUpdates || restoringSession
              ? tr("working")
              : message}
          </span>
          {desktopSession ? (
            <button
              className="userIdentity userIdentityButton"
              aria-label={`${tr("signedInAs")}: ${accountDetail || accountName}`}
              onClick={() => void handleOpenConsole()}
            >
              <span className="userAvatar" aria-hidden="true">
                <UserCircleIcon weight="fill" />
              </span>
              <span className="userIdentityText">
                <strong>{accountName}</strong>
                <small>{accountDetail}</small>
              </span>
            </button>
          ) : null}
          <button
            className="headerActionButton"
            aria-label={tr("language")}
            onClick={toggleLocale}
          >
            {locale === "zh" ? "EN" : "中文"}
          </button>
          <button
            className="headerActionButton"
            aria-label={tr("theme")}
            onClick={cycleTheme}
          >
            {theme === "system"
              ? tr("system")
              : theme === "light"
                ? tr("light")
                : tr("dark")}
          </button>
          {desktopSession ? (
            <button
              className="headerActionButton headerSignOutButton"
              aria-label={tr("signOut")}
              title={tr("signOut")}
              disabled={busy || installingCodex || restoringSession}
              onClick={() => void handleSignOut()}
            >
              <SignOutIcon weight="bold" />
              <span>{tr("signOut")}</span>
            </button>
          ) : null}
        </header>
        {showSettings ? (
          <section className="settingsContent">
            <p className="sectionKicker">{tr("settings")}</p>
            <h1>{tr("connectionRecovery")}</h1>
            <p className="lead">{tr("connectionRecoveryLead")}</p>
            <div className="preferencesPanel">
              <strong>{tr("appearance")}</strong>
              <label className="fieldLabel">
                {tr("theme")}
                <select
                  value={theme}
                  onChange={(event) =>
                    changeTheme(event.target.value as ThemeMode)
                  }
                >
                  <option value="system">{tr("system")}</option>
                  <option value="light">{tr("light")}</option>
                  <option value="dark">{tr("dark")}</option>
                </select>
              </label>
              <label className="fieldLabel">
                {tr("language")}
                <select
                  value={localePreference}
                  onChange={(event) =>
                    changeLocale(event.target.value as LocalePreference)
                  }
                >
                  <option value="system">{tr("automatic")}</option>
                  <option value="zh">{tr("chinese")}</option>
                  <option value="en">{tr("english")}</option>
                </select>
              </label>
            </div>
            <label className="fieldLabel">
              {tr("endpoint")}
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                autoComplete="url"
              />
            </label>
            <div className="settingsDivider" />
            <div className="recoveryRow">
              <div>
                <strong>{tr("backups")}</strong>
                <span>
                  {tr("backupsAvailable", {
                    count: backupCount,
                    suffix: backupCount === 1 ? "" : "s",
                  })}
                </span>
              </div>
              <button
                className="secondaryButton"
                disabled={busy || backupCount === 0}
                onClick={() => void handleRestoreBackups()}
              >
                {tr("restoreLatest")}
              </button>
            </div>
            <button
              className="secondaryButton backButton"
              onClick={() => setShowSettings(false)}
            >
              {tr("backToSetup")}
            </button>
          </section>
        ) : (
          renderSetupContent()
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  isTrayPopupWindow() ? <TrayPopup /> : <App />,
);
