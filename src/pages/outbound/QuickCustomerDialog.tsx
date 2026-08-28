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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface QuickCustomerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  onNameChange: (v: string) => void
  phone: string
  onPhoneChange: (v: string) => void
  busy: boolean
  error: string
  onSubmit: () => void
}

/** 「+ 新客户」快捷建档 Dialog：只填姓名电话，建完自动选中 */
export function QuickCustomerDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  phone,
  onPhoneChange,
  busy,
  error,
  onSubmit,
}: QuickCustomerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新客户</DialogTitle>
          <DialogDescription>先建个简单的档案，回头可以在「客户」页补全资料</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>姓名 *</Label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="比如：老王"
            />
          </div>
          <div className="space-y-1">
            <Label>电话</Label>
            <Input value={phone} onChange={(e) => onPhoneChange(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? '保存中...' : '保存并选中'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
