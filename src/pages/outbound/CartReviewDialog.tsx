import { Fish } from 'lucide-react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { productPhotoUrl } from '@/lib/photo'
import { formatPrice, productName } from '@/lib/formatters'
import { unitOf } from '@/lib/quantity'
import { computeFifoPlan } from '@/lib/fifo'
import type { InventoryBatch } from '@/types'
import type { CartItem } from './CartPanel'

/** 出库逐项「复核放大」：只读弹层，大图 + 名称大字 + 单价/数量/小计大字号 + 批次/效期。
 * 不产生任何写入；关闭仅关闭弹层，购物清单（已选行）不动。 */
export function CartReviewDialog({
  item,
  batches,
  onClose,
}: {
  item: CartItem | null
  batches: InventoryBatch[]
  onClose: () => void
}) {
  if (!item) return null
  const p = item.product
  const photo = productPhotoUrl(p.photo_path, p.updated_at)
  const activeBatches = batches
    .filter((b) => b.product_id === p.id && b.quantity > 0)
    .sort((a, b) => a.inbound_date.localeCompare(b.inbound_date) || a.id - b.id)
  const plan = computeFifoPlan(activeBatches, item.quantity)
  const batchById = new Map(activeBatches.map((b) => [b.id, b]))

  return (
    <Dialog open={item !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">商品复核（只读，不产生记账）</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* 大图 + 名称大字 */}
          <div className="flex items-center gap-4">
            <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100">
              {photo ? (
                <img src={photo} className="size-full object-cover" alt={productName(p)} />
              ) : (
                <Fish className="size-12 text-slate-300" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-2xl font-bold text-slate-900">{productName(p)}</div>
              <div className="mt-1 text-sm text-slate-500">
                {p.brand}
                {p.model ? ' / ' + p.model : ''}
                {p.location ? ' · ' + p.location : ''}
              </div>
            </div>
          </div>

          {/* 大字价格：单价 × 数量 = 小计 */}
          <div className="grid grid-cols-3 gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
            <div>
              <div className="text-xs text-slate-500">单价</div>
              <div className="text-xl font-bold tabular-nums text-slate-800">{formatPrice(item.priceCents)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">数量</div>
              <div className="text-xl font-bold tabular-nums text-slate-800">
                {item.quantity} {unitOf(p)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">小计</div>
              <div className="text-xl font-bold tabular-nums text-emerald-700">
                {formatPrice(item.quantity * item.priceCents)}
              </div>
            </div>
          </div>

          {/* 批次/效期（若有在库正量批次） */}
          {plan.allocations.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium text-slate-600">将按 FIFO 扣减批次</div>
              <div className="space-y-1.5">
                {plan.allocations.map((a) => {
                  const b = batchById.get(a.batch_id)
                  return (
                    <div
                      key={a.batch_id}
                      className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                    >
                      <span className="font-mono text-xs">
                        {a.batch_no}
                        {b?.expiry_date ? ' · 效期 ' + b.expiry_date : ''}
                      </span>
                      <span>
                        扣 <span className="font-medium text-red-600">{a.deduct}</span> → 剩 {a.remaining_after}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            知道了
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
