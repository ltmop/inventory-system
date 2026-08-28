// 商品规格字段（通用版）：颜色/材质/保质期；旧规格列保留数据兼容
// 纯函数，不依赖 store / UI，InboundPage / InventoryPage / 导入导出共用
import type { Category } from '@/types'

export type SpecField =
  | 'color'        // 颜色
  | 'material'     // 材质
  | 'expiry_date'  // 保质期（食品/日化用），如 2027-06-30

export const SPEC_FIELDS: SpecField[] = [
  'color', 'material', 'expiry_date',
]

export const SPEC_LABELS: Record<SpecField, string> = {
  color: '颜色',
  material: '材质',
  expiry_date: '保质期',
}

// 输入占位提示：老板手输，给个例子就知道填什么格式
export const SPEC_PLACEHOLDERS: Record<SpecField, string> = {
  color: '如：红色 / 蓝色',
  material: '如：塑料 / 不锈钢 / 棉',
  expiry_date: '如：2027-06-30',
}

/** 该品类是否入库必填到期日（通用版：到期日可选，不强制） */
export function requiresExpiry(_category: Category | string | null | undefined): boolean {
  return false
}

/** 品类 → 表单该显示的规格字段（通用版统一为 颜色/材质/保质期） */
export function specFieldsFor(_category: Category | string): SpecField[] {
  return ['color', 'material', 'expiry_date']
}

/** 把商品的非空规格拼成一行展示，如「红色 · 塑料 · 2027-06-30」；全空返回空串 */
export function formatSpecs(
  p: object,
): string {
  return SPEC_FIELDS.map((f) => {
    const v = (p as Record<string, unknown>)[f]
    return typeof v === 'string' ? v.trim() : ''
  })
    .filter((v) => !!v)
    .join(' · ')
}

/** 商品行 → 表单字符串状态（与 collectSpecs 互逆） */
export function specsToForm(
  p: object,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of SPEC_FIELDS) {
    const v = (p as Record<string, unknown>)[f]
    out[f] = typeof v === 'string' ? v : ''
  }
  return out
}

/** 从表单字符串状态收集规格字段：空串归 null，直接可传给 addProduct/updateProduct */
export function collectSpecs(
  form: { [k: string]: string },
): Record<string, string | null> {
  const out = {} as Record<string, string | null>
  for (const f of SPEC_FIELDS) {
    const v = form[f]?.trim()
    out[f] = v ? v : null
  }
  return out
}
