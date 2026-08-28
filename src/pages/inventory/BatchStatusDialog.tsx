import { useEffect, useState } from 'react'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PRODUCT_STATUSES, type ProductStatus } from '@/types'

interface BatchStatusDialogProps {
  open: boolean
  /** 涉及的商品数（确认话术里要用） */
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: (status: ProductStatus) => void
}

/** 批量改状态 Dialog：选目标状态，确认话术大白话说清影响 */
export function BatchStatusDialog({ open, count, busy, onClose, onConfirm }: BatchStatusDialogProps) {
  const [status, setStatus] = useState<ProductStatus>('已盘点')

  useEffect(() => {
    if (open) setStatus('已盘点')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>批量改状态（{count} 个商品）</DialogTitle>
          <DialogDescription>
            这会把 {count} 个商品的状态都改成「{status}」，改完不能一键撤回。
            {status === '停产' ? '停产的商品以后不卖了，但历史记录都还在。' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>改成什么状态</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as ProductStatus)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRODUCT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => onConfirm(status)} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            确认修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
