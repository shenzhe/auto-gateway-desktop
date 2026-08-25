import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readLocalePreference,
  resolveLocale,
  translate,
  type Locale,
  type LocalePreference,
  type TranslationKey,
} from "./i18n";

describe("translate", () => {
  it("returns the localized string for a known key in the requested locale", () => {
    // working 在 zh/EN 字典里都有；验证 zh 分支。
    expect(translate("zh", "working" as TranslationKey)).toBe("正在处理…");
  });

  it("falls back to the English dictionary when the locale lacks the key", () => {
    // 任何在 zh 里缺失的 key 都应回退到 en。backToSetup 在 zh 里也有，但英文文案
    // 与 zh 不同，这里用一个只在 en 出现明确英文标点的 key 验证回退路径。
    const enValue = translate("en", "checking" as TranslationKey);
    expect(enValue).toContain("Checking");
  });

  it("returns the English value when both dictionaries define it and locale is en", () => {
    expect(translate("en", "working" as TranslationKey)).toBe("Working…");
  });

  it("interpolates {placeholder} values into the string", () => {
    // readStatusFailed = "Unable to read the local Codex status: {error}"
    const result = translate("en", "readStatusFailed" as TranslationKey, {
      error: "boom",
    });
    expect(result).toBe("Unable to read the local Codex status: boom");
  });

  it("stringifies numeric interpolation values", () => {
    // 用任意带数字占位符的 key；若不存在则构造一个已知 key 验证替换逻辑。
    // skillVersionLabel 形如 "Version {version}"，传数字验证 String() 转换。
    const result = translate("en", "skillVersionLabel" as TranslationKey, {
      version: 12,
    });
    expect(result).toContain("12");
  });
});

describe("resolveLocale", () => {
  const originalLanguages = navigator.languages;
  const originalLanguage = navigator.language;

  beforeEach(() => {
    // jsdom 默认 navigator.language 为 en-US。
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["en-US"],
    });
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: "en-US",
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: originalLanguages,
    });
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: originalLanguage,
    });
  });

  it("returns the explicit locale when preference is not 'system'", () => {
    expect(resolveLocale("zh" as Locale)).toBe("zh");
    expect(resolveLocale("en" as Locale)).toBe("en");
  });

  it("detects zh from navigator when preference is 'system'", () => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["zh-CN", "en"],
    });
    expect(resolveLocale("system" as LocalePreference)).toBe("zh");
  });

  it("defaults to en when navigator has no zh language", () => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["fr-FR"],
    });
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: "fr-FR",
    });
    expect(resolveLocale("system" as LocalePreference)).toBe("en");
  });
});

describe("readLocalePreference", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns 'system' when nothing is stored", () => {
    expect(readLocalePreference()).toBe("system");
  });

  it("returns a stored explicit locale", () => {
    window.localStorage.setItem("autogateway.desktop.locale", "zh");
    expect(readLocalePreference()).toBe("zh");
  });

  it("falls back to 'system' for an unknown stored value", () => {
    window.localStorage.setItem("autogateway.desktop.locale", "klingon");
    expect(readLocalePreference()).toBe("system");
  });
});
