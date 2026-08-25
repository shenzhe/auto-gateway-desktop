// 顶部栏控件：语言/主题切换菜单。从 main.tsx 提取。
// 主题/语言偏好直接从 LocaleContext 消费，不再经 props 传递。
import { useEffect, useRef, useState } from "react";
import {
  CaretDownIcon,
  CheckIcon,
  DesktopIcon,
  MoonIcon,
  SunIcon,
  TranslateIcon,
} from "@phosphor-icons/react";
import { useLocale } from "../context/LocaleContext";
import type { LocalePreference } from "../shared/i18n";
import { translate } from "../shared/i18n";
import type { ThemeMode } from "../shared/theme";

type HeaderMenu = "language" | "theme";

export function HeaderControls() {
  const { locale, localePreference, theme, changeLocale, changeTheme } =
    useLocale();
  const [openMenu, setOpenMenu] = useState<HeaderMenu | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const tr = (key: Parameters<typeof translate>[1]) => translate(locale, key);
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
    changeLocale(nextLocale);
    setOpenMenu(null);
  }

  function selectTheme(nextTheme: ThemeMode) {
    changeTheme(nextTheme);
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
          <span>{locale === "zh" ? tr("chineseShort") : tr("englishShort")}</span>
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
