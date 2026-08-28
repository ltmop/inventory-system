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
import type { Supplier } from '@/types'

interface DeleteSupplierDialogProps {
  deleting: Supplier | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 删除确认 Dialog（危险操作二次确认） */
export function DeleteSupplierDialog({ deleting, busy, onConfirm, onCancel }: DeleteSupplierDialogProps) {
  return (
    <Dialog open={deleting !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除供应商</DialogTitle>
          <DialogDescription>
            确定要删掉供应商「{deleting?.name}」吗？删掉后，它名下的进货记录还在，
            只是记录里不再显示这个供应商的名字。这个操作找不回来。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? '删除中...' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
