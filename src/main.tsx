import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUUpLeftIcon,
  ArrowsClockwiseIcon,
  BellIcon,
  ChartLineUpIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  CubeIcon,
  CreditCardIcon,
  CurrencyDollarIcon,
  GearIcon,
  HouseIcon,
  ChatCircleTextIcon,
  PuzzlePieceIcon,
  QuestionIcon,
  SignOutIcon,
  UserCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { PanelLeft, PanelRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  bootstrapDesktopKey,
  closeDesktopSignIn,
  clearDesktopSession,
  clearStoredDesktopAPIKey,
  closeCodex,
  configureCodex,
  downloadCodexUpdate,
  downloadAndOpenDesktopInstaller,
  exchangeDesktopAuthorization,
  getCodexAppStatus,
  getCodexStatus,
  getDesktopAccountSummary,
  getDesktopAppVersion,
  getDesktopNotifications,
  getDesktopSubscriptions,
  getLocalCodexAppStatus,
  applyCodexUpdate,
  getPendingDesktopUrls,
  installCodex,
  isCodexExternalInstallationComplete,
  isCodexRunning,
  isAuthenticationRequired,
  openDesktopSignIn,
  openCodex,
  openConsole,
  openNotificationWindow,
  openDevtools,
  refreshDesktopState,
  restoreDesktopState,
  restoreLatestCodexBackups,
  signOutDesktop,
  updateTrayStatus,
  type CodexAppStatus,
  type CodexInstallProgress,
  type CodexStatus,
  type DesktopAccountSummary,
  type DesktopNotification,
  type DesktopNotificationList,
  type DesktopSession,
  type DesktopSubscription,
  type DesktopSubscriptionList,
} from "./shared/desktop";
import { trackSkillEvent } from "./shared/analytics";
import { LocaleProvider, useLocale } from "./context/LocaleContext";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HeaderControls } from "./components/HeaderControls";
import { SettingsPanel } from "./settings/SettingsPanel";
import { SkillsView } from "./skills/SkillsView";
import { NotificationDetailWindow } from "./windows/NotificationDetailWindow";
import { TrayPopup } from "./windows/TrayPopup";
import {
  buildDesktopSignInUrl,
  clearPendingAuthorization,
  createChallenge,
  createState,
  createVerifier,
  readPendingAuthorization,
  savePendingAuthorization,
} from "./shared/auth";
import { notifyBalanceAlerts } from "./shared/balanceAlerts";
import {
  loadNotificationReads,
  notificationReadStorageKey,
  readNotificationDetailID,
  saveNotificationReads,
  saveNotificationWindowPayload,
} from "./shared/notifications";
import { useCopyOnlyContextMenu } from "./shared/useCopyOnlyContextMenu";
import {
  formatBalance,
  formatDataSize,
  formatDownloadSpeed,
  formatFullSyncTime,
  formatNotificationDate,
  formatRemainingDuration,
  formatSubscriptionResetAt,
  subscriptionUsagePercent,
} from "./shared/format";
import "./styles.css";

const defaultEndpoint = import.meta.env.VITE_AUTO_GATEWAY_API_BASE_URL;
const consoleBaseUrl = import.meta.env.VITE_AUTO_GATEWAY_CONSOLE_BASE_URL;
const setupCompletedStoragePrefix = "autogateway.desktop.setup-completed";
const notificationPageSize = 5;
const externalInstallationTimeoutMs = 15 * 60 * 1000;
const designPreviewState = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get("preview")
  : null;

type WizardStep = 1 | 2 | 3 | 4;
type ConfigurationPhase =
  "idle" | "creatingKey" | "configuring" | "complete" | "error";
type DesktopUpdatePhase =
  "idle" | "checking" | "ready" | "downloading" | "error" | "manual";
type CodexOpenPhase = "closed" | "opening" | "opened";

function setupCompletedStorageKey(userID: number): string {
  return `${setupCompletedStoragePrefix}:${userID}`;
}


function hasCompletedSetup(session: DesktopSession): boolean {
  return (
    window.localStorage.getItem(setupCompletedStorageKey(session.user.id)) ===
    "true"
  );
}

function formatBuildTime(locale: "en" | "zh"): string {
  const value = new Date(__BUILD_TIME__);
  if (Number.isNaN(value.getTime())) return "—";
  return value.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}


function isTrayPopupWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === "tray-popup";
  } catch {
    return false;
  }
}

function App() {
  useCopyOnlyContextMenu();
  useEffect(() => {
    function handleDevtoolsShortcut(event: KeyboardEvent) {
      const isDevtoolsShortcut =
        event.key.toLowerCase() === "i" &&
        ((event.ctrlKey && event.shiftKey) ||
          (event.metaKey && event.altKey));
      if (!isDevtoolsShortcut) return;
      event.preventDefault();
      void handleOpenDevtools();
    }
    window.addEventListener("keydown", handleDevtoolsShortcut);
    return () => window.removeEventListener("keydown", handleDevtoolsShortcut);
  }, []);
  // 主题/语言/侧栏折叠来自 LocaleProvider；解构出同名变量，函数体内 600+ 处
  // tr(...)/locale/theme 引用无需修改。
  const {
    tr,
    locale,
    sidebarCollapsed,
    setSidebarCollapsed,
  } = useLocale();
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
  // Tauri's webview suppresses window.confirm() (it returns false without
  // showing a dialog), so destructive actions route through this in-app
  // confirmation dialog instead. See confirm() below.
  const [confirmState, setConfirmState] = useState<{
    message: string;
    resolve: (accepted: boolean) => void;
  } | null>(null);
  const confirmResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const [installingCodex, setInstallingCodex] = useState(false);
  const [checkingCodexUpdates, setCheckingCodexUpdates] = useState(false);
  const [awaitingExternalInstallation, setAwaitingExternalInstallation] =
    useState(false);
  const [installationTimedOut, setInstallationTimedOut] = useState(false);
  const [storeInstallForceUpdate, setStoreInstallForceUpdate] = useState(false);
  const [canRetryCachedInstaller, setCanRetryCachedInstaller] = useState(false);
  const [externalInstallationMessage, setExternalInstallationMessage] =
    useState("");
  const externalInstallationStartedAt = useRef<number | null>(null);
  const externalInstallationTargetVersion = useRef<string | undefined>(undefined);
  const storeAutoRetryAttempted = useRef(false);
  const [setupCompleted, setSetupCompleted] = useState(false);
  const [accountBalance, setAccountBalance] = useState("");
  const [balanceSyncedAt, setBalanceSyncedAt] = useState<number | null>(null);
  const [accountSubscription, setAccountSubscription] =
    useState<DesktopSubscription | null>(null);
  const [notifications, setNotifications] = useState<DesktopNotification[]>(
    [],
  );
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [notificationReads, setNotificationReads] = useState<Set<number>>(
    new Set(),
  );
  const [notificationPage, setNotificationPage] = useState(0);
  const [notificationsRefreshNonce, setNotificationsRefreshNonce] = useState(0);
  const [desktopAppVersion, setDesktopAppVersion] = useState("");
  const [installProgress, setInstallProgress] =
    useState<CodexInstallProgress | null>(null);
  const [installStageElapsedSeconds, setInstallStageElapsedSeconds] =
    useState(0);
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
  const [openingDesktopInstaller, setOpeningDesktopInstaller] = useState(false);
  const [homeActionError, setHomeActionError] = useState("");
  const [codexInstallNotice, setCodexInstallNotice] = useState("");
  const [codexOpenPhase, setCodexOpenPhase] =
    useState<CodexOpenPhase>("closed");
  const [selectedStep, setSelectedStep] = useState<WizardStep>(1);
  const [showSettings, setShowSettings] = useState(false);
  const [activeView, setActiveView] = useState<"home" | "skills">("home");
  const configurationRun = useRef(false);
  const authorizationExchangeInProgress = useRef(false);
  const completedAuthorizationCode = useRef("");
  // 稳定的外链打开回调：传给 MarkdownContent 等子组件，避免每次渲染创建新函数引用。
  const openExternalUrl = useCallback(
    (url: string) => {
      void openUrl(url);
    },
    [],
  );

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

  function installStageLabel(stage: string): string {
    switch (stage) {
      case "selecting-source":
        return tr("selectingDownloadSource");
      case "closing":
        return tr("closingCodex");
      case "mounting":
        return tr("mountingCodex");
      case "copying":
        return tr("copyingCodex");
      case "verifying-signature":
        return tr("verifyingCodexSignature");
      case "unmounting":
        return tr("unmountingCodex");
      case "windows-installing":
        return tr("windowsInstallingElapsed", {
          elapsed: formatRemainingDuration(installStageElapsedSeconds),
        });
      case "windows-fallback":
        return tr("windowsFallbackInstalling");
      case "windows-store":
        return tr("windowsStoreOpening");
      case "verifying":
        return tr("verifyingCodex");
      case "opening":
        return tr("openingCodex");
      default:
        return tr("replacingCodex");
    }
  }
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
  const returningToSetup = Boolean(
    desktopSession &&
      !setupCompleted &&
      hasCompletedSetup(desktopSession),
  );
  const maximumReachableSetupStep: WizardStep = !accountConnected
    ? 1
    : !appInstalled
      ? 2
      : !gatewayConfigured
        ? 3
        : 4;

  function resetSessionState(nextMessage: string) {
    clearPendingAuthorization();
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
    setNotifications([]);
    setNotificationsLoading(false);
    setNotificationsError("");
    setNotificationReads(new Set());
    setNotificationPage(0);
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
    setCodexInstallNotice("");
    externalInstallationTargetVersion.current = undefined;
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
    if (!(await confirm(tr("signOutConfirm")))) return;
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

  function confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmState({ message, resolve });
    });
  }

  function resolveConfirm(accepted: boolean) {
    confirmResolverRef.current?.(accepted);
    confirmResolverRef.current = null;
    setConfirmState(null);
  }

  async function refreshStatus(updateMessage = true) {
    try {
      const [nextStatus, nextAppStatus] = await Promise.all([
        getCodexStatus(),
        getCodexAppStatus(),
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
    if (designPreviewState) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen("desktop-check-updates", () => {
      if (active) void checkDesktopUpdate(true);
    }).then((nextUnlisten) => {
      if (!active) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [desktopUpdatePhase, designPreviewState]);

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
      modelProvider: previewComplete ? "autogateway" : undefined,
      configValid: previewComplete,
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
    let active = true;
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
        if (payload.stage === "mounting") setMessage(tr("mountingCodex"));
        if (payload.stage === "copying") setMessage(tr("copyingCodex"));
        if (payload.stage === "verifying-signature")
          setMessage(tr("verifyingCodexSignature"));
        if (payload.stage === "replacing") setMessage(tr("replacingCodex"));
        if (payload.stage === "unmounting") setMessage(tr("unmountingCodex"));
        if (payload.stage === "windows-installing")
          setMessage(tr("windowsInstalling"));
        if (payload.stage === "windows-fallback")
          setMessage(tr("windowsFallbackInstalling"));
        if (payload.stage === "windows-store")
          setMessage(tr("windowsStoreOpening"));
        if (payload.stage === "verifying") setMessage(tr("verifyingCodex"));
        if (payload.stage === "opening") setMessage(tr("openingCodex"));
      },
    ).then((nextUnlisten) => {
      // 若 cleanup 已先于 listen resolve 执行，立即注销，避免泄漏。
      if (!active) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [locale, designPreviewState]);

  useEffect(() => {
    const stage = installProgress?.stage;
    const tracksElapsedTime =
      stage === "windows-installing" ||
      stage === "windows-fallback" ||
      stage === "windows-store";
    if (!installingCodex || !tracksElapsedTime) {
      setInstallStageElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setInstallStageElapsedSeconds(0);
    const interval = window.setInterval(() => {
      setInstallStageElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [installingCodex, installProgress?.stage]);

  async function completeExternalInstallation(nextAppStatus: CodexAppStatus) {
    externalInstallationStartedAt.current = null;
    setAppStatus(nextAppStatus);
    setAwaitingExternalInstallation(false);
    setInstallingCodex(false);
    setInstallProgress(null);
    setCanRetryCachedInstaller(false);
    setExternalInstallationMessage("");
    setInstallationTimedOut(false);
    const completedMessage = tr(
      storeInstallForceUpdate ? "updatedReady" : "installedReady",
    );
    setMessage(completedMessage);
    setCodexInstallNotice(completedMessage);
    if (storeInstallForceUpdate) {
      try {
        await openCodex();
        const reopened = await waitForCodexOpen();
        setCodexOpenPhase(reopened ? "opened" : "closed");
        if (!reopened) setHomeActionError(tr("codexUpdatedReopenFailed"));
      } catch {
        setHomeActionError(tr("codexUpdatedReopenFailed"));
      }
    }
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
    setHomeActionError(tr("windowsInstallationTimedOut"));
  }

  useEffect(() => {
    if (!awaitingExternalInstallation || designPreviewState) return;
    let active = true;
    let checking = false;
    async function checkExternalInstallation() {
      if (checking) return;
      checking = true;
      try {
        const nextAppStatus =
          storeInstallForceUpdate && !externalInstallationTargetVersion.current
            ? await getCodexAppStatus()
            : await getLocalCodexAppStatus();
        if (!active) return;
        const startedAt = externalInstallationStartedAt.current;
        if (
          isCodexExternalInstallationComplete(
            nextAppStatus,
            storeInstallForceUpdate,
            externalInstallationTargetVersion.current,
          )
        ) {
          await completeExternalInstallation(nextAppStatus);
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
      // 若 cleanup 已先于 listen resolve 执行，立即注销，避免泄漏。
      if (!active) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [locale]);

  useEffect(() => {
    const userID = desktopSession?.user.id;
    if (!userID) {
      setNotificationReads(new Set());
      setNotificationPage(0);
      return;
    }
    setNotificationReads(loadNotificationReads(userID));
    setNotificationPage(0);
  }, [desktopSession?.user.id]);

  useEffect(() => {
    const userID = desktopSession?.user.id;
    if (!userID) return;
    const notificationUserID = userID;
    function handleNotificationReadsChanged(event: StorageEvent): void {
      if (event.key === notificationReadStorageKey(notificationUserID)) {
        setNotificationReads(loadNotificationReads(notificationUserID));
      }
    }
    window.addEventListener("storage", handleNotificationReadsChanged);
    return () =>
      window.removeEventListener("storage", handleNotificationReadsChanged);
  }, [desktopSession?.user.id]);

  useEffect(() => {
    if (!desktopAccessToken || !showHome) {
      setNotifications([]);
      setNotificationsLoading(false);
      setNotificationsError("");
      setNotificationPage(0);
      return;
    }
    let active = true;
    let syncing = false;

    async function syncNotifications() {
      if (syncing) return;
      syncing = true;
      setNotificationsLoading(true);
      setNotificationsError("");
      try {
        let data: DesktopNotificationList;
        try {
          data = await getDesktopNotifications(desktopAccessToken);
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
          data = await getDesktopNotifications(refreshed.session.token);
        }
        if (!active) return;
        const nextItems = [...(data.items ?? [])].sort(
          (left, right) =>
            (left.sortOrder ?? 0) - (right.sortOrder ?? 0) ||
            (right.id ?? 0) - (left.id ?? 0),
        );
        setNotifications(nextItems);
        setNotificationPage((current) =>
          Math.min(
            current,
            Math.max(Math.ceil(nextItems.length / notificationPageSize) - 1, 0),
          ),
        );
      } catch (error) {
        if (!active) return;
        if (isAuthenticationRequired(error)) {
          void handleSessionExpired();
          return;
        }
        setNotificationsError(String(error));
      } finally {
        if (active) setNotificationsLoading(false);
        syncing = false;
      }
    }

    void syncNotifications();
    const interval = window.setInterval(
      () => void syncNotifications(),
      5 * 60_000,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [desktopAccessToken, showHome, notificationsRefreshNonce]);

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
        setBalanceSyncedAt(Date.now());
        void notifyBalanceAlerts(
          desktopSession?.user.id,
          summary.balance,
          locale,
        );
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
  }, [desktopAccessToken, desktopSession?.user.id, locale, showHome]);

  useEffect(() => {
    if (!desktopAccessToken) {
      setAccountSubscription(null);
      return;
    }
    let active = true;
    let syncing = false;
    async function syncAccountSubscription() {
      if (syncing) return;
      syncing = true;
      try {
        let data: DesktopSubscriptionList;
        try {
          data = await getDesktopSubscriptions(desktopAccessToken);
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
          data = await getDesktopSubscriptions(refreshed.session.token);
        }
        if (!active) return;
        const current = (data.items ?? []).find((subscription) =>
          ["active", "trialing"].includes(subscription.status.toLowerCase()),
        );
        setAccountSubscription(current ?? null);
      } catch (error) {
        if (!active) return;
        if (isAuthenticationRequired(error)) {
          void handleSessionExpired();
          return;
        }
        // Keep the last confirmed subscription during transient failures.
      } finally {
        syncing = false;
      }
    }
    void syncAccountSubscription();
    const interval = window.setInterval(
      () => void syncAccountSubscription(),
      60_000,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [desktopAccessToken, desktopSession?.user.id, showHome]);

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
      // Native and plugin listeners may deliver the same callback more than once.
      if (code && completedAuthorizationCode.current === code) return;
      const pending = readPendingAuthorization();
      if (!code || !pending || pending.state !== state) {
        setMessage(tr("callbackInvalid"));
        return;
      }
      if (authorizationExchangeInProgress.current) return;
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
        clearPendingAuthorization();
        completedAuthorizationCode.current = code;
        setMessage(tr("signedIn"));
      } catch (error) {
        setMessage(tr("signInFailed", { error: String(error) }));
      } finally {
        authorizationExchangeInProgress.current = false;
        setBusy(false);
      }
    }
    let activeDeepLink = true;
    void onOpenUrl(receiveDesktopAuthorization).then((nextUnlisten) => {
      // Dispose a listener that resolves after this effect has been cleaned up.
      if (!activeDeepLink) {
        nextUnlisten();
        return;
      }
      unlistenDeepLink = nextUnlisten;
    });
    void listen<string[]>("desktop-open-url", ({ payload }) => {
      void receiveDesktopAuthorization(payload);
    }).then((nextUnlisten) => {
      if (!activeDeepLink) {
        nextUnlisten();
        return;
      }
      unlistenSingleInstance = nextUnlisten;
      return getPendingDesktopUrls();
    })
      .then((urls) => {
        if (activeDeepLink && urls?.length) void receiveDesktopAuthorization(urls);
      })
      .catch(() => undefined);
    void getCurrent()
      .then((urls) => {
        if (urls) void receiveDesktopAuthorization(urls);
      })
      .catch(() => undefined);
    return () => {
      activeDeepLink = false;
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
      const fallbackUrl = buildDesktopSignInUrl(
        consoleBaseUrl,
        challenge,
        state,
        locale,
      );
      savePendingAuthorization({ verifier, state });
      setDesktopSignInUrl(fallbackUrl);
      const signInUrl = await openDesktopSignIn(
        challenge,
        state,
        locale,
        navigator.userAgent,
      );
      setDesktopSignInUrl(signInUrl || fallbackUrl);
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
    if (returningToSetup) {
      enterWorkspace();
      return;
    }
    selectStep(4);
  }

  function enterWorkspace() {
    if (!desktopSession) return;
    window.localStorage.setItem(
      setupCompletedStorageKey(desktopSession.user.id),
      "true",
    );
    setActiveView("home");
    setShowSettings(false);
    setSetupCompleted(true);
    setMessage(tr("workspaceReady"));
  }

  async function handleInstallCodex(
    forceUpdate = false,
    automaticRetry = false,
    forceRedownload = false,
  ) {
    if (installingCodex) return;
    setHomeActionError("");
    setCodexInstallNotice("");
    externalInstallationTargetVersion.current = forceUpdate
      ? appStatus?.latestVersion
      : undefined;
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
      if (forceUpdate) {
        const downloadedUpdate = await downloadCodexUpdate(forceRedownload);
        if (/^\d+(\.\d+)*$/.test(downloadedUpdate.version)) {
          externalInstallationTargetVersion.current = downloadedUpdate.version;
        }
        setMessage(tr("downloadReadyForCodexUpdate"));

        if (await isCodexRunning()) {
          if (!(await confirm(tr("codexCloseConfirm")))) {
            setMessage(tr("codexUpdateCancelled"));
            setCodexInstallNotice(tr("codexUpdateCancelled"));
            return;
          }
          setInstallProgress({ stage: "closing", downloadedBytes: 0 });
          setMessage(tr("closingCodex"));
          await closeCodex(downloadedUpdate.targetPath);
        }

        const windowsInstallation = /Windows/i.test(navigator.userAgent);
        setInstallProgress({
          stage: windowsInstallation ? "windows-installing" : "installing",
          downloadedBytes: 0,
        });
        setMessage(
          tr(windowsInstallation ? "windowsInstalling" : "replacingCodex"),
        );
        const result = await applyCodexUpdate(
          downloadedUpdate.version,
          downloadedUpdate.targetPath,
        );
        if (result.awaitingInstallation) {
          waitingForExternalInstallation = true;
          externalInstallationStartedAt.current = Date.now();
          storeAutoRetryAttempted.current = true;
          setAwaitingExternalInstallation(true);
          setCanRetryCachedInstaller(result.canRetryCachedInstaller);
          setExternalInstallationMessage(result.message);
          setInstallProgress({
            stage: "windows-store",
            downloadedBytes: 0,
          });
          setMessage(result.message);
          return;
        }
        if (!result.installed) throw new Error(result.message);
        await refreshStatus(false);
        const reopened = await waitForCodexOpen();
        setCodexOpenPhase(reopened ? "opened" : "closed");
        setMessage(
          tr(reopened ? "codexUpdatedAndReopened" : "codexUpdatedReopenFailed"),
        );
        setCodexInstallNotice(tr("updatedReady"));
        if (!reopened) setHomeActionError(tr("codexUpdatedReopenFailed"));
        return;
      }

      const result = await installCodex(forceUpdate, forceRedownload);
      if (result.awaitingInstallation) {
        waitingForExternalInstallation = true;
        externalInstallationStartedAt.current = Date.now();
        storeAutoRetryAttempted.current = automaticRetry;
        setAwaitingExternalInstallation(true);
        setCanRetryCachedInstaller(result.canRetryCachedInstaller);
        setExternalInstallationMessage(result.message);
        setInstallProgress({
          stage: "windows-store",
          downloadedBytes: 0,
        });
        setMessage(result.message);
        return;
      }
      if (!result.installed) throw new Error(result.message);
      setAwaitingExternalInstallation(false);
      setCanRetryCachedInstaller(false);
      setExternalInstallationMessage("");
      await refreshStatus();
      setMessage(tr(forceUpdate ? "updatedReady" : "installedReady"));
      setCodexInstallNotice(tr(forceUpdate ? "updatedReady" : "installedReady"));
    } catch (error) {
      const failure = tr("installationFailed", { error: String(error) });
      setMessage(failure);
      setHomeActionError(failure);
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
    if (!(await confirm(tr("desktopUpdateManualConfirm")))) return;
    setOpeningDesktopInstaller(true);
    try {
      setMessage(tr("desktopUpdateManualOpening"));
      const installerPath = await downloadAndOpenDesktopInstaller(installerUrl);
      setMessage(tr("desktopUpdateManualOpened", { path: installerPath }));
    } catch (error) {
      setMessage(tr("desktopUpdateManualOpenFailed", { error: String(error) }));
    } finally {
      setOpeningDesktopInstaller(false);
    }
  }

  async function downloadAndInstallDesktopUpdate(update: Update) {
    setDesktopUpdateProgress(0);
    let contentLength = 0;
    let downloadedBytes = 0;
    await update.downloadAndInstall(
      (event) => {
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
      },
    );
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
      const nextAppStatus =
        storeInstallForceUpdate && !externalInstallationTargetVersion.current
          ? await getCodexAppStatus()
          : await getLocalCodexAppStatus();
      if (
        isCodexExternalInstallationComplete(
          nextAppStatus,
          storeInstallForceUpdate,
          externalInstallationTargetVersion.current,
        )
      ) {
        await completeExternalInstallation(nextAppStatus);
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
      setHomeActionError(tr("readStatusFailed", { error: String(error) }));
    }
  }

  async function handleRestoreBackups() {
    if (backupCount === 0) {
      setMessage(tr("restoreUnavailable"));
      return;
    }
    if (!(await confirm(tr("restoreConfirm")))) return;
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
    if (backupCount === 0) {
      setMessage(tr("restoreUnavailable"));
      return;
    }
    if (!(await confirm(tr("switchBackConfirm")))) return;
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

  async function handleOpenConsole(
    section?: "billing" | "support" | "usage" | "subscription",
  ) {
    if (!desktopAccessToken) {
      setMessage(tr("signInRequired"));
      return;
    }
    try {
      await openConsole(
        desktopAccessToken,
        section,
        locale,
        navigator.userAgent,
      );
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

  async function waitForCodexOpen(): Promise<boolean> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await isCodexRunning()) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    return false;
  }

  async function handleOpenCodex() {
    setHomeActionError("");
    setCodexOpenPhase("opening");
    try {
      await openCodex();
      if (await waitForCodexOpen()) {
        setCodexOpenPhase("opened");
      } else {
        setCodexOpenPhase("closed");
        setHomeActionError(tr("codexOpenTimeout"));
      }
    } catch (error) {
      setCodexOpenPhase("closed");
      setHomeActionError(tr("openCodexFailed", { error: String(error) }));
    }
  }

  async function handleRestartCodex() {
    setHomeActionError("");
    if (!(await confirm(tr("restartCodexConfirm")))) return;
    setCodexOpenPhase("opening");
    setMessage(tr("restartingCodex"));
    try {
      await closeCodex(appStatus?.path);
      await openCodex();
      if (await waitForCodexOpen()) {
        setCodexOpenPhase("opened");
        setMessage(tr("codexRestarted"));
      } else {
        setCodexOpenPhase("closed");
        setHomeActionError(tr("codexOpenTimeout"));
      }
    } catch (error) {
      setCodexOpenPhase("closed");
      setHomeActionError(tr("restartCodexFailed", { error: String(error) }));
    }
  }

  function openSetupFromHome() {
    setShowSettings(false);
    setSetupCompleted(false);
    setSelectedStep(2);
  }

  function getBalanceTooltip(): string {
    return [
      accountBalance || tr("balanceUnavailable"),
      tr("lastSyncedAt", {
        time: formatFullSyncTime(balanceSyncedAt, locale, tr("notSynced")),
      }),
    ].join("\n");
  }

  async function openAnnouncement(notification: DesktopNotification): Promise<void> {
    const userID = desktopSession?.user.id;
    if (!userID) return;
    setNotificationReads((current) => {
      if (current.has(notification.id)) return current;
      const next = new Set(current);
      next.add(notification.id);
      saveNotificationReads(userID, next);
      return next;
    });
    saveNotificationWindowPayload({
      userID,
      activeID: notification.id,
      items: notifications,
    });
    try {
      await openNotificationWindow(notification.id);
    } catch (error) {
      setHomeActionError(
        tr("announcementWindowOpenFailed", { error: String(error) }),
      );
    }
  }

  function renderDesktopUpdateNotice() {
    if (desktopUpdate && desktopUpdatePhase !== "manual") {
      return (
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
      );
    }
    if (desktopUpdatePhase === "error") {
      return (
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
      );
    }
    if (desktopUpdatePhase === "manual") {
      return (
        <section className="notice warning desktopUpdateNotice">
          <strong>{tr("desktopUpdateManualTitle")}</strong>
          <span>{tr("desktopUpdateManualDescription")}</span>
          {desktopUpdateError ? (
            <small className="desktopUpdateErrorDetail">
              {tr("desktopUpdateFailureDetail", {
                error: desktopUpdateError,
              })}
            </small>
          ) : null}
          <button
            className="secondaryButton"
            disabled={!desktopInstallerUrl || openingDesktopInstaller}
            onClick={() => void openManualDesktopInstaller(desktopUpdate)}
          >
            {openingDesktopInstaller
              ? tr("desktopUpdateManualOpening")
              : tr("desktopUpdateManualOpen")}
          </button>
        </section>
      );
    }
    return null;
  }

  function renderHomeContent() {
    const version = appStatus?.localVersion || tr("versionUnavailable");
    const buildTime = formatBuildTime(locale);
    const unreadNotificationCount = notifications.filter(
      (notification) => !notificationReads.has(notification.id),
    ).length;
    const notificationPageCount = Math.max(
      1,
      Math.ceil(notifications.length / notificationPageSize),
    );
    const currentNotificationPage = Math.min(
      notificationPage,
      notificationPageCount - 1,
    );
    const visibleNotifications = notifications.slice(
      currentNotificationPage * notificationPageSize,
      (currentNotificationPage + 1) * notificationPageSize,
    );
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
      <>
      <main
        className={`homeShell ${sidebarCollapsed ? "sidebarCollapsed" : ""}`.trim()}
      >
        <aside
          className={`homeRail ${sidebarCollapsed ? "collapsed" : ""}`.trim()}
        >
          <button
            className="tooltipValue homeRailToggle"
            aria-label={
              sidebarCollapsed
                ? tr("sidebarExpand")
                : tr("sidebarCollapse")
            }
            data-tooltip={
              sidebarCollapsed
                ? tr("sidebarExpand")
                : tr("sidebarCollapse")
            }
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? <PanelRight /> : <PanelLeft />}
          </button>
          <div className="homeBrand">
            <img className="homeBrandLogo" src="/site-icon.png" alt="" />
            <div className="homeBrandCopy">
              <strong>AUTO Gateway</strong>
              <div className="homeBrandVersion">
                <small
                  className="tooltipValue buildTimeTooltip"
                  aria-label={tr("lastCompiledAt", { time: buildTime })}
                  data-tooltip={tr("lastCompiledAt", { time: buildTime })}
                  tabIndex={0}
                >
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
            <button
              className={`tooltipValue homeNavTooltip ${activeView === "home" ? "selected" : ""}`.trim()}
              aria-current={activeView === "home" ? "page" : undefined}
              aria-label={tr("home")}
              data-tooltip={tr("home")}
              onClick={() => setActiveView("home")}
            >
              <HouseIcon weight="bold" />
              <span className="homeNavLabel">{tr("home")}</span>
            </button>
            <button
              className="tooltipValue homeNavTooltip"
              aria-label={tr("codexSetup")}
              data-tooltip={tr("codexSetup")}
              onClick={openSetupFromHome}
            >
              <CubeIcon />
              <span className="homeNavLabel">{tr("codexSetup")}</span>
            </button>
            <button
              className={`tooltipValue homeNavTooltip ${activeView === "skills" ? "selected" : ""}`.trim()}
              aria-current={activeView === "skills" ? "page" : undefined}
              aria-label={tr("skillManagement")}
              data-tooltip={tr("skillManagement")}
              onClick={() => {
                if (activeView !== "skills") {
                  trackSkillEvent("skill_manager_opened");
                }
                setActiveView("skills");
              }}
            >
              <PuzzlePieceIcon weight="bold" />
              <span className="homeNavLabel">{tr("skillManagement")}</span>
            </button>
            <button
              className="tooltipValue homeNavTooltip"
              aria-label={tr("usageRecords")}
              data-tooltip={tr("usageRecords")}
              onClick={() => void handleOpenConsole("usage")}
            >
              <ChartLineUpIcon weight="bold" />
              <span className="homeNavLabel">{tr("usageRecords")}</span>
            </button>
            <button
              className="tooltipValue homeNavTooltip"
              aria-label={tr("subscriptions")}
              data-tooltip={tr("subscriptions")}
              onClick={() => void handleOpenConsole("subscription")}
            >
              <CreditCardIcon weight="bold" />
              <span className="homeNavLabel">{tr("subscriptions")}</span>
            </button>
            <button
              className="tooltipValue homeNavTooltip"
              aria-label={tr("userConsole")}
              data-tooltip={tr("userConsole")}
              onClick={() => void handleOpenConsole()}
            >
              <UserCircleIcon />
              <span className="homeNavLabel">{tr("userConsole")}</span>
            </button>
          </nav>
          <div className="homeSupportLinks">
            <button
              className="homeSupportLink tooltipValue homeNavTooltip"
              aria-label={tr("needHelp")}
              data-tooltip={tr("needHelp")}
              onClick={() => void openUrl(`${consoleBaseUrl}/docs#codex`)}
            >
              <QuestionIcon weight="bold" />
              <span className="homeNavLabel">{tr("needHelp")}</span>
            </button>
            <button
              className="homeSupportLink tooltipValue homeNavTooltip"
              aria-label={tr("reportIssue")}
              data-tooltip={tr("reportIssue")}
              onClick={() => void handleOpenConsole("support")}
            >
              <ChatCircleTextIcon weight="bold" />
              <span className="homeNavLabel">{tr("reportIssue")}</span>
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
                <strong
                  className="tooltipValue balanceValue"
                  aria-label={getBalanceTooltip()}
                  data-tooltip={getBalanceTooltip()}
                  tabIndex={0}
                >
                  {formatBalance(accountBalance, locale) ||
                    tr("balanceUnavailable")}
                </strong>
              </div>
              <button
                className="headerTopUpButton"
                onClick={() => void handleOpenConsole("billing")}
              >
                <CurrencyDollarIcon weight="bold" />
                {tr("topUpBalance")}
              </button>
            </div>
            <HeaderControls />
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
          {activeView === "skills" ? (
            <SkillsView
              desktopAccessToken={desktopAccessToken}
              openExternalUrl={openExternalUrl}
            />
          ) : (
          <section className="homeContent">
            <p className="sectionKicker">{tr("workspace")}</p>
            <h1>{tr("homeTitle")}</h1>
            <p className="lead homeLead">{tr("homeLead")}</p>
            {renderDesktopUpdateNotice()}
            {homeActionError ? (
              <p className="homeActionMessage" role="alert">
                {homeActionError}
              </p>
            ) : null}
            {codexInstallNotice ? (
              <p role="status">{codexInstallNotice}</p>
            ) : null}
            {accountSubscription ? (
              <section
                className="homeSubscriptionCard"
                aria-labelledby="home-subscription-title"
              >
                <div className="homeSubscriptionHeader">
                  <div className="homeSubscriptionTitle">
                    <span className="homeSubscriptionKicker">
                      {tr("currentSubscription")}
                    </span>
                    <h2 id="home-subscription-title">
                      {accountSubscription.planName}
                    </h2>
                  </div>
                  <button
                    className="homeSubscriptionAction"
                    type="button"
                    onClick={() => void handleOpenConsole("subscription")}
                  >
                    {tr("manageSubscription")}
                    <ArrowRightIcon weight="bold" />
                  </button>
                </div>
                <div className="homeSubscriptionBody">
                  <div className="homeSubscriptionBalance">
                    <span>{tr("subscriptionBalance")}</span>
                    <strong>{accountSubscription.available}</strong>
                    <small>
                      {tr("subscriptionBalanceUsed", {
                        used: accountSubscription.monthlyUsed,
                        limit: accountSubscription.monthlyLimit,
                      })}
                    </small>
                  </div>
                  <div className="homeSubscriptionWindows">
                    {[
                      {
                        label: tr("subscriptionFiveHour"),
                        used: accountSubscription.fiveHourUsed,
                        limit: accountSubscription.fiveHourLimit,
                        usedMicros: accountSubscription.fiveHourUsedMicros,
                        limitMicros: accountSubscription.fiveHourLimitMicros,
                        resetAt: accountSubscription.fiveHourResetAt ?? "",
                      },
                      {
                        label: tr("subscriptionWeekly"),
                        used: accountSubscription.weeklyUsed,
                        limit: accountSubscription.weeklyLimit,
                        usedMicros: accountSubscription.weeklyUsedMicros,
                        limitMicros: accountSubscription.weeklyLimitMicros,
                        resetAt: accountSubscription.weeklyResetAt ?? "",
                      },
                      {
                        label: tr("subscriptionMonthly"),
                        used: accountSubscription.monthlyUsed,
                        limit: accountSubscription.monthlyLimit,
                        usedMicros: accountSubscription.monthlyUsedMicros,
                        limitMicros: accountSubscription.monthlyLimitMicros,
                        resetAt: accountSubscription.monthlyResetAt ?? "",
                      },
                    ].map((window) => {
                      const percentage = subscriptionUsagePercent(
                        window.usedMicros,
                        window.limitMicros,
                      );
                      const resetAt = formatSubscriptionResetAt(
                        window.resetAt,
                        locale,
                      );
                      return (
                        <div
                          className="homeSubscriptionUsageWindow"
                          key={window.label}
                        >
                          <div className="homeSubscriptionProgressMeta">
                            <span>{window.label}</span>
                            <strong>
                              {tr("subscriptionUsedPercent", {
                                value: percentage,
                              })}
                            </strong>
                          </div>
                          <div
                            className="homeSubscriptionProgress"
                            role="progressbar"
                            aria-label={`${window.label}: ${percentage}%`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percentage}
                          >
                            <span style={{ width: `${percentage}%` }} />
                          </div>
                          <div className="homeSubscriptionUsageDetails">
                            <small>
                              {tr("subscriptionUsedAmount", {
                                used: window.used,
                                limit: window.limit,
                              })}
                            </small>
                            <small className="homeSubscriptionResetAt">
                              {tr("subscriptionNextReset", {
                                time:
                                  resetAt ||
                                  tr("subscriptionResetUnavailable"),
                              })}
                            </small>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="homeSubscriptionMeta">
                    <span>
                      {accountSubscription.cancelAtPeriodEnd
                        ? tr("subscriptionEndsAt")
                        : tr("subscriptionRenewsAt")}
                    </span>
                    <strong>{accountSubscription.renewsAt || "—"}</strong>
                  </div>
                </div>
              </section>
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
              <div className="homeMetric homeBalanceMetric">
                <span>{tr("accountBalance")}</span>
                <strong
                  className="tooltipValue balanceValue"
                  aria-label={getBalanceTooltip()}
                  data-tooltip={getBalanceTooltip()}
                  tabIndex={0}
                >
                  {formatBalance(accountBalance, locale) ||
                    tr("balanceUnavailable")}
                </strong>
                <button onClick={() => void handleOpenConsole("billing")}>
                  {tr("topUpBalance")}
                </button>
              </div>
              <div className="homeMetric">
                <span>{tr("localVersion")}</span>
                <strong>{version}</strong>
                <small>{versionStatus}</small>
                {appStatus?.path ? (
                  <small
                    className="managedCodexPath"
                    title={appStatus.path}
                  >
                    {tr("managedCodexPath", { path: appStatus.path })}
                  </small>
                ) : null}
                <div className="homeVersionActions">
                  {!updateAvailable ? (
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
                  ) : null}
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
              </div>
              <div className="homeOpenActions">
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
                {codexOpenPhase === "opened" ? (
                  <button
                    className="secondaryButton homeRestartButton"
                    disabled={installingCodex}
                    onClick={() => void handleRestartCodex()}
                  >
                    {tr("restartCodex")}
                  </button>
                ) : null}
              </div>
            </section>
            {installingCodex && installProgress ? (
              <div className="homeCodexUpdateProgress" aria-live="polite">
                {installProgress.stage === "downloading" ? (
                  <>
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
                  </>
                ) : (
                  <>
                    <div className="progressStatusRow">
                      <span className="progressSpinner" aria-hidden="true" />
                      <small>
                        {externalInstallationMessage || installStageLabel(installProgress.stage)}
                      </small>
                    </div>
                    <div
                      className="indeterminateProgressTrack"
                      role="progressbar"
                      aria-label={installStageLabel(installProgress.stage)}
                      aria-valuetext={installStageLabel(installProgress.stage)}
                    >
                      <span />
                    </div>
                  </>
                )}
              </div>
            ) : null}
            <section className="homeDualSection">
              <section className="homeSectionColumn">
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
                    disabled={busy}
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
              <section className="homeSectionColumn announcementsColumn">
                <div className="sectionHeadingRow">
                  <h2>{tr("latestAnnouncements")}</h2>
                  {unreadNotificationCount > 0 ? (
                    <span className="announcementUnreadCount">
                      {tr("announcementUnread", {
                        count: unreadNotificationCount,
                      })}
                    </span>
                  ) : null}
                </div>
                <div
                  className="announcementList"
                  aria-busy={notificationsLoading}
                >
                  {notifications.length === 0 && notificationsLoading ? (
                    <div className="announcementFeedback">
                      <CircleNotchIcon className="spin" weight="bold" />
                      <span>{tr("announcementLoading")}</span>
                    </div>
                  ) : null}
                  {notifications.length === 0 &&
                  !notificationsLoading &&
                  !notificationsError ? (
                    <div className="announcementFeedback">
                      <BellIcon weight="bold" />
                      <span>{tr("announcementEmpty")}</span>
                    </div>
                  ) : null}
                  {notificationsError ? (
                    <div className="announcementFeedback announcementError">
                      <span>{tr("announcementLoadFailed")}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setNotificationsRefreshNonce((value) => value + 1)
                        }
                      >
                        {tr("announcementRetry")}
                      </button>
                    </div>
                  ) : null}
                  {visibleNotifications.map((notification) => {
                    const isRead = notificationReads.has(notification.id);
                    const date = formatNotificationDate(
                      notification.createdAt ?? notification.startsAt,
                      locale,
                    );
                    return (
                      <article
                        className={`announcementItem${isRead ? "" : " unread"}`}
                        key={notification.id}
                      >
                        <button
                          className="announcementTrigger"
                          type="button"
                          onClick={() => void openAnnouncement(notification)}
                        >
                          <span className="announcementTriggerCopy">
                            <span className="announcementTitleLine">
                              {!isRead ? (
                                <span
                                  className="announcementUnreadDot"
                                  aria-label={tr("announcementUnreadLabel")}
                                />
                              ) : null}
                              <strong>{notification.title}</strong>
                            </span>
                            {date ? <small>{date}</small> : null}
                          </span>
                          <ArrowRightIcon weight="bold" />
                        </button>
                      </article>
                    );
                  })}
                  {notificationPageCount > 1 ? (
                    <div className="announcementPager">
                      <button
                        className="announcementPagerButton"
                        type="button"
                        disabled={currentNotificationPage <= 0}
                        onClick={() =>
                          setNotificationPage((current) =>
                            Math.max(current - 1, 0),
                          )
                        }
                      >
                        <ArrowLeftIcon weight="bold" />
                        {tr("announcementPreviousPage")}
                      </button>
                      <span>
                        {tr("announcementPage", {
                          current: currentNotificationPage + 1,
                          total: notificationPageCount,
                        })}
                      </span>
                      <button
                        className="announcementPagerButton"
                        type="button"
                        disabled={
                          currentNotificationPage >= notificationPageCount - 1
                        }
                        onClick={() =>
                          setNotificationPage((current) =>
                            Math.min(current + 1, notificationPageCount - 1),
                          )
                        }
                      >
                        {tr("announcementNextPage")}
                        <ArrowRightIcon weight="bold" />
                      </button>
                    </div>
                  ) : null}
                </div>
              </section>
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
          )}
        </section>
      </main>
      {confirmState ? (
        <ConfirmDialog
          message={confirmState.message}
          confirmLabel={tr("confirm")}
          cancelLabel={tr("cancel")}
          onResolve={resolveConfirm}
        />
      ) : null}
      </>
    );
  }

  function selectStep(step: WizardStep) {
    if (step > maximumReachableSetupStep) return;
    if (!returningToSetup && step > selectedStep + 1) return;
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
            {renderDesktopUpdateNotice()}
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
            {homeActionError ? (
              <p className="homeActionMessage" role="alert">
                {homeActionError}
              </p>
            ) : null}
            <div
              className={
                appInstalled && !updateAvailable
                  ? "notice success installNotice setupNotice"
                  : "notice warning installNotice setupNotice"
              }
            >
              <div className="installNoticeSummary">
                <div className="installNoticeCopy">
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
                </div>
                {!appInstalled &&
                appStatus &&
                !installationTimedOut &&
                !awaitingExternalInstallation ? (
                  <button
                    className="primaryButton installNoticeAction"
                    disabled={installingCodex}
                    onClick={() => void handleInstallCodex()}
                  >
                    {installingCodex
                      ? installPercent === undefined
                        ? tr("installingCodex")
                        : `${tr("installingCodex")} ${installPercent}%`
                      : tr("autoInstall")}
                  </button>
                ) : null}
              </div>
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
                  {!updateAvailable ? (
                    <button
                      className="secondaryButton updateButton versionUpdateButton"
                      disabled={checkingCodexUpdates || installingCodex}
                      onClick={() => void handleCheckCodexUpdates()}
                    >
                      {checkingCodexUpdates
                        ? tr("checkingCodexUpdates")
                        : tr("checkNow")}
                    </button>
                  ) : null}
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
              (installProgress?.stage === "windows-installing" ||
                installProgress?.stage === "windows-fallback" ||
                installProgress?.stage === "windows-store") ? (
                <div
                  className="installProgress indeterminateProgress"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <div className="progressStatusRow">
                    <span className="progressSpinner" aria-hidden="true" />
                    <small>
                      {externalInstallationMessage ||
                        installStageLabel(installProgress.stage)}
                    </small>
                  </div>
                  <div
                    className="indeterminateProgressTrack"
                    role="progressbar"
                    aria-label={installStageLabel(installProgress.stage)}
                    aria-valuetext={installStageLabel(installProgress.stage)}
                  >
                    <span />
                  </div>
                </div>
              ) : null}
              {installingCodex &&
              (installProgress?.stage === "closing" ||
                installProgress?.stage === "mounting" ||
                installProgress?.stage === "copying" ||
                installProgress?.stage === "verifying-signature" ||
                installProgress?.stage === "replacing" ||
                installProgress?.stage === "unmounting" ||
                installProgress?.stage === "installing" ||
                installProgress?.stage === "verifying" ||
                installProgress?.stage === "opening") ? (
                <div
                  className="installProgress indeterminateProgress"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <div className="progressStatusRow">
                    <span className="progressSpinner" aria-hidden="true" />
                    <small>{installStageLabel(installProgress.stage)}</small>
                  </div>
                  <div
                    className="indeterminateProgressTrack"
                    role="progressbar"
                    aria-label={tr("updatingCodex")}
                    aria-valuetext={tr("updatingCodex")}
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
            ) : null}
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
    <>
    <main className="appShell">
      <aside className={`wizardRail ${returningToSetup ? "returning" : ""}`.trim()}>
        {returningToSetup ? (
          <button className="setupHomeButton" onClick={enterWorkspace}>
            <HouseIcon weight="bold" />
            {tr("backToHome")}
          </button>
        ) : null}
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
            disabled={
              returningToSetup
                ? maximumReachableSetupStep < 2
                : selectedStep < 2
            }
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
            disabled={
              returningToSetup
                ? maximumReachableSetupStep < 3
                : selectedStep < 3
            }
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
            disabled={
              returningToSetup
                ? maximumReachableSetupStep < 4
                : selectedStep < 4
            }
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
          <HeaderControls />
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
          <SettingsPanel
            endpoint={endpoint}
            onEndpointChange={setEndpoint}
            busy={busy}
            backupCount={backupCount}
            onRestoreBackups={() => void handleRestoreBackups()}
            onClose={() => setShowSettings(false)}
          />
        ) : (
          renderSetupContent()
        )}
      </section>
    </main>
    {confirmState ? (
      <ConfirmDialog
        message={confirmState.message}
        confirmLabel={tr("confirm")}
        cancelLabel={tr("cancel")}
        onResolve={resolveConfirm}
      />
    ) : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  isTrayPopupWindow() ? (
    <TrayPopup />
  ) : readNotificationDetailID() !== null ? (
    <NotificationDetailWindow />
  ) : (
    <LocaleProvider>
      <App />
    </LocaleProvider>
  ),
);
