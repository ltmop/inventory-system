// 补货/滞销建议（与 src/lib/restockAdvice.ts 同一口径的纯 JS 版；主进程/手机端专用）
// 注意：打包只含 electron/**，主进程不得引用 src/**——算法修改需与 src/lib/restockAdvice.ts 同步
export const ADVICE_WINDOW_DAYS = 90
export const ADVICE_RESTOCK_DAYS_LEFT = 30
export const ADVICE_TARGET_DAYS = 45
export const ADVICE_MIN_LISTED_DAYS = 90

const DAY_MS = 24 * 3600 * 1000

/** 参与销量统计的流水：out 计正、return 计负（换货退旧不算销量） */
function isSaleTx(t) {
  if (t.type === 'out') return true
  if (t.type === 'return' && t.notes !== '换货退旧') return true
  return false
}

export function computeRestockAdvice(products, batches, transactions, now = new Date()) {
  const nowMs = now.getTime()
  const cutoffMs = nowMs - ADVICE_WINDOW_DAYS * DAY_MS

  const sales90 = new Map()
  for (const t of transactions) {
    if (!isSaleTx(t)) continue
    if (new Date(t.timestamp).getTime() < cutoffMs) continue
    const sign = t.type === 'return' ? -1 : 1
    sales90.set(t.product_id, (sales90.get(t.product_id) ?? 0) + t.quantity * sign)
  }
  const stock = new Map()
  for (const b of batches) {
    stock.set(b.product_id, (stock.get(b.product_id) ?? 0) + b.quantity)
  }
  const lastCost = new Map()
  const sorted = [...batches].sort((a, b) => a.inbound_date.localeCompare(b.inbound_date) || a.id - b.id)
  for (const b of sorted) lastCost.set(b.product_id, b.cost_price)

  const restock = []
  const deadStock = []

  for (const p of products) {
    const s90 = sales90.get(p.id) ?? 0
    const st = stock.get(p.id) ?? 0
    if (s90 > 0) {
      if (p.status === '停产') continue
      const dailyRate = s90 / ADVICE_WINDOW_DAYS
      const daysOfStock = st / dailyRate
      if (daysOfStock < ADVICE_RESTOCK_DAYS_LEFT) {
        restock.push({
          productId: p.id,
          stock: st,
          sales90: s90,
          dailyRate,
          daysOfStock,
          suggestedQty: Math.max(1, Math.ceil(dailyRate * ADVICE_TARGET_DAYS - st)),
        })
      }
    } else if (st > 0) {
      const listedMs = nowMs - new Date(p.created_at).getTime()
      if (listedMs < ADVICE_MIN_LISTED_DAYS * DAY_MS) continue
      const cost = lastCost.get(p.id) ?? p.cost_price ?? 0
      deadStock.push({
        productId: p.id,
        stock: st,
        tiedCapital: st * cost,
        daysListed: Math.floor(listedMs / DAY_MS),
      })
    }
  }

  restock.sort((a, b) => a.daysOfStock - b.daysOfStock || a.productId - b.productId)
  deadStock.sort((a, b) => b.tiedCapital - a.tiedCapital || a.productId - b.productId)

  return {
    restock,
    deadStock,
    totalSuggestedQty: restock.reduce((s, r) => s + r.suggestedQty, 0),
    totalTiedCapital: deadStock.reduce((s, d) => s + d.tiedCapital, 0),
  }
}
