import { Badge } from '@/components/ui/badge'
import type { StockTake, Supplier } from '@/types'

/** 盘点单范围的大白话描述：「A区 · 品类：饮料 · 供应商：XX」，无筛选就是「全店」 */
export function takeScopeLabel(t: StockTake, suppliers: Supplier[]): string {
  const parts: string[] = []
  if (t.location_filter) parts.push(t.location_filter)
  if (t.category_filter) parts.push(`品类：${t.category_filter}`)
  if (t.supplier_filter != null) {
    parts.push(`供应商：${suppliers.find((s) => s.id === t.supplier_filter)?.name ?? `#${t.supplier_filter}`}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '全店'
}

/** 盘点单状态徽章：进行中-黄，其余-灰 */
export function statusBadge(s: StockTake['status']) {
  return s === '进行中' ? (
    <Badge className="bg-amber-500">{s}</Badge>
  ) : (
    <Badge variant="secondary">{s}</Badge>
  )
}
