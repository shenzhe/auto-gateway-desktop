export type ThemeMode = "system" | "light" | "dark";

const themeStorageKey = "autogateway.desktop.theme";

export function readTheme(): ThemeMode {
  const value = window.localStorage.getItem(themeStorageKey);
  return value === "light" || value === "dark" ? value : "system";
}

export function writeTheme(theme: ThemeMode) {
  window.localStorage.setItem(themeStorageKey, theme);
}

export function applyTheme(theme: ThemeMode) {
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  document.documentElement.dataset.theme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
}
