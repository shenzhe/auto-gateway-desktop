import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 拦截 Tauri 的 invoke，记录调用参数并返回可控结果。
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// 在 mock 生效后导入被测模块。
import {
  closeCodex,
  configureCodex,
  exportSkill,
  getCodexStatus,
  getSkillDetail,
  installSkill,
  isCodexExternalInstallationComplete,
  openCodex,
  scanSkills,
  validateSkillSource,
} from "./desktop";

describe("desktop.ts invoke wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scanSkills calls invoke with the scan_skills command and no args", async () => {
    invokeMock.mockResolvedValue({ skills: [] });
    await scanSkills();
    expect(invokeMock).toHaveBeenCalledWith("scan_skills");
  });

  it("getCodexStatus calls invoke with get_codex_status", async () => {
    invokeMock.mockResolvedValue({ configured: true });
    await getCodexStatus();
    expect(invokeMock).toHaveBeenCalledWith("get_codex_status");
  });

  it("getSkillDetail passes the id under { id }", async () => {
    invokeMock.mockResolvedValue({});
    await getSkillDetail("skill-123");
    expect(invokeMock).toHaveBeenCalledWith("get_skill_detail", {
      id: "skill-123",
    });
  });

  it("installSkill maps all parameters to the install_skill command", async () => {
    invokeMock.mockResolvedValue({});
    await installSkill("git", "owner/repo", true, ["a", "b"], "cat-1");
    expect(invokeMock).toHaveBeenCalledWith("install_skill", {
      kind: "git",
      location: "owner/repo",
      replace: true,
      names: ["a", "b"],
      categoryId: "cat-1",
    });
  });

  it("installSkill forwards undefined categoryId as undefined", async () => {
    invokeMock.mockResolvedValue({});
    await installSkill("dir", "/path", false, []);
    expect(invokeMock).toHaveBeenCalledWith("install_skill", {
      kind: "dir",
      location: "/path",
      replace: false,
      names: [],
      categoryId: undefined,
    });
  });

  it("validateSkillSource passes kind and location", async () => {
    invokeMock.mockResolvedValue([]);
    await validateSkillSource("zip", "/path/to/skill.zip");
    expect(invokeMock).toHaveBeenCalledWith("validate_skill_source", {
      kind: "zip",
      location: "/path/to/skill.zip",
    });
  });

  it("exportSkill passes the id", async () => {
    invokeMock.mockResolvedValue({});
    await exportSkill("skill-1");
    expect(invokeMock).toHaveBeenCalledWith("export_skill", { id: "skill-1" });
  });

  it("configureCodex passes api_key and endpoint", async () => {
    invokeMock.mockResolvedValue({});
    await configureCodex("sk-xxx", "https://endpoint");
    expect(invokeMock).toHaveBeenCalledWith("configure_codex", {
      apiKey: "sk-xxx",
      endpoint: "https://endpoint",
    });
  });

  it("closeCodex passes the optional target_path", async () => {
    invokeMock.mockResolvedValue(undefined);
    await closeCodex("/Applications/Codex.app");
    expect(invokeMock).toHaveBeenCalledWith("close_codex", {
      targetPath: "/Applications/Codex.app",
    });
  });

  it("openCodex calls invoke with no args", async () => {
    invokeMock.mockResolvedValue(undefined);
    await openCodex();
    expect(invokeMock).toHaveBeenCalledWith("open_codex");
  });

  it("returns the invoke result to the caller", async () => {
    const payload = { configured: true, providerStatus: "autogateway" };
    invokeMock.mockResolvedValue(payload);
    await expect(getCodexStatus()).resolves.toEqual(payload);
  });

  it("propagates invoke rejections", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await expect(scanSkills()).rejects.toThrow("boom");
  });
});

describe("Codex external installation completion", () => {
  const installedStatus = {
    installed: true,
    platformMessage: "installed",
  };

  it("completes a first-time installation when the app is present", () => {
    expect(isCodexExternalInstallationComplete(installedStatus, false)).toBe(
      true,
    );
  });

  it("keeps waiting for an update while the old version remains", () => {
    expect(
      isCodexExternalInstallationComplete(
        { ...installedStatus, updateAvailable: true },
        true,
      ),
    ).toBe(false);
  });

  it("completes an update only after the latest version is installed", () => {
    expect(
      isCodexExternalInstallationComplete(
        { ...installedStatus, updateAvailable: false },
        true,
      ),
    ).toBe(true);
  });
});
