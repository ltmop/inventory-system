import type { InventoryBatch } from '@/types'

export interface FifoAllocation {
  batch_id: number
  batch_no: string
  deduct: number // 该批次扣减数量
  remaining_after: number // 扣减后该批次剩余
  cost_price: number // 该批次成本价（分），出库流水 unit_price 用
}

export interface FifoPlan {
  ok: boolean
  shortage: number // 不足的数量（ok=false 时 >0）
  allocations: FifoAllocation[]
}

/**
 * FIFO 扣减计算（纯函数）：
 * 输入批次列表 + 出库数量，输出按入库日期升序的扣减方案。
 * 库存不足时 ok=false 并返回缺口，不产生任何扣减。
 */
export function computeFifoPlan(batches: InventoryBatch[], quantity: number): FifoPlan {
  // 米商品（鱼线）允许小数出库；件商品仍是整数，但纯函数不区分单位，统一放行正数
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, shortage: quantity, allocations: [] }
  }
  const sorted = [...batches]
    .filter((b) => b.quantity > 0)
    .sort((a, b) => a.inbound_date.localeCompare(b.inbound_date) || a.id - b.id)

  const total = sorted.reduce((sum, b) => sum + b.quantity, 0)
  if (quantity > total) {
    return { ok: false, shortage: quantity - total, allocations: [] }
  }

  let left = quantity
  const allocations: FifoAllocation[] = []
  for (const b of sorted) {
    if (left <= 0) break
    const deduct = Math.min(b.quantity, left)
    allocations.push({ batch_id: b.id, batch_no: b.batch_no, deduct, remaining_after: b.quantity - deduct, cost_price: b.cost_price })
    left -= deduct
  }
  return { ok: true, shortage: 0, allocations }
}

/** 仅做预览：返回每个批次的扣减量映射（不校验充足性，超出部分记 shortage） */
export function previewFifo(batches: InventoryBatch[], quantity: number): { plan: FifoPlan; byBatch: Map<number, number> } {
  const plan = computeFifoPlan(batches, quantity)
  const byBatch = new Map<number, number>()
  for (const a of plan.allocations) byBatch.set(a.batch_id, a.deduct)
  return { plan, byBatch }
}
