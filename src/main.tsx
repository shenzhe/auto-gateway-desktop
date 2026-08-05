import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { ArrowRightIcon, ArrowsClockwiseIcon, CheckCircleIcon, CheckIcon, CircleNotchIcon, CopyIcon, CubeIcon, CurrencyDollarIcon, GearIcon, HouseIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapDesktopKey, clearStoredDesktopAPIKey, configureCodex, exchangeDesktopAuthorization, getCodexAppStatus, getCodexStatus, getDesktopAccountSummary, installCodex, openCodex, openConsole, restoreDesktopState, restoreLatestCodexBackups, updateTrayStatus, type CodexAppStatus, type CodexInstallProgress, type CodexStatus, type DesktopSession } from "./desktop";
import { readLocalePreference, resolveLocale, translate, writeLocalePreference, type LocalePreference } from "./i18n";
import { applyTheme, readTheme, writeTheme, type ThemeMode } from "./theme";
import "./styles.css";

const defaultEndpoint = "https://api.autogateway.cc";
const pendingAuthorizationStorageKey = "autogateway.desktop.pending-authorization";
const setupCompletedStoragePrefix = "autogateway.desktop.setup-completed";
const designPreviewState = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("preview") : null;

type PendingAuthorization = {
  verifier: string;
  state: string;
};

type WizardStep = 1 | 2 | 3 | 4;
type ConfigurationPhase = "idle" | "creatingKey" | "configuring" | "complete" | "error";
type DesktopUpdatePhase = "idle" | "checking" | "ready" | "downloading" | "error";

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function createVerifier(): string {
  const bytes = new Uint8Array(64);
  window.crypto.getRandomValues(bytes);
  return base64URL(bytes);
}

async function createChallenge(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
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
  return window.localStorage.getItem(setupCompletedStorageKey(session.user.id)) === "true";
}

function formatSyncTime(value: Date | null, locale: "en" | "zh", fallback: string): string {
  if (!value) return fallback;
  return value.toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
}

function App() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [appStatus, setAppStatus] = useState<CodexAppStatus | null>(null);
  const [apiKey, setAPIKey] = useState("");
  const [desktopAccessToken, setDesktopAccessToken] = useState("");
  const [desktopSession, setDesktopSession] = useState<DesktopSession | null>(null);
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const [installingCodex, setInstallingCodex] = useState(false);
  const [awaitingStoreInstallation, setAwaitingStoreInstallation] = useState(false);
  const [setupCompleted, setSetupCompleted] = useState(false);
  const [accountBalance, setAccountBalance] = useState("");
  const [balanceSyncedAt, setBalanceSyncedAt] = useState<Date | null>(null);
  const [installProgress, setInstallProgress] = useState<CodexInstallProgress | null>(null);
  const [configurationPhase, setConfigurationPhase] = useState<ConfigurationPhase>("idle");
  const [configurationError, setConfigurationError] = useState("");
  const [apiKeyCopied, setAPIKeyCopied] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<Update | null>(null);
  const [desktopUpdatePhase, setDesktopUpdatePhase] = useState<DesktopUpdatePhase>("idle");
  const [desktopUpdateProgress, setDesktopUpdateProgress] = useState<number | null>(null);
  const [homeActionError, setHomeActionError] = useState("");
  const [selectedStep, setSelectedStep] = useState<WizardStep>(1);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => readTheme());
  const [localePreference, setLocalePreference] = useState<LocalePreference>(() => readLocalePreference());
  const configurationRun = useRef(false);
  const authorizationExchangeInProgress = useRef(false);
  const completedAuthorizationCode = useRef("");
  const locale = resolveLocale(localePreference);
  const tr = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate(locale, key, values);

  const accountConnected = Boolean(desktopAccessToken);
  const appInstalled = Boolean(appStatus?.installed);
  const updateAvailable = appStatus?.updateAvailable === true;
  const installPercent = typeof installProgress?.percent === "number" && Number.isFinite(installProgress.percent) ? installProgress.percent : undefined;
  const configured = Boolean(status?.configured);
  const codexDetected = accountConnected && appInstalled;
  const gatewayConfigured = codexDetected && (configured || configurationPhase === "complete");
  const backupCount = (status?.configBackupCount ?? 0) + (status?.authBackupCount ?? 0);
  const accountName = desktopSession?.user.displayName || desktopSession?.user.name || desktopSession?.user.username || "";
  const accountDetail = desktopSession?.user.email || desktopSession?.user.username || "";
  const showHome = setupCompleted && Boolean(desktopSession);

  async function refreshStatus(updateMessage = true) {
    try {
      const [nextStatus, nextAppStatus] = await Promise.all([getCodexStatus(), getCodexAppStatus()]);
      setStatus(nextStatus);
      setAppStatus(nextAppStatus);
      if (updateMessage) setMessage(nextStatus.configured ? tr("connected") : tr("notConfigured"));
    } catch (error) {
      setMessage(tr("readStatusFailed", { error: String(error) }));
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
      user: { id: 1, username: "demo", email: "demo@autogateway.cc", displayName: "Demo User", name: "Demo User", role: "user" },
    });
    setAPIKey("agk_preview_7Bf32Pd9M4xQ8wR6kT1nY5cV");
    setSelectedStep(previewCodexUpdate ? 2 : 3);
    setConfigurationPhase(previewComplete ? "complete" : "configuring");
    setRestoringSession(false);
  }, []);

  useEffect(() => {
    if (designPreviewState) return;
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (designPreviewState || !import.meta.env.PROD) return;
    let active = true;
    async function checkDesktopUpdate() {
      if (!active) return;
      setDesktopUpdatePhase("checking");
      try {
        const nextUpdate = await check();
        if (!active) return;
        setDesktopUpdate(nextUpdate);
        setDesktopUpdatePhase(nextUpdate ? "ready" : "idle");
      } catch {
        if (active) setDesktopUpdatePhase("error");
      }
    }
    void checkDesktopUpdate();
    const interval = window.setInterval(() => void checkDesktopUpdate(), 6 * 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (designPreviewState) return;
    let unlisten: (() => void) | undefined;
    void listen<CodexInstallProgress>("codex-install-progress", ({ payload }) => {
      setInstallProgress(payload);
      if (payload.stage === "preparing") setMessage(tr("preparingDownload"));
      if (payload.stage === "downloading") setMessage(payload.percent === undefined ? tr("downloadingCodex") : tr("downloadingCodexProgress", { percent: payload.percent }));
      if (payload.stage === "installing") setMessage(tr("replacingCodex"));
      if (payload.stage === "verifying") setMessage(tr("verifyingCodex"));
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten;
    });
    return () => unlisten?.();
  }, [locale, designPreviewState]);

  useEffect(() => {
    if (!awaitingStoreInstallation || designPreviewState) return;
    let active = true;
    async function checkStoreInstallation() {
      try {
        const nextAppStatus = await getCodexAppStatus();
        if (!active) return;
        setAppStatus(nextAppStatus);
        if (nextAppStatus.installed) {
          setAwaitingStoreInstallation(false);
          setMessage(tr("installedReady"));
        }
      } catch {
        // The user can continue checking after the temporary Store installation state changes.
      }
    }
    void checkStoreInstallation();
    const interval = window.setInterval(() => void checkStoreInstallation(), 4000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [awaitingStoreInstallation, designPreviewState, locale]);

  useEffect(() => {
    if (designPreviewState) {
      setRestoringSession(false);
      return;
    }
    let active = true;
    void restoreDesktopState()
      .then((stored) => {
        if (!active || !stored) return;
        setDesktopSession(stored.session);
        setDesktopAccessToken(stored.session.token);
        setAPIKey(stored.apiKey);
        const setupWasCompleted = hasCompletedSetup(stored.session);
        setSetupCompleted(setupWasCompleted);
        setSelectedStep(setupWasCompleted ? 4 : 2);
        setMessage(setupWasCompleted ? tr("workspaceRestored") : tr("sessionRestored"));
      })
      .catch((error) => {
        if (active) setMessage(tr("sessionRestoreFailed", { error: String(error) }));
      })
      .finally(() => {
        if (active) setRestoringSession(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!desktopAccessToken) {
      setAccountBalance("");
      return;
    }
    let active = true;
    async function syncAccountBalance() {
      try {
        const summary = await getDesktopAccountSummary(desktopAccessToken);
        if (!active) return;
        setAccountBalance(summary.balance);
        setBalanceSyncedAt(new Date());
        void updateTrayStatus(accountName || accountDetail, summary.balance);
      } catch {
        if (!active) return;
        setAccountBalance("");
        void updateTrayStatus(accountName || accountDetail, tr("balanceUnavailable"));
      }
    }
    void syncAccountBalance();
    const interval = window.setInterval(() => void syncAccountBalance(), 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [desktopAccessToken, showHome]);

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
    changeTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system");
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
        .find((url): url is URL => url?.protocol === "autogateway:" && url.hostname === "auth" && url.pathname === "/callback");
      if (!callback) return;
      const code = callback.searchParams.get("code") ?? "";
      const state = callback.searchParams.get("state") ?? "";
      const pending = readPendingAuthorization();
      if (!code || !pending || pending.state !== state) {
        setMessage(tr("callbackInvalid"));
        return;
      }
      if (authorizationExchangeInProgress.current || completedAuthorizationCode.current === code) return;
      authorizationExchangeInProgress.current = true;
      setBusy(true);
      try {
        const session = await exchangeDesktopAuthorization(code, pending.verifier, pending.state);
        setDesktopAccessToken(session.token);
        setDesktopSession(session);
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
    void getCurrent().then((urls) => {
      if (urls) void receiveDesktopAuthorization(urls);
    }).catch(() => undefined);
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
      window.sessionStorage.setItem(pendingAuthorizationStorageKey, JSON.stringify({ verifier, state }));
      const query = new URLSearchParams({ desktopCodeChallenge: challenge, desktopState: state });
      await openUrl(`https://autogateway.cc/login?${query.toString()}`);
      setMessage(tr("completeInBrowser"));
    } catch (error) {
      setMessage(tr("startSignInFailed", { error: String(error) }));
    } finally {
      setBusy(false);
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
      setStatus((current) => current ? { ...current, configured: true } : current);
      setConfigurationPhase("complete");
      setMessage(`${tr("configurationWritten", { backup: result.configBackupPath ? tr("backupCreated") : "" })}${cleanupWarning}`);
      await refreshStatus(false);
    } catch (error) {
      const errorMessage = String(error);
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
    window.localStorage.setItem(setupCompletedStorageKey(desktopSession.user.id), "true");
    setSetupCompleted(true);
    setMessage(tr("workspaceReady"));
  }

  async function handleInstallCodex(forceUpdate = false) {
    setInstallingCodex(true);
    setInstallProgress({ stage: "preparing", downloadedBytes: 0 });
    setMessage(tr(forceUpdate ? "updating" : "installing"));
    try {
      const result = await installCodex(forceUpdate);
      if (result.awaitingInstallation) {
        setAwaitingStoreInstallation(true);
        setMessage(result.message);
        return;
      }
      await refreshStatus();
      setMessage(tr(forceUpdate ? "updatedReady" : "installedReady"));
    } catch (error) {
      setMessage(tr("installationFailed", { error: String(error) }));
    } finally {
      setInstallingCodex(false);
      setInstallProgress(null);
    }
  }

  async function handleInstallDesktopUpdate() {
    if (!desktopUpdate) return;
    setDesktopUpdatePhase("downloading");
    setDesktopUpdateProgress(0);
    let contentLength = 0;
    let downloadedBytes = 0;
    try {
      await desktopUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          setDesktopUpdateProgress(contentLength > 0 ? 0 : null);
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setDesktopUpdateProgress(contentLength > 0 ? Math.min(100, Math.round(downloadedBytes / contentLength * 100)) : null);
        } else if (event.event === "Finished") {
          setDesktopUpdateProgress(100);
        }
      });
      await relaunch();
    } catch (error) {
      setDesktopUpdatePhase("ready");
      setDesktopUpdateProgress(null);
      setMessage(tr("desktopUpdateFailed", { error: String(error) }));
    }
  }

  async function checkStoreInstallation() {
    try {
      const nextAppStatus = await getCodexAppStatus();
      setAppStatus(nextAppStatus);
      if (nextAppStatus.installed) {
        setAwaitingStoreInstallation(false);
        setMessage(tr("installedReady"));
      } else {
        setMessage(tr("storeInstallationInProgress"));
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

  async function handleOpenConsole(section?: "billing") {
    if (!desktopAccessToken) {
      setMessage(tr("signInRequired"));
      return;
    }
    try {
      await openConsole(desktopAccessToken, section);
    } catch (error) {
      setMessage(tr("consoleFailed", { error: String(error) }));
    }
  }

  async function handleOpenCodex() {
    setHomeActionError("");
    try {
      await openCodex();
    } catch (error) {
      setHomeActionError(tr("openCodexFailed", { error: String(error) }));
    }
  }

  function openSetupFromHome() {
    setSetupCompleted(false);
    setSelectedStep(2);
  }

  function renderHomeContent() {
    const version = appStatus?.localVersion || tr("versionUnavailable");
    const ready = accountConnected && appInstalled && configured;
    return <main className="homeShell">
      <aside className="homeRail">
        <div className="homeBrand"><img className="homeBrandLogo" src="/site-icon.png" alt="" /><strong>AUTO Gateway</strong></div>
        <nav className="homeNav" aria-label={tr("homeNavigation")}>
          <button className="selected"><HouseIcon weight="bold" />{tr("home")}</button>
          <button onClick={openSetupFromHome}><CubeIcon />{tr("codexSetup")}</button>
          <button onClick={() => void handleOpenConsole()}><UserCircleIcon />{tr("userConsole")}</button>
        </nav>
        <button className="homeHelp" onClick={() => void openUrl("https://autogateway.cc/docs#codex")}>{tr("needHelp")}</button>
      </aside>
      <section className="homeWorkspace">
        <header className="topBar homeTopBar"><span className="topStatus" aria-live="polite">{message}</span><button className="userIdentity userIdentityButton" aria-label={`${tr("signedInAs")}: ${accountDetail || accountName}`} onClick={() => void handleOpenConsole()}><span className="userAvatar" aria-hidden="true"><UserCircleIcon weight="fill" /></span><span className="userIdentityText"><strong>{accountName}</strong><small>{accountDetail}</small></span></button><div className="headerBalance" aria-label={tr("accountBalance")}><div className="headerBalanceInfo"><span>{tr("accountBalance")}</span><strong>{accountBalance || tr("balanceUnavailable")}</strong><small>{tr("lastSyncedAt", { time: formatSyncTime(balanceSyncedAt, locale, tr("notSynced")) })}</small></div><button className="headerTopUpButton" onClick={() => void handleOpenConsole("billing")}><CurrencyDollarIcon weight="bold" />{tr("topUpBalance")}</button></div><button className="headerActionButton" aria-label={tr("language")} onClick={toggleLocale}>{locale === "zh" ? "EN" : "中文"}</button><button className="headerActionButton" aria-label={tr("theme")} onClick={cycleTheme}>{theme === "system" ? tr("system") : theme === "light" ? tr("light") : tr("dark")}</button></header>
        <section className="homeContent">
          <p className="sectionKicker">{tr("workspace")}</p><h1>{tr("homeTitle")}</h1><p className="lead homeLead">{tr("homeLead")}</p>
          {desktopUpdate ? <section className="notice warning desktopUpdateNotice"><strong>{tr("desktopUpdateAvailable")}</strong><span>{tr("desktopUpdateDescription", { version: desktopUpdate.version })}</span><button className="secondaryButton" disabled={desktopUpdatePhase === "downloading"} onClick={() => void handleInstallDesktopUpdate()}>{desktopUpdatePhase === "downloading" ? tr("desktopUpdating", { percent: desktopUpdateProgress ?? "…" }) : tr("desktopUpdateNow")}</button></section> : null}
          {homeActionError ? <p className="homeActionMessage" role="alert">{homeActionError}</p> : null}
          <section className="homeStatusPanel">
            <div className="homeHealth" aria-label={ready ? tr("active") : tr("checking")}><span className={`healthBadge ${ready ? "ready" : ""}`}><CheckCircleIcon weight="fill" /></span><div><span className="statusLabel">{ready ? tr("active") : tr("checking")}</span><strong>{ready ? tr("workspaceReadyTitle") : tr("workspaceCheckingTitle")}</strong><small>{ready ? tr("workspaceReadyDescription") : tr("workspaceCheckingDescription")}</small></div></div>
            <div className="homeMetric"><span>{tr("accountBalance")}</span><strong>{accountBalance || tr("balanceUnavailable")}</strong><small>{tr("lastSyncedAt", { time: formatSyncTime(balanceSyncedAt, locale, tr("notSynced")) })}</small><button onClick={() => void handleOpenConsole("billing")}>{tr("topUpBalance")}</button></div>
            <div className="homeMetric"><span>{tr("localVersion")}</span><strong>{version}</strong><small>{updateAvailable ? tr("updateAvailable") : tr("upToDate")}</small></div>
            <button className="primaryButton homeOpenButton" disabled={!appInstalled} onClick={() => void handleOpenCodex()}>{tr("openCodex")}</button>
          </section>
          <section className="homeSection"><h2>{tr("quickActions")}</h2><div className="quickActions">
            <button onClick={() => void handleOpenConsole()}><UserCircleIcon /><span><strong>{tr("openConsole")}</strong><small>{tr("openConsoleDescription")}</small></span><ArrowRightIcon /></button>
            <button onClick={() => void refreshStatus(false)}><ArrowsClockwiseIcon /><span><strong>{tr("checkUpdates")}</strong><small>{tr("checkUpdatesDescription")}</small></span><ArrowRightIcon /></button>
            <button onClick={openSetupFromHome}><GearIcon /><span><strong>{tr("reconfigureCodex")}</strong><small>{tr("reconfigureCodexDescription")}</small></span><ArrowRightIcon /></button>
          </div></section>
          <section className="homeSection"><h2>{tr("recentSetup")}</h2><div className="recentSetup">
            <div><CheckIcon weight="bold" /><strong>{tr("connectedAccount")}</strong><span>{accountDetail}</span></div>
            <div><CheckIcon weight="bold" /><strong>{tr("codexConfigured")}</strong><span>{configured ? tr("configured") : tr("notConfigured")}</span></div>
            <div><CheckIcon weight="bold" /><strong>{tr("versionUpToDate")}</strong><span>{updateAvailable ? tr("updateAvailable") : tr("upToDate")}</span></div>
          </div></section>
        </section>
      </section>
    </main>;
  }

  function selectStep(step: WizardStep) {
    const maximumReachableStep: WizardStep = !accountConnected ? 1 : !appInstalled ? 2 : !gatewayConfigured ? 3 : 4;
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
      return <section className="setupContent heroContent">
        <div className="heroCopy">
          <p className="sectionKicker heroKicker">{tr("secureSignIn")}</p>
          <h1>{tr("connectTitle")}</h1>
          <p className="lead">{tr("connectLead")}</p>
          <button className="primaryButton" disabled={busy || restoringSession} onClick={() => accountConnected ? selectStep(2) : void handleStartSignIn()}>{restoringSession ? tr("restoringSession") : accountConnected ? tr("continueToCodex") : busy ? tr("openingBrowser") : tr("continueInBrowser")}</button>
          <p className="inlineStatus"><span className="statusDot" />{accountConnected ? tr("accountConnected") : tr("noAccount")}</p>
        </div>
      </section>;
    }
    if (selectedStep === 2) {
      return <section className="setupContent taskContent">
        <p className="sectionKicker">{tr("officialDesktopApp")}</p>
        <h1>{tr("installTitle")}</h1>
        <p className="lead">{tr("installLead")}</p>
        <div className={appInstalled && !updateAvailable ? "notice success installNotice" : "notice warning installNotice"}>
          <strong>{updateAvailable ? tr("updateAvailable") : appInstalled ? appStatus?.updateAvailable === false ? tr("upToDate") : tr("installed") : tr("notInstalled")}</strong>
          <span>{updateAvailable ? tr("updateAvailableDescription") : appInstalled ? appStatus?.updateCheckError ? tr("updateCheckUnavailable") : tr("installedDescription") : appStatus ? tr("notInstalledDescription") : tr("checkingInstallation")}</span>
          {appInstalled ? <div className="versionGrid" aria-label={tr("installed")}>
            <div className="versionItem"><span>{tr("localVersion")}</span><strong>{appStatus?.localVersion || tr("versionUnavailable")}</strong></div>
            <div className="versionItem"><span>{tr("latestVersion")}</span><strong>{appStatus?.latestVersion || tr("versionUnavailable")}</strong></div>
            {updateAvailable ? <button className="secondaryButton updateButton versionUpdateButton" disabled={installingCodex} onClick={() => void handleInstallCodex(true)}>{installingCodex ? installPercent === undefined ? tr("updatingCodex") : `${tr("updatingCodex")} ${installPercent}%` : tr("updateNow")}</button> : null}
          </div> : null}
          {installingCodex ? <div className="installProgress" aria-live="polite"><progress max="100" value={installPercent} /><small>{installPercent === undefined ? tr("working") : tr("downloadPercent", { percent: installPercent })}</small></div> : null}
          {awaitingStoreInstallation ? <div className="installProgress" aria-live="polite"><small>{tr("storeInstallationInProgress")}</small></div> : null}
        </div>
        <div className="buttonRow"><button className="secondaryButton" onClick={() => selectStep(1)}>{tr("previous")}</button>{appInstalled ? <button className="primaryButton" disabled={installingCodex} onClick={() => selectStep(3)}>{tr("next")}</button> : awaitingStoreInstallation ? <button className="primaryButton" onClick={() => void checkStoreInstallation()}>{tr("checkInstallation")}</button> : <button className="primaryButton" disabled={installingCodex} onClick={() => void handleInstallCodex()}>{installingCodex ? installPercent === undefined ? tr("installingCodex") : `${tr("installingCodex")} ${installPercent}%` : tr("installAutomatically")}</button>}</div>
      </section>;
    }
    if (selectedStep === 3) {
      const configurationRunning = configurationPhase === "creatingKey" || configurationPhase === "configuring";
      const noticeTitle = configurationPhase === "creatingKey" ? tr("creatingAPIKey") : configurationPhase === "configuring" ? tr("automaticConfiguring") : configurationPhase === "complete" ? tr("automaticConfigurationComplete") : configurationPhase === "error" ? tr("automaticConfigurationFailed") : tr("preparingConfiguration");
      const noticeDescription = configurationPhase === "creatingKey" ? tr("creatingAPIKeyDescription") : configurationPhase === "configuring" ? tr("automaticConfiguringDescription") : configurationPhase === "complete" ? tr("automaticConfigurationCompleteDescription") : configurationPhase === "error" ? tr("automaticConfigurationFailedDescription", { error: configurationError }) : tr("preparingConfigurationDescription");
      return <section className="setupContent taskContent configurationContent">
        <p className="sectionKicker">{tr("safeConfiguration")}</p>
        <h1>{tr("configureTitle")}</h1>
        <p className="lead">{tr("configureLead")}</p>
        <div className={`notice configurationNotice ${configurationPhase === "error" ? "warning" : "success"}`}>
          <strong>{noticeTitle}</strong>
          <span>{noticeDescription}</span>
          {apiKey ? <div className="apiKeyReveal"><label>{tr("generatedAPIKey")}</label><div><code>{apiKey}</code><button type="button" onClick={() => void handleCopyAPIKey()} aria-label={tr("copyAPIKey")}>{apiKeyCopied ? <CheckIcon aria-hidden="true" weight="bold" /> : <CopyIcon aria-hidden="true" weight="bold" />}<span>{apiKeyCopied ? tr("copiedAPIKey") : tr("copyAPIKey")}</span></button></div></div> : null}
        </div>
        <div className="buttonRow"><button className="secondaryButton" disabled={configurationRunning} onClick={() => selectStep(2)}>{tr("previous")}</button>{configurationPhase === "complete" ? <button className="primaryButton" onClick={handleConfigurationNext}>{tr("next")}</button> : configurationPhase === "error" ? <button className="primaryButton" onClick={() => void runAutomaticConfiguration()}>{tr("retryConfiguration")}</button> : <button className="primaryButton configurationLoadingButton" disabled><CircleNotchIcon aria-hidden="true" weight="bold" />{tr("configuring")}</button>}</div>
      </section>;
    }
    return <section className="setupContent taskContent completionContent">
      <p className="sectionKicker">{tr("setupComplete")}</p>
      <h1>{tr("completeTitle")}</h1>
      <p className="lead">{tr("completeLead")}</p>
      <div className="notice success"><strong>{configured ? tr("configured") : tr("readyToVerify")}</strong><span>{message}</span></div>
        <div className="buttonRow"><button className="secondaryButton" onClick={() => selectStep(3)}>{tr("previous")}</button><button className="primaryButton" disabled={!appInstalled || !configured} onClick={enterWorkspace}>{tr("enterWorkspace")}</button><button className="secondaryButton" disabled={!desktopAccessToken} onClick={() => void handleOpenConsole()}>{tr("openConsole")}</button></div>
    </section>;
  }

  if (showHome) return renderHomeContent();

  return <main className="appShell">
    <aside className="wizardRail">
      <nav className="stepNav" aria-label={tr("setupSteps")}>
        <button className={stepClass(1, accountConnected)} onClick={() => selectStep(1)}><span>{accountConnected ? <CheckIcon aria-hidden="true" weight="bold" /> : "1"}</span><b>{tr("stepConnect")}</b></button>
        <button className={stepClass(2, codexDetected)} disabled={selectedStep < 2} onClick={() => selectStep(2)}><span>{codexDetected ? <CheckIcon aria-hidden="true" weight="bold" /> : "2"}</span><b>{tr("stepInstall")}</b></button>
        <button className={stepClass(3, gatewayConfigured)} disabled={selectedStep < 3} onClick={() => selectStep(3)}><span>{gatewayConfigured ? <CheckIcon aria-hidden="true" weight="bold" /> : "3"}</span><b>{tr("stepConfigure")}</b></button>
        <button className={stepClass(4, gatewayConfigured)} disabled={selectedStep < 4} onClick={() => selectStep(4)}><span>{gatewayConfigured ? <CheckIcon aria-hidden="true" weight="bold" /> : "4"}</span><b>{tr("stepFinish")}</b></button>
      </nav>
    </aside>
    <section className="workspace">
      <header className="topBar"><span className="topStatus" aria-live="polite">{busy || installingCodex || restoringSession ? tr("working") : message}</span>{desktopSession ? <button className="userIdentity userIdentityButton" aria-label={`${tr("signedInAs")}: ${accountDetail || accountName}`} onClick={() => void handleOpenConsole()}><span className="userAvatar" aria-hidden="true"><UserCircleIcon weight="fill" /></span><span className="userIdentityText"><strong>{accountName}</strong><small>{accountDetail}</small></span></button> : null}<button className="headerActionButton" aria-label={tr("language")} onClick={toggleLocale}>{locale === "zh" ? "EN" : "中文"}</button><button className="headerActionButton" aria-label={tr("theme")} onClick={cycleTheme}>{theme === "system" ? tr("system") : theme === "light" ? tr("light") : tr("dark")}</button><button className="helpButton" onClick={() => void openUrl("https://autogateway.cc/docs#codex")}>{tr("needHelp")}</button></header>
      {showSettings ? <section className="settingsContent"><p className="sectionKicker">{tr("settings")}</p><h1>{tr("connectionRecovery")}</h1><p className="lead">{tr("connectionRecoveryLead")}</p><div className="preferencesPanel"><strong>{tr("appearance")}</strong><label className="fieldLabel">{tr("theme")}<select value={theme} onChange={(event) => changeTheme(event.target.value as ThemeMode)}><option value="system">{tr("system")}</option><option value="light">{tr("light")}</option><option value="dark">{tr("dark")}</option></select></label><label className="fieldLabel">{tr("language")}<select value={localePreference} onChange={(event) => changeLocale(event.target.value as LocalePreference)}><option value="system">{tr("automatic")}</option><option value="zh">{tr("chinese")}</option><option value="en">{tr("english")}</option></select></label></div><label className="fieldLabel">{tr("endpoint")}<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} autoComplete="url" /></label><div className="settingsDivider" /><div className="recoveryRow"><div><strong>{tr("backups")}</strong><span>{tr("backupsAvailable", { count: backupCount, suffix: backupCount === 1 ? "" : "s" })}</span></div><button className="secondaryButton" disabled={busy || backupCount === 0} onClick={() => void handleRestoreBackups()}>{tr("restoreLatest")}</button></div><button className="secondaryButton backButton" onClick={() => setShowSettings(false)}>{tr("backToSetup")}</button></section> : renderSetupContent()}
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
