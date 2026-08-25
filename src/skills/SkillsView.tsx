// SkillsView：技能管理视图（安装技能 / 技能库 / Skill Advisor）。从 App 单体提取，
// 自包含所有 skills 域的 state、effects、handlers 和 render 函数。
// 仅在 activeView === "skills" 时由 App 挂载，从而避免 skills 频繁的 state 变化
// 触发整个 App 树重渲染。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleTextIcon,
  CheckIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  CubeIcon,
  DownloadSimpleIcon,
  MagnifyingGlassIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  PlusIcon,
  PuzzlePieceIcon,
  SparkleIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import {
  disableSkill,
  enableSkill,
  exportSkill,
  getSkillDetail,
  installSkill,
  listRecoverableSkills,
  removeSkill,
  restoreSkill,
  scanSkills,
  setSkillCategory,
  setSkillTags,
  validateSkillSource,
  type RecoverableSkill,
  type SkillDetail,
  type SkillExportResult,
  type SkillFileEntry,
  type SkillInstallPreview,
  type SkillInstallProgress,
  type SkillInstallSourceKind,
  type SkillInstallSummary,
  type SkillRecord,
  type SkillScanResult,
} from "../shared/desktop";
import { trackSkillEvent } from "../shared/analytics";
import {
  orderedSkillCategories,
  flattenedSkillCategories,
  skillCategoryMatches,
  skillCategoryPath,
} from "../skills/skillLogic";
import {
  skillCatalogPageSize,
  skillLibraryClient,
  type PublicSkill,
  type SkillAdvisorConversation,
  type SkillAdvisorMessage,
  type SkillCategoryDto,
  type SkillRecommendationResponse,
} from "../skills/skillLibrary";
import { MarkdownContent } from "../components/MarkdownContent";
import { formatDataSize } from "../shared/format";
import { useLocale } from "../context/LocaleContext";

const skillSearchDebounceMs = 350;



export type SkillsViewProps = {
  /** 桌面端访问令牌；用于上报卸载、安装技能库技能等需鉴权的后端调用。 */
  desktopAccessToken: string;
  /** 稳定的外链打开回调（传给 MarkdownContent）。 */
  openExternalUrl: (url: string) => void;
};

export function SkillsView({
  desktopAccessToken,
  openExternalUrl,
}: SkillsViewProps) {
  const { tr, locale } = useLocale();

  // SkillsView 仅在 activeView === "skills" 时挂载，effects 中的
  // activeView !== "skills" 守卫恒为 false（即始终通过）。
  const activeView = "skills" as const;

  // 进入技能视图时的 priming：重置分页并触发库刷新（原由 App 的 nav 按钮执行）。
  useEffect(() => {
    setLibraryPage(0);
    setLibraryRefreshNonce((nonce) => nonce + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // 已安装技能列表分页：上传技能较多时避免一次性渲染全部卡片。
  const [installedSkillPage, setInstalledSkillPage] = useState(0);
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

  const completedAuthorizationCode = useRef("");
  const skillAdvisorEndRef = useRef<HTMLDivElement>(null);
  const skillAdvisorInputRef = useRef<HTMLTextAreaElement>(null);
  const skillAdvisorConversationGenerationRef = useRef(0);
  const skillAdvisorHistoryInitializedRef = useRef(false);
  const libraryIndexRefreshRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);

  // —— 派生数据（useMemo）：把 filter/sort 从 render 函数里提出来，避免每次渲染都重算 ——
  // 已安装技能列表（renderInstalledSkills）
  const visibleInstalledSkills = useMemo(() => {
    const skills = skillScan?.skills ?? [];
    const scopedSkills = skills.filter((skill) =>
      skillsTab === "builtin"
        ? skill.sourceType === "system" || skill.sourceType === "plugin"
        : skill.sourceType !== "system" &&
          skill.sourceType !== "plugin" &&
          skill.sourceType !== "autogateway" &&
          skill.sourceType !== "team",
    );
    const query = skillSearch.trim().toLowerCase();
    return scopedSkills
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
  }, [
    skillScan,
    skillsTab,
    skillSearch,
    skillCategoryFilter,
    skillSort,
  ]);

  // 技能库派生数据（renderSkillLibrary）
  const libraryInstalledSkills = useMemo(
    () =>
      (skillScan?.skills ?? []).filter(
        (skill) =>
          skill.sourceType === "autogateway" || skill.sourceType === "team",
      ),
    [skillScan],
  );
  const libraryDerived = useMemo(() => {
    const installedNames = new Set(
      libraryInstalledSkills.map((skill) => skill.name),
    );
    const catalogByName = new Map(
      libraryItems.map((skill) => [skill.name, skill] as const),
    );
    const query = librarySearch.trim().toLowerCase();
    const visibleInstalled = libraryInstalledSkills
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
    const available = libraryItems.filter(
      (skill) => !installedNames.has(skill.name),
    );
    return { installedNames, visibleInstalled, available };
  }, [
    libraryInstalledSkills,
    libraryItems,
    libraryCategories,
    libraryCategory,
    librarySearch,
  ]);

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
    const { visibleInstalled: visibleInstalledSkills, available: availableSkills } =
      libraryDerived;
    const query = librarySearch.trim().toLowerCase();
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
    // visible 来自 App 顶层 useMemo，仅依赖 skillScan/skillsTab/skillSearch/
    // skillCategoryFilter/skillSort，避免每次渲染重算 filter+sort。
    const visible = visibleInstalledSkills;
    const pageCount = Math.max(
      1,
      Math.ceil(visible.length / skillCatalogPageSize),
    );
    const currentPage = Math.min(installedSkillPage, pageCount - 1);
    const pageStart = currentPage * skillCatalogPageSize;
    const pagedVisible = visible.slice(
      pageStart,
      pageStart + skillCatalogPageSize,
    );
    return (
      <>
        {visible.length === 0 ? (
          <div className="skillsComingSoon">
            <MagnifyingGlassIcon weight="duotone" />
            <strong>{tr("skillsNoMatches")}</strong>
          </div>
        ) : (
          <>
            <div className="skillList">
              {pagedVisible.map((skill) => renderSkillCard(skill))}
            </div>
            {visible.length > skillCatalogPageSize ? (
              <nav
                className="skillCatalogPagination"
                aria-label={tr("skillLibraryPagination")}
              >
                <button
                  className="secondaryButton"
                  disabled={currentPage === 0}
                  onClick={() => setInstalledSkillPage(currentPage - 1)}
                >
                  <ArrowLeftIcon weight="bold" />
                  {tr("skillLibraryPreviousPage")}
                </button>
                <span>
                  {tr("skillLibraryPageStatus", {
                    current: currentPage + 1,
                    total: pageCount,
                  })}
                </span>
                <button
                  className="secondaryButton"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setInstalledSkillPage(currentPage + 1)}
                >
                  {tr("skillLibraryNextPage")}
                  <ArrowRightIcon weight="bold" />
                </button>
              </nav>
            ) : null}
          </>
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
                      onOpenLink={openExternalUrl}
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

  // SkillsView 渲染入口：renderSkillsContent 是主渲染函数。
  return renderSkillsContent();
}
