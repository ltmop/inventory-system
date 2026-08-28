import { motion } from 'motion/react'
import { CheckCircle2, Loader2, Truck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PurchaseOrderDetail } from '@/types'

interface ReceiveDialogProps {
  target: PurchaseOrderDetail | null
  receiveQty: Record<number, string>
  onReceiveQtyChange: (itemId: number, v: string) => void
  error: string
  busy: boolean
  onSubmit: () => void
  onClose: () => void
}

/** 收货 Dialog：每条明细默认填剩余待收数量，可改小分批收 */
export function ReceiveDialog({
  target,
  receiveQty,
  onReceiveQtyChange,
  error,
  busy,
  onSubmit,
  onClose,
}: ReceiveDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="size-5 text-green-600" />
            收货入库
          </DialogTitle>
          <DialogDescription>
            数一下实际到了多少件，填进去；这次没收到的行留空就行，下次再收
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="space-y-3">
          {target?.items
            .filter((it) => it.quantity - it.received_qty > 0)
            .map((it) => {
              const remaining = it.quantity - it.received_qty
              return (
                <div
                  key={it.id}
                  className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3"
                >
                  <div className="text-sm">
                    <div className="font-medium text-slate-800">{it.product_name}</div>
                    <div className="text-xs text-muted-foreground">
                      订了 {it.quantity} 件，已收 {it.received_qty} 件，还差 {remaining} 件
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-sm whitespace-nowrap">这次收</Label>
                    <Input
                      type="number"
                      min={0}
                      max={remaining}
                      value={receiveQty[it.id] ?? ''}
                      onChange={(e) => onReceiveQtyChange(it.id, e.target.value)}
                      className="h-11 w-24 text-right text-lg font-bold tabular-nums"
                    />
                    <span className="text-sm text-muted-foreground">件</span>
                  </div>
                </div>
              )
            })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            asChild
            onClick={onSubmit}
            disabled={busy}
            className="bg-green-600 hover:bg-green-700"
          >
            <motion.button whileTap={{ scale: 0.96 }}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              {busy ? '入库中...' : '确认收货入库'}
            </motion.button>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
