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
import { cn } from '@/lib/utils'
import { PRICE_LEVELS, PRICE_LEVEL_LABELS, type PriceLevel } from '@/types'

/** 客户表单：price_level 为空字符串 = 零售默认（不设档） */
export interface CustomerForm {
  name: string
  phone: string
  notes: string
  price_level: PriceLevel | ''
  /** 老钓友偏好（v2.2）：自由文本，如"爱用红虫/常买3.6m竿/月底结账" */
  preferences: string
}

interface CustomerFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isEdit: boolean
  form: CustomerForm
  onFormChange: (form: CustomerForm) => void
  error: string
  saving: boolean
  onSubmit: () => void
}

/** 新增/编辑客户 Dialog */
export function CustomerFormDialog({
  open,
  onOpenChange,
  isEdit,
  form,
  onFormChange,
  error,
  saving,
  onSubmit,
}: CustomerFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑客户' : '新增客户'}</DialogTitle>
          <DialogDescription>带 * 为必填项</DialogDescription>
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
              value={form.name}
              onChange={(e) => onFormChange({ ...form, name: e.target.value })}
              placeholder="比如：老王"
            />
          </div>
          <div className="space-y-1">
            <Label>电话</Label>
            <Input
              value={form.phone}
              onChange={(e) => onFormChange({ ...form, phone: e.target.value })}
              placeholder="方便催账时联系"
            />
          </div>
          {/* 默认价格档：选了他来买货自动按这个价，伙计不用手动输价 */}
          <div className="space-y-2">
            <Label>默认价格档</Label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => onFormChange({ ...form, price_level: '' })}
                className={cn(
                  'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                  form.price_level === ''
                    ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                )}
              >
                零售
              </button>
              {PRICE_LEVELS.filter((l) => l !== 'retail').map((l) => (
                <button
                  type="button"
                  key={l}
                  onClick={() => onFormChange({ ...form, price_level: l })}
                  className={cn(
                    'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                    form.price_level === l
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  {PRICE_LEVEL_LABELS[l]}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              选了他来买货自动按这个价（商品设了这档价才生效，没设就按建议价），卖货时还能临时改
            </div>
          </div>
          <div className="space-y-1">
            <Label>偏好</Label>
            <Textarea
              value={form.preferences}
              onChange={(e) => onFormChange({ ...form, preferences: e.target.value })}
              placeholder="比如：爱用红虫、常买 3.6m 手竿、主钓鲤鱼..."
            />
            <div className="text-xs text-muted-foreground">
              记下老钓友爱用什么饵/竿、钓什么鱼，他来了直接推荐
            </div>
          </div>
          <div className="space-y-1">
            <Label>备注</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => onFormChange({ ...form, notes: e.target.value })}
              placeholder="比如：老钓友，月底结账..."
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
