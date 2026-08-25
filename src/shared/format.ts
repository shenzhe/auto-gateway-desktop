// 显示格式化的纯函数：从 main.tsx 提取，便于单元测试，也为后续组件拆分
// 提供独立模块。无副作用、不依赖 React 或 Tauri 运行时。
// 注意：formatBuildTime 依赖构建期注入的 __BUILD_TIME__，仍留在 main.tsx。

type Locale = "en" | "zh";

function localeTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}

/** 解析形如 "$1,234.56" / "¥100" 的金额字符串为数字；无法解析返回 null。 */
export function parseBalanceAmount(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized) return null;
  const currencyPrefix = normalized.match(/^[^\d+-]*/)?.[0] ?? "";
  const amount = Number(normalized.slice(currencyPrefix.length));
  return Number.isFinite(amount) ? amount : null;
}

/** 把金额字符串格式化为带货币符号的本地化展示（用于余额提醒）。 */
export function formatBalanceAlertAmount(value: string, locale: Locale): string {
  const amount = parseBalanceAmount(value);
  if (amount === null) return value.trim();
  return amount.toLocaleString(localeTag(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 余额展示：保留原有货币前缀，数字部分本地化并固定两位小数。 */
export function formatBalance(value: string, locale: Locale): string {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized) return "";
  const currencyPrefix = normalized.match(/^[^\d+-]*/)?.[0] ?? "";
  const amount = Number(normalized.slice(currencyPrefix.length));
  if (!Number.isFinite(amount)) return value;
  const formatted = amount.toLocaleString(localeTag(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currencyPrefix}${formatted}`;
}

/** 订阅用量百分比，钳制到 [0,100]；无效输入返回 0。 */
export function subscriptionUsagePercent(
  usedMicros: number,
  limitMicros: number,
): number {
  if (
    !Number.isFinite(usedMicros) ||
    !Number.isFinite(limitMicros) ||
    limitMicros <= 0
  ) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((usedMicros / limitMicros) * 100)));
}

/** 通知日期的短格式展示（年/月/日）。 */
export function formatNotificationDate(
  value: string | undefined,
  locale: Locale,
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(localeTag(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 上次同步时间的完整展示（年月日时分）；value 为时间戳毫秒。 */
export function formatFullSyncTime(
  value: number | null,
  locale: Locale,
  fallback: string,
): string {
  if (!value) return fallback;
  return new Date(value).toLocaleString(localeTag(locale), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 订阅重置时间的展示。 */
export function formatSubscriptionResetAt(value: string, locale: Locale): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(localeTag(locale), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 字节数/秒的可读化展示（B/s → GB/s），<10 且非基础单位保留一位小数。 */
export function formatDownloadSpeed(bytesPerSecond?: number): string {
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

/** 字节数的可读化展示（B → GB）。 */
export function formatDataSize(bytes?: number): string {
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

/** 剩余时长的可读化展示（秒 → "Xm Ys"）。 */
export function formatRemainingDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return "";
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  return `${minutes}m ${rounded % 60}s`;
}
