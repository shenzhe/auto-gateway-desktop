import { invoke } from "@tauri-apps/api/core";
import type { SkillInstallSummary } from "./desktop";

export type SkillScanRisk =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "blocked"
  | "unknown";

export type SkillCategoryDto = {
  publicId: string;
  parentPublicId: string;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
};

export type SkillVersionDto = {
  publicId: string;
  skillPublicId: string;
  version: string;
  status: string;
  archiveSha256: string;
  archiveSize: number;
  fileCount: number;
  changelog: string;
  scan: {
    scannerVersion: string;
    risk: SkillScanRisk | string;
    blockingFindings: number;
    warningFindings: number;
  };
  publishedAt?: string;
};

export type PublicSkill = {
  publicId: string;
  owner: { publicId: string; displayName: string };
  slug: string;
  name: string;
  displayName: string;
  description: string;
  visibility: string;
  status: string;
  primaryCategory: SkillCategoryDto | null;
  tags: string[];
  latestPublishedVersion: SkillVersionDto | null;
  downloadCount: number;
  installCount: number;
  updatedAt: string;
};

export type Paged<T> = {
  items: T[];
  total?: number;
  limit?: number;
  offset?: number;
  hasNext?: boolean;
  hasPrevious?: boolean;
  nextCursor: string | null;
};

export const skillCatalogPageSize = 20;

export type CatalogQuery = {
  q?: string;
  category?: string;
  sort?: "popular" | "newest" | "updated";
  offset?: number;
};

export type SkillAdvisorMessage = {
  role: "user" | "assistant";
  content: string;
};

export type SkillRecommendationResponse = {
  reply: string;
  recommendedPublicIds: string[];
  needsMoreContext: boolean;
  usedFallback: boolean;
};

export type SkillLibraryClient = {
  listCategories(locale: "en" | "zh"): Promise<SkillCategoryDto[]>;
  listPublicSkills(
    query: CatalogQuery,
    locale: "en" | "zh",
  ): Promise<Paged<PublicSkill>>;
  installPublicSkill(
    publicId: string,
    versionPublicId: string,
    replace?: boolean,
    categoryId?: string,
    accessToken?: string,
  ): Promise<SkillInstallSummary>;
  reportUninstalled(id: string, accessToken: string): Promise<boolean>;
  recommendSkills(
    catalog: PublicSkill[],
    messages: SkillAdvisorMessage[],
    locale: "en" | "zh",
    apiKey: string,
    endpoint: string,
  ): Promise<SkillRecommendationResponse>;
};

export const skillLibraryClient: SkillLibraryClient = {
  listCategories: (locale) =>
    invoke<SkillCategoryDto[]>("list_ag_skill_categories", { locale }),
  listPublicSkills: (query, locale) =>
    invoke<Paged<PublicSkill>>("list_ag_skills", {
      query: query.q,
      category: query.category,
      sort: query.sort,
      offset: query.offset,
      locale,
    }),
  installPublicSkill: (
    publicId,
    versionPublicId,
    replace = false,
    categoryId,
    accessToken = "",
  ) =>
    invoke<SkillInstallSummary>("install_ag_skill", {
      publicId,
      versionPublicId,
      replace,
      categoryId,
      accessToken,
    }),
  reportUninstalled: (id, accessToken) =>
    invoke<boolean>("report_ag_skill_uninstalled", { id, accessToken }),
  recommendSkills: (catalog, messages, locale, apiKey, endpoint) =>
    invoke<SkillRecommendationResponse>("recommend_ag_skills", {
      catalog,
      messages,
      locale,
      apiKey,
      endpoint,
    }),
};
