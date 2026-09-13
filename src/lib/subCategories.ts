/**
 * 「子类」候选值的**唯一来源**（库存查询筛选 / 新建建档 / 编辑商品三处共用）。
 *
 * ---------- 为什么不做成"受控下拉"（2026-09-13 生产库实测推翻了初判）----------
 *
 * 初版诊断（docs 里那份《商品分类与商品身份诊断》§二）把子类判成
 * 「❌ 自由文本，无法聚合/筛选/统计」——依据是"152 行填了 150 个不同值"。
 * **这个判定是错的。** 逐条看生产库原值后确认：那不是污染，那是老板真实的、
 * 专业的渔具子类词典，每个值都合法，只是**同一子类下往往只有一件货**：
 *
 *   鱼竿：中通竿 / 前打竿 / 插节竿 / 海竿 / 溪流竿 / 矶竿 / 筏竿 / 路亚竿 / 雷强竿
 *   鱼钩：伊势尼 / 丸世 / 千又 / 袖钩 / 海夕 / 新关东 / 爆炸钩 / 曲柄钩 / 朝天钩
 *   渔轮：纺车轮 / 水滴轮 / 鼓轮 / 微型轮
 *
 * 实测：用 ≥2 次的子类只有 2 个（太空豆、新关东），其余 148 个各用 1 次。
 *
 * 所以正解**不是限制取值**——那会把这 150 个真值压成一张小表、丢掉信息；
 * 而是**让已用过的值可以复用**：datalist 给建议，同时仍然允许自由输入。
 * 这样老板打第二个「伊势尼」时不必重打，也不会被逼着把
 * 「伊势尼(粗弯倒刺深)」这种带注解的真值改掉。
 */

/** 只需要这两个字段，便于单测传小对象（不必造整个 Product） */
export interface SubCategorySource {
  category: string
  sub_category: string | null
}

/**
 * 从商品里派生出子类候选值。
 *
 * @param products 商品集合（一般是 store.products 全量）
 * @param category 传了就只返回该**品类**下已用过的子类
 *                 （鱼钩下面不该建议"纺车轮"）。空/未传 = 不限品类。
 * @returns 去重后的子类值；**用得多的排前面**（复用越多的越容易被选中，
 *          形成"越用越收敛"的正循环），同频次按中文名称排序。
 */
export function subCategoryOptions(
  products: readonly SubCategorySource[],
  category?: string | null,
): string[] {
  const counts = new Map<string, number>()
  for (const p of products) {
    if (category && p.category !== category) continue
    const v = (p.sub_category ?? '').trim()
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([v]) => v)
}
