import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { PurchaseOrderDetail } from '@/types'

interface CancelOrderDialogProps {
  target: PurchaseOrderDetail | null
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}

/** 取消订单二次确认（大白话说明后果） */
export function CancelOrderDialog({ target, busy, onConfirm, onClose }: CancelOrderDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>取消这张采购单？</DialogTitle>
          <DialogDescription>
            取消后：已经收进库的货会保留，还没收的部分就作废了，供应商再送货来也入不了这张单。
            确定要取消「{target?.order.po_no}」吗？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            再想想
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? '取消中...' : '确定取消订单'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
