// 系统托盘弹窗：通过 createRoot 单独渲染（tray-popup 窗口）。
// 从 main.tsx 提取的自包含组件。
import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { exit } from "@tauri-apps/plugin-process";
import {
  clearDesktopSession,
  getDesktopAccountSummary,
  isAuthenticationRequired,
  refreshDesktopState,
  restoreDesktopState,
  signOutDesktop,
  showMainWindow,
  updateTrayStatus,
  type DesktopAccountSummary,
  type DesktopSession,
} from "../shared/desktop";
import { resolveLocale, translate, readLocalePreference } from "../shared/i18n";
import { applyTheme, readTheme } from "../shared/theme";
import { formatBalance } from "../shared/format";
import { useCopyOnlyContextMenu } from "../shared/useCopyOnlyContextMenu";

export function TrayPopup() {
  useCopyOnlyContextMenu();
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
    if (!(await confirm(tr("signOutConfirm")))) return;
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
            <strong>{formatBalance(accountBalance, locale) || "—"}</strong>
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
