// 余额预警通知：低余额/负余额时的桌面通知逻辑（含去重缓存）。
// 从 main.tsx 提取。
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { translate } from "./i18n";
import {
  formatBalanceAlertAmount,
  parseBalanceAmount,
} from "./format";
import type { DesktopNotification } from "./desktop";

export type BalanceAlertKind = "low" | "negative";

export type BalanceAlertState = {
  lowNotified: boolean;
  negativeNotified: boolean;
};

const balanceAlertStoragePrefix = "autogateway.desktop.balance-alerts.v1";
const lowBalanceThreshold = 0.5;
const negativeBalanceThreshold = 0;

const balanceAlertStateCache = new Map<number, BalanceAlertState>();
const balanceAlertInFlight = new Map<string, Promise<void>>();
let balanceNotificationPermission: Promise<boolean> | null = null;

function balanceAlertStorageKey(userID: number): string {
  return `${balanceAlertStoragePrefix}:${userID}`;
}

function loadBalanceAlertState(userID: number): BalanceAlertState {
  const cached = balanceAlertStateCache.get(userID);
  if (cached) return cached;
  try {
    const raw = window.localStorage.getItem(balanceAlertStorageKey(userID));
    const parsed = JSON.parse(raw ?? "null") as Partial<BalanceAlertState>;
    const state = {
      lowNotified: parsed?.lowNotified === true,
      negativeNotified: parsed?.negativeNotified === true,
    };
    balanceAlertStateCache.set(userID, state);
    return state;
  } catch {
    const state = { lowNotified: false, negativeNotified: false };
    balanceAlertStateCache.set(userID, state);
    return state;
  }
}

function saveBalanceAlertState(userID: number, state: BalanceAlertState): void {
  balanceAlertStateCache.set(userID, state);
  try {
    window.localStorage.setItem(
      balanceAlertStorageKey(userID),
      JSON.stringify(state),
    );
  } catch {
    // The in-memory cache still prevents duplicate alerts during this run.
  }
}

async function hasBalanceNotificationPermission(): Promise<boolean> {
  if (!balanceNotificationPermission) {
    balanceNotificationPermission = isPermissionGranted()
      .then(async (granted) => {
        if (granted) return true;
        return (await requestPermission()) === "granted";
      })
      .catch(() => false);
  }
  return balanceNotificationPermission;
}

async function sendBalanceAlert(
  userID: number,
  kind: BalanceAlertKind,
  balance: string,
  locale: "en" | "zh",
): Promise<void> {
  const key = `${userID}:${kind}`;
  const existing = balanceAlertInFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const state = loadBalanceAlertState(userID);
    const alreadyNotified =
      kind === "low" ? state.lowNotified : state.negativeNotified;
    if (alreadyNotified || !(await hasBalanceNotificationPermission())) return;

    try {
      sendNotification({
        title: translate(
          locale,
          kind === "low"
            ? "balanceLowAlertTitle"
            : "balanceNegativeAlertTitle",
        ),
        body: translate(
          locale,
          kind === "low" ? "balanceLowAlertBody" : "balanceNegativeAlertBody",
          { balance: formatBalanceAlertAmount(balance, locale) },
        ),
      });
    } catch {
      return;
    }

    saveBalanceAlertState(userID, {
      ...state,
      ...(kind === "low" ? { lowNotified: true } : { negativeNotified: true }),
    });
  })().finally(() => {
    balanceAlertInFlight.delete(key);
  });
  balanceAlertInFlight.set(key, promise);
  return promise;
}

export async function notifyBalanceAlerts(
  userID: number | undefined,
  balance: string,
  locale: "en" | "zh",
): Promise<void> {
  if (!userID) return;
  const amount = parseBalanceAmount(balance);
  if (amount === null) return;

  if (amount < lowBalanceThreshold) {
    await sendBalanceAlert(userID, "low", balance, locale);
  }
  if (amount < negativeBalanceThreshold) {
    await sendBalanceAlert(userID, "negative", balance, locale);
  }
}

// DesktopNotification 类型在此模块中被 NotificationWindowPayload 间接引用，
// 实际使用见 notifications.ts；此处 re-export 以保持类型可见性。
export type { DesktopNotification };
