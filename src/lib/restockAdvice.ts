import type { InventoryBatch, Product, Transaction } from '@/types'

// 经营建议（纯规则，不依赖 AI/网络）：
// - 该补货了：按最近 90 天净销量算消耗速度，库存撑不到 30 天就建议补，补到 45 天用量
// - 该清仓了：上架满 90 天且 90 天零销量、还有库存的，按"库存 × 最近进价"算压着的钱
// 规则透明、口径与经营报表一致（退货冲减、换货退旧不算销量），老板可以复核每一个数字

export interface RestockItem {
  productId: number
  stock: number // 当前库存
  sales90: number // 90 天净卖出件数（出库 − 退货）
  dailyRate: number // 每天卖多少（sales90 / 90）
  daysOfStock: number // 现有库存还能卖几天（stock / dailyRate）
  suggestedQty: number // 建议补货量（补到 45 天用量）
}

export interface DeadStockItem {
  productId: number
  stock: number
  tiedCapital: number // 压着的钱（分）= 库存 × 最近进价
  daysListed: number // 上架天数
}

export interface RestockAdvice {
  restock: RestockItem[] // 按剩余天数升序（最急的在前）
  deadStock: DeadStockItem[] // 按压资金额降序（压最多的在前）
  totalSuggestedQty: number // 建议补货总件数
  totalTiedCapital: number // 滞销压着的总资金（分）
}

export const ADVICE_WINDOW_DAYS = 90 // 动销统计窗口
export const ADVICE_RESTOCK_DAYS_LEFT = 30 // 库存撑不到这个天数就建议补
export const ADVICE_TARGET_DAYS = 45 // 补到这个天数的用量
export const ADVICE_MIN_LISTED_DAYS = 90 // 上架满这个天数才参与滞销判定（新品不算滞销）

const DAY_MS = 24 * 3600 * 1000

/** 参与销量统计的流水：out 计正、return 计负（换货退旧腿不算销量，与经营报表同口径） */
function isSaleTx(t: Transaction): boolean {
  if (t.type === 'out') return true
  if (t.type === 'return' && t.notes !== '换货退旧') return true
  return false
}

export function computeRestockAdvice(
  products: Product[],
  batches: InventoryBatch[],
  transactions: Transaction[],
  now: Date = new Date(),
): RestockAdvice {
  const nowMs = now.getTime()
  const cutoffMs = nowMs - ADVICE_WINDOW_DAYS * DAY_MS

  // 每商品：90 天净销量 / 当前库存 / 最近进价
  const sales90 = new Map<number, number>()
  for (const t of transactions) {
    if (!isSaleTx(t)) continue
    if (new Date(t.timestamp).getTime() < cutoffMs) continue
    const sign = t.type === 'return' ? -1 : 1
    sales90.set(t.product_id, (sales90.get(t.product_id) ?? 0) + t.quantity * sign)
  }
  const stock = new Map<number, number>()
  for (const b of batches) {
    stock.set(b.product_id, (stock.get(b.product_id) ?? 0) + b.quantity)
  }
  // 最近进价：批次按入库日期/ID 取最新，没有批次回退商品档案进价
  const lastCost = new Map<number, number>()
  const sorted = [...batches].sort((a, b) => a.inbound_date.localeCompare(b.inbound_date) || a.id - b.id)
  for (const b of sorted) lastCost.set(b.product_id, b.cost_price)

  const restock: RestockItem[] = []
  const deadStock: DeadStockItem[] = []

  for (const p of products) {
    const s90 = sales90.get(p.id) ?? 0
    const st = stock.get(p.id) ?? 0
    if (s90 > 0) {
      // 补货判定：停产商品不再补
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
      // 滞销判定：上架满 90 天（新货不动销是正常的，不吓人）
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
