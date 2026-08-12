import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUUpLeftIcon,
  ArrowsClockwiseIcon,
  BellIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChartLineUpIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CircleNotchIcon,
  CopyIcon,
  CubeIcon,
  CreditCardIcon,
  CurrencyDollarIcon,
  DesktopIcon,
  DownloadSimpleIcon,
  GearIcon,
  HouseIcon,
  ChatCircleTextIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  PlusIcon,
  PuzzlePieceIcon,
  QuestionIcon,
  SparkleIcon,
  SignOutIcon,
  XIcon,
  SunIcon,
  TranslateIcon,
  TrashIcon,
  UserCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
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
  installCodex,
  isCodexRunning,
  isAuthenticationRequired,
  openDesktopSignIn,
  openCodex,
  openConsole,
  openNotificationBrowser,
  openNotificationWindow,
  openDevtools,
  refreshDesktopState,
  restoreDesktopState,
  restoreLatestCodexBackups,
  scanSkills,
  getSkillDetail,
  setSkillCategory,
  setSkillTags,
  enableSkill,
  disableSkill,
  removeSkill,
  restoreSkill,
  listRecoverableSkills,
  validateSkillSource,
  installSkill,
  exportSkill,
  signOutDesktop,
  showMainWindow,
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
  type SkillRecord,
  type SkillScanResult,
  type SkillDetail,
  type SkillFileEntry,
  type RecoverableSkill,
  type SkillInstallPreview,
  type SkillInstallSourceKind,
  type SkillInstallProgress,
  type SkillInstallSummary,
  type SkillExportResult,
} from "./desktop";
import {
  readLocalePreference,
  resolveLocale,
  translate,
  writeLocalePreference,
  type LocalePreference,
} from "./i18n";
import { applyTheme, readTheme, writeTheme, type ThemeMode } from "./theme";
import { trackSkillEvent } from "./analytics";
import {
  skillCatalogPageSize,
  skillLibraryClient,
  type PublicSkill,
  type SkillAdvisorConversation,
  type SkillAdvisorMessage,
  type SkillCategoryDto,
  type SkillRecommendationResponse,
} from "./skillLibrary";
import "./styles.css";

const defaultEndpoint = import.meta.env.VITE_AUTO_GATEWAY_API_BASE_URL;
const consoleBaseUrl = import.meta.env.VITE_AUTO_GATEWAY_CONSOLE_BASE_URL;
const pendingAuthorizationStorageKey =
  "autogateway.desktop.pending-authorization";
const setupCompletedStoragePrefix = "autogateway.desktop.setup-completed";
const notificationReadStoragePrefix =
  "autogateway.desktop.notification-reads.v1";
const balanceAlertStoragePrefix = "autogateway.desktop.balance-alerts.v1";
const notificationWindowStorageKey =
  "autogateway.desktop.notification-window.v1";
const notificationDetailQueryKey = "notificationId";
const notificationPageSize = 5;
const lowBalanceThreshold = 0.5;
const negativeBalanceThreshold = 0;

type BalanceAlertKind = "low" | "negative";

type BalanceAlertState = {
  lowNotified: boolean;
  negativeNotified: boolean;
};

const balanceAlertStateCache = new Map<number, BalanceAlertState>();
const balanceAlertInFlight = new Map<string, Promise<void>>();
let balanceNotificationPermission: Promise<boolean> | null = null;
const skillSearchDebounceMs = 350;
const sidebarCollapsedStorageKey =
  "autogateway.desktop.sidebar-collapsed.v1";
const externalInstallationTimeoutMs = 5 * 60 * 1000;
const designPreviewState = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get("preview")
  : null;

function orderedSkillCategories(
  categories: SkillCategoryDto[],
): SkillCategoryDto[] {
  return categories
    .filter((category) => category.enabled)
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
}

function flattenedSkillCategories(
  categories: SkillCategoryDto[],
): Array<{ category: SkillCategoryDto; depth: number }> {
  const ordered = orderedSkillCategories(categories);
  const categoryIDs = new Set(ordered.map((category) => category.publicId));
  const visited = new Set<string>();
  const flattened: Array<{ category: SkillCategoryDto; depth: number }> = [];
  const visit = (parentPublicId: string, depth: number) => {
    for (const category of ordered) {
      const isRoot =
        !category.parentPublicId || !categoryIDs.has(category.parentPublicId);
      const matchesParent = parentPublicId
        ? category.parentPublicId === parentPublicId
        : isRoot;
      if (!matchesParent || visited.has(category.publicId)) continue;
      visited.add(category.publicId);
      flattened.push({ category, depth });
      visit(category.publicId, depth + 1);
    }
  };
  visit("", 0);
  for (const category of ordered) {
    if (visited.has(category.publicId)) continue;
    visited.add(category.publicId);
    flattened.push({ category, depth: 0 });
  }
  return flattened;
}

function skillCategoryPath(
  categories: SkillCategoryDto[],
  reference: string | null | undefined,
): SkillCategoryDto[] {
  if (!reference || reference === "all") return [];
  const ordered = orderedSkillCategories(categories);
  const byPublicId = new Map(
    ordered.map((category) => [category.publicId, category] as const),
  );
  let current = ordered.find(
    (category) =>
      category.slug === reference || category.publicId === reference,
  );
  const visited = new Set<string>();
  const path: SkillCategoryDto[] = [];
  while (current && !visited.has(current.publicId)) {
    visited.add(current.publicId);
    path.unshift(current);
    current = current.parentPublicId
      ? byPublicId.get(current.parentPublicId)
      : undefined;
  }
  return path;
}

function skillCategoryMatches(
  categories: SkillCategoryDto[],
  categoryReference: string | null | undefined,
  selectedReference: string,
): boolean {
  if (selectedReference === "all") return true;
  return skillCategoryPath(categories, categoryReference).some(
    (category) =>
      category.slug === selectedReference ||
      category.publicId === selectedReference,
  );
}

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

function notificationReadStorageKey(userID: number): string {
  return `${notificationReadStoragePrefix}:${userID}`;
}

function loadNotificationReads(userID: number): Set<number> {
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

function saveNotificationReads(userID: number, reads: Set<number>): void {
  const compactReads = Array.from(reads).slice(-500);
  window.localStorage.setItem(
    notificationReadStorageKey(userID),
    JSON.stringify(compactReads),
  );
}

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

function parseBalanceAmount(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized) return null;
  const currencyPrefix = normalized.match(/^[^\d+-]*/)?.[0] ?? "";
  const amount = Number(normalized.slice(currencyPrefix.length));
  return Number.isFinite(amount) ? amount : null;
}

function formatBalanceAlertAmount(value: string, locale: "en" | "zh"): string {
  const amount = parseBalanceAmount(value);
  if (amount === null) return value.trim();
  return amount.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

async function notifyBalanceAlerts(
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

type NotificationWindowPayload = {
  userID: number;
  activeID: number;
  items: DesktopNotification[];
};

function saveNotificationWindowPayload(
  payload: NotificationWindowPayload,
): void {
  window.localStorage.setItem(
    notificationWindowStorageKey,
    JSON.stringify(payload),
  );
}

function loadNotificationWindowPayload(): NotificationWindowPayload | null {
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

function readNotificationDetailID(): number | null {
  const rawID = new URLSearchParams(window.location.search).get(
    notificationDetailQueryKey,
  );
  if (!rawID) return null;
  const notificationID = Number(rawID);
  return Number.isFinite(notificationID) && notificationID > 0
    ? notificationID
    : null;
}

function renderMarkdownInline(
  value: string,
  onOpenLink: (url: string) => void,
): ReactNode[] {
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(.+?)\*|_(.+?)_|(https?:\/\/[^\s<]+))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const fullMatch = match[0];
    const linkLabel = match[2];
    const linkURL = match[3];
    const code = match[4];
    const strong = match[5] || match[6];
    const strike = match[7];
    const emphasis = match[8] || match[9];
    const plainURL = match[10];
    if (linkLabel && linkURL) {
      nodes.push(
        <button
          className="markdownLink"
          key={`link-${key++}`}
          type="button"
          onClick={() => onOpenLink(linkURL)}
        >
          {linkLabel}
        </button>,
      );
    } else if (code) {
      nodes.push(
        <code className="markdownInlineCode" key={`code-${key++}`}>
          {code}
        </code>,
      );
    } else if (strong) {
      nodes.push(<strong key={`strong-${key++}`}>{strong}</strong>);
    } else if (strike) {
      nodes.push(<del key={`strike-${key++}`}>{strike}</del>);
    } else if (emphasis) {
      nodes.push(<em key={`emphasis-${key++}`}>{emphasis}</em>);
    } else if (plainURL) {
      const trailing = plainURL.match(/[.,!?;:]+$/)?.[0] ?? "";
      const url = trailing ? plainURL.slice(0, -trailing.length) : plainURL;
      nodes.push(
        <button
          className="markdownLink"
          key={`url-${key++}`}
          type="button"
          onClick={() => onOpenLink(url)}
        >
          {url}
        </button>,
      );
      if (trailing) nodes.push(trailing);
    } else {
      nodes.push(fullMatch);
    }
    cursor = match.index + fullMatch.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function isMarkdownBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^```/.test(line) ||
    /^~~~/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^([-*_])(?:\s*\1){2,}$/.test(line)
  );
}

function renderMarkdownBlocks(
  markdown: string,
  onOpenLink: (url: string) => void,
): ReactNode[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)\s*.*$/);
    if (fence) {
      const fenceMarker = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !lines[index].trimStart().startsWith(fenceMarker)
      ) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <pre className="markdownCodeBlock" key={`code-block-${key++}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4;
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4";
      nodes.push(
        <Heading key={`heading-${key++}`}>
          {renderMarkdownInline(heading[2], onOpenLink)}
        </Heading>,
      );
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      nodes.push(
        <blockquote key={`quote-${key++}`}>
          {renderMarkdownBlocks(quoteLines.join("\n"), onOpenLink)}
        </blockquote>,
      );
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.test(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.test(line);
    if (unordered || ordered) {
      const items: string[] = [];
      const itemPattern = ordered
        ? /^\s*\d+[.)]\s+(.+)$/
        : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(itemPattern);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      nodes.push(
        <List key={`list-${key++}`}>
          {items.map((item, itemIndex) => (
            <li key={`list-item-${itemIndex}`}>
              {renderMarkdownInline(item, onOpenLink)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      nodes.push(<hr key={`rule-${key++}`} />);
      index += 1;
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isMarkdownBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    nodes.push(
      <p key={`paragraph-${key++}`}>
        {paragraphLines.map((paragraphLine, lineIndex) => (
          <span key={`paragraph-line-${lineIndex}`}>
            {lineIndex > 0 ? <br /> : null}
            {renderMarkdownInline(paragraphLine, onOpenLink)}
          </span>
        ))}
      </p>,
    );
  }
  return nodes;
}

function MarkdownContent({
  value,
  onOpenLink,
}: {
  value: string;
  onOpenLink: (url: string) => void;
}) {
  return (
    <div className="markdownContent">
      {renderMarkdownBlocks(value, onOpenLink)}
    </div>
  );
}

function formatNotificationDate(
  value: string | undefined,
  locale: "en" | "zh",
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function hasCompletedSetup(session: DesktopSession): boolean {
  return (
    window.localStorage.getItem(setupCompletedStorageKey(session.user.id)) ===
    "true"
  );
}

function formatFullSyncTime(
  value: Date | null,
  locale: "en" | "zh",
  fallback: string,
): string {
  if (!value) return fallback;
  return value.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function formatBalance(value: string, locale: "en" | "zh"): string {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized) return "";
  const currencyPrefix = normalized.match(/^[^\d+-]*/)?.[0] ?? "";
  const amount = Number(normalized.slice(currencyPrefix.length));
  if (!Number.isFinite(amount)) return value;
  const formatted = amount.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currencyPrefix}${formatted}`;
}

function subscriptionUsagePercent(usedMicros: number, limitMicros: number): number {
  if (
    !Number.isFinite(usedMicros) ||
    !Number.isFinite(limitMicros) ||
    limitMicros <= 0
  ) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((usedMicros / limitMicros) * 100)));
}

function formatSubscriptionResetAt(value: string, locale: "en" | "zh"): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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

const copyMenuID = "__autogateway_copy_menu";

async function copySelection(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back to the legacy WebView clipboard path below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;opacity:0;";
  (document.body || document.documentElement).appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function closeCopyMenu(): void {
  document.getElementById(copyMenuID)?.remove();
}

function useCopyOnlyContextMenu(): void {
  useEffect(() => {
    function handleContextMenu(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest(`#${copyMenuID}`)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeCopyMenu();
      const selectedText = window.getSelection()?.toString() ?? "";

      const menu = document.createElement("div");
      menu.id = copyMenuID;
      menu.setAttribute("role", "menu");
      menu.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "min-width:96px",
        "padding:5px",
        "border:1px solid rgba(110,90,70,.25)",
        "border-radius:8px",
        "color:#2a211c",
        "background:#fffaf4",
        "box-shadow:0 8px 24px rgba(42,33,28,.18)",
        'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        "visibility:hidden",
      ].join(";");

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.textContent = "Copy";
      copyButton.setAttribute("role", "menuitem");
      copyButton.style.cssText = [
        "display:block",
        "width:100%",
        "padding:7px 12px",
        "border:0",
        "border-radius:5px",
        "color:inherit",
        "background:transparent",
        "font:inherit",
        "text-align:left",
        "cursor:pointer",
      ].join(";");

      if (!selectedText.trim()) {
        copyButton.disabled = true;
        copyButton.style.opacity = ".45";
        copyButton.style.cursor = "default";
      } else {
        copyButton.addEventListener("click", async () => {
          await copySelection(selectedText);
          copyButton.textContent = "Copied";
          copyButton.disabled = true;
          copyButton.style.cursor = "default";
          window.setTimeout(closeCopyMenu, 500);
        });
        copyButton.addEventListener("mouseenter", () => {
          copyButton.style.background = "#f3e7da";
        });
        copyButton.addEventListener("mouseleave", () => {
          copyButton.style.background = "transparent";
        });
      }

      menu.appendChild(copyButton);
      (document.body || document.documentElement).appendChild(menu);
      const left = Math.min(
        event.clientX,
        window.innerWidth - menu.offsetWidth - 8,
      );
      const top = Math.min(
        event.clientY,
        window.innerHeight - menu.offsetHeight - 8,
      );
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.visibility = "visible";
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(`#${copyMenuID}`)
      ) {
        closeCopyMenu();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeCopyMenu();
    }

    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", closeCopyMenu, true);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", closeCopyMenu, true);
      closeCopyMenu();
    };
  }, []);
}

type HeaderMenu = "language" | "theme";

type HeaderControlsProps = {
  locale: "en" | "zh";
  localePreference: LocalePreference;
  theme: ThemeMode;
  onLocaleChange: (nextLocale: LocalePreference) => void;
  onThemeChange: (nextTheme: ThemeMode) => void;
};

function HeaderControls({
  locale,
  localePreference,
  theme,
  onLocaleChange,
  onThemeChange,
}: HeaderControlsProps) {
  const [openMenu, setOpenMenu] = useState<HeaderMenu | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const tr = (key: Parameters<typeof translate>[1]) =>
    translate(locale, key);
  const themeLabel =
    theme === "system"
      ? tr("system")
      : theme === "light"
        ? tr("light")
        : tr("dark");
  const ThemeIcon =
    theme === "system" ? DesktopIcon : theme === "light" ? SunIcon : MoonIcon;

  useEffect(() => {
    if (!openMenu) return;
    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !controlsRef.current?.contains(event.target)
      ) {
        setOpenMenu(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenu]);

  function selectLocale(nextLocale: LocalePreference) {
    onLocaleChange(nextLocale);
    setOpenMenu(null);
  }

  function selectTheme(nextTheme: ThemeMode) {
    onThemeChange(nextTheme);
    setOpenMenu(null);
  }

  return (
    <div className="headerControls" ref={controlsRef}>
      <div className="headerMenu">
        <button
          className="headerMenuButton languageMenuButton"
          type="button"
          aria-label={tr("language")}
          aria-expanded={openMenu === "language"}
          aria-haspopup="menu"
          title={tr("language")}
          onClick={() =>
            setOpenMenu(openMenu === "language" ? null : "language")
          }
        >
          <TranslateIcon weight="bold" aria-hidden="true" />
          <span>{locale === "zh" ? "简" : "EN"}</span>
          <CaretDownIcon className="headerMenuCaret" aria-hidden="true" />
        </button>
        {openMenu === "language" ? (
          <div className="headerMenuPopover" role="menu">
            {(
              [
                ["system", tr("automatic")],
                ["zh", tr("chinese")],
                ["en", tr("english")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={localePreference === value}
                onClick={() => selectLocale(value)}
              >
                <TranslateIcon weight={value === "system" ? "regular" : "bold"} />
                <span>{label}</span>
                {localePreference === value ? (
                  <CheckIcon className="headerMenuCheck" weight="bold" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="headerMenu">
        <button
          className="headerMenuButton themeMenuButton"
          type="button"
          aria-label={`${tr("theme")}: ${themeLabel}`}
          aria-expanded={openMenu === "theme"}
          aria-haspopup="menu"
          title={themeLabel}
          onClick={() => setOpenMenu(openMenu === "theme" ? null : "theme")}
        >
          <ThemeIcon weight="bold" aria-hidden="true" />
        </button>
        {openMenu === "theme" ? (
          <div className="headerMenuPopover" role="menu">
            {(
              [
                ["system", tr("system"), DesktopIcon],
                ["light", tr("light"), SunIcon],
                ["dark", tr("dark"), MoonIcon],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={theme === value}
                onClick={() => selectTheme(value)}
              >
                <Icon weight="bold" />
                <span>{label}</span>
                {theme === value ? (
                  <CheckIcon className="headerMenuCheck" weight="bold" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotificationDetailWindow() {
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

function TrayPopup() {
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

function ConfirmDialog({
  message,
  confirmLabel,
  cancelLabel,
  onResolve,
}: {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onResolve: (accepted: boolean) => void;
}) {
  return createPortal(
    <div
      className="confirmOverlay"
      role="dialog"
      aria-modal="true"
      aria-live="assertive"
    >
      <div className="confirmDialog">
        <p className="confirmMessage">{message}</p>
        <div className="confirmActions">
          <button
            type="button"
            className="secondaryButton"
            onClick={() => onResolve(false)}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="primaryButton"
            // Autofocus the destructive action's confirm button so keyboard
            // users can review the message first via shift-tab.
            autoFocus
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
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
  const storeAutoRetryAttempted = useRef(false);
  const [setupCompleted, setSetupCompleted] = useState(false);
  const [accountBalance, setAccountBalance] = useState("");
  const [balanceSyncedAt, setBalanceSyncedAt] = useState<Date | null>(null);
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
  const [codexOpenPhase, setCodexOpenPhase] =
    useState<CodexOpenPhase>("closed");
  const [selectedStep, setSelectedStep] = useState<WizardStep>(1);
  const [showSettings, setShowSettings] = useState(false);
  const [activeView, setActiveView] = useState<"home" | "skills">("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem(sidebarCollapsedStorageKey) === "true",
  );
  const [skillsTab, setSkillsTab] = useState<
    "builtin" | "uploaded" | "library"
  >("library");
  const [skillScan, setSkillScan] = useState<SkillScanResult | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const [skillsRefreshNonce, setSkillsRefreshNonce] = useState(0);
  const [skillSearch, setSkillSearch] = useState("");
  const [skillSort, setSkillSort] = useState<
    "name-asc" | "name-desc" | "updated-desc"
  >("name-asc");
  const [skillCategoryFilter, setSkillCategoryFilter] = useState("all");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState("");
  const [skillTagDraft, setSkillTagDraft] = useState("");
  const [skillCategoryError, setSkillCategoryError] = useState("");
  const [pendingReloadIds, setPendingReloadIds] = useState<Set<string>>(
    new Set(),
  );
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [recoverableSkills, setRecoverableSkills] = useState<
    RecoverableSkill[]
  >([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [installKind, setInstallKind] =
    useState<SkillInstallSourceKind>("dir");
  const [installLocation, setInstallLocation] = useState("");
  const [installCategory, setInstallCategory] = useState("");
  const [installPlan, setInstallPlan] = useState<SkillInstallPreview[] | null>(
    null,
  );
  const [selectedInstallNames, setSelectedInstallNames] = useState<Set<string>>(
    new Set(),
  );
  const [installReplace, setInstallReplace] = useState(false);
  const [installSummary, setInstallSummary] =
    useState<SkillInstallSummary | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState("");
  const [skillInstallProgress, setSkillInstallProgress] =
    useState<SkillInstallProgress | null>(null);
  const [exportResult, setExportResult] = useState<SkillExportResult | null>(
    null,
  );
  const [exportBusy, setExportBusy] = useState(false);
  // AG skill library state.
  const [libraryItems, setLibraryItems] = useState<PublicSkill[]>([]);
  const [libraryCategories, setLibraryCategories] = useState<
    SkillCategoryDto[]
  >([]);
  const [libraryCategoriesLoading, setLibraryCategoriesLoading] =
    useState(false);
  const [libraryCategoriesError, setLibraryCategoriesError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [libraryHasNextPage, setLibraryHasNextPage] = useState(false);
  const [libraryResultTotal, setLibraryResultTotal] = useState(0);
  const [libraryCatalogTotal, setLibraryCatalogTotal] = useState<number | null>(
    null,
  );
  const [librarySearch, setLibrarySearch] = useState("");
  const [debouncedLibrarySearch, setDebouncedLibrarySearch] = useState("");
  const [libraryCategory, setLibraryCategory] = useState("all");
  const [libraryInstallFilter, setLibraryInstallFilter] = useState<
    "installed" | "available"
  >("available");
  const [libraryPage, setLibraryPage] = useState(0);
  const [expandedLibraryCategories, setExpandedLibraryCategories] = useState<
    Set<string>
  >(new Set());
  const [librarySort, setLibrarySort] = useState<
    "popular" | "newest" | "updated"
  >("popular");
  const [selectedLibrarySkill, setSelectedLibrarySkill] =
    useState<PublicSkill | null>(null);
  const [libraryInstallNote, setLibraryInstallNote] = useState("");
  const [libraryInstallConflict, setLibraryInstallConflict] = useState(false);
  const [libraryInstallConflictId, setLibraryInstallConflictId] = useState<
    string | null
  >(null);
  const [libraryInstallingId, setLibraryInstallingId] = useState<string | null>(
    null,
  );
  const [libraryRefreshNonce, setLibraryRefreshNonce] = useState(0);
  const [showSkillAdvisor, setShowSkillAdvisor] = useState(false);
  const [skillAdvisorCatalog, setSkillAdvisorCatalog] = useState<PublicSkill[]>(
    [],
  );
  const [skillAdvisorMessages, setSkillAdvisorMessages] = useState<
    SkillAdvisorMessage[]
  >([]);
  const [skillAdvisorInput, setSkillAdvisorInput] = useState("");
  const [skillAdvisorLoading, setSkillAdvisorLoading] = useState(false);
  const [skillAdvisorCatalogLoading, setSkillAdvisorCatalogLoading] =
    useState(false);
  const [skillAdvisorError, setSkillAdvisorError] = useState("");
  const [skillAdvisorRecommendedIds, setSkillAdvisorRecommendedIds] = useState<
    string[]
  >([]);
  const [skillAdvisorRecommendedSkills, setSkillAdvisorRecommendedSkills] =
    useState<PublicSkill[]>([]);
  const [skillAdvisorUsedFallback, setSkillAdvisorUsedFallback] =
    useState(false);
  const [skillAdvisorThreadId, setSkillAdvisorThreadId] = useState<
    string | null
  >(null);
  const [skillAdvisorConversations, setSkillAdvisorConversations] = useState<
    SkillAdvisorConversation[]
  >([]);
  const [skillAdvisorConversationId, setSkillAdvisorConversationId] = useState<
    string | null
  >(null);
  const [skillAdvisorConversationTitle, setSkillAdvisorConversationTitle] =
    useState("");
  const [skillAdvisorConversationCreatedAt, setSkillAdvisorConversationCreatedAt] =
    useState(0);
  const [skillAdvisorHistoryOpen, setSkillAdvisorHistoryOpen] = useState(true);
  const [skillAdvisorHistoryLoading, setSkillAdvisorHistoryLoading] =
    useState(false);
  const [skillAdvisorHistoryError, setSkillAdvisorHistoryError] = useState("");
  const [skillAdvisorRenamingId, setSkillAdvisorRenamingId] = useState<
    string | null
  >(null);
  const [skillAdvisorRenameInput, setSkillAdvisorRenameInput] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => readTheme());
  const [localePreference, setLocalePreference] = useState<LocalePreference>(
    () => readLocalePreference(),
  );
  const configurationRun = useRef(false);
  const authorizationExchangeInProgress = useRef(false);
  const completedAuthorizationCode = useRef("");
  const skillAdvisorEndRef = useRef<HTMLDivElement>(null);
  const skillAdvisorInputRef = useRef<HTMLTextAreaElement>(null);
  const skillAdvisorConversationGenerationRef = useRef(0);
  const skillAdvisorHistoryInitializedRef = useRef(false);
  const libraryIndexRefreshRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  const locale = resolveLocale(localePreference);
  const tr = (
    key: Parameters<typeof translate>[1],
    values?: Record<string, string | number>,
  ) => translate(locale, key, values);

  useEffect(() => {
    if (activeView !== "skills") return;
    let active = true;
    const started = performance.now();
    setSkillsLoading(true);
    setSkillsError("");
    scanSkills()
      .then((result) => {
        if (!active) return;
        setSkillScan(result);
        trackSkillEvent("skill_scan_completed", {
          result: "ok",
          count: result.skills.length,
          failedCount: result.failedSources.length,
          durationMs: Math.round(performance.now() - started),
        });
      })
      .catch((error) => {
        if (!active) return;
        setSkillsError(String(error));
        trackSkillEvent("skill_scan_completed", { result: "error" });
      })
      .finally(() => {
        if (active) setSkillsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeView, skillsRefreshNonce]);

  useEffect(() => {
    if (!selectedSkillId) {
      setSkillDetail(null);
      setSkillDetailError("");
      return;
    }
    let active = true;
    setSkillDetailLoading(true);
    setSkillDetailError("");
    setSkillDetail(null);
    getSkillDetail(selectedSkillId)
      .then((detail) => {
        if (active) setSkillDetail(detail);
      })
      .catch((error) => {
        if (active) setSkillDetailError(String(error));
      })
      .finally(() => {
        if (active) setSkillDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSkillId, skillsRefreshNonce]);

  useEffect(() => {
    setSkillTagDraft(skillDetail ? skillDetail.tags.join(", ") : "");
    setExportResult(null);
  }, [skillDetail]);

  useEffect(() => {
    if (activeView !== "skills" || !showTrash) return;
    let active = true;
    setTrashLoading(true);
    listRecoverableSkills()
      .then((items) => {
        if (active) setRecoverableSkills(items);
      })
      .catch(() => {
        if (active) setRecoverableSkills([]);
      })
      .finally(() => {
        if (active) setTrashLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeView, showTrash, skillsRefreshNonce]);

  useEffect(() => {
    if (!showInstallDialog) return;
    const unlisten = listen<SkillInstallProgress>(
      "skill-install-progress",
      ({ payload }) => setSkillInstallProgress(payload),
    );
    return () => {
      void unlisten.then((off) => off());
    };
  }, [showInstallDialog]);

  useEffect(() => {
    if (activeView !== "skills") return;
    let active = true;
    setLibraryCategoriesLoading(true);
    setLibraryCategoriesError("");
    skillLibraryClient
      .listCategories(locale)
      .then((categories) => {
        if (!active) return;
        setLibraryCategories(categories);
        setExpandedLibraryCategories((current) => {
          if (current.size > 0) return current;
          return new Set(
            categories
              .filter((category) => !category.parentPublicId)
              .map((category) => category.publicId),
          );
        });
      })
      .catch((error) => {
        if (active) setLibraryCategoriesError(String(error));
      })
      .finally(() => {
        if (active) setLibraryCategoriesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeView, libraryRefreshNonce, locale]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedLibrarySearch(librarySearch.trim());
      setLibraryPage(0);
    }, skillSearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [librarySearch]);

  useEffect(() => {
    if (activeView !== "skills" || skillsTab !== "library") return;
    let active = true;
    setLibraryLoading(true);
    setLibraryError("");
    const refreshKey = `${locale}:${libraryRefreshNonce}`;
    if (libraryIndexRefreshRef.current?.key !== refreshKey) {
      libraryIndexRefreshRef.current = {
        key: refreshKey,
        promise: skillLibraryClient.refreshIndex(locale).then(() => undefined),
      };
    }
    libraryIndexRefreshRef.current.promise
      .then(() =>
        skillLibraryClient.listPublicSkills(
          {
            q: debouncedLibrarySearch || undefined,
            category:
              libraryCategory !== "all" ? libraryCategory : undefined,
            sort: librarySort,
            offset: libraryPage * skillCatalogPageSize,
          },
          locale,
        ),
      )
      .then((page) => {
        if (!active) return;
        if (libraryPage > 0 && page.items.length === 0) {
          setLibraryPage((current) => Math.max(0, current - 1));
          return;
        }
        const requestedOffset = libraryPage * skillCatalogPageSize;
        const hasNext =
          page.hasNext ??
          (page.items.length === skillCatalogPageSize &&
            page.nextCursor !== null);
        const total =
          page.total ??
          requestedOffset + page.items.length + (hasNext ? 1 : 0);
        setLibraryItems(page.items);
        setLibraryResultTotal(total);
        setLibraryHasNextPage(hasNext);
        if (
          typeof page.total === "number" &&
          !debouncedLibrarySearch &&
          libraryCategory === "all"
        ) {
          setLibraryCatalogTotal(page.total);
        }
      })
      .catch((error) => {
        if (active) setLibraryError(String(error));
      })
      .finally(() => {
        if (active) setLibraryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    activeView,
    skillsTab,
    debouncedLibrarySearch,
    libraryCategory,
    libraryInstallFilter,
    libraryPage,
    librarySort,
    libraryRefreshNonce,
    locale,
  ]);

  useEffect(() => {
    if (!showSkillAdvisor) return;
    skillAdvisorEndRef.current?.scrollIntoView({ block: "end" });
    if (!skillAdvisorCatalogLoading && !skillAdvisorLoading) {
      skillAdvisorInputRef.current?.focus();
    }
  }, [
    showSkillAdvisor,
    skillAdvisorMessages,
    skillAdvisorRecommendedIds,
    skillAdvisorCatalogLoading,
    skillAdvisorLoading,
  ]);

  useEffect(() => {
    setLibraryPage(0);
  }, [libraryCategory, libraryInstallFilter, librarySort]);

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
        if (payload.stage === "opening") setMessage(tr("openingCodex"));
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
        setBalanceSyncedAt(new Date());
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
      const signInUrl = await openDesktopSignIn(
        challenge,
        state,
        locale,
        navigator.userAgent,
      );
      setDesktopSignInUrl(signInUrl);
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
        setMessage(tr("downloadReadyForCodexUpdate"));

        if (await isCodexRunning()) {
          if (!(await confirm(tr("codexCloseConfirm")))) {
            setMessage(tr("codexUpdateCancelled"));
            return;
          }
          setInstallProgress({ stage: "closing", downloadedBytes: 0 });
          setMessage(tr("closingCodex"));
          await closeCodex();
        }

        setInstallProgress({ stage: "installing", downloadedBytes: 0 });
        setMessage(tr("replacingCodex"));
        await applyCodexUpdate(downloadedUpdate.version);
        await refreshStatus(false);
        const reopened = await waitForCodexOpen();
        setCodexOpenPhase(reopened ? "opened" : "closed");
        setMessage(
          tr(reopened ? "codexUpdatedAndReopened" : "codexUpdatedReopenFailed"),
        );
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

  function skillSourceLabel(source: SkillRecord["sourceType"]): string {
    switch (source) {
      case "user":
        return tr("skillSourceUser");
      case "system":
        return tr("skillSourceSystem");
      case "plugin":
        return tr("skillSourcePlugin");
      case "external":
        return tr("skillSourceExternal");
      case "autogateway":
        return tr("skillSourceAutogateway");
      case "team":
        return tr("skillSourceTeam");
      default:
        return source;
    }
  }

  function isSkillReadOnly(
    skill: Pick<SkillRecord, "ownership" | "sourceType">,
  ): boolean {
    return (
      skill.ownership !== "user-managed" ||
      skill.sourceType === "system" ||
      skill.sourceType === "plugin"
    );
  }

  function categoryForReference(
    reference?: string | null,
  ): SkillCategoryDto | undefined {
    if (!reference) return undefined;
    return libraryCategories.find(
      (category) =>
        category.slug === reference || category.publicId === reference,
    );
  }

  function normalizedCategorySlug(reference?: string | null): string | null {
    return categoryForReference(reference)?.slug ?? null;
  }

  async function runSkillMetadataMutation(action: () => Promise<unknown>) {
    try {
      await action();
      setSkillCategoryError("");
      setSkillsRefreshNonce((nonce) => nonce + 1);
      trackSkillEvent("skill_metadata_changed", { result: "ok" });
    } catch (error) {
      setSkillCategoryError(String(error));
    }
  }

  async function toggleSkill(id: string, enable: boolean) {
    try {
      await (enable ? enableSkill(id) : disableSkill(id));
      setSkillCategoryError("");
      setPendingReloadIds((previous) => new Set(previous).add(id));
      setSkillsRefreshNonce((nonce) => nonce + 1);
      trackSkillEvent("skill_status_changed", {
        result: enable ? "enabled" : "disabled",
      });
    } catch (error) {
      setSkillCategoryError(String(error));
    }
  }

  async function confirmRemoveSkill(id: string) {
    try {
      await removeSkill(id);
      let syncWarning = "";
      try {
        await skillLibraryClient.reportUninstalled(id, desktopAccessToken);
      } catch (error) {
        syncWarning = tr("skillInstallationSyncWarning", {
          error: String(error),
        });
      }
      setSkillCategoryError(syncWarning);
      if (syncWarning && skillsTab === "library") {
        setLibraryInstallNote(syncWarning);
      }
      setRemoveConfirmId(null);
      setSelectedSkillId(null);
      setSkillsRefreshNonce((nonce) => nonce + 1);
    } catch (error) {
      setSkillCategoryError(String(error));
    }
  }

  async function restoreSkillAction(id: string) {
    try {
      await restoreSkill(id);
      setSkillCategoryError("");
      setSkillsRefreshNonce((nonce) => nonce + 1);
      trackSkillEvent("skill_recovery_completed", { result: "ok" });
    } catch (error) {
      setSkillCategoryError(String(error));
    }
  }

  async function exportCurrentSkill(id: string) {
    setExportBusy(true);
    setSkillCategoryError("");
    setExportResult(null);
    try {
      setExportResult(await exportSkill(id));
      trackSkillEvent("skill_export_completed", { result: "ok" });
    } catch (error) {
      setSkillCategoryError(String(error));
    } finally {
      setExportBusy(false);
    }
  }

  async function installFromLibrary(skill: PublicSkill, replace = false) {
    const version = skill.latestPublishedVersion;
    if (!version) return;
    setLibraryInstallingId(skill.publicId);
    setLibraryInstallNote("");
    setLibraryInstallConflict(false);
    setLibraryInstallConflictId(null);
    try {
      const summary = await skillLibraryClient.installPublicSkill(
        skill.publicId,
        version.publicId,
        replace,
        skill.primaryCategory?.slug,
        desktopAccessToken,
      );
      const conflict = summary.skipped.some((item) => item.reason === "exists");
      setLibraryInstallConflict(conflict);
      setLibraryInstallConflictId(conflict ? skill.publicId : null);
      const resultNote = conflict
          ? tr("skillLibraryInstallConflict")
          : tr("skillLibraryInstallSuccess", {
              installed: summary.installed.length,
              failed: summary.failed.length,
            });
      setLibraryInstallNote(
        summary.syncWarning
          ? `${resultNote} ${tr("skillInstallationSyncWarning", {
              error: summary.syncWarning,
            })}`
          : resultNote,
      );
      if (summary.installed.length > 0) {
        setSkillsRefreshNonce((nonce) => nonce + 1);
        trackSkillEvent("skill_install_completed", {
          result: summary.failed.length > 0 ? "partial" : "ok",
          sourceType: "autogateway",
          installedCount: summary.installed.length,
          failedCount: summary.failed.length,
        });
      }
    } catch (error) {
      setLibraryInstallNote(String(error));
    } finally {
      setLibraryInstallingId(null);
    }
  }

  function installedSkillAdvisorNames() {
    return new Set(
      (skillScan?.skills ?? [])
        .filter(
          (skill) =>
            skill.sourceType === "autogateway" || skill.sourceType === "team",
        )
        .map((skill) => skill.name),
    );
  }

  function availableSkillAdvisorCatalog(catalog = skillAdvisorCatalog) {
    const installedNames = installedSkillAdvisorNames();
    return catalog.filter((skill) => !installedNames.has(skill.name));
  }

  function closeSkillAdvisor() {
    setShowSkillAdvisor(false);
  }

  function advisorConversationTitle(messages: SkillAdvisorMessage[]) {
    const firstUserMessage = messages.find((message) => message.role === "user");
    const title = firstUserMessage?.content.replace(/\s+/g, " ").trim() ?? "";
    return (
      Array.from(title).slice(0, 48).join("") ||
      tr("skillAdvisorNewConversation")
    );
  }

  function advisorConversationTimestamp() {
    return Math.floor(Date.now() / 1000);
  }

  function upsertSkillAdvisorConversation(
    conversation: SkillAdvisorConversation,
  ) {
    setSkillAdvisorConversations((current) =>
      [conversation, ...current.filter((item) => item.id !== conversation.id)]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 50),
    );
  }

  async function persistSkillAdvisorConversation(
    conversation: SkillAdvisorConversation,
  ) {
    try {
      const saved = await skillLibraryClient.saveAdvisorConversation(
        conversation,
      );
      upsertSkillAdvisorConversation(saved);
      setSkillAdvisorHistoryError("");
      return saved;
    } catch (error) {
      setSkillAdvisorHistoryError(
        tr("skillAdvisorHistorySaveFailed", { error: String(error) }),
      );
      return null;
    }
  }

  function restoreSkillAdvisorConversation(
    conversation: SkillAdvisorConversation,
  ) {
    skillAdvisorConversationGenerationRef.current += 1;
    setSkillAdvisorLoading(false);
    setSkillAdvisorConversationId(conversation.id);
    setSkillAdvisorConversationTitle(conversation.title);
    setSkillAdvisorConversationCreatedAt(conversation.createdAt);
    setSkillAdvisorThreadId(conversation.threadId);
    setSkillAdvisorMessages(
      conversation.messages.length > 0
        ? conversation.messages
        : [{ role: "assistant", content: tr("skillAdvisorWelcome") }],
    );
    setSkillAdvisorRecommendedIds(conversation.recommendedPublicIds);
    setSkillAdvisorRecommendedSkills(conversation.recommendedSkills);
    setSkillAdvisorCatalog((current) => {
      const merged = new Map(
        current.map((skill) => [skill.publicId, skill] as const),
      );
      conversation.recommendedSkills.forEach((skill) =>
        merged.set(skill.publicId, skill),
      );
      return Array.from(merged.values());
    });
    setSkillAdvisorUsedFallback(conversation.usedFallback);
    setSkillAdvisorInput("");
    setSkillAdvisorError("");
    setLibraryInstallNote("");
    setLibraryInstallConflict(false);
    setLibraryInstallConflictId(null);
  }

  function localizedSkillAdvisorReply(
    recommendation: SkillRecommendationResponse,
  ) {
    switch (recommendation.fallbackReplyKey) {
      case "need-task-details":
        return tr("skillAdvisorFallbackNeedTaskDetails");
      case "need-tools":
        return tr("skillAdvisorFallbackNeedTools");
      case "no-match":
        return tr("skillAdvisorFallbackNoMatch");
      case "matches-found":
        return tr("skillAdvisorFallbackMatchesFound");
      default:
        return recommendation.reply;
    }
  }

  function resetSkillAdvisorConversation() {
    skillAdvisorConversationGenerationRef.current += 1;
    setSkillAdvisorLoading(false);
    setSkillAdvisorConversationId(null);
    setSkillAdvisorConversationTitle(tr("skillAdvisorNewConversation"));
    setSkillAdvisorConversationCreatedAt(0);
    setSkillAdvisorThreadId(null);
    setSkillAdvisorMessages([
      { role: "assistant", content: tr("skillAdvisorWelcome") },
    ]);
    setSkillAdvisorInput("");
    setSkillAdvisorError("");
    setSkillAdvisorRecommendedIds([]);
    setSkillAdvisorRecommendedSkills([]);
    setSkillAdvisorUsedFallback(false);
    setLibraryInstallNote("");
    setLibraryInstallConflict(false);
    setLibraryInstallConflictId(null);
  }

  async function openSkillAdvisor() {
    setSelectedLibrarySkill(null);
    setShowSkillAdvisor(true);
    setSkillAdvisorCatalogLoading(true);
    setSkillAdvisorHistoryLoading(true);
    setSkillAdvisorHistoryError("");
    trackSkillEvent("skill_advisor_opened", { sourceType: "autogateway" });
    const shouldRestoreConversation =
      !skillAdvisorHistoryInitializedRef.current;
    skillAdvisorHistoryInitializedRef.current = true;
    const historyPromise = skillLibraryClient
      .listAdvisorConversations()
      .then((conversations) => {
        setSkillAdvisorConversations(conversations);
        if (shouldRestoreConversation) {
          if (conversations[0]) {
            restoreSkillAdvisorConversation(conversations[0]);
          } else {
            resetSkillAdvisorConversation();
          }
        }
      })
      .catch((error) => {
        setSkillAdvisorHistoryError(
          tr("skillAdvisorHistoryLoadFailed", { error: String(error) }),
        );
        if (shouldRestoreConversation) resetSkillAdvisorConversation();
      })
      .finally(() => setSkillAdvisorHistoryLoading(false));
    try {
      const page = await skillLibraryClient.listPublicSkills(
        { sort: "popular" },
        locale,
      );
      setSkillAdvisorCatalog(page.items);
      if (availableSkillAdvisorCatalog(page.items).length === 0) {
        setSkillAdvisorError(tr("skillAdvisorNoAvailableSkills"));
      }
    } catch (error) {
      if (libraryItems.length > 0) {
        setSkillAdvisorCatalog(libraryItems);
      } else {
        setSkillAdvisorError(
          tr("skillAdvisorCatalogUnavailable", { error: String(error) }),
        );
      }
    } finally {
      setSkillAdvisorCatalogLoading(false);
    }
    await historyPromise;
  }

  async function deleteSkillAdvisorConversation(
    conversation: SkillAdvisorConversation,
  ) {
    if (
      skillAdvisorLoading ||
      !window.confirm(
        tr("skillAdvisorHistoryDeleteConfirm", { title: conversation.title }),
      )
    ) {
      return;
    }
    try {
      const threadId = await skillLibraryClient.deleteAdvisorConversation(
        conversation.id,
      );
      setSkillAdvisorConversations((current) =>
        current.filter((item) => item.id !== conversation.id),
      );
      if (skillAdvisorConversationId === conversation.id) {
        resetSkillAdvisorConversation();
      }
      if (threadId) {
        void skillLibraryClient.deleteAdvisorThread(threadId).catch(() => {
          // Local history deletion succeeds even when Codex thread cleanup fails.
        });
      }
      setSkillAdvisorHistoryError("");
    } catch (error) {
      setSkillAdvisorHistoryError(
        tr("skillAdvisorHistoryDeleteFailed", { error: String(error) }),
      );
    }
  }

  function beginSkillAdvisorRename(conversation: SkillAdvisorConversation) {
    setSkillAdvisorRenamingId(conversation.id);
    setSkillAdvisorRenameInput(conversation.title);
  }

  async function commitSkillAdvisorRename(
    conversation: SkillAdvisorConversation,
  ) {
    const title = skillAdvisorRenameInput.trim();
    if (!title) return;
    const saved = await persistSkillAdvisorConversation({
      ...conversation,
      title,
    });
    if (!saved) return;
    if (skillAdvisorConversationId === conversation.id) {
      setSkillAdvisorConversationTitle(saved.title);
    }
    setSkillAdvisorRenamingId(null);
    setSkillAdvisorRenameInput("");
  }

  function formatSkillAdvisorHistoryTime(timestamp: number) {
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function submitSkillAdvisorMessage(value = skillAdvisorInput) {
    const content = value.trim();
    const catalog = availableSkillAdvisorCatalog();
    if (!content || skillAdvisorLoading || catalog.length === 0) return;
    const nextMessages: SkillAdvisorMessage[] = [
      ...skillAdvisorMessages,
      { role: "user", content },
    ];
    const now = advisorConversationTimestamp();
    const conversationId =
      skillAdvisorConversationId ?? globalThis.crypto.randomUUID();
    const conversationTitle = skillAdvisorConversationId
      ? skillAdvisorConversationTitle
      : advisorConversationTitle(nextMessages);
    const conversationCreatedAt = skillAdvisorConversationCreatedAt || now;
    setSkillAdvisorConversationId(conversationId);
    setSkillAdvisorConversationTitle(conversationTitle);
    setSkillAdvisorConversationCreatedAt(conversationCreatedAt);
    setSkillAdvisorMessages(nextMessages);
    setSkillAdvisorInput("");
    setSkillAdvisorError("");
    setSkillAdvisorRecommendedIds([]);
    setSkillAdvisorRecommendedSkills([]);
    setSkillAdvisorUsedFallback(false);
    setLibraryInstallNote("");
    setLibraryInstallConflict(false);
    setLibraryInstallConflictId(null);
    setSkillAdvisorLoading(true);
    const conversationGeneration =
      skillAdvisorConversationGenerationRef.current;
    try {
      await persistSkillAdvisorConversation({
        id: conversationId,
        title: conversationTitle,
        createdAt: conversationCreatedAt,
        updatedAt: now,
        messages: nextMessages,
        recommendedPublicIds: [],
        recommendedSkills: [],
        usedFallback: false,
        threadId: skillAdvisorThreadId,
      });
      const recommendation = await skillLibraryClient.recommendSkills(
        catalog,
        nextMessages,
        locale,
        skillAdvisorThreadId,
        Array.from(installedSkillAdvisorNames()),
      );
      if (
        conversationGeneration !== skillAdvisorConversationGenerationRef.current
      ) {
        if (recommendation.threadId) {
          void skillLibraryClient
            .deleteAdvisorThread(recommendation.threadId)
            .catch(() => {
              // A superseded conversation is already hidden from the user.
            });
        }
        return;
      }
      const assistantReply = localizedSkillAdvisorReply(recommendation);
      const completedMessages: SkillAdvisorMessage[] = [
        ...nextMessages,
        { role: "assistant", content: assistantReply },
      ];
      setSkillAdvisorThreadId(recommendation.threadId);
      if (recommendation.recommendedSkills.length > 0) {
        setSkillAdvisorCatalog((current) => {
          const merged = new Map(
            current.map((skill) => [skill.publicId, skill] as const),
          );
          recommendation.recommendedSkills.forEach((skill) =>
            merged.set(skill.publicId, skill),
          );
          return Array.from(merged.values());
        });
      }
      setSkillAdvisorMessages(completedMessages);
      setSkillAdvisorRecommendedIds(recommendation.recommendedPublicIds);
      setSkillAdvisorRecommendedSkills(recommendation.recommendedSkills);
      setSkillAdvisorUsedFallback(recommendation.usedFallback);
      await persistSkillAdvisorConversation({
        id: conversationId,
        title: conversationTitle,
        createdAt: conversationCreatedAt,
        updatedAt: advisorConversationTimestamp(),
        messages: completedMessages,
        recommendedPublicIds: recommendation.recommendedPublicIds,
        recommendedSkills: recommendation.recommendedSkills,
        usedFallback: recommendation.usedFallback,
        threadId: recommendation.threadId,
      });
      trackSkillEvent("skill_advisor_recommendation_completed", {
        result: recommendation.usedFallback ? "local-fallback" : "local-codex",
        count: recommendation.recommendedPublicIds.length,
      });
    } catch (error) {
      if (
        conversationGeneration !== skillAdvisorConversationGenerationRef.current
      ) {
        return;
      }
      setSkillAdvisorError(
        tr("skillAdvisorRequestFailed", { error: String(error) }),
      );
    } finally {
      if (
        conversationGeneration === skillAdvisorConversationGenerationRef.current
      ) {
        setSkillAdvisorLoading(false);
      }
    }
  }

  function renderCatalogCard(skill: PublicSkill) {
    const open = () => {
      setSelectedLibrarySkill(skill);
      setLibraryInstallNote("");
      setLibraryInstallConflict(false);
      setLibraryInstallConflictId(null);
    };
    return (
      <article
        className="skillCatalogCard"
        key={skill.publicId}
        onClick={open}
      >
        <div className="skillCatalogCardTop">
          <div className="skillCardHeader">
            <button
              className="skillCatalogCardTitle"
              onClick={(event) => {
                event.stopPropagation();
                open();
              }}
            >
              <strong>{skill.displayName}</strong>
            </button>
            {skill.latestPublishedVersion ? (
              <span className="skillCardVersion">
                {tr("skillVersionLabel", {
                  version: skill.latestPublishedVersion.version,
                })}
              </span>
            ) : null}
          </div>
          <button
            className="primaryButton skillCatalogInstallButton"
            disabled={
              !skill.latestPublishedVersion || libraryInstallingId !== null
            }
            onClick={(event) => {
              event.stopPropagation();
              void installFromLibrary(skill);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {libraryInstallingId === skill.publicId ? (
              <CircleNotchIcon className="spin" weight="bold" />
            ) : (
              <DownloadSimpleIcon weight="bold" />
            )}
            {tr("skillLibraryInstallLocal")}
          </button>
        </div>
        <p className="skillCardDescription">{skill.description}</p>
        <div className="skillCardMeta">
          {skill.primaryCategory ? (
            <span className="skillTag source">
              {skill.primaryCategory.name}
            </span>
          ) : null}
          {skill.tags.map((tag) => (
            <span className="skillTag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      </article>
    );
  }

  function renderLibraryDetailDrawer() {
    if (!selectedLibrarySkill) return null;
    const skill = selectedLibrarySkill;
    const version = skill.latestPublishedVersion;
    const installedSkill = (skillScan?.skills ?? []).find(
      (localSkill) =>
        (localSkill.sourceType === "autogateway" ||
          localSkill.sourceType === "team") &&
        localSkill.name === skill.name,
    );
    return (
      <div
        className="skillDrawerOverlay"
        onClick={() => setSelectedLibrarySkill(null)}
      >
        <aside
          className="skillDrawer skillLibraryDrawer"
          role="dialog"
          aria-modal="true"
          aria-label={skill.displayName}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="skillDrawerHeader">
            <strong>{skill.displayName}</strong>
            <button
              className="iconButton"
              aria-label={tr("skillDetailClose")}
              onClick={() => setSelectedLibrarySkill(null)}
            >
              <XIcon weight="bold" />
            </button>
          </header>
          <div className="skillDrawerBody">
            <p className="skillCardDescription">{skill.description}</p>
            <dl className="skillDetailGrid">
              <div>
                <dt>{tr("skillsFilterCategory")}</dt>
                <dd>{skill.primaryCategory?.name ?? "—"}</dd>
              </div>
              <div>
                <dt>{tr("skillLibraryVersion")}</dt>
                <dd>{version ? version.version : "—"}</dd>
              </div>
            </dl>
            <div className="skillDrawerActions">
              {installedSkill ? (
                <button
                  className="primaryButton"
                  onClick={() => {
                    setSelectedLibrarySkill(null);
                    setSelectedSkillId(installedSkill.id);
                  }}
                >
                  {tr("skillLibraryManageInstalled")}
                </button>
              ) : (
                <button
                  className="primaryButton"
                  disabled={!version || libraryInstallingId === skill.publicId}
                  onClick={() => void installFromLibrary(skill)}
                >
                  {libraryInstallingId === skill.publicId ? (
                    <CircleNotchIcon className="spin" weight="bold" />
                  ) : null}
                  {tr("skillLibraryInstallLocal")}
                </button>
              )}
              {libraryInstallConflict ? (
                <button
                  className="secondaryButton"
                  disabled={libraryInstallingId === skill.publicId}
                  onClick={() => void installFromLibrary(skill, true)}
                >
                  {tr("skillLibraryReplaceLocal")}
                </button>
              ) : null}
            </div>
            {libraryInstallNote ? (
              <section
                className={`notice ${libraryInstallConflict ? "warning" : ""}`.trim()}
              >
                <span>{libraryInstallNote}</span>
              </section>
            ) : null}
          </div>
        </aside>
      </div>
    );
  }

  function renderSkillAdvisorDrawer() {
    if (!showSkillAdvisor) return null;
    const recommendedSkills =
      skillAdvisorRecommendedSkills.length > 0
        ? skillAdvisorRecommendedSkills
        : skillAdvisorRecommendedIds
            .map((publicId) =>
              skillAdvisorCatalog.find((skill) => skill.publicId === publicId),
            )
            .filter((skill): skill is PublicSkill => Boolean(skill));
    const hasUserMessage = skillAdvisorMessages.some(
      (message) => message.role === "user",
    );
    const starterPrompts = [
      tr("skillAdvisorStarterAutomation"),
      tr("skillAdvisorStarterDocuments"),
      tr("skillAdvisorStarterDevelopment"),
    ];
    return (
      <div
        className="skillDrawerOverlay"
        onClick={closeSkillAdvisor}
      >
        <aside
          className="skillDrawer skillAdvisorDrawer"
          role="dialog"
          aria-modal="true"
          aria-label={tr("skillAdvisorTitle")}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="skillDrawerHeader">
            <div className="skillAdvisorTitle">
              <SparkleIcon weight="duotone" />
              <div>
                <strong>{tr("skillAdvisorTitle")}</strong>
                <span>{tr("skillAdvisorSubtitle")}</span>
              </div>
            </div>
            <div className="skillAdvisorHeaderActions">
              <button
                className={`skillAdvisorHeaderButton ${
                  skillAdvisorHistoryOpen ? "selected" : ""
                }`.trim()}
                aria-expanded={skillAdvisorHistoryOpen}
                aria-controls="skill-advisor-history"
                onClick={() => setSkillAdvisorHistoryOpen((open) => !open)}
              >
                <ClockCounterClockwiseIcon weight="bold" />
                {tr("skillAdvisorHistory")}
              </button>
              <button
                className="skillAdvisorHeaderButton"
                aria-label={tr("skillAdvisorRestart")}
                title={tr("skillAdvisorRestart")}
                disabled={skillAdvisorLoading}
                onClick={resetSkillAdvisorConversation}
              >
                <PlusIcon weight="bold" />
                {tr("skillAdvisorNewConversation")}
              </button>
              <button
                className="iconButton"
                aria-label={tr("skillDetailClose")}
                onClick={closeSkillAdvisor}
              >
                <XIcon weight="bold" />
              </button>
            </div>
          </header>
          <div
            className={`skillAdvisorWorkspace ${
              skillAdvisorHistoryOpen ? "" : "historyCollapsed"
            }`.trim()}
          >
            {skillAdvisorHistoryOpen ? (
              <aside
                className="skillAdvisorHistory"
                id="skill-advisor-history"
                aria-label={tr("skillAdvisorHistory")}
              >
                <div className="skillAdvisorHistoryHeader">
                  <strong>{tr("skillAdvisorHistory")}</strong>
                  <span>{skillAdvisorConversations.length}</span>
                </div>
                {skillAdvisorHistoryLoading ? (
                  <div className="skillAdvisorHistoryStatus">
                    <CircleNotchIcon className="spin" weight="bold" />
                    <span>{tr("skillAdvisorHistoryLoading")}</span>
                  </div>
                ) : skillAdvisorConversations.length === 0 ? (
                  <div className="skillAdvisorHistoryEmpty">
                    <ChatCircleTextIcon weight="duotone" />
                    <span>{tr("skillAdvisorHistoryEmpty")}</span>
                  </div>
                ) : (
                  <div className="skillAdvisorHistoryList">
                    {skillAdvisorConversations.map((conversation) => (
                      <article
                        className={`skillAdvisorHistoryItem ${
                          skillAdvisorConversationId === conversation.id
                            ? "selected"
                            : ""
                        }`.trim()}
                        key={conversation.id}
                      >
                        {skillAdvisorRenamingId === conversation.id ? (
                          <form
                            className="skillAdvisorHistoryRename"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void commitSkillAdvisorRename(conversation);
                            }}
                          >
                            <input
                              autoFocus
                              maxLength={80}
                              value={skillAdvisorRenameInput}
                              aria-label={tr("skillAdvisorHistoryRename")}
                              onChange={(event) =>
                                setSkillAdvisorRenameInput(event.target.value)
                              }
                            />
                            <button
                              className="iconButton"
                              type="submit"
                              aria-label={tr("confirm")}
                              disabled={!skillAdvisorRenameInput.trim()}
                            >
                              <CheckIcon weight="bold" />
                            </button>
                            <button
                              className="iconButton"
                              type="button"
                              aria-label={tr("cancel")}
                              onClick={() => setSkillAdvisorRenamingId(null)}
                            >
                              <XIcon weight="bold" />
                            </button>
                          </form>
                        ) : (
                          <>
                            <button
                              className="skillAdvisorHistorySelect"
                              disabled={skillAdvisorLoading}
                              onClick={() =>
                                restoreSkillAdvisorConversation(conversation)
                              }
                            >
                              <ChatCircleTextIcon weight="duotone" />
                              <span>
                                <strong>{conversation.title}</strong>
                                <small>
                                  {formatSkillAdvisorHistoryTime(
                                    conversation.updatedAt,
                                  )}
                                </small>
                              </span>
                            </button>
                            <div className="skillAdvisorHistoryActions">
                              <button
                                className="iconButton"
                                aria-label={tr("skillAdvisorHistoryRename")}
                                title={tr("skillAdvisorHistoryRename")}
                                disabled={skillAdvisorLoading}
                                onClick={() =>
                                  beginSkillAdvisorRename(conversation)
                                }
                              >
                                <PencilSimpleIcon weight="bold" />
                              </button>
                              <button
                                className="iconButton danger"
                                aria-label={tr("skillAdvisorHistoryDelete")}
                                title={tr("skillAdvisorHistoryDelete")}
                                disabled={skillAdvisorLoading}
                                onClick={() =>
                                  void deleteSkillAdvisorConversation(
                                    conversation,
                                  )
                                }
                              >
                                <TrashIcon weight="bold" />
                              </button>
                            </div>
                          </>
                        )}
                      </article>
                    ))}
                  </div>
                )}
                {skillAdvisorHistoryError ? (
                  <p className="skillAdvisorHistoryError" role="alert">
                    {skillAdvisorHistoryError}
                  </p>
                ) : null}
                <p className="skillAdvisorHistoryRetention">
                  {tr("skillAdvisorHistoryRetention")}
                </p>
              </aside>
            ) : null}
            <section className="skillAdvisorChat">
              {skillAdvisorConversationId ? (
                <div className="skillAdvisorCurrentConversation">
                  <ChatCircleTextIcon weight="duotone" />
                  <strong>{skillAdvisorConversationTitle}</strong>
                </div>
              ) : null}
              <div className="skillAdvisorUsageNotice" role="note">
                <WarningIcon weight="duotone" aria-hidden="true" />
                <span>{tr("skillAdvisorUsageNotice")}</span>
              </div>
              <div className="skillAdvisorConversation" aria-live="polite">
                <div className="skillAdvisorMessages">
                  {skillAdvisorMessages.map((message, index) => (
                    <div
                      className={`skillAdvisorMessage ${message.role}`}
                      key={`${message.role}-${index}`}
                    >
                      {message.role === "assistant" ? (
                        <SparkleIcon weight="fill" />
                      ) : null}
                      <p>{message.content}</p>
                    </div>
                  ))}
                  {skillAdvisorLoading ? (
                    <div className="skillAdvisorMessage assistant loading">
                      <CircleNotchIcon className="spin" weight="bold" />
                      <p>{tr("skillAdvisorThinking")}</p>
                    </div>
                  ) : null}
                </div>
                {!hasUserMessage && !skillAdvisorCatalogLoading ? (
                  <div className="skillAdvisorStarters">
                    {starterPrompts.map((prompt) => (
                      <button
                        className="skillAdvisorStarter"
                        key={prompt}
                        disabled={skillAdvisorCatalog.length === 0}
                        onClick={() => void submitSkillAdvisorMessage(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                ) : null}
                {skillAdvisorCatalogLoading ? (
                  <div className="skillAdvisorCatalogLoading">
                    <CircleNotchIcon className="spin" weight="bold" />
                    <span>{tr("skillAdvisorLoadingCatalog")}</span>
                  </div>
                ) : null}
                {recommendedSkills.length > 0 ? (
                  <section
                    className="skillAdvisorRecommendations"
                    aria-label={tr("skillAdvisorRecommendations")}
                  >
                    <h3>{tr("skillAdvisorRecommendations")}</h3>
                    <div className="skillAdvisorRecommendationList">
                      {recommendedSkills.map((skill) => (
                        <article
                          className="skillAdvisorRecommendation"
                          key={skill.publicId}
                        >
                          <div>
                            <strong>{skill.displayName}</strong>
                            <p>{skill.description}</p>
                            {skill.primaryCategory ? (
                              <span className="skillTag">
                                {skill.primaryCategory.name}
                              </span>
                            ) : null}
                          </div>
                          <div className="skillAdvisorRecommendationActions">
                            <button
                              className="linkButton"
                              onClick={() => {
                                closeSkillAdvisor();
                                setSelectedLibrarySkill(skill);
                              }}
                            >
                              {tr("skillAdvisorViewDetails")}
                            </button>
                            {libraryInstallConflictId === skill.publicId ? (
                              <button
                                className="secondaryButton"
                                disabled={libraryInstallingId === skill.publicId}
                                onClick={() =>
                                  void installFromLibrary(skill, true)
                                }
                              >
                                {tr("skillLibraryReplaceLocal")}
                              </button>
                            ) : (
                              <button
                                className="primaryButton"
                                disabled={
                                  !skill.latestPublishedVersion ||
                                  libraryInstallingId === skill.publicId
                                }
                                onClick={() => void installFromLibrary(skill)}
                              >
                                {libraryInstallingId === skill.publicId ? (
                                  <CircleNotchIcon
                                    className="spin"
                                    weight="bold"
                                  />
                                ) : null}
                                {tr("skillLibraryInstallLocal")}
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}
                {skillAdvisorUsedFallback ? (
                  <p className="skillAdvisorFallbackNote">
                    {tr("skillAdvisorFallbackNote")}
                  </p>
                ) : null}
                {libraryInstallNote ? (
                  <section
                    className={`notice ${
                      libraryInstallConflict ? "warning" : ""
                    }`.trim()}
                  >
                    <span>{libraryInstallNote}</span>
                  </section>
                ) : null}
                {skillAdvisorError ? (
                  <section className="notice warning">
                    <strong>{skillAdvisorError}</strong>
                  </section>
                ) : null}
                <div ref={skillAdvisorEndRef} />
              </div>
              <form
                className="skillAdvisorComposer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitSkillAdvisorMessage();
                }}
              >
                <textarea
                  ref={skillAdvisorInputRef}
                  rows={2}
                  maxLength={2000}
                  value={skillAdvisorInput}
                  aria-label={tr("skillAdvisorInputPlaceholder")}
                  placeholder={tr("skillAdvisorInputPlaceholder")}
                  disabled={skillAdvisorCatalogLoading || skillAdvisorLoading}
                  onChange={(event) => setSkillAdvisorInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void submitSkillAdvisorMessage();
                    }
                  }}
                />
                <button
                  className="primaryButton skillAdvisorSend"
                  type="submit"
                  aria-label={tr("skillAdvisorSend")}
                  title={tr("skillAdvisorUsageNotice")}
                  disabled={
                    !skillAdvisorInput.trim() ||
                    skillAdvisorCatalogLoading ||
                    skillAdvisorLoading ||
                    availableSkillAdvisorCatalog().length === 0
                  }
                >
                  <PaperPlaneRightIcon weight="bold" />
                </button>
              </form>
            </section>
          </div>
        </aside>
      </div>
    );
  }

  function renderSkillCategoryTree(
    selectedCategory: string,
    onSelectCategory: (category: string) => void,
  ) {
    const categories = orderedSkillCategories(libraryCategories);
    const categoryIds = new Set(categories.map((category) => category.publicId));
    const renderCategoryNodes = (
      parentPublicId: string,
      depth = 0,
    ): ReactNode => {
      const children = categories.filter((category) =>
        parentPublicId
          ? category.parentPublicId === parentPublicId
          : !category.parentPublicId ||
            !categoryIds.has(category.parentPublicId),
      );
      return children.map((category) => {
        const hasChildren = categories.some(
          (item) => item.parentPublicId === category.publicId,
        );
        const expanded = expandedLibraryCategories.has(category.publicId);
        return (
          <li key={category.publicId} role="none">
            <div
              className="skillCategoryTreeRow"
              style={{ paddingLeft: `${depth * 14}px` }}
            >
              {hasChildren ? (
                <button
                  className="skillCategoryTreeToggle"
                  aria-label={
                    expanded
                      ? tr("skillLibraryCategoryCollapse")
                      : tr("skillLibraryCategoryExpand")
                  }
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedLibraryCategories((current) => {
                      const next = new Set(current);
                      if (next.has(category.publicId)) {
                        next.delete(category.publicId);
                      } else {
                        next.add(category.publicId);
                      }
                      return next;
                    })
                  }
                >
                  {expanded ? (
                    <CaretDownIcon weight="bold" />
                  ) : (
                    <CaretRightIcon weight="bold" />
                  )}
                </button>
              ) : (
                <span className="skillCategoryTreeSpacer" />
              )}
              <button
                role="treeitem"
                aria-selected={selectedCategory === category.slug}
                className={`skillCategoryTreeItem ${
                  selectedCategory === category.slug ? "selected" : ""
                }`.trim()}
                title={category.description || category.name}
                onClick={() => onSelectCategory(category.slug)}
              >
                {category.name}
              </button>
            </div>
            {hasChildren && expanded ? (
              <ul role="group">
                {renderCategoryNodes(category.publicId, depth + 1)}
              </ul>
            ) : null}
          </li>
        );
      });
    };
    return (
      <aside className="skillCategoryTreePanel">
        <div className="skillCategoryTreeHeader">
          <strong>{tr("skillLibraryCategoriesTitle")}</strong>
          <span>{tr("skillLibraryCategoriesSource")}</span>
        </div>
        <div className="skillCategoryTree" role="tree">
          <button
            role="treeitem"
            aria-selected={selectedCategory === "all"}
            className={`skillCategoryTreeAll ${
              selectedCategory === "all" ? "selected" : ""
            }`.trim()}
            onClick={() => onSelectCategory("all")}
          >
            {tr("skillsFilterAllCategories")}
          </button>
          {libraryCategoriesLoading ? (
            <p className="skillCategoryTreeMessage">
              {tr("skillCategoriesLoading")}
            </p>
          ) : libraryCategoriesError && categories.length === 0 ? (
            <p className="skillCategoryTreeMessage">
              {tr("skillCategoriesUnavailable")}
            </p>
          ) : (
            <ul>{renderCategoryNodes("")}</ul>
          )}
        </div>
      </aside>
    );
  }

  function renderSkillCategoryBreadcrumb(
    selectedCategory: string,
    onSelectCategory: (category: string) => void,
  ) {
    const path = skillCategoryPath(libraryCategories, selectedCategory);
    return (
      <nav
        className="skillCategoryBreadcrumb"
        aria-label={tr("skillLibraryCategoryBreadcrumb")}
      >
        {path.length === 0 ? (
          <span aria-current="page">{tr("skillsFilterAllCategories")}</span>
        ) : (
          <button onClick={() => onSelectCategory("all")}>
            {tr("skillsFilterAllCategories")}
          </button>
        )}
        {path.map((category, index) => {
          const isCurrent = index === path.length - 1;
          return (
            <span className="skillCategoryBreadcrumbSegment" key={category.publicId}>
              <CaretRightIcon weight="bold" aria-hidden="true" />
              {isCurrent ? (
                <span aria-current="page">{category.name}</span>
              ) : (
                <button onClick={() => onSelectCategory(category.slug)}>
                  {category.name}
                </button>
              )}
            </span>
          );
        })}
      </nav>
    );
  }

  async function openInstalledLibrarySkill(skill: SkillRecord) {
    const catalogSkill = libraryItems.find((item) => item.name === skill.name);
    const catalogCategory = catalogSkill?.primaryCategory?.slug;
    if (
      catalogCategory &&
      normalizedCategorySlug(skill.categoryId) !== catalogCategory
    ) {
      try {
        await setSkillCategory(skill.id, catalogCategory);
        setSkillsRefreshNonce((nonce) => nonce + 1);
      } catch (error) {
        setSkillCategoryError(String(error));
      }
    }
    setSelectedSkillId(skill.id);
  }

  function renderSkillLibrary() {
    const installedSkills = (skillScan?.skills ?? []).filter(
      (skill) =>
        skill.sourceType === "autogateway" || skill.sourceType === "team",
    );
    const installedNames = new Set(installedSkills.map((skill) => skill.name));
    const catalogByName = new Map(
      libraryItems.map((skill) => [skill.name, skill] as const),
    );
    const query = librarySearch.trim().toLowerCase();
    const visibleInstalledSkills = installedSkills
      .filter((skill) => {
        const catalogSkill = catalogByName.get(skill.name);
        const category =
          normalizedCategorySlug(skill.categoryId) ??
          catalogSkill?.primaryCategory?.slug;
        return skillCategoryMatches(
          libraryCategories,
          category,
          libraryCategory,
        );
      })
      .filter(
        (skill) =>
          !query ||
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const availableSkills = libraryItems.filter(
      (skill) => !installedNames.has(skill.name),
    );
    const availableSkillTotal =
      libraryCatalogTotal === null && libraryCategory === "all" && !query
        ? availableSkills.length
        : Math.max(0, libraryResultTotal - visibleInstalledSkills.length);
    const visibleCount =
      libraryInstallFilter === "installed"
        ? visibleInstalledSkills.length
        : availableSkills.length;
    const installedPageCount = Math.max(
      1,
      Math.ceil(visibleInstalledSkills.length / skillCatalogPageSize),
    );
    const catalogPageCount = Math.max(
      1,
      Math.ceil(libraryResultTotal / skillCatalogPageSize),
    );
    const currentLibraryPage =
      libraryInstallFilter === "installed"
        ? Math.min(libraryPage, installedPageCount - 1)
        : libraryPage;
    const libraryPageStart = currentLibraryPage * skillCatalogPageSize;
    const pagedInstalledSkills = visibleInstalledSkills.slice(
      libraryPageStart,
      libraryPageStart + skillCatalogPageSize,
    );
    const canOpenNextLibraryPage =
      libraryInstallFilter === "installed"
        ? currentLibraryPage < installedPageCount - 1
        : libraryHasNextPage;
    const shouldShowLibraryPagination =
      libraryInstallFilter === "installed"
        ? visibleInstalledSkills.length > 0
        : libraryResultTotal > 0;
    const installConflictSkill = libraryInstallConflictId
      ? libraryItems.find(
          (skill) => skill.publicId === libraryInstallConflictId,
        )
      : undefined;
    return (
      <div className="skillLibraryLayout">
        {renderSkillCategoryTree(libraryCategory, setLibraryCategory)}
        <div className="skillLibraryResults">
          {renderSkillCategoryBreadcrumb(
            libraryCategory,
            setLibraryCategory,
          )}
          <div className="skillLibraryStatusTabs" role="tablist">
            <button
              role="tab"
              aria-selected={libraryInstallFilter === "available"}
              className={libraryInstallFilter === "available" ? "selected" : ""}
              onClick={() => setLibraryInstallFilter("available")}
            >
              {tr("skillLibraryAvailableTab")}
              <strong>{availableSkillTotal}</strong>
            </button>
            <button
              role="tab"
              aria-selected={libraryInstallFilter === "installed"}
              className={libraryInstallFilter === "installed" ? "selected" : ""}
              onClick={() => setLibraryInstallFilter("installed")}
            >
              {tr("skillLibraryInstalledTab")}
              <strong>{visibleInstalledSkills.length}</strong>
            </button>
          </div>
          <div className="skillsToolbar">
            <label className="skillSearch">
              <MagnifyingGlassIcon weight="bold" />
              <input
                type="search"
                value={librarySearch}
                placeholder={tr("skillsSearchPlaceholder")}
                onChange={(event) => setLibrarySearch(event.target.value)}
              />
            </label>
            {libraryInstallFilter === "available" ? (
              <select
                className="skillSelect"
                aria-label={tr("skillsSortLabel")}
                value={librarySort}
                onChange={(event) =>
                  setLibrarySort(event.target.value as typeof librarySort)
                }
              >
                <option value="popular">{tr("skillLibrarySortPopular")}</option>
                <option value="newest">{tr("skillLibrarySortNewest")}</option>
                <option value="updated">{tr("skillLibrarySortUpdated")}</option>
              </select>
            ) : null}
            {libraryInstallFilter === "installed" ||
            (!libraryLoading && !libraryError) ? (
              <span className="skillsCount">
                {tr("skillsCount", {
                  count:
                    libraryInstallFilter === "installed"
                      ? visibleCount
                      : libraryResultTotal,
                })}
              </span>
            ) : null}
          </div>
          {!selectedLibrarySkill && libraryInstallNote ? (
            <section
              className={`notice skillLibraryInstallNotice ${
                libraryInstallConflict ? "warning" : ""
              }`.trim()}
              aria-live="polite"
            >
              <span>{libraryInstallNote}</span>
              {libraryInstallConflict && installConflictSkill ? (
                <button
                  className="secondaryButton"
                  disabled={libraryInstallingId !== null}
                  onClick={() =>
                    void installFromLibrary(installConflictSkill, true)
                  }
                >
                  {tr("skillLibraryReplaceLocal")}
                </button>
              ) : null}
            </section>
          ) : null}
          {libraryInstallFilter === "installed" ? (
            visibleInstalledSkills.length === 0 ? (
              <div className="skillsComingSoon">
                <MagnifyingGlassIcon weight="duotone" />
                <strong>{tr("skillsNoMatches")}</strong>
              </div>
            ) : (
              <div className="skillList">
                {pagedInstalledSkills.map((skill) =>
                  renderSkillCard(skill, () =>
                    void openInstalledLibrarySkill(skill),
                  ),
                )}
              </div>
            )
          ) : libraryLoading ? (
            <div className="skillCatalog skillSkeleton" aria-busy="true">
              <div className="skillSkeletonRow" />
              <div className="skillSkeletonRow" />
              <div className="skillSkeletonRow" />
            </div>
          ) : libraryError ? (
            <div className="skillsComingSoon skillLibraryError">
              <WarningIcon weight="duotone" />
              <strong>{tr("skillLibraryUnavailableTitle")}</strong>
              <span>{tr("skillLibraryUnavailableBody")}</span>
              <button
                className="secondaryButton"
                onClick={() => setLibraryRefreshNonce((nonce) => nonce + 1)}
              >
                <ArrowsClockwiseIcon weight="bold" />
                {tr("skillLibraryRetry")}
              </button>
              <details>
                <summary>{tr("skillLibraryErrorDetails")}</summary>
                <code>{libraryError}</code>
              </details>
            </div>
          ) : availableSkills.length === 0 ? (
            <div className="skillsComingSoon">
              <MagnifyingGlassIcon weight="duotone" />
              <strong>{tr("skillsNoMatches")}</strong>
            </div>
          ) : (
            <div className="skillCatalog">
              {availableSkills.map(renderCatalogCard)}
            </div>
          )}
          {!libraryLoading &&
          !libraryError &&
          shouldShowLibraryPagination ? (
            <nav
              className="skillCatalogPagination"
              aria-label={tr("skillLibraryPagination")}
            >
              <button
                className="secondaryButton"
                disabled={currentLibraryPage === 0}
                onClick={() => setLibraryPage(currentLibraryPage - 1)}
              >
                <ArrowLeftIcon weight="bold" />
                {tr("skillLibraryPreviousPage")}
              </button>
              <span>
                {libraryInstallFilter === "installed"
                  ? tr("skillLibraryPageStatus", {
                      current: currentLibraryPage + 1,
                      total: installedPageCount,
                    })
                  : tr("skillLibraryPageStatus", {
                      current: currentLibraryPage + 1,
                      total: catalogPageCount,
                    })}
              </span>
              <button
                className="secondaryButton"
                disabled={!canOpenNextLibraryPage}
                onClick={() => setLibraryPage(currentLibraryPage + 1)}
              >
                {tr("skillLibraryNextPage")}
                <ArrowRightIcon weight="bold" />
              </button>
            </nav>
          ) : null}
        </div>
        {renderLibraryDetailDrawer()}
        {renderSkillAdvisorDrawer()}
      </div>
    );
  }

  function skillStatusLabel(status: SkillRecord["status"]): string {
    switch (status) {
      case "enabled":
        return tr("skillStatusEnabled");
      case "disabled":
        return tr("skillStatusDisabled");
      case "error":
        return tr("skillStatusError");
      default:
        return tr("skillStatusSourceUnavailable");
    }
  }

  function fileKindLabel(kind: SkillFileEntry["kind"]): string {
    switch (kind) {
      case "markdown":
        return tr("skillFileKindMarkdown");
      case "script":
        return tr("skillFileKindScript");
      case "reference":
        return tr("skillFileKindReference");
      case "asset":
        return tr("skillFileKindAsset");
      case "agent":
        return tr("skillFileKindAgent");
      default:
        return tr("skillFileKindOther");
    }
  }

  function formatSkillTime(value?: string): string {
    if (!value) return "—";
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    return new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  }

  function renderSkillCard(skill: SkillRecord, onOpen?: () => void) {
    const open = onOpen ?? (() => setSelectedSkillId(skill.id));
    const readOnly = isSkillReadOnly(skill);
    const category = categoryForReference(skill.categoryId);
    const statusClass =
      skill.status === "enabled"
        ? "enabled"
        : skill.status === "disabled"
          ? "disabled"
          : skill.status === "error"
            ? "error"
            : "";
    return (
      <article
        className={`skillCard ${selectedSkillId === skill.id ? "selected" : ""}`.trim()}
        key={skill.id}
        role="button"
        tabIndex={0}
        aria-label={skill.name}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        }}
      >
        <div className="skillCardMain">
          <div className="skillCardHeader">
            <strong>{skill.name}</strong>
            {skill.version ? (
              <span className="skillCardVersion">
                {tr("skillVersionLabel", { version: skill.version })}
              </span>
            ) : null}
          </div>
          <p className="skillCardDescription">{skill.description}</p>
          <div className="skillCardMeta">
            <span className="skillTag source">
              {skillSourceLabel(skill.sourceType)}
            </span>
            {category ? <span className="skillTag">{category.name}</span> : null}
            {skill.tags.map((tag) => (
              <span className="skillTag" key={tag}>
                {tag}
              </span>
            ))}
            {readOnly ? (
              <span className="skillTag readOnly">{tr("skillReadOnly")}</span>
            ) : null}
          </div>
        </div>
        <div className="skillCardAside">
          <span className={`skillStatusBadge ${statusClass}`.trim()}>
            {skillStatusLabel(skill.status)}
          </span>
          {pendingReloadIds.has(skill.id) ? (
            <span className="skillTag pending">{tr("skillPendingReload")}</span>
          ) : null}
          {!readOnly &&
          (skill.status === "enabled" || skill.status === "disabled") ? (
            <button
              className="linkButton"
              onClick={(event) => {
                event.stopPropagation();
                void toggleSkill(skill.id, skill.status !== "enabled");
              }}
            >
              {skill.status === "enabled"
                ? tr("skillDisable")
                : tr("skillEnable")}
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  function renderInstalledSkills() {
    if (skillsLoading && !skillScan) {
      return (
        <div className="skillSkeleton" aria-busy="true">
          <div className="skillSkeletonRow" />
          <div className="skillSkeletonRow" />
          <div className="skillSkeletonRow" />
        </div>
      );
    }
    if (skillsError) {
      return (
        <section className="notice warning">
          <strong>{tr("skillsScanError", { error: skillsError })}</strong>
          <button
            className="secondaryButton"
            onClick={() => setSkillsRefreshNonce((nonce) => nonce + 1)}
          >
            {tr("skillsRescan")}
          </button>
        </section>
      );
    }
    const skills = skillScan?.skills ?? [];
    const scopedSkills = skills.filter((skill) =>
      skillsTab === "builtin"
        ? skill.sourceType === "system" || skill.sourceType === "plugin"
        : skill.sourceType !== "system" &&
          skill.sourceType !== "plugin" &&
          skill.sourceType !== "autogateway" &&
          skill.sourceType !== "team",
    );
    if (scopedSkills.length === 0) {
      return (
        <div className="skillsComingSoon">
          <PuzzlePieceIcon weight="duotone" />
          <strong>
            {tr(
              skillsTab === "builtin"
                ? "skillsBuiltinEmptyTitle"
                : "skillsUploadedEmptyTitle",
            )}
          </strong>
          <span>
            {tr(
              skillsTab === "builtin"
                ? "skillsBuiltinEmptyBody"
                : "skillsUploadedEmptyBody",
            )}
          </span>
          {skillsTab === "uploaded" ? (
            <button className="primaryButton" onClick={() => openInstallDialog()}>
              {tr("skillInstall")}
            </button>
          ) : null}
        </div>
      );
    }
    const query = skillSearch.trim().toLowerCase();
    const visible = scopedSkills
      .filter(
        (skill) =>
          skillsTab !== "uploaded" ||
          skillCategoryFilter === "all" ||
          normalizedCategorySlug(skill.categoryId) === skillCategoryFilter,
      )
      .filter(
        (skill) =>
          !query ||
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query),
      )
      .sort((a, b) => {
        if (skillSort === "name-asc") return a.name.localeCompare(b.name);
        if (skillSort === "name-desc") return b.name.localeCompare(a.name);
        return Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
      });
    return (
      <>
        {visible.length === 0 ? (
          <div className="skillsComingSoon">
            <MagnifyingGlassIcon weight="duotone" />
            <strong>{tr("skillsNoMatches")}</strong>
          </div>
        ) : (
          <div className="skillList">
            {visible.map((skill) => renderSkillCard(skill))}
          </div>
        )}
      </>
    );
  }

  function renderSkillDetailDrawer() {
    if (!selectedSkillId) return null;
    return (
      <div
        className="skillDrawerOverlay"
        onClick={() => setSelectedSkillId(null)}
      >
        <aside
          className="skillDrawer"
          role="dialog"
          aria-modal="true"
          aria-label={skillDetail?.name ?? tr("skillsTitle")}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="skillDrawerHeader">
            <div className="skillCardHeader">
              <strong>{skillDetail?.name ?? "…"}</strong>
              {skillDetail?.version ? (
                <span className="skillCardVersion">
                  {tr("skillVersionLabel", { version: skillDetail.version })}
                </span>
              ) : null}
            </div>
            <button
              className="iconButton"
              aria-label={tr("skillDetailClose")}
              onClick={() => setSelectedSkillId(null)}
            >
              <XIcon weight="bold" />
            </button>
          </header>
          <div className="skillDrawerBody">
            {skillDetailLoading ? (
              <div className="skillSkeleton" aria-busy="true">
                <div className="skillSkeletonRow" />
                <div className="skillSkeletonRow" />
              </div>
            ) : skillDetailError ? (
              <section className="notice warning">
                <strong>
                  {tr("skillDetailError", { error: skillDetailError })}
                </strong>
              </section>
            ) : skillDetail ? (
              <>
                {isSkillReadOnly(skillDetail) ? (
                  <section className="notice skillReadOnlyNote">
                    <WarningIcon weight="bold" />
                    <span>{tr("skillDetailReadOnlyNote")}</span>
                  </section>
                ) : null}
                {!isSkillReadOnly(skillDetail) ? (
                  <div className="skillDrawerActions">
                    <button
                      className="secondaryButton"
                      onClick={() =>
                        void toggleSkill(
                          skillDetail.id,
                          skillDetail.status !== "enabled",
                        )
                      }
                    >
                      {skillDetail.status === "enabled"
                        ? tr("skillDisable")
                        : tr("skillEnable")}
                    </button>
                    {removeConfirmId === skillDetail.id ? (
                      <>
                        <span className="skillMuted">
                          {tr("skillRemoveConfirm")}
                        </span>
                        <button
                          className="linkButton danger"
                          onClick={() =>
                            void confirmRemoveSkill(skillDetail.id)
                          }
                        >
                          {tr("skillRemoveConfirmYes")}
                        </button>
                        <button
                          className="linkButton"
                          onClick={() => setRemoveConfirmId(null)}
                        >
                          {tr("skillCategoryCancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        className="linkButton danger"
                        onClick={() => setRemoveConfirmId(skillDetail.id)}
                      >
                        {tr("skillRemove")}
                      </button>
                    )}
                    <button
                      className="linkButton"
                      disabled={exportBusy}
                      onClick={() => void exportCurrentSkill(skillDetail.id)}
                    >
                      {tr("skillExport")}
                    </button>
                  </div>
                ) : null}
                {pendingReloadIds.has(skillDetail.id) ? (
                  <section className="notice skillPendingNote">
                    <span>{tr("skillPendingReloadNote")}</span>
                  </section>
                ) : null}
                {exportResult ? (
                  <section className="notice skillExportResult">
                    <strong>{tr("skillExportDone")}</strong>
                    <div className="skillInstallPath">
                      {exportResult.zipPath}
                    </div>
                    <div className="skillChecksum">
                      SHA-256: {exportResult.sha256}
                    </div>
                    <button
                      className="linkButton"
                      onClick={() =>
                        void navigator.clipboard?.writeText(exportResult.sha256)
                      }
                    >
                      {tr("skillExportCopyChecksum")}
                    </button>
                    {exportResult.warnings.length > 0 ? (
                      <ul className="skillScriptList">
                        {exportResult.warnings.map((warning, index) => (
                          <li key={`${warning.code}-${index}`}>
                            {warning.path
                              ? `${warning.path}: ${warning.message}`
                              : warning.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                ) : null}
                {skillDetail.markdownBody ? (
                  <section className="skillDrawerSection">
                    <h3>{tr("skillDetailDescription")}</h3>
                    <MarkdownContent
                      value={skillDetail.markdownBody}
                      onOpenLink={(url) => void openUrl(url)}
                    />
                  </section>
                ) : (
                  <p className="skillCardDescription">
                    {skillDetail.description}
                  </p>
                )}
                <section className="skillDrawerSection">
                  <dl className="skillDetailGrid">
                    <div>
                      <dt>{tr("skillDetailSource")}</dt>
                      <dd>{skillSourceLabel(skillDetail.sourceType)}</dd>
                    </div>
                    <div>
                      <dt>{tr("skillDetailStatus")}</dt>
                      <dd>{skillStatusLabel(skillDetail.status)}</dd>
                    </div>
                    <div>
                      <dt>{tr("skillDetailFileCount")}</dt>
                      <dd>{skillDetail.fileCount}</dd>
                    </div>
                    <div>
                      <dt>{tr("skillDetailSize")}</dt>
                      <dd>{formatDataSize(skillDetail.totalSizeBytes)}</dd>
                    </div>
                    <div>
                      <dt>{tr("skillDetailInstalledAt")}</dt>
                      <dd>{formatSkillTime(skillDetail.installedAt)}</dd>
                    </div>
                    <div>
                      <dt>{tr("skillDetailUpdatedAt")}</dt>
                      <dd>{formatSkillTime(skillDetail.updatedAt)}</dd>
                    </div>
                    <div className="skillDetailWide">
                      <dt>{tr("skillDetailChecksum")}</dt>
                      <dd className="skillChecksum">
                        {skillDetail.checksum ?? tr("skillDetailChecksumNA")}
                      </dd>
                    </div>
                    <div className="skillDetailWide">
                      <dt>{tr("skillDetailInstallPath")}</dt>
                      <dd className="skillInstallPath">
                        {skillDetail.installPath}
                      </dd>
                    </div>
                  </dl>
                </section>
                {!isSkillReadOnly(skillDetail) ? (
                  <section className="skillDrawerSection">
                    <h3>{tr("skillDetailCategory")}</h3>
                    <select
                        className="skillSelect"
                        value={
                          normalizedCategorySlug(skillDetail.categoryId) ??
                          "uncategorized"
                        }
                        disabled={libraryCategoriesLoading}
                        onChange={(event) => {
                          const value = event.target.value;
                          void runSkillMetadataMutation(() =>
                            setSkillCategory(
                              skillDetail.id,
                              value === "uncategorized" ? null : value,
                            ),
                          );
                        }}
                      >
                        <option value="uncategorized">
                          {tr("skillCategoryUncategorized")}
                        </option>
                        {flattenedSkillCategories(libraryCategories).map(
                          ({ category, depth }) => (
                            <option key={category.publicId} value={category.slug}>
                              {`${"- ".repeat(depth)}${category.name}`}
                            </option>
                          ),
                        )}
                    </select>
                    {libraryCategoriesError ? (
                      <p className="skillMuted">
                        {tr("skillCategoriesUnavailable")}
                      </p>
                    ) : null}
                    <h3>{tr("skillDetailTags")}</h3>
                    <div className="skillTagEditor">
                        <input
                          type="text"
                          value={skillTagDraft}
                          placeholder={tr("skillTagsPlaceholder")}
                          onChange={(event) =>
                            setSkillTagDraft(event.target.value)
                          }
                        />
                        <button
                          className="secondaryButton"
                          onClick={() =>
                            void runSkillMetadataMutation(() =>
                              setSkillTags(
                                skillDetail.id,
                                skillTagDraft
                                  .split(",")
                                  .map((tag) => tag.trim())
                                  .filter(Boolean),
                              ),
                            )
                          }
                        >
                          {tr("skillTagsSave")}
                        </button>
                    </div>
                    {skillCategoryError ? (
                      <p className="skillMuted">{skillCategoryError}</p>
                    ) : null}
                  </section>
                ) : null}
                <section className="skillDrawerSection">
                  <h3>{tr("skillDetailScripts")}</h3>
                  {skillDetail.scripts.length > 0 ? (
                    <>
                      <section className="notice warning skillScriptsWarning">
                        <WarningIcon weight="bold" />
                        <span>
                          {tr("skillDetailScriptsWarning", {
                            count: skillDetail.scripts.length,
                          })}
                        </span>
                      </section>
                      <ul className="skillScriptList">
                        {skillDetail.scripts.map((script) => (
                          <li key={script}>{script}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="skillMuted">{tr("skillDetailNoScripts")}</p>
                  )}
                </section>
                <section className="skillDrawerSection">
                  <h3>{tr("skillDetailFiles")}</h3>
                  {skillDetail.truncated ? (
                    <p className="skillMuted">{tr("skillDetailTruncated")}</p>
                  ) : null}
                  <ul className="skillFileList">
                    {skillDetail.files.map((file) => (
                      <li key={file.relativePath}>
                        <span className={`skillFileKind ${file.kind}`}>
                          {fileKindLabel(file.kind)}
                        </span>
                        <span className="skillFilePath">
                          {file.relativePath}
                        </span>
                        {file.isExecutable ? (
                          <span className="skillTag readOnly">
                            {tr("skillFileExecutable")}
                          </span>
                        ) : null}
                        <span className="skillFileSize">
                          {formatDataSize(file.sizeBytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            ) : null}
          </div>
        </aside>
      </div>
    );
  }

  function resetInstallResults() {
    setInstallPlan(null);
    setSelectedInstallNames(new Set());
    setInstallReplace(false);
    setInstallSummary(null);
    setSkillInstallProgress(null);
    setInstallError("");
  }

  function openInstallDialog() {
    setInstallKind("dir");
    setInstallLocation("");
    setInstallCategory("");
    resetInstallResults();
    setShowInstallDialog(true);
  }

  async function pickInstallSource() {
    try {
      const selected = await openFileDialog(
        installKind === "dir"
          ? { directory: true }
          : { filters: [{ name: "Zip", extensions: ["zip"] }] },
      );
      if (typeof selected === "string") {
        setInstallLocation(selected);
        resetInstallResults();
      }
    } catch (error) {
      setInstallError(String(error));
    }
  }

  async function previewInstall() {
    if (!installLocation.trim()) return;
    setInstallBusy(true);
    resetInstallResults();
    try {
      const plan = await validateSkillSource(installKind, installLocation.trim());
      setInstallPlan(plan);
      setSelectedInstallNames(new Set(plan.map((item) => item.targetName)));
    } catch (error) {
      setInstallError(String(error));
    } finally {
      setInstallBusy(false);
    }
  }

  async function doInstall() {
    if (!installPlan || installPlan.length === 0) return;
    const single = installPlan.length === 1;
    const names = single
      ? []
      : installPlan
          .map((item) => item.targetName)
          .filter((name) => selectedInstallNames.has(name));
    if (!single && names.length === 0) return;
    const replace = single ? installPlan[0].conflict : installReplace;
    setInstallBusy(true);
    setInstallError("");
    setSkillInstallProgress(null);
    trackSkillEvent("skill_install_started", { kind: installKind });
    try {
      const summary = await installSkill(
        installKind,
        installLocation.trim(),
        replace,
        names,
        installCategory || undefined,
      );
      setSkillsRefreshNonce((nonce) => nonce + 1);
      trackSkillEvent("skill_install_completed", {
        kind: installKind,
        result: "ok",
        count: summary.installed.length,
      });
      if (
        single &&
        summary.installed.length === 1 &&
        summary.skipped.length === 0 &&
        summary.failed.length === 0
      ) {
        setShowInstallDialog(false);
      } else {
        setInstallSummary(summary);
      }
    } catch (error) {
      setInstallError(String(error));
      trackSkillEvent("skill_install_failed", {
        kind: installKind,
        result: "error",
      });
    } finally {
      setInstallBusy(false);
    }
  }

  function renderInstallDialog() {
    if (!showInstallDialog) return null;
    const singlePreview =
      installPlan && installPlan.length === 1 ? installPlan[0] : null;
    const collection =
      installPlan && installPlan.length > 1 ? installPlan : null;
    return (
      <div
        className="skillDrawerOverlay skillModalOverlay"
        onClick={() => setShowInstallDialog(false)}
      >
        <div
          className="skillModal"
          role="dialog"
          aria-modal="true"
          aria-label={tr("skillInstallTitle")}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="skillDrawerHeader">
            <strong>{tr("skillInstallTitle")}</strong>
            <button
              className="iconButton"
              aria-label={tr("skillDetailClose")}
              onClick={() => setShowInstallDialog(false)}
            >
              <XIcon weight="bold" />
            </button>
          </header>
          <div className="skillModalBody">
            <div className="skillInstallSource">
              <select
                className="skillSelect"
                value={installKind}
                onChange={(event) => {
                  setInstallKind(event.target.value as SkillInstallSourceKind);
                  resetInstallResults();
                }}
              >
                <option value="dir">{tr("skillInstallFromDir")}</option>
                <option value="zip">{tr("skillInstallFromZip")}</option>
                <option value="git">{tr("skillInstallFromGit")}</option>
              </select>
              <input
                type="text"
                className="skillInstallInput"
                value={installLocation}
                placeholder={
                  installKind === "dir"
                    ? tr("skillInstallDirPlaceholder")
                    : installKind === "zip"
                      ? tr("skillInstallZipPlaceholder")
                      : tr("skillInstallGitPlaceholder")
                }
                onChange={(event) => {
                  setInstallLocation(event.target.value);
                  resetInstallResults();
                }}
              />
              {installKind !== "git" ? (
                <button
                  className="secondaryButton"
                  onClick={() => void pickInstallSource()}
                >
                  {tr("skillInstallBrowse")}
                </button>
              ) : null}
              <button
                className="secondaryButton"
                disabled={!installLocation.trim() || installBusy}
                onClick={() => void previewInstall()}
              >
                {tr("skillInstallPreview")}
              </button>
            </div>
            <label className="skillInstallCategoryField">
              <span>{tr("skillInstallCategory")}</span>
              <select
                className="skillSelect"
                value={installCategory}
                disabled={libraryCategoriesLoading}
                onChange={(event) => setInstallCategory(event.target.value)}
              >
                <option value="">{tr("skillCategoryUncategorized")}</option>
                {flattenedSkillCategories(libraryCategories).map(
                  ({ category, depth }) => (
                    <option key={category.publicId} value={category.slug}>
                      {`${"- ".repeat(depth)}${category.name}`}
                    </option>
                  ),
                )}
              </select>
              <small>{tr("skillInstallCategoryHelp")}</small>
            </label>
            {installError ? (
              <section className="notice warning">
                <strong>{installError}</strong>
              </section>
            ) : null}
            {installBusy && skillInstallProgress ? (
              <div className="skillInstallProgress">
                <span>
                  {tr(
                    `skillInstallStage_${skillInstallProgress.stage}` as Parameters<
                      typeof tr
                    >[0],
                  )}
                  {typeof skillInstallProgress.percent === "number" &&
                  skillInstallProgress.stage === "downloading"
                    ? ` ${skillInstallProgress.percent}%`
                    : ""}
                </span>
                <div className="skillProgressTrack">
                  <div
                    className="skillProgressBar"
                    style={{
                      transform: `scaleX(${
                        skillInstallProgress.stage === "complete"
                          ? 1
                          : (skillInstallProgress.percent ?? 20) / 100
                      })`,
                    }}
                  />
                </div>
              </div>
            ) : null}
            {installSummary ? (
              <>
                <section className="notice">
                  <strong>
                    {tr("skillInstallSummary", {
                      installed: installSummary.installed.length,
                      skipped: installSummary.skipped.length,
                      failed: installSummary.failed.length,
                    })}
                  </strong>
                  {installSummary.failed.length > 0 ? (
                    <ul className="skillScriptList">
                      {installSummary.failed.map((item) => (
                        <li key={item.name}>
                          {item.name}: {item.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
                <div className="skillDrawerActions">
                  <button
                    className="primaryButton"
                    onClick={() => setShowInstallDialog(false)}
                  >
                    {tr("skillInstallClose")}
                  </button>
                </div>
              </>
            ) : singlePreview ? (
              <>
                <div className="skillDrawerSection">
                  <div className="skillCardHeader">
                    <strong>{singlePreview.name}</strong>
                    {singlePreview.version ? (
                      <span className="skillCardVersion">
                        {tr("skillVersionLabel", {
                          version: singlePreview.version,
                        })}
                      </span>
                    ) : null}
                  </div>
                  <p className="skillCardDescription">
                    {singlePreview.description}
                  </p>
                  <dl className="skillDetailGrid">
                    <div className="skillDetailWide">
                      <dt>{tr("skillInstallTarget")}</dt>
                      <dd className="skillInstallPath">
                        {singlePreview.targetPath}
                      </dd>
                    </div>
                    <div>
                      <dt>{tr("skillDetailFileCount")}</dt>
                      <dd>{singlePreview.fileCount}</dd>
                    </div>
                    <div>
                      <dt>{tr("skillDetailSize")}</dt>
                      <dd>{formatDataSize(singlePreview.totalSizeBytes)}</dd>
                    </div>
                  </dl>
                </div>
                {singlePreview.warnings.length > 0 ? (
                  <section className="notice warning">
                    <strong>{tr("skillInstallRisks")}</strong>
                    <ul className="skillScriptList">
                      {singlePreview.warnings.map((warning, index) => (
                        <li key={`${warning.code}-${index}`}>
                          {warning.path
                            ? `${warning.path}: ${warning.message}`
                            : warning.message}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {singlePreview.conflict ? (
                  <section className="notice warning">
                    <strong>{tr("skillInstallConflict")}</strong>
                  </section>
                ) : null}
                <div className="skillDrawerActions">
                  <button
                    className="primaryButton"
                    disabled={installBusy}
                    onClick={() => void doInstall()}
                  >
                    {singlePreview.conflict
                      ? tr("skillInstallReplace")
                      : tr("skillInstallConfirm")}
                  </button>
                  <button
                    className="linkButton"
                    onClick={() => setShowInstallDialog(false)}
                  >
                    {tr("skillCategoryCancel")}
                  </button>
                </div>
              </>
            ) : collection ? (
              <>
                <div className="skillsToolbar">
                  <span className="skillsCount">
                    {tr("skillInstallFound", { count: collection.length })}
                  </span>
                  <label className="skillInlineCheck">
                    <input
                      type="checkbox"
                      checked={selectedInstallNames.size === collection.length}
                      onChange={(event) =>
                        setSelectedInstallNames(
                          event.target.checked
                            ? new Set(collection.map((item) => item.targetName))
                            : new Set(),
                        )
                      }
                    />
                    {tr("skillInstallSelectAll")}
                  </label>
                  <label className="skillInlineCheck">
                    <input
                      type="checkbox"
                      checked={installReplace}
                      onChange={(event) =>
                        setInstallReplace(event.target.checked)
                      }
                    />
                    {tr("skillInstallReplaceExisting")}
                  </label>
                </div>
                <ul className="skillPlanList">
                  {collection.map((item) => (
                    <li key={item.targetName}>
                      <label className="skillInlineCheck">
                        <input
                          type="checkbox"
                          checked={selectedInstallNames.has(item.targetName)}
                          onChange={(event) =>
                            setSelectedInstallNames((previous) => {
                              const next = new Set(previous);
                              if (event.target.checked) {
                                next.add(item.targetName);
                              } else {
                                next.delete(item.targetName);
                              }
                              return next;
                            })
                          }
                        />
                        <span className="skillPlanName">{item.name}</span>
                      </label>
                      <span className="skillFileSize">
                        {formatDataSize(item.totalSizeBytes)}
                      </span>
                      {item.conflict ? (
                        <span className="skillTag pending">
                          {tr("skillInstallExists")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="skillDrawerActions">
                  <button
                    className="primaryButton"
                    disabled={installBusy || selectedInstallNames.size === 0}
                    onClick={() => void doInstall()}
                  >
                    {tr("skillInstallSelected", {
                      count: selectedInstallNames.size,
                    })}
                  </button>
                  <button
                    className="linkButton"
                    onClick={() => setShowInstallDialog(false)}
                  >
                    {tr("skillCategoryCancel")}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function renderTrashPanel() {
    if (!showTrash) return null;
    return (
      <section className="categoryManager">
        <div className="categoryManagerHeader">
          <h3>{tr("skillTrashTitle")}</h3>
          <button
            className="iconButton"
            aria-label={tr("skillDetailClose")}
            onClick={() => setShowTrash(false)}
          >
            <XIcon weight="bold" />
          </button>
        </div>
        {trashLoading ? (
          <p className="skillMuted">{tr("skillsScanning")}</p>
        ) : recoverableSkills.length === 0 ? (
          <p className="skillMuted">{tr("skillTrashEmpty")}</p>
        ) : (
          <ul className="categoryList">
            {recoverableSkills.map((item) => (
              <li key={item.id}>
                <div className="categoryRow">
                  <span className="categoryName">{item.name}</span>
                  <div className="categoryActions">
                    <button
                      className="linkButton"
                      onClick={() => void restoreSkillAction(item.id)}
                    >
                      {tr("skillRestore")}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  function renderSkillsContent() {
    const skills = skillScan?.skills ?? [];
    const builtinSkills = skills.filter(
      (skill) => skill.sourceType === "system" || skill.sourceType === "plugin",
    );
    const uploadedSkills = skills.filter(
      (skill) =>
        skill.sourceType !== "system" &&
        skill.sourceType !== "plugin" &&
        skill.sourceType !== "autogateway" &&
        skill.sourceType !== "team",
    );
    const activeLocalSkills =
      skillsTab === "builtin" ? builtinSkills : uploadedSkills;
    const localSummary = {
      total: activeLocalSkills.length,
      enabled: activeLocalSkills.filter((skill) => skill.status === "enabled")
        .length,
      disabled: activeLocalSkills.filter((skill) => skill.status === "disabled")
        .length,
      issues:
        activeLocalSkills.filter(
          (skill) =>
            skill.status === "error" || skill.status === "source-unavailable",
        ).length,
    };
    const sourceTab = (
      key: "builtin" | "uploaded" | "library",
      label: string,
      count: number | null,
      icon: ReactNode,
    ) => (
      <button
        role="tab"
        className={`skillSourceTab ${skillsTab === key ? "selected" : ""}`.trim()}
        aria-selected={skillsTab === key}
        onClick={() => {
          setSkillsTab(key);
          if (key === "library") {
            setLibraryPage(0);
            setLibraryRefreshNonce((nonce) => nonce + 1);
          }
          setSelectedSkillId(null);
          setSkillCategoryFilter("all");
        }}
      >
        {icon}
        <span>{label}</span>
        {count !== null ? <strong>{count}</strong> : null}
      </button>
    );
    const rescanButton = (
      <button
        className="secondaryButton"
        disabled={skillsLoading}
        onClick={() => {
          setPendingReloadIds(new Set());
          setSkillsRefreshNonce((nonce) => nonce + 1);
        }}
      >
        <ArrowsClockwiseIcon weight="bold" />
        {tr("skillsRescan")}
      </button>
    );
    const renderLocalSource = () => {
      const localResults = (
        <>
          <div className="skillListControls">
            <div
              className="skillSummaryStrip"
              aria-label={tr("skillsSummaryLabel")}
            >
              <span>
                <strong>{localSummary.total}</strong>
                {tr("skillsOverviewTotal")}
              </span>
              <span>
                <strong>{localSummary.enabled}</strong>
                {tr("skillsOverviewEnabled")}
              </span>
              <span>
                <strong>
                  {skillsTab === "builtin"
                    ? localSummary.issues
                    : localSummary.disabled}
                </strong>
                {tr(
                  skillsTab === "builtin"
                    ? "skillsOverviewIssues"
                    : "skillsOverviewDisabled",
                )}
              </span>
            </div>
            <div className="skillsToolbar skillFilterBar">
              <label className="skillSearch">
                <MagnifyingGlassIcon weight="bold" />
                <input
                  type="search"
                  value={skillSearch}
                  placeholder={tr("skillsSearchPlaceholder")}
                  onChange={(event) => setSkillSearch(event.target.value)}
                />
              </label>
              <select
                className="skillSelect"
                aria-label={tr("skillsSortLabel")}
                value={skillSort}
                onChange={(event) =>
                  setSkillSort(event.target.value as typeof skillSort)
                }
              >
                <option value="name-asc">{tr("skillsSortNameAsc")}</option>
                <option value="name-desc">{tr("skillsSortNameDesc")}</option>
                <option value="updated-desc">{tr("skillsSortUpdated")}</option>
              </select>
            </div>
          </div>
          {skillCategoryError ? (
            <section className="notice warning">
              <strong>{skillCategoryError}</strong>
            </section>
          ) : null}
          {skillsTab === "uploaded" ? renderTrashPanel() : null}
          {renderInstalledSkills()}
        </>
      );
      return (
        <>
          <div className="skillSourceIntro">
            <div>
              <h2>
                {tr(
                  skillsTab === "builtin"
                    ? "skillsBuiltinTitle"
                    : "skillsUploadedTitle",
                )}
              </h2>
              <p>
                {tr(
                  skillsTab === "builtin"
                    ? "skillsBuiltinDescription"
                    : "skillsUploadedDescription",
                )}
              </p>
            </div>
            <div className="skillSourceActions">
              {skillsTab === "uploaded" ? (
                <>
                  <button
                    className="primaryButton"
                    onClick={() => openInstallDialog()}
                  >
                    <DownloadSimpleIcon weight="bold" />
                    {tr("skillInstall")}
                  </button>
                  <button
                    className="secondaryButton"
                    onClick={() => setShowTrash((open) => !open)}
                  >
                    <TrashIcon weight="bold" />
                    {tr("skillTrashTitle")}
                  </button>
                </>
              ) : null}
              {rescanButton}
            </div>
          </div>
          {skillsTab === "uploaded" ? (
            <div className="skillLibraryLayout">
              {renderSkillCategoryTree(
                skillCategoryFilter,
                setSkillCategoryFilter,
              )}
              <div className="skillLibraryResults">{localResults}</div>
            </div>
          ) : (
            localResults
          )}
          {skillsTab === "uploaded" ? renderInstallDialog() : null}
        </>
      );
    };
    return (
      <section className="homeContent skillsView">
        <header className="skillsHeader">
          <h1>{tr("skillsTitle")}</h1>
          <p className="lead homeLead">{tr("skillsLead")}</p>
        </header>
        <div className="skillsSourceNav" role="tablist">
          {sourceTab(
            "builtin",
            tr("skillsTabBuiltin"),
            builtinSkills.length,
            <CubeIcon weight="duotone" />,
          )}
          {sourceTab(
            "uploaded",
            tr("skillsTabUploaded"),
            uploadedSkills.length,
            <UserCircleIcon weight="duotone" />,
          )}
          {sourceTab(
            "library",
            tr("skillsTabLibrary"),
            libraryError ? null : libraryCatalogTotal,
            <PuzzlePieceIcon weight="duotone" />,
          )}
        </div>
        {skillsTab === "library" ? (
          <>
            <div className="skillSourceIntro">
              <div>
                <h2>{tr("skillsLibraryTitle")}</h2>
                <p>{tr("skillsLibraryDescription")}</p>
              </div>
              <div className="skillSourceActions">
                <button
                  className="primaryButton"
                  onClick={() => void openSkillAdvisor()}
                >
                  <SparkleIcon weight="duotone" />
                  {tr("skillAdvisorOpen")}
                </button>
              </div>
            </div>
            {renderSkillLibrary()}
          </>
        ) : (
          renderLocalSource()
        )}
        {renderSkillDetailDrawer()}
      </section>
    );
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
            onClick={() => {
              const next = !sidebarCollapsed;
              setSidebarCollapsed(next);
              window.localStorage.setItem(
                sidebarCollapsedStorageKey,
                String(next),
              );
            }}
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
                  setLibraryPage(0);
                  setLibraryRefreshNonce((nonce) => nonce + 1);
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
            <HeaderControls
              locale={locale}
              localePreference={localePreference}
              theme={theme}
              onLocaleChange={changeLocale}
              onThemeChange={changeTheme}
            />
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
            renderSkillsContent()
          ) : (
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
            ) : null}
            {homeActionError ? (
              <p className="homeActionMessage" role="alert">
                {homeActionError}
              </p>
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
              <div className="homeMetric">
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
                <div className="homeVersionActions">
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
                  <div className="progressStatusRow">
                    <span className="progressSpinner" aria-hidden="true" />
                    <small>
                      {installProgress.stage === "selecting-source"
                        ? tr("selectingDownloadSource")
                        : installProgress.stage === "closing"
                          ? tr("closingCodex")
                          : installProgress.stage === "verifying"
                            ? tr("verifyingCodex")
                            : installProgress.stage === "opening"
                              ? tr("openingCodex")
                              : tr("replacingCodex")}
                    </small>
                  </div>
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
              {installingCodex &&
              (installProgress?.stage === "closing" ||
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
                    <small>
                      {installProgress.stage === "verifying"
                        ? tr("verifyingCodex")
                        : installProgress.stage === "opening"
                          ? tr("openingCodex")
                          : installProgress.stage === "closing"
                            ? tr("closingCodex")
                          : tr("replacingCodex")}
                    </small>
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
          <HeaderControls
            locale={locale}
            localePreference={localePreference}
            theme={theme}
            onLocaleChange={changeLocale}
            onThemeChange={changeTheme}
          />
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
                disabled={busy}
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
    <App />
  ),
);
