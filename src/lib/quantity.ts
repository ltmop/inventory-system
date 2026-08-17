// 计量单位工具（v2.2）：全站数量/单位统一的唯一定义。
// 件=正整数按个卖（默认）；米=鱼线按长度小数卖（保留 1 位小数，如 3.5 米）。
// 前后端共用同一套归一规则：roundQty 归一，validateQty 校验，unitOf/unitLabel 取单位。
import type { Unit } from '@/types'

/** 归一化数量到 1 位小数（件商品也走这里，整数归一后不变） */
export function roundQty(v: number): number {
  return Math.round((Number(v) + Number.EPSILON) * 10) / 10
}

/** 取商品计量单位；null/undefined 一律按"件"（老数据没有 unit 字段） */
export function unitOf(p: { unit?: Unit | null } | null | undefined): Unit {
  return p?.unit === '米' ? '米' : '件'
}

/** 与 unitOf 同义的展示别名（JSX 里读起来更顺） */
export function unitLabel(p: { unit?: Unit | null } | null | undefined): Unit {
  return unitOf(p)
}

/**
 * 校验并归一化数量输入：
 * - 件：必须是正整数（拒绝 0/负数/小数/NaN）
 * - 米：必须是有限正数，且归一后无精度损失（最多 1 位小数）
 * 返回归一化后的数量；非法返回 null。
 */
export function validateQty(raw: number, unit: Unit): number | null {
  if (!Number.isFinite(raw)) return null
  if (unit === '米') {
    if (raw <= 0) return null
    const rounded = roundQty(raw)
    return Math.abs(rounded - raw) < 1e-9 ? rounded : null
  }
  // 件：正整数
  if (!Number.isInteger(raw) || raw <= 0) return null
  return raw
}
