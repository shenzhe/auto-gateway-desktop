// 通知相关的本地存储工具：已读状态、通知窗口 payload、详情窗口 ID 解析。
// 从 main.tsx 提取的纯函数。
import type { DesktopNotification } from "./desktop";

const notificationReadStoragePrefix =
  "autogateway.desktop.notification-reads.v1";
const notificationWindowStorageKey =
  "autogateway.desktop.notification-window.v1";
const notificationDetailQueryKey = "notificationId";

export function notificationReadStorageKey(userID: number): string {
  return `${notificationReadStoragePrefix}:${userID}`;
}

export function loadNotificationReads(userID: number): Set<number> {
  try {
    const raw = window.localStorage.getItem(notificationReadStorageKey(userID));
    const parsed = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    );
  } catch {
    return new Set();
  }
}

export function saveNotificationReads(userID: number, reads: Set<number>): void {
  const compactReads = Array.from(reads).slice(-500);
  window.localStorage.setItem(
    notificationReadStorageKey(userID),
    JSON.stringify(compactReads),
  );
}

export type NotificationWindowPayload = {
  userID: number;
  activeID: number;
  items: DesktopNotification[];
};

export function saveNotificationWindowPayload(
  payload: NotificationWindowPayload,
): void {
  window.localStorage.setItem(
    notificationWindowStorageKey,
    JSON.stringify(payload),
  );
}

export function loadNotificationWindowPayload(): NotificationWindowPayload | null {
  try {
    const raw = window.localStorage.getItem(notificationWindowStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NotificationWindowPayload;
    if (
      !parsed ||
      !Number.isFinite(parsed.userID) ||
      !Number.isFinite(parsed.activeID) ||
      !Array.isArray(parsed.items)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function readNotificationDetailID(): number | null {
  const rawID = new URLSearchParams(window.location.search).get(
    notificationDetailQueryKey,
  );
  if (!rawID) return null;
  const notificationID = Number(rawID);
  return Number.isFinite(notificationID) && notificationID > 0
    ? notificationID
    : null;
}
