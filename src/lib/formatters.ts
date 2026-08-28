// 价格与日期显示格式化。数据库价格一律存"分"，展示时 /100

export function formatPrice(cents: number | null | undefined, currency: 'CNY' | 'VND' = 'CNY'): string {
  if (cents === null || cents === undefined) return '-'
  if (currency === 'CNY') return `¥${(cents / 100).toFixed(2)}`
  // VND 与 CNY 统一按"最小单位存储"约定处理（/100），取整到盾；
  // 后期做跨境定价时如需汇率换算，应在业务层换算后再调用，而不是在这里乘汇率
  return `₫${Math.round(cents / 100).toLocaleString('vi-VN')}`
}

/** 商品显示名：品牌+型号，都为空时回退 SKU，杜绝界面出现 "null" 或孤零零的空格 */
export function productName(p: { brand: string | null; model: string | null; sku_code: string }): string {
  return [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** CSV 单元格转义：含逗号/引号/换行的字段必须包引号、引号双写，
 * 否则品牌型号里带逗号时 Excel 打开整行错位 */
export function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 大白话相对时间（备份状态用）：今天 03:00 / 昨天 03:00 / X 天前 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '还没有过'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  const hm = formatTime(iso)
  if (dayDiff <= 0) return `今天 ${hm}`
  if (dayDiff === 1) return `昨天 ${hm}`
  return `${dayDiff} 天前`
}

export function todayStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isToday(iso: string): boolean {
  const d = new Date(iso)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}
