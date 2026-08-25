import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { skillLibraryClient } from "./skillLibrary";

describe("skillLibraryClient invoke wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listCategories passes the locale", async () => {
    invokeMock.mockResolvedValue([]);
    await skillLibraryClient.listCategories("zh");
    expect(invokeMock).toHaveBeenCalledWith("list_ag_skill_categories", {
      locale: "zh",
    });
  });

  it("refreshIndex passes the locale", async () => {
    invokeMock.mockResolvedValue({ total: 0, changed: false });
    await skillLibraryClient.refreshIndex("en");
    expect(invokeMock).toHaveBeenCalledWith("refresh_ag_skill_index", {
      locale: "en",
    });
  });

  it("listPublicSkills maps CatalogQuery fields to flat params", async () => {
    invokeMock.mockResolvedValue({ items: [], nextCursor: null });
    await skillLibraryClient.listPublicSkills(
      { q: "search", category: "cat", sort: "newest", offset: 20 },
      "en",
    );
    expect(invokeMock).toHaveBeenCalledWith("list_ag_skills", {
      query: "search",
      category: "cat",
      sort: "newest",
      offset: 20,
      locale: "en",
    });
  });

  it("listPublicSkills forwards undefined query fields", async () => {
    invokeMock.mockResolvedValue({ items: [], nextCursor: null });
    await skillLibraryClient.listPublicSkills({}, "zh");
    expect(invokeMock).toHaveBeenCalledWith("list_ag_skills", {
      query: undefined,
      category: undefined,
      sort: undefined,
      offset: undefined,
      locale: "zh",
    });
  });

  it("installPublicSkill applies defaults (replace=false, accessToken='')", async () => {
    invokeMock.mockResolvedValue({});
    await skillLibraryClient.installPublicSkill("pid", "vid");
    expect(invokeMock).toHaveBeenCalledWith("install_ag_skill", {
      publicId: "pid",
      versionPublicId: "vid",
      replace: false,
      categoryId: undefined,
      accessToken: "",
    });
  });

  it("installPublicSkill forwards explicit optional params", async () => {
    invokeMock.mockResolvedValue({});
    await skillLibraryClient.installPublicSkill(
      "pid",
      "vid",
      true,
      "cat",
      "token",
    );
    expect(invokeMock).toHaveBeenCalledWith("install_ag_skill", {
      publicId: "pid",
      versionPublicId: "vid",
      replace: true,
      categoryId: "cat",
      accessToken: "token",
    });
  });

  it("reportUninstalled passes id and accessToken", async () => {
    invokeMock.mockResolvedValue(true);
    await skillLibraryClient.reportUninstalled("id", "token");
    expect(invokeMock).toHaveBeenCalledWith("report_ag_skill_uninstalled", {
      id: "id",
      accessToken: "token",
    });
  });

  it("recommendSkills passes the full payload including excluded names", async () => {
    invokeMock.mockResolvedValue({});
    const catalog = [
      { name: "a", publicId: "pa" },
    ] as never;
    const messages = [{ role: "user", content: "hi" }] as never;
    await skillLibraryClient.recommendSkills(
      catalog,
      messages,
      "zh",
      "thread-1",
      ["installed-name"],
    );
    expect(invokeMock).toHaveBeenCalledWith("recommend_ag_skills", {
      catalog,
      messages,
      locale: "zh",
      threadId: "thread-1",
      excludedSkillNames: ["installed-name"],
    });
  });

  it("saveAdvisorConversation passes the conversation under { conversation }", async () => {
    invokeMock.mockResolvedValue({});
    const conversation = {
      id: "c1",
      title: "T",
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      recommendedPublicIds: [],
      recommendedSkills: [],
      usedFallback: false,
      threadId: null,
    } as never;
    await skillLibraryClient.saveAdvisorConversation(conversation);
    expect(invokeMock).toHaveBeenCalledWith("save_ag_skill_advisor_conversation", {
      conversation,
    });
  });

  it("deleteAdvisorConversation passes the conversationId", async () => {
    invokeMock.mockResolvedValue(null);
    await skillLibraryClient.deleteAdvisorConversation("c1");
    expect(invokeMock).toHaveBeenCalledWith(
      "delete_ag_skill_advisor_conversation",
      { conversationId: "c1" },
    );
  });

  it("returns the invoke result to the caller", async () => {
    invokeMock.mockResolvedValue([{ slug: "x" }]);
    const result = await skillLibraryClient.listCategories("en");
    expect(result).toEqual([{ slug: "x" }]);
  });
});
