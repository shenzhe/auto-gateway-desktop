import { describe, expect, it } from "vitest";
import {
  formatBalance,
  formatBalanceAlertAmount,
  formatDataSize,
  formatDownloadSpeed,
  formatFullSyncTime,
  formatRemainingDuration,
  formatSubscriptionResetAt,
  parseBalanceAmount,
  subscriptionUsagePercent,
} from "./format";

describe("parseBalanceAmount", () => {
  it("parses a prefixed amount and strips thousands separators", () => {
    expect(parseBalanceAmount("$1,234.50")).toBe(1234.5);
    expect(parseBalanceAmount("¥100")).toBe(100);
  });

  it("returns null for empty input", () => {
    expect(parseBalanceAmount("")).toBeNull();
  });

  it("treats a pure non-numeric string as 0 (known edge case: trailing empty slice)", () => {
    // 已知边界：纯前缀字符串（如 "abc"）切片后为空，Number("")===0。
    // 测试记录现状；如未来改为返回 null，更新此断言即可。
    expect(parseBalanceAmount("abc")).toBe(0);
  });
});

describe("formatBalance", () => {
  it("returns empty string for empty/whitespace input", () => {
    expect(formatBalance("", "en")).toBe("");
    expect(formatBalance("   ", "en")).toBe("");
  });

  it("preserves the currency prefix and formats the amount", () => {
    expect(formatBalance("$1000", "en")).toBe("$1,000.00");
  });

  it("formats a pure-prefix string as <prefix>0.00 (known edge case)", () => {
    // 与 parseBalanceAmount 一致："$abc" 切片为空 → 0；前缀被保留。
    expect(formatBalance("$abc", "en")).toBe("$abc0.00");
  });
});

describe("formatBalanceAlertAmount", () => {
  it("formats as USD currency", () => {
    expect(formatBalanceAlertAmount("$1000", "en")).toContain("1,000.00");
  });

  it("formats a pure-prefix string as USD 0.00 (known edge case)", () => {
    expect(formatBalanceAlertAmount("  abc  ", "en")).toContain("0.00");
  });
});

describe("subscriptionUsagePercent", () => {
  it("computes and clamps to [0,100]", () => {
    expect(subscriptionUsagePercent(25, 100)).toBe(25);
    expect(subscriptionUsagePercent(150, 100)).toBe(100);
    expect(subscriptionUsagePercent(0, 100)).toBe(0);
  });

  it("returns 0 for invalid inputs", () => {
    expect(subscriptionUsagePercent(NaN, 100)).toBe(0);
    expect(subscriptionUsagePercent(50, 0)).toBe(0);
    expect(subscriptionUsagePercent(50, -10)).toBe(0);
  });
});

describe("formatFullSyncTime", () => {
  it("returns the fallback for null", () => {
    expect(formatFullSyncTime(null, "en", "—")).toBe("—");
  });

  it("treats timestamp 0 as no-value (known: 0 is falsy)", () => {
    // 已知边界：value 为 0 时被当作无值返回 fallback。
    expect(formatFullSyncTime(0, "en", "—")).toBe("—");
  });

  it("formats a non-zero timestamp into a localized string containing the year", () => {
    // 2000-01-01T00:00:00Z 的毫秒数。
    const result = formatFullSyncTime(946684800000, "en", "—");
    expect(result).toMatch(/2000/);
  });
});

describe("formatSubscriptionResetAt", () => {
  it("returns empty for empty input", () => {
    expect(formatSubscriptionResetAt("", "en")).toBe("");
  });

  it("returns empty for an invalid date string", () => {
    expect(formatSubscriptionResetAt("not-a-date", "en")).toBe("");
  });
});

describe("formatDownloadSpeed / formatDataSize", () => {
  it("formats bytes with units and scales up", () => {
    expect(formatDataSize(0)).toBe("0 B");
    expect(formatDataSize(1024)).toBe("1.0 KB");
    expect(formatDataSize(1048576)).toBe("1.0 MB");
  });

  it("returns empty for invalid size input", () => {
    expect(formatDataSize(undefined)).toBe("");
    expect(formatDataSize(-1)).toBe("");
    expect(formatDataSize(NaN)).toBe("");
  });

  it("formats speed with /s units", () => {
    expect(formatDownloadSpeed(2048)).toBe("2.0 KB/s");
  });

  it("returns empty for invalid speed input", () => {
    expect(formatDownloadSpeed(0)).toBe("");
    expect(formatDownloadSpeed(undefined)).toBe("");
    expect(formatDownloadSpeed(-1)).toBe("");
  });
});

describe("formatRemainingDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatRemainingDuration(45)).toBe("45s");
    expect(formatRemainingDuration(45.6)).toBe("46s"); // 向上取整
  });

  it("formats minutes with remainder seconds", () => {
    expect(formatRemainingDuration(125)).toBe("2m 5s");
  });

  it("returns empty for invalid input", () => {
    expect(formatRemainingDuration(undefined)).toBe("");
    expect(formatRemainingDuration(-1)).toBe("");
  });
});
