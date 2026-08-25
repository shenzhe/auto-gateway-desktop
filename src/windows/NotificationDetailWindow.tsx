// 通知详情独立窗口：通过 createRoot 单独渲染（?notificationId= 参数触发）。
// 从 main.tsx 提取的自包含组件。
import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowLeftIcon, ArrowRightIcon, BellIcon } from "@phosphor-icons/react";
import { MarkdownContent } from "../components/MarkdownContent";
import { openNotificationBrowser } from "../shared/desktop";
import { resolveLocale, translate, readLocalePreference } from "../shared/i18n";
import { applyTheme, readTheme } from "../shared/theme";
import { formatNotificationDate } from "../shared/format";
import {
  loadNotificationReads,
  loadNotificationWindowPayload,
  readNotificationDetailID,
  saveNotificationReads,
  saveNotificationWindowPayload,
  type NotificationWindowPayload,
} from "../shared/notifications";
import { useCopyOnlyContextMenu } from "../shared/useCopyOnlyContextMenu";

export function NotificationDetailWindow() {
  useCopyOnlyContextMenu();
  const [payload] = useState<NotificationWindowPayload | null>(() =>
    loadNotificationWindowPayload(),
  );
  const [activeID, setActiveID] = useState<number | null>(() => {
    const queryID = readNotificationDetailID();
    return queryID ?? loadNotificationWindowPayload()?.activeID ?? null;
  });
  const theme = readTheme();
  const localePreference = readLocalePreference();
  const [linkError, setLinkError] = useState("");
  const locale = resolveLocale(localePreference);
  const tr = (
    key: Parameters<typeof translate>[1],
    values?: Record<string, string | number>,
  ) => translate(locale, key, values);
  const items = payload?.items ?? [];
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeID),
  );
  const activeItem = items[activeIndex] ?? null;

  useEffect(() => {
    document.documentElement.classList.add("notificationWindowHtml");
    document.body.classList.add("notificationWindowBody");
    return () => {
      document.documentElement.classList.remove("notificationWindowHtml");
      document.body.classList.remove("notificationWindowBody");
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!payload || !activeItem) return;
    const reads = loadNotificationReads(payload.userID);
    if (!reads.has(activeItem.id)) {
      reads.add(activeItem.id);
      saveNotificationReads(payload.userID, reads);
    }
  }, [activeItem?.id, payload?.userID]);

  function closeWindow(): void {
    void getCurrentWebviewWindow().close();
  }

  async function handleOpenLink(url: string): Promise<void> {
    setLinkError("");
    try {
      await openNotificationBrowser(url, navigator.userAgent);
    } catch (error) {
      setLinkError(tr("announcementBrowserFailed", { error: String(error) }));
    }
  }

  function navigateTo(index: number): void {
    const nextItem = items[index];
    if (!nextItem) return;
    setActiveID(nextItem.id);
    if (payload) {
      saveNotificationWindowPayload({
        ...payload,
        activeID: nextItem.id,
      });
    }
  }

  return (
    <main className="notificationWindowShell">
      {activeItem ? (
        <>
          <div className="notificationDetailViewport">
            <header className="notificationDetailHeader">
              <div className="notificationDetailMeta">
                <span>
                  {formatNotificationDate(
                    activeItem.createdAt ?? activeItem.startsAt,
                    locale,
                  )}
                </span>
              </div>
              <h1>{activeItem.title}</h1>
            </header>
            <article
              className="notificationDetailBody"
              key={activeItem.id}
            >
              <MarkdownContent value={activeItem.body} onOpenLink={handleOpenLink} />
              {activeItem.linkUrl ? (
                <button
                  className="notificationDetailLink"
                  type="button"
                  onClick={() => void handleOpenLink(activeItem.linkUrl ?? "")}
                >
                  {tr("announcementOpenLink")}
                  <ArrowRightIcon weight="bold" />
                </button>
              ) : null}
              {linkError ? (
                <p className="notificationDetailError" role="alert">
                  {linkError}
                </p>
              ) : null}
            </article>
          </div>
          <footer className="notificationDetailFooter">
            <button
              className="notificationPagerButton"
              type="button"
              disabled={activeIndex <= 0}
              onClick={() => navigateTo(activeIndex - 1)}
            >
              <ArrowLeftIcon weight="bold" />
              {tr("announcementPrevious")}
            </button>
            <button
              className="notificationPagerButton"
              type="button"
              disabled={activeIndex >= items.length - 1}
              onClick={() => navigateTo(activeIndex + 1)}
            >
              {tr("announcementNext")}
              <ArrowRightIcon weight="bold" />
            </button>
          </footer>
        </>
      ) : (
        <div className="notificationWindowEmpty">
          <BellIcon weight="bold" />
          <p>{tr("announcementWindowUnavailable")}</p>
          <button
            className="notificationPagerButton"
            type="button"
            onClick={closeWindow}
          >
            {tr("announcementClose")}
          </button>
        </div>
      )}
    </main>
  );
}
