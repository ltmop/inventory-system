// 批量导入的表头规范化/映射与严格数值解析（纯函数，便于单测）

// CSV 表头映射：用户 CSV 列名 → 系统字段
export const HEADER_MAP: Record<string, string> = {
  sku编码: 'sku_code', sku: 'sku_code', sku_code: 'sku_code',
  条码: 'barcode', 条形码: 'barcode', barcode: 'barcode',
  品类: 'category', 大类: 'category', category: 'category',
  // 「规格」必须落到 sub_category —— 它就是现场口径里的「规格」列。
  // 2026-09-22 修：这里原来写的是 `规格: 'model'`，于是老板在 Excel 里用「规格」列
  //   填的尺码全被写进了"型号/系列"，正是「有些明显是规格的录到了别处」的机器成因。
  //   「子类」保留为老文件的别名，历史导出（表头写子类）照样能导进来。
  型号: 'model', 系列: 'model', 规格: 'sub_category', 子类: 'sub_category', sub_category: 'sub_category', model: 'model',
  进价: 'cost_price', 成本: 'cost_price', cost_price: 'cost_price',
  '进价(元)': 'cost_price', '进价（元）': 'cost_price',
  售价: 'suggest_price', 建议售价: 'suggest_price', suggest_price: 'suggest_price',
  '建议售价(元)': 'suggest_price', '建议售价（元）': 'suggest_price',
  数量: 'quantity', 库存: 'quantity', quantity: 'quantity',
  货位: 'location', 库位: 'location', location: 'location',
}

/** 表头规范化：去 BOM、去空白、小写化 */
export function normalizeHeader(h: string): string {
  return h.trim().replace(/^﻿/, '').toLowerCase() // eslint-disable-line no-irregular-whitespace
}

/** 单个表头 → 系统字段名，识别不了返回 null。
 *  先按原样查映射表（覆盖「进价(元)」等显式变体），
 *  再剥离括号注释（如「进价(含税)」→「进价」）兜底，防未来再加后缀。 */
export function mapHeader(raw: string): string | null {
  const h = normalizeHeader(raw)
  return HEADER_MAP[h] ?? HEADER_MAP[h.replace(/[(（].*$/, '')] ?? null
}

/** 严格解析数量：必须是非负整数，非法（空/非数字/小数/负数）返回 null */
export function parseQuantity(val: string): number | null {
  if (!val) return null
  const n = Number(val)
  if (!Number.isInteger(n) || n < 0) return null
  return n
}

/** 严格解析金额（元 → 分）：必须是有限数字，非法返回 null */
export function parseMoney(val: string): number | null {
  if (!val) return null
  const n = Number(val)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}
