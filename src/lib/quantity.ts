// 计量单位工具（通用版）：单位是否允许小数由 units 表的 allow_decimal 决定（loadAll 已映射为商品.unit_decimal）。
// 允许小数的单位（斤/公斤/米/克等）数量保留 1 位小数（如 1.5 斤）；其余单位正整数按个卖。
import type { Unit } from '@/types'

/** 归一化数量到 1 位小数（整数商品也走这里，整数归一后不变） */
export function roundQty(v: number): number {
  return Math.round((Number(v) + Number.EPSILON) * 10) / 10
}

/** 商品单位是否允许小数（unit_decimal=1 → 斤/米等；缺省按件整数） */
export function isDecimalUnit(p: { unit_decimal?: number | null; unit?: Unit | null } | null | undefined): boolean {
  return !!(p && p.unit_decimal)
}

/** 取商品计量单位；null/undefined 一律按"件"（老数据没有 unit 字段） */
export function unitOf(p: { unit?: Unit | null; unit_decimal?: number | null } | null | undefined): Unit {
  return ((p && p.unit) || '件') as Unit
}

/** 与 unitOf 同义的展示别名（JSX 里读起来更顺） */
export function unitLabel(p: { unit?: Unit | null; unit_decimal?: number | null } | null | undefined): Unit {
  return unitOf(p)
}

/**
 * 校验并归一化数量输入：
 * - 允许小数单位（斤/米等）：有限正数，归一后无精度损失（最多 1 位小数）
 * - 其他单位：必须是正整数
 * 返回归一化后的数量；非法返回 null。
 */
export function validateQty(raw: number, unit: Unit, decimal?: boolean): number | null {
  if (!Number.isFinite(raw)) return null
  // 兼容旧调用：decimal 缺省时按 unit==='米' 判断（米是默认小数单位）
  const isDecimal = decimal !== undefined ? decimal : unit === '米'
  if (isDecimal) {
    if (raw <= 0) return null
    const rounded = roundQty(raw)
    return Math.abs(rounded - raw) < 1e-9 ? rounded : null
  }
  // 件：正整数
  if (!Number.isInteger(raw) || raw <= 0) return null
  return raw
}
