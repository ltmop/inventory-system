// FIFO 扣减单测：件整数 + 米小数（v2.2）
import { describe, expect, it } from 'vitest'
import { computeFifoPlan, previewFifo } from './fifo'
import type { InventoryBatch } from '@/types'

const batch = (
  id: number,
  quantity: number,
  inbound_date = '2026-01-01',
): InventoryBatch =>
  ({
    id,
    product_id: 1,
    batch_no: `PO20260101-${String(id).padStart(3, '0')}`,
    quantity,
    cost_price: 100,
    inbound_date,
  }) as InventoryBatch

describe('computeFifoPlan', () => {
  it('整数出库：按入库日期升序扣减', () => {
    const plan = computeFifoPlan([batch(2, 10, '2026-02-01'), batch(1, 5, '2026-01-01')], 7)
    expect(plan.ok).toBe(true)
    expect(plan.allocations.map((a) => a.batch_id)).toEqual([1, 2])
    expect(plan.allocations[0].deduct).toBe(5)
    expect(plan.allocations[1].deduct).toBe(2)
  })

  it('库存不足返回缺口', () => {
    const plan = computeFifoPlan([batch(1, 5)], 6)
    expect(plan.ok).toBe(false)
    expect(plan.shortage).toBe(1)
  })

  it('米商品小数出库：允许小数扣减', () => {
    const plan = computeFifoPlan([batch(1, 500)], 3.5)
    expect(plan.ok).toBe(true)
    expect(plan.allocations[0].deduct).toBe(3.5)
    expect(plan.allocations[0].remaining_after).toBe(496.5)
  })

  it('非法数量返回 ok=false', () => {
    expect(computeFifoPlan([batch(1, 5)], 0).ok).toBe(false)
    expect(computeFifoPlan([batch(1, 5)], NaN).ok).toBe(false)
    expect(computeFifoPlan([batch(1, 5)], -1).ok).toBe(false)
  })
})

describe('previewFifo', () => {
  it('返回每批扣减映射', () => {
    const { byBatch } = previewFifo([batch(1, 5), batch(2, 5)], 6)
    expect(byBatch.get(1)).toBe(5)
    expect(byBatch.get(2)).toBe(1)
  })
})
