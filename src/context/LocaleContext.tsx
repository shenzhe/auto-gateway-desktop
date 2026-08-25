// LocaleContext：持有主题、语言、侧栏折叠等"全局 UI 偏好"状态。
// 把这些低频变化的状态从 App 单体中拆出，使切换主题/语言时只触发消费这些
// 值的组件重渲染，而非整个 App 树。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  readLocalePreference,
  resolveLocale,
  translate,
  writeLocalePreference,
  type Locale,
  type LocalePreference,
} from "../shared/i18n";
import { applyTheme, readTheme, writeTheme, type ThemeMode } from "../shared/theme";

const sidebarCollapsedStorageKey =
  "autogateway.desktop.sidebar-collapsed.v1";

type LocaleContextValue = {
  locale: Locale;
  tr: (
    key: Parameters<typeof translate>[1],
    values?: Record<string, string | number>,
  ) => string;
  theme: ThemeMode;
  changeTheme: (nextTheme: ThemeMode) => void;
  localePreference: LocalePreference;
  changeLocale: (nextLocale: LocalePreference) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (next: boolean | ((prev: boolean) => boolean)) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(() => readTheme());
  const [localePreference, setLocalePreference] = useState<LocalePreference>(
    () => readLocalePreference(),
  );
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(
    () => window.localStorage.getItem(sidebarCollapsedStorageKey) === "true",
  );

  const locale = resolveLocale(localePreference);

  // tr 仅在 locale 变化时重建；稳定引用便于下游 memo 子组件。
  const tr = useCallback(
    (
      key: Parameters<typeof translate>[1],
      values?: Record<string, string | number>,
    ) => translate(locale, key, values),
    [locale],
  );

  const changeTheme = useCallback((nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    writeTheme(nextTheme);
  }, []);

  const changeLocale = useCallback((nextLocale: LocalePreference) => {
    setLocalePreference(nextLocale);
    writeLocalePreference(nextLocale);
  }, []);

  const setSidebarCollapsed = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setSidebarCollapsedState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        window.localStorage.setItem(
          sidebarCollapsedStorageKey,
          String(value),
        );
        return value;
      });
    },
    [],
  );

  // 主题应用 + 系统主题变化监听。
  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const refreshSystemTheme = () => theme === "system" && applyTheme(theme);
    media?.addEventListener("change", refreshSystemTheme);
    return () => media?.removeEventListener("change", refreshSystemTheme);
  }, [theme]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      tr,
      theme,
      changeTheme,
      localePreference,
      changeLocale,
      sidebarCollapsed,
      setSidebarCollapsed,
    }),
    [
      locale,
      tr,
      theme,
      changeTheme,
      localePreference,
      changeLocale,
      sidebarCollapsed,
      setSidebarCollapsed,
    ],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale must be used within a LocaleProvider");
  }
  return ctx;
}
