// 盘点 sku 模式的批次分摊（v2.2）：把"按商品盘总数"的差异按各批次数量比例摊回每个批次。
// 与后端 electron/commands/stocktake.js submitStockTake 的 sku 分摊算法逐字节一致，
// 保证前端"摊完预览"和实际落库结果相同，不两眼一抹黑。
import { roundQty } from '@/lib/quantity'

export interface AllocBatch {
  id: number
  quantity: number
}

export interface BatchAllocation {
  batchId: number
  quantity: number
}

/**
 * 按商品盘总数 → 每个批次最后该有多少。
 * @param batches 该商品的全部批次（含 0 库存的），顺序按批次 id 升序（与后端一致）
 * @param target  实盘总数
 * @param systemQty 系统库存总数（盘点行里的 system_qty）
 */
export function allocSkuToBatches(
  batches: AllocBatch[],
  target: number,
  systemQty: number,
): BatchAllocation[] {
  if (batches.length === 0) return []
  const sys = systemQty || 0
  if (sys <= 0) {
    // 系统库存为 0 但盘出有货：全部记到第一个批次（与后端同口径）
    return [{ batchId: batches[0].id, quantity: roundQty(target) }]
  }
  const out: BatchAllocation[] = []
  let allocated = 0
  // 米商品（鱼线）目标带小数 → 每批按 1 位小数摊；件商品整数摊。与后端兜底分摊逐字节一致
  const precision = Number.isInteger(target) ? 1 : 10
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i]
    // 按数量比例分摊，最后一个批次补平取整误差；每批至少 0（防止负值）
    const share =
      i === batches.length - 1
        ? target - allocated
        : Math.max(0, Math.round(((target * b.quantity) / sys) * precision) / precision)
    out.push({ batchId: b.id, quantity: roundQty(share) })
    allocated += share
  }
  return out
}
