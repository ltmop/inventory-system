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
import { formatPrice } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { PAYMENT_METHODS, type CustomerWithStats, type PaymentMethod } from '@/types'

interface PayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 弹窗标题/说明用的客户（页面已用最新 store 数据刷新过），关闭时可能为 null */
  detail: CustomerWithStats | null
  amount: string
  onAmountChange: (v: string) => void
  method: PaymentMethod
  onMethodChange: (m: PaymentMethod) => void
  error: string
  busy: boolean
  onSubmit: () => void
}

/** 还账 Dialog：大金额输入 + 四个大按钮选方式 */
export function PayDialog({
  open,
  onOpenChange,
  detail,
  amount,
  onAmountChange,
  method,
  onMethodChange,
  error,
  busy,
  onSubmit,
}: PayDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{detail?.name} 还账</DialogTitle>
          <DialogDescription>
            {detail && detail.outstanding > 0
              ? `他目前还欠 ${formatPrice(detail.outstanding)}，可以全还也可以先还一部分`
              : '可以记一笔还款，多还的钱算预收，下次拿货抵'}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>还了多少钱（元）*</Label>
            <Input
              autoFocus
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => onAmountChange(e.target.value)}
              className="h-14 text-2xl font-bold tabular-nums"
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1">
            <Label>怎么给的</Label>
            <div className="grid grid-cols-4 gap-2">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m}
                  onClick={() => onMethodChange(m)}
                  className={cn(
                    'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                    method === m
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button size="lg" onClick={onSubmit} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? '记账中...' : '记上'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
