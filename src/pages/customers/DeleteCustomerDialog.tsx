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
import type { CustomerWithStats } from '@/types'

interface DeleteCustomerDialogProps {
  deleting: CustomerWithStats | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 删除确认 Dialog */
export function DeleteCustomerDialog({ deleting, busy, onConfirm, onCancel }: DeleteCustomerDialogProps) {
  return (
    <Dialog open={deleting !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除客户</DialogTitle>
          <DialogDescription>
            确定要删掉客户「{deleting?.name}」吗？这个操作找不回来。
            如果他有过买卖或还账记录，系统会拒绝删除，免得赊账历史对不上。
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
