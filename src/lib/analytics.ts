import type { InventoryBatch, Product, Transaction } from '@/types'
import { productName } from '@/lib/formatters'
import { localDayKey } from '@/lib/salesReport'

export interface TrendPoint { date: string; revenue: number; profit: number; qty: number }
export interface CategoryStat { category: string; revenue: number; profit: number; qty: number }
export interface TopStat { productId: number; name: string; brand: string; model: string; sku: string; revenue: number; profit: number; qty: number }
export interface StockValueByCat { totalValue: number; byCategory: { category: string; qty: number; value: number }[] }
export interface OverviewStat {
  today: { revenue: number; profit: number }
  month: { revenue: number; profit: number }
  stockValue: number; totalStock: number; totalSku: number
}

// 口径与 electron/commands/analytics.js 完全一致（同源）：
// 营业额 = Σ(out) 卖价×数量 − Σ(return 非换货退旧) 卖价×数量
// 毛利   = Σ(out) (卖价−成本)×数量 − Σ(return 非换货退旧) (卖价−成本)×数量

/** 近 N 天（含今天）销售额/毛利/件数趋势 */
export function computeTrend(transactions: Transaction[], days = 7): TrendPoint[] {
  const n = Math.max(1, Math.min(days, 90))
  const byDay = new Map<string, TrendPoint>()
  for (const t of transactions) {
    if (t.type !== 'out' && t.type !== 'return') continue
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const dk = localDayKey(t.timestamp)
    const cur = byDay.get(dk) ?? { date: dk, revenue: 0, profit: 0, qty: 0 }
    const sign = t.type === 'return' ? -1 : 1
    cur.qty += t.quantity * sign
    if (t.selling_price != null) cur.revenue += t.selling_price * t.quantity * sign
    if (t.selling_price != null && t.unit_price != null) cur.profit += (t.selling_price - t.unit_price) * t.quantity * sign
    byDay.set(dk, cur)
  }
  const out: TrendPoint[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const dk = localDayKey(d.toISOString())
    const r = byDay.get(dk)
    out.push({ date: dk, revenue: Math.round(r?.revenue ?? 0), profit: Math.round(r?.profit ?? 0), qty: Math.round(r?.qty ?? 0) })
  }
  return out
}

/** 品类销售额/毛利/件数 */
export function computeCategory(transactions: Transaction[], products: Product[]): CategoryStat[] {
  const byCat = new Map<string, CategoryStat>()
  const pMeta = new Map(products.map((p) => [p.id, p]))
  for (const t of transactions) {
    if (t.type !== 'out' && t.type !== 'return') continue
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const cat = pMeta.get(t.product_id)?.category || '未分类'
    const cur = byCat.get(cat) ?? { category: cat, revenue: 0, profit: 0, qty: 0 }
    const sign = t.type === 'return' ? -1 : 1
    cur.qty += t.quantity * sign
    if (t.selling_price != null) cur.revenue += t.selling_price * t.quantity * sign
    if (t.selling_price != null && t.unit_price != null) cur.profit += (t.selling_price - t.unit_price) * t.quantity * sign
    byCat.set(cat, cur)
  }
  return [...byCat.values()].sort((a, b) => b.revenue - a.revenue).map((r) => ({
    category: r.category, revenue: Math.round(r.revenue), profit: Math.round(r.profit), qty: Math.round(r.qty),
  }))
}

/** 畅销 Top N */
export function computeTop(transactions: Transaction[], products: Product[], n = 10): TopStat[] {
  const k = Math.max(1, Math.min(n, 50))
  const pMeta = new Map(products.map((p) => [p.id, p]))
  const byP = new Map<number, { productId: number; revenue: number; profit: number; qty: number }>()
  for (const t of transactions) {
    if (t.type !== 'out' && t.type !== 'return') continue
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const cur = byP.get(t.product_id) ?? { productId: t.product_id, revenue: 0, profit: 0, qty: 0 }
    const sign = t.type === 'return' ? -1 : 1
    cur.qty += t.quantity * sign
    if (t.selling_price != null) cur.revenue += t.selling_price * t.quantity * sign
    if (t.selling_price != null && t.unit_price != null) cur.profit += (t.selling_price - t.unit_price) * t.quantity * sign
    byP.set(t.product_id, cur)
  }
  return [...byP.values()].sort((a, b) => b.revenue - a.revenue).slice(0, k).map((r) => {
    const m = pMeta.get(r.productId)
    return { productId: r.productId, name: m ? productName(m) : '未知商品', brand: m?.brand ?? '', model: m?.model ?? '', sku: m?.sku_code ?? '', revenue: Math.round(r.revenue), profit: Math.round(r.profit), qty: Math.round(r.qty) }
  })
}

/** 库存金额按品类 */
export function computeStockValue(batches: InventoryBatch[], products: Product[]): StockValueByCat {
  const pMeta = new Map(products.map((p) => [p.id, p]))
  const byCat = new Map<string, { category: string; qty: number; value: number }>()
  for (const b of batches) {
    if (b.quantity <= 0) continue
    const cat = pMeta.get(b.product_id)?.category || '未分类'
    const cur = byCat.get(cat) ?? { category: cat, qty: 0, value: 0 }
    cur.qty += b.quantity
    cur.value += b.quantity * b.cost_price
    byCat.set(cat, cur)
  }
  const arr = [...byCat.values()].sort((a, b) => b.value - a.value)
  return { totalValue: Math.round(arr.reduce((s, r) => s + r.value, 0)), byCategory: arr.map((r) => ({ category: r.category, qty: Math.round(r.qty), value: Math.round(r.value) })) }
}

/** 经营概览：今日/本月营业额毛利 + 库存总额 + SKU 数 */
export function computeOverview(transactions: Transaction[], batches: InventoryBatch[], products: Product[]): OverviewStat {
  const now = new Date()
  const todayKey = localDayKey(now.toISOString())
  const monthPrefix = todayKey.slice(0, 7)
  let todayRevenue = 0, todayProfit = 0, monthRevenue = 0, monthProfit = 0
  for (const t of transactions) {
    if ((t.type !== 'out' && t.type !== 'return') || (t.type === 'return' && t.notes === '换货退旧')) continue
    if (t.selling_price == null) continue
    const dk = localDayKey(t.timestamp)
    const sign = t.type === 'return' ? -1 : 1
    const rev = t.selling_price * t.quantity * sign
    const prof = t.unit_price != null ? (t.selling_price - t.unit_price) * t.quantity * sign : 0
    if (dk === todayKey) { todayRevenue += rev; todayProfit += prof }
    if (dk.startsWith(monthPrefix)) { monthRevenue += rev; monthProfit += prof }
  }
  const totalStock = batches.filter((b) => b.quantity > 0).reduce((s, b) => s + b.quantity, 0)
  const stockValue = batches.filter((b) => b.quantity > 0).reduce((s, b) => s + b.quantity * b.cost_price, 0)
  return {
    today: { revenue: Math.round(todayRevenue), profit: Math.round(todayProfit) },
    month: { revenue: Math.round(monthRevenue), profit: Math.round(monthProfit) },
    stockValue: Math.round(stockValue), totalStock: Math.round(totalStock), totalSku: products.length,
  }
}