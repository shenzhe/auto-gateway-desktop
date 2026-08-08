// Phase-2 Skill Library / My Distribution client.
//
// DTOs mirror the server contract in docs/codex-skill-service/api-contract.md.
// The server is not built yet, so this ships a mock implementation. Swapping to
// the real backend is a ONE-LINE change at the bottom of this file
// (`skillLibraryClient = ...`); the real client can call Rust commands or fetch
// api.autogateway.cc while conforming to the same `SkillLibraryClient` interface.
// UI code must treat enum values as open (unknown fallback) per the contract's
// evolution rules and never parse `nextCursor`.

export type SkillVisibility = "private" | "unlisted" | "public";
export type SkillScanRisk = "low" | "medium" | "high" | "unknown";

export type SkillCategoryDto = {
  publicId: string;
  slug: string;
  name: string;
};

export type SkillVersionDto = {
  publicId: string;
  skillPublicId: string;
  version: string;
  status: string;
  archiveSha256: string;
  archiveSize: number;
  fileCount: number;
  changelog?: string;
  scan: {
    scannerVersion: string;
    risk: SkillScanRisk;
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
  visibility: SkillVisibility;
  status: string;
  primaryCategory: SkillCategoryDto;
  tags: string[];
  latestPublishedVersion: SkillVersionDto | null;
  downloadCount: number;
  installCount: number;
  updatedAt: string;
};

export type DownloadLicense = {
  downloadUrl: string;
  expiresAt: string;
  archiveSha256: string;
  archiveSize: number;
  manifestSha256: string;
  version: string;
};

export type ShareLink = {
  publicId: string;
  shareUrl: string;
  expiresAt?: string;
  maxUses?: number;
  useCount: number;
};

export type Installation = {
  publicId: string;
  skillPublicId: string;
  skillName: string;
  versionPublicId: string;
  version: string;
  deviceAlias: string;
  status: "installed" | "uninstalled";
  enabled: boolean;
  reportedAt: string;
};

export type Paged<T> = { items: T[]; nextCursor: string | null };

export type CatalogQuery = {
  q?: string;
  category?: string;
  sort?: "popular" | "newest" | "updated";
  cursor?: string;
  limit?: number;
};

export type UserSkillScope = "owned" | "shared" | "installed" | "all";

export type SkillLibraryClient = {
  listCategories(): Promise<SkillCategoryDto[]>;
  listPublicSkills(query: CatalogQuery): Promise<Paged<PublicSkill>>;
  getPublicSkill(publicId: string): Promise<PublicSkill>;
  listPublicVersions(publicId: string): Promise<Paged<SkillVersionDto>>;
  createDownloadLicense(
    publicId: string,
    versionPublicId: string,
  ): Promise<DownloadLicense>;
  listUserSkills(scope: UserSkillScope): Promise<Paged<PublicSkill>>;
  listShareLinks(skillPublicId: string): Promise<Paged<ShareLink>>;
  listInstallations(): Promise<Paged<Installation>>;
};

// --- Mock implementation -------------------------------------------------

const MOCK_CATEGORIES: SkillCategoryDto[] = [
  { publicId: "cat_dev", slug: "development", name: "Development & Engineering" },
  { publicId: "cat_data", slug: "data", name: "Data & Documents" },
  { publicId: "cat_design", slug: "design", name: "Design & Creative" },
  { publicId: "cat_sec", slug: "security", name: "Security & Quality" },
];

function mockVersion(
  skillPublicId: string,
  version: string,
  risk: SkillScanRisk,
): SkillVersionDto {
  return {
    publicId: `skv_${skillPublicId}_${version}`,
    skillPublicId,
    version,
    status: "published",
    archiveSha256: "4b2f".padEnd(64, "0"),
    archiveSize: 184320,
    fileCount: 12,
    changelog: "Improvements and fixes.",
    scan: {
      scannerVersion: "skill-scanner/1.0.0",
      risk,
      blockingFindings: 0,
      warningFindings: risk === "low" ? 0 : 2,
    },
    publishedAt: "2026-08-05T00:00:00Z",
  };
}

const MOCK_SKILLS: PublicSkill[] = [
  {
    publicId: "sk_release_notes",
    owner: { publicId: "usr_openai", displayName: "AUTO Gateway" },
    slug: "release-notes",
    name: "release-notes",
    displayName: "Release Notes",
    description: "Generate release notes from repository changes.",
    visibility: "public",
    status: "active",
    primaryCategory: MOCK_CATEGORIES[0],
    tags: ["git", "documentation"],
    latestPublishedVersion: mockVersion("sk_release_notes", "1.2.0", "low"),
    downloadCount: 1280,
    installCount: 940,
    updatedAt: "2026-08-05T00:00:00Z",
  },
  {
    publicId: "sk_pr_review",
    owner: { publicId: "usr_openai", displayName: "AUTO Gateway" },
    slug: "pr-review",
    name: "pr-review",
    displayName: "PR Review",
    description: "Review pull requests for correctness and style.",
    visibility: "public",
    status: "active",
    primaryCategory: MOCK_CATEGORIES[3],
    tags: ["review", "quality"],
    latestPublishedVersion: mockVersion("sk_pr_review", "0.9.1", "medium"),
    downloadCount: 860,
    installCount: 610,
    updatedAt: "2026-08-06T00:00:00Z",
  },
  {
    publicId: "sk_data_report",
    owner: { publicId: "usr_community", displayName: "Community" },
    slug: "data-report",
    name: "data-report",
    displayName: "Data Report",
    description: "Summarize CSV and spreadsheet data into a report.",
    visibility: "public",
    status: "active",
    primaryCategory: MOCK_CATEGORIES[1],
    tags: ["data", "csv"],
    latestPublishedVersion: mockVersion("sk_data_report", "2.0.0", "low"),
    downloadCount: 540,
    installCount: 300,
    updatedAt: "2026-08-04T00:00:00Z",
  },
  {
    publicId: "sk_mockups",
    owner: { publicId: "usr_community", displayName: "Community" },
    slug: "ui-mockups",
    name: "ui-mockups",
    displayName: "UI Mockups",
    description: "Produce quick UI mockups and wireframes.",
    visibility: "public",
    status: "active",
    primaryCategory: MOCK_CATEGORIES[2],
    tags: ["design", "ui"],
    latestPublishedVersion: mockVersion("sk_mockups", "1.0.3", "low"),
    downloadCount: 410,
    installCount: 220,
    updatedAt: "2026-08-03T00:00:00Z",
  },
];

const MOCK_INSTALLATIONS: Installation[] = [
  {
    publicId: "ins_1",
    skillPublicId: "sk_release_notes",
    skillName: "release-notes",
    versionPublicId: "skv_sk_release_notes_1.2.0",
    version: "1.2.0",
    deviceAlias: "This Mac",
    status: "installed",
    enabled: true,
    reportedAt: "2026-08-07T08:25:00Z",
  },
];

const MOCK_SHARE_LINKS: ShareLink[] = [
  {
    publicId: "shr_1",
    shareUrl: "https://autogateway.cc/skills/share#example",
    expiresAt: "2026-09-07T00:00:00Z",
    maxUses: 100,
    useCount: 3,
  },
];

function delay<T>(value: T, ms = 160): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export const mockSkillLibraryClient: SkillLibraryClient = {
  listCategories: () => delay(MOCK_CATEGORIES),
  listPublicSkills: (query) => {
    const q = query.q?.trim().toLowerCase();
    let items = MOCK_SKILLS.filter(
      (skill) =>
        (!query.category || skill.primaryCategory.slug === query.category) &&
        (!q ||
          skill.displayName.toLowerCase().includes(q) ||
          skill.description.toLowerCase().includes(q)),
    );
    if (query.sort === "popular") {
      items = [...items].sort((a, b) => b.downloadCount - a.downloadCount);
    } else if (query.sort === "newest" || query.sort === "updated") {
      items = [...items].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    }
    return delay({ items, nextCursor: null });
  },
  getPublicSkill: (publicId) => {
    const skill = MOCK_SKILLS.find((item) => item.publicId === publicId);
    return skill
      ? delay(skill)
      : Promise.reject(new Error("SKILL_NOT_FOUND"));
  },
  listPublicVersions: (publicId) => {
    const skill = MOCK_SKILLS.find((item) => item.publicId === publicId);
    const items = skill?.latestPublishedVersion
      ? [skill.latestPublishedVersion]
      : [];
    return delay({ items, nextCursor: null });
  },
  createDownloadLicense: (publicId, versionPublicId) =>
    delay({
      downloadUrl: `https://mock.local/${publicId}/${versionPublicId}`,
      expiresAt: "2026-08-07T08:20:00Z",
      archiveSha256: "4b2f".padEnd(64, "0"),
      archiveSize: 184320,
      manifestSha256: "8c90".padEnd(64, "0"),
      version: "1.2.0",
    }),
  listUserSkills: (scope) => {
    const items =
      scope === "installed"
        ? MOCK_SKILLS.slice(0, 1)
        : MOCK_SKILLS.slice(0, 2);
    return delay({ items, nextCursor: null });
  },
  listShareLinks: () => delay({ items: MOCK_SHARE_LINKS, nextCursor: null }),
  listInstallations: () => delay({ items: MOCK_INSTALLATIONS, nextCursor: null }),
};

// Swap point: replace with the real client when the server ships.
export const skillLibraryClient: SkillLibraryClient = mockSkillLibraryClient;

// True while the mock backs the library — the UI shows a "mock data" banner.
export const skillLibraryIsMock = true;
