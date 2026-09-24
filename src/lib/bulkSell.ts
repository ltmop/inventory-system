// 散货（按金额卖）的唯一口径 —— 老板 2026-09-23 原话：
//   「比如进货蚯蚓，卖价一斤 70 块；一般客户都是买整数，比如 5、10、15、20」→ 追问后确认：
//   **不是 5 克，是 5 块钱；5 块钱正常是 35 克蚯蚓**（¥70/斤 = ¥0.14/克 → 5 ÷ 0.14 ≈ 35.7 克）。
//
// 所以散货的真实动作是「客户说来 5 块钱的」→ 收银按金额一键入车，**重量由系统按单价折算**。
// 不是让收银去心算 5 块钱几克，也不是让客户报克数。
//
// 为什么放在 lib 而不是页面里：这段要被「开单页快选」「手机端开单」「日结对账」共用，
// 口径只写一遍（与 lib/quantity.ts、lib/moneyAccounts.ts 同一个套路）。
// 数量精度跟随系统既有口径：**最多 1 位小数**（见 lib/quantity.ts 的 roundQty）。
import type { Unit } from '@/types'

/** 能按金额卖的重量类单位（件/包/盒这种整数件的不适用） */
export const BULK_WEIGHT_UNITS: Unit[] = ['克', '斤', '两', '公斤', '千克']

/** 默认快选金额（分）：5 / 10 / 15 / 20 元 —— 老板说的"一般客户都是买整数" */
export const BULK_AMOUNTS_FEN = [500, 1000, 1500, 2000]

/** 1 斤 = 500 克（本地市场习惯；换算只在这里写一次） */
export const GRAMS_PER_JIN = 500

/** 这个单位能不能按金额散卖（重量类 + 允许小数） */
export function isBulkWeightUnit(unit: Unit | null | undefined): boolean {
  return !!unit && BULK_WEIGHT_UNITS.includes(unit)
}

/** 商品是不是散货：单位是重量类、且该单位允许小数（units.allow_decimal，loadAll 映射成 unit_decimal） */
export function isBulkWeightProduct(p: { unit?: Unit | null; unit_decimal?: number | null } | null | undefined): boolean {
  return !!p && !!p.unit_decimal && isBulkWeightUnit(p.unit)
}

/**
 * 按金额折算数量（重量）：数量 = 金额 ÷ 每单位单价，保留 1 位小数（与系统数量口径一致）。
 * @returns 归一化后的数量；金额或单价非法、或算出来不足 0.1 时返回 null
 */
export function qtyForAmount(amountFen: number, perUnitFen: number): number | null {
  const amount = Number(amountFen)
  const price = Number(perUnitFen)
  if (!Number.isFinite(amount) || !Number.isFinite(price) || amount <= 0 || price <= 0) return null
  const qty = Math.round((amount / price) * 10) / 10
  return qty > 0 ? qty : null
}

/**
 * 按金额折算后，这一单实际收了多少钱（分）：数量 × 单价。
 * 因为它可能与客户说的金额差几厘（数量被归一到 1 位小数），所以**报表看的是这个数**，
 * 而不是客户口报的金额 —— 账要跟实际记的重量对得上。
 */
export function actualFenForAmount(amountFen: number, perUnitFen: number): number | null {
  const qty = qtyForAmount(amountFen, perUnitFen)
  return qty === null ? null : Math.round(qty * perUnitFen)
}

/**
 * 「按斤报价」换算成「每克价」（分）。老板报价习惯是"一斤 70 块"，而散货得按克卖，
 * 这个函数就是给录入时用的，免得心算错：¥70/斤 → 14 分/克。
 */
export function perGramFenFromPerJin(perJinYuan: number, gramsPerJin = GRAMS_PER_JIN): number | null {
  const yuan = Number(perJinYuan)
  if (!Number.isFinite(yuan) || yuan <= 0 || !(gramsPerJin > 0)) return null
  // 每克元 → 分：yuan * 100 / gramsPerJin，四舍五入到分
  return Math.round((yuan * 100) / gramsPerJin)
}

/** 反向：每克价（分）折成"多少元一斤"，用于商品表单里给老板回显核对 */
export function perJinYuanFromPerGram(perGramFen: number, gramsPerJin = GRAMS_PER_JIN): number | null {
  const fen = Number(perGramFen)
  if (!Number.isFinite(fen) || fen <= 0) return null
  return (fen * gramsPerJin) / 100
}
