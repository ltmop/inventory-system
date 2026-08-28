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
import { Textarea } from '@/components/ui/textarea'

/** 供应商表单 */
export interface SupplierForm {
  name: string
  contact: string
  phone: string
  address: string
  notes: string
}

interface SupplierFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isEdit: boolean
  form: SupplierForm
  onFormChange: (form: SupplierForm) => void
  error: string
  saving: boolean
  onSubmit: () => void
}

/** 新增/编辑供应商 Dialog */
export function SupplierFormDialog({
  open,
  onOpenChange,
  isEdit,
  form,
  onFormChange,
  error,
  saving,
  onSubmit,
}: SupplierFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑供应商' : '新增供应商'}</DialogTitle>
          <DialogDescription>带 * 为必填项</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-1">
            <Label>名称 *</Label>
            <Input
              value={form.name}
              onChange={(e) => onFormChange({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label>联系人</Label>
            <Input
              value={form.contact}
              onChange={(e) => onFormChange({ ...form, contact: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label>电话</Label>
            <Input
              value={form.phone}
              onChange={(e) => onFormChange({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>地址</Label>
            <Input
              value={form.address}
              onChange={(e) => onFormChange({ ...form, address: e.target.value })}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>备注</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => onFormChange({ ...form, notes: e.target.value })}
              placeholder="账期、主营品类等..."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
