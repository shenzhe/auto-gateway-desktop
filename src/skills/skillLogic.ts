// 技能分类树的纯逻辑：从 main.tsx 提取出来以便单元测试，并为后续 SkillsView
// 拆分提供独立模块。无副作用、不依赖 React 或 Tauri 运行时。
import type { SkillCategoryDto } from "./skillLibrary";

/** 过滤掉禁用分类，按 sortOrder 再按名称稳定排序。 */
export function orderedSkillCategories(
  categories: SkillCategoryDto[],
): SkillCategoryDto[] {
  return categories
    .filter((category) => category.enabled)
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
}

/** 把分类树按父子关系展平成（分类 + 深度）列表，根在前，孤儿节点归到深度 0。 */
export function flattenedSkillCategories(
  categories: SkillCategoryDto[],
): Array<{ category: SkillCategoryDto; depth: number }> {
  const ordered = orderedSkillCategories(categories);
  const categoryIDs = new Set(ordered.map((category) => category.publicId));
  const visited = new Set<string>();
  const flattened: Array<{ category: SkillCategoryDto; depth: number }> = [];
  const visit = (parentPublicId: string, depth: number) => {
    for (const category of ordered) {
      const isRoot =
        !category.parentPublicId || !categoryIDs.has(category.parentPublicId);
      const matchesParent = parentPublicId
        ? category.parentPublicId === parentPublicId
        : isRoot;
      if (!matchesParent || visited.has(category.publicId)) continue;
      visited.add(category.publicId);
      flattened.push({ category, depth });
      visit(category.publicId, depth + 1);
    }
  };
  visit("", 0);
  for (const category of ordered) {
    if (visited.has(category.publicId)) continue;
    visited.add(category.publicId);
    flattened.push({ category, depth: 0 });
  }
  return flattened;
}

/** 从某个分类引用（slug 或 publicId）向上走到根，返回路径（根在前）。 */
export function skillCategoryPath(
  categories: SkillCategoryDto[],
  reference: string | null | undefined,
): SkillCategoryDto[] {
  if (!reference || reference === "all") return [];
  const ordered = orderedSkillCategories(categories);
  const byPublicId = new Map(
    ordered.map((category) => [category.publicId, category] as const),
  );
  let current = ordered.find(
    (category) =>
      category.slug === reference || category.publicId === reference,
  );
  const visited = new Set<string>();
  const path: SkillCategoryDto[] = [];
  while (current && !visited.has(current.publicId)) {
    visited.add(current.publicId);
    path.unshift(current);
    current = current.parentPublicId
      ? byPublicId.get(current.parentPublicId)
      : undefined;
  }
  return path;
}

/** 判定一个分类引用是否落在选中的分类子树下（含子孙）。"all" 匹配一切。 */
export function skillCategoryMatches(
  categories: SkillCategoryDto[],
  categoryReference: string | null | undefined,
  selectedReference: string,
): boolean {
  if (selectedReference === "all") return true;
  return skillCategoryPath(categories, categoryReference).some(
    (category) =>
      category.slug === selectedReference ||
      category.publicId === selectedReference,
  );
}
