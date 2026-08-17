// 通用商品规格字段：品类 → 该显示的字段列表 + 中文标签 + 一行格式化
// 纯函数，不依赖 store / UI，InboundPage / InventoryPage / 导入导出共用
import type { Category } from '@/types'

export type SpecField =
  | 'color'        // 颜色
  | 'material'     // 材质
  | 'expiry_date'  // 保质期，如 2027-06

export const SPEC_FIELDS: SpecField[] = [
  'color', 'material', 'expiry_date',
]

export const SPEC_LABELS: Record<SpecField, string> = {
  color: '颜色',
  material: '材质',
  expiry_date: '保质期',
}

// 输入占位提示：给个例子就知道填什么格式
export const SPEC_PLACEHOLDERS: Record<SpecField, string> = {
  color: '如：红 / 黑',
  material: '如：不锈钢 / 塑料',
  expiry_date: '如：2027-06',
}

/**
 * 是否入库必填到期日（通用版）：不按品类强制——所有商品到期日都可选，
 * 填了该批次就走保质期批次管理（临期预警/FEFO），没填当普通商品。
 */
export function requiresExpiry(_category: Category | string | null | undefined): boolean {
  return false
}

/** 品类 → 表单该显示的规格字段（全部选填）；通用版统一给颜色/材质/保质期 */
export function specFieldsFor(_category: Category | string): SpecField[] {
  return ['color', 'material', 'expiry_date']
}

/** 把商品的非空规格拼成一行展示，如「红 · 不锈钢」；全空返回空串 */
export function formatSpecs(
  p: Partial<Record<SpecField, string | null>>,
): string {
  return SPEC_FIELDS.map((f) => p[f]?.trim())
    .filter((v): v is string => !!v)
    .join(' · ')
}

/** 从表单字符串状态收集规格字段：空串归 null，直接可传给 addProduct/updateProduct */
export function collectSpecs(
  form: Record<SpecField, string>,
): Record<SpecField, string | null> {
  const out = {} as Record<SpecField, string | null>
  for (const f of SPEC_FIELDS) {
    const v = form[f]?.trim()
    out[f] = v ? v : null
  }
  return out
}

/** 从商品读出规格字段的表单字符串状态（null → ''），编辑弹窗初始化用 */
export function specsToForm(
  p: Partial<Record<SpecField, string | null>>,
): Record<SpecField, string> {
  const out = {} as Record<SpecField, string>
  for (const f of SPEC_FIELDS) out[f] = p[f] ?? ''
  return out
}
