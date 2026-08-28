// 经营建议规则引擎单测：补货判定 / 滞销判定 / 口径边界
import { describe, expect, it } from 'vitest'
import {
  computeRestockAdvice,
  ADVICE_MIN_LISTED_DAYS,
} from './restockAdvice'
import type { InventoryBatch, Product, Transaction } from '@/types'

const NOW = new Date('2026-07-31T12:00:00')
const DAY = 24 * 3600 * 1000

function daysAgo(n: number, hour = 10): string {
  return new Date(NOW.getTime() - n * DAY + hour * 0).toISOString()
}

function product(id: number, overrides: Partial<Product> = {}): Product {
  return {
    id,
    sku_code: `SKU-${id}`,
    barcode: null,
    category: '鱼竿',
    sub_category: null,
    brand: '测试',
    model: `型号${id}`,
    cost_price: 1000,
    suggest_price: 2000,
    location: null,
    photo_path: null,
    name_vi: null,
    rod_length: null,
    line_number: null,
    hook_size: null,
    color: null,
    material: null,
    rod_action: null,
    power_rating: null,
    expiry_date: null,
    min_stock: null,
    status: '已盘点',
    created_at: daysAgo(120), // 默认上架 120 天（满滞销判定期）
    updated_at: daysAgo(1),
    ...overrides,
  }
}

function batch(id: number, productId: number, quantity: number, costPrice = 1000): InventoryBatch {
  return {
    id,
    product_id: productId,
    batch_no: `PO20260701-${String(id).padStart(3, '0')}`,
    quantity,
    cost_price: costPrice,
    location: null,
    inbound_date: '2026-07-01',
    supplier_id: null,
  }
}

function sale(productId: number, quantity: number, agoDays: number, type: 'out' | 'return' = 'out', notes: string | null = null): Transaction {
  return {
    id: Math.floor(Math.random() * 1e9),
    product_id: productId,
    batch_id: null,
    type,
    quantity,
    unit_price: 1000,
    selling_price: 2000,
    timestamp: daysAgo(agoDays),
    operator: null,
    notes,
    customer_id: null,
    paid_amount: null,
  }
}

describe('computeRestockAdvice · 补货建议', () => {
  it('90 天卖 90 件（每天 1 件）库存 10 件 → 撑 10 天，建议补到 45 天用量 = 35 件', () => {
    const txs = Array.from({ length: 9 }, (_, i) => sale(1, 10, i * 10)) // 90 件
    const r = computeRestockAdvice([product(1)], [batch(1, 1, 10)], txs, NOW)
    expect(r.restock).toHaveLength(1)
    const item = r.restock[0]
    expect(item.sales90).toBe(90)
    expect(item.dailyRate).toBeCloseTo(1)
    expect(item.daysOfStock).toBeCloseTo(10)
    expect(item.suggestedQty).toBe(35)
    expect(r.totalSuggestedQty).toBe(35)
  })

  it('库存还能卖 40 天（≥30 天）→ 不建议补', () => {
    const txs = Array.from({ length: 9 }, (_, i) => sale(1, 10, i * 10)) // 每天 1 件
    const r = computeRestockAdvice([product(1)], [batch(1, 1, 40)], txs, NOW)
    expect(r.restock).toHaveLength(0)
  })

  it('零库存但有销量（在卖断货）→ 最优先，建议补满 45 天', () => {
    const txs = Array.from({ length: 9 }, (_, i) => sale(1, 10, i * 10))
    const r = computeRestockAdvice([product(1)], [], txs, NOW)
    expect(r.restock[0].daysOfStock).toBe(0)
    expect(r.restock[0].suggestedQty).toBe(45)
  })

  it('退货冲减销量；换货退旧不算退货也不算销量', () => {
    const txs = [
      ...Array.from({ length: 9 }, (_, i) => sale(1, 10, i * 10)), // +90
      sale(1, 30, 5, 'return'), // −30 → 净 60 件
      sale(1, 50, 6, 'return', '换货退旧'), // 不计
    ]
    const r = computeRestockAdvice([product(1)], [batch(1, 1, 100)], txs, NOW)
    // 净 60 件 → 每天 0.667 件，100 件库存能卖 150 天 → 不补
    expect(r.restock).toHaveLength(0)
  })

  it('90 天窗口之外的销量不参与', () => {
    const txs = [sale(1, 500, 91)] // 91 天前卖的，不算
    const r = computeRestockAdvice([product(1)], [batch(1, 1, 5)], txs, NOW)
    expect(r.restock).toHaveLength(0)
  })

  it('停产商品不再建议补货', () => {
    const txs = Array.from({ length: 9 }, (_, i) => sale(1, 10, i * 10))
    const r = computeRestockAdvice([product(1, { status: '停产' })], [batch(1, 1, 2)], txs, NOW)
    expect(r.restock).toHaveLength(0)
  })

  it('多个商品按剩余天数升序（最急在前）', () => {
    // 商品1 每天 1 件库存 5（5 天）；商品2 每天 2 件库存 10（5 天）；商品3 每天 1 件库存 29（29 天）
    const txs = [
      ...Array.from({ length: 9 }, (_, i) => sale(1, 10, i * 10)),
      ...Array.from({ length: 9 }, (_, i) => sale(2, 20, i * 10)),
      ...Array.from({ length: 9 }, (_, i) => sale(3, 10, i * 10)),
    ]
    const batches = [batch(1, 1, 5), batch(2, 2, 10), batch(3, 3, 29)]
    const r = computeRestockAdvice([product(1), product(2), product(3)], batches, txs, NOW)
    expect(r.restock.map((x) => x.productId)).toEqual([1, 2, 3])
  })
})

describe('computeRestockAdvice · 滞销清仓', () => {
  it('上架 120 天、90 天零销量、库存 8 件 @1000 → 压 80 元', () => {
    const r = computeRestockAdvice([product(1)], [batch(1, 1, 8, 1000)], [], NOW)
    expect(r.deadStock).toHaveLength(1)
    expect(r.deadStock[0].tiedCapital).toBe(8000)
    expect(r.totalTiedCapital).toBe(8000)
  })

  it(`上架不满 ${ADVICE_MIN_LISTED_DAYS} 天的新品不算滞销`, () => {
    const r = computeRestockAdvice([product(1, { created_at: daysAgo(30) })], [batch(1, 1, 8)], [], NOW)
    expect(r.deadStock).toHaveLength(0)
  })

  it('零库存不算滞销（没压钱）', () => {
    const r = computeRestockAdvice([product(1)], [], [], NOW)
    expect(r.deadStock).toHaveLength(0)
  })

  it('90 天前有销量但窗口内零销量 → 算滞销', () => {
    const r = computeRestockAdvice([product(1)], [batch(1, 1, 3)], [sale(1, 10, 100)], NOW)
    expect(r.deadStock).toHaveLength(1)
  })

  it('压着资金按最近批次进价算，多商品按金额降序', () => {
    const batches = [
      batch(1, 1, 5, 800), // 旧批次便宜
      { ...batch(2, 1, 5, 2000), inbound_date: '2026-07-10' }, // 新批次贵 → 用 2000
      batch(3, 2, 2, 5000),
    ]
    const r = computeRestockAdvice([product(1), product(2)], batches, [], NOW)
    expect(r.deadStock[0].productId).toBe(1) // 5×2000=10000 > 2×5000=10000？相等按 id 升序
    expect(r.deadStock[0].tiedCapital).toBe(20000) // (5+5)×2000
    expect(r.deadStock[1].tiedCapital).toBe(10000)
  })
})
