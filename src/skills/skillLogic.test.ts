import { describe, expect, it } from "vitest";
import type { SkillCategoryDto } from "./skillLibrary";
import {
  flattenedSkillCategories,
  orderedSkillCategories,
  skillCategoryMatches,
  skillCategoryPath,
} from "./skillLogic";

function makeCategory(overrides: Partial<SkillCategoryDto>): SkillCategoryDto {
  return {
    publicId: overrides.publicId ?? "id",
    parentPublicId: overrides.parentPublicId ?? "",
    slug: overrides.slug ?? "slug",
    name: overrides.name ?? "Category",
    description: overrides.description ?? "",
    sortOrder: overrides.sortOrder ?? 0,
    enabled: overrides.enabled ?? true,
  };
}

describe("orderedSkillCategories", () => {
  it("drops disabled categories", () => {
    const result = orderedSkillCategories([
      makeCategory({ publicId: "a", enabled: true }),
      makeCategory({ publicId: "b", enabled: false }),
    ]);
    expect(result.map((c) => c.publicId)).toEqual(["a"]);
  });

  it("sorts by sortOrder then by name", () => {
    const result = orderedSkillCategories([
      makeCategory({ publicId: "b", sortOrder: 1, name: "Bravo" }),
      makeCategory({ publicId: "a", sortOrder: 1, name: "Alpha" }),
      makeCategory({ publicId: "c", sortOrder: 0, name: "Charlie" }),
    ]);
    expect(result.map((c) => c.publicId)).toEqual(["c", "a", "b"]);
  });
});

describe("flattenedSkillCategories", () => {
  it("places children under their parent with increasing depth", () => {
    const tree = [
      makeCategory({ publicId: "root", sortOrder: 0 }),
      makeCategory({ publicId: "child", parentPublicId: "root", sortOrder: 1 }),
      makeCategory({
        publicId: "grandchild",
        parentPublicId: "child",
        sortOrder: 2,
      }),
    ];
    const flat = flattenedSkillCategories(tree);
    expect(flat.map((n) => [n.category.publicId, n.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ]);
  });

  it("orphan nodes (parent missing) are placed at depth 0", () => {
    const flat = flattenedSkillCategories([
      makeCategory({ publicId: "orphan", parentPublicId: "missing" }),
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].depth).toBe(0);
  });
});

describe("skillCategoryPath", () => {
  it("returns [] for null, undefined, and 'all'", () => {
    expect(skillCategoryPath([], null)).toEqual([]);
    expect(skillCategoryPath([], undefined)).toEqual([]);
    expect(skillCategoryPath([], "all")).toEqual([]);
  });

  it("walks from a node up to the root, root first", () => {
    const tree = [
      makeCategory({ publicId: "root" }),
      makeCategory({ publicId: "mid", parentPublicId: "root" }),
      makeCategory({ publicId: "leaf", parentPublicId: "mid" }),
    ];
    const path = skillCategoryPath(tree, "leaf");
    expect(path.map((c) => c.publicId)).toEqual(["root", "mid", "leaf"]);
  });

  it("matches a node by either slug or publicId", () => {
    const tree = [makeCategory({ publicId: "pid", slug: "sl" })];
    expect(skillCategoryPath(tree, "sl").map((c) => c.publicId)).toEqual([
      "pid",
    ]);
    expect(skillCategoryPath(tree, "pid").map((c) => c.publicId)).toEqual([
      "pid",
    ]);
  });

  it("breaks cycles safely (does not loop forever)", () => {
    // 两个互相指对方的节点。
    const tree = [
      makeCategory({ publicId: "a", parentPublicId: "b" }),
      makeCategory({ publicId: "b", parentPublicId: "a" }),
    ];
    const path = skillCategoryPath(tree, "a");
    // 应在访问过的节点处停止，结果有限。
    expect(path.length).toBeLessThanOrEqual(2);
  });
});

describe("skillCategoryMatches", () => {
  const tree = [
    makeCategory({ publicId: "root", slug: "root-slug" }),
    makeCategory({ publicId: "child", parentPublicId: "root", slug: "child-slug" }),
  ];

  it("returns true for 'all' regardless of reference", () => {
    expect(skillCategoryMatches(tree, "child-slug", "all")).toBe(true);
    expect(skillCategoryMatches(tree, null, "all")).toBe(true);
  });

  it("matches when the selected reference is an ancestor of the category", () => {
    // child 的路径是 [root, child]，选中 root 应匹配。
    expect(skillCategoryMatches(tree, "child-slug", "root-slug")).toBe(true);
  });

  it("does not match when the selected reference is outside the path", () => {
    // root 的路径是 [root]，选中 child 不应匹配。
    expect(skillCategoryMatches(tree, "root-slug", "child-slug")).toBe(false);
  });
});
