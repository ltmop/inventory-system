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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatPrice, productName } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { PAYMENT_METHODS, type CustomerWithStats, type PaymentMethod } from '@/types'
import type { CartItem } from './CartPanel'

function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

interface CheckoutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: CartItem[]
  totalCents: number
  custKey: string
  walkInKey: string
  newCustKey: string
  onSelectCustomer: (key: string) => void
  payMode: 'full' | 'partial' | 'credit'
  onPayModeChange: (mode: 'full' | 'partial' | 'credit') => void
  payMethod: PaymentMethod
  onPayMethodChange: (m: PaymentMethod) => void
  paidYuan: string
  onPaidYuanChange: (v: string) => void
  confirmError: string
  customers: CustomerWithStats[]
  executing: boolean
  onExecute: () => void
}

/** 一单多商品开单确认：清单明细 + 统一收款（客户/赊账/到账方式，与单品出库同口径） */
export function CheckoutDialog({
  open,
  onOpenChange,
  items,
  totalCents,
  custKey,
  walkInKey,
  newCustKey,
  onSelectCustomer,
  payMode,
  onPayModeChange,
  payMethod,
  onPayMethodChange,
  paidYuan,
  onPaidYuanChange,
  confirmError,
  customers,
  executing,
  onExecute,
}: CheckoutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认开单（{items.length} 样商品）</DialogTitle>
          <DialogDescription>
            应付 <span className="font-semibold text-slate-700">{formatPrice(totalCents)}</span>
            ，一单出齐，按 FIFO 扣减各商品批次：
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-56 space-y-1.5 overflow-y-auto">
          {items.map((i) => (
            <div
              key={i.product.id}
              className="flex items-center justify-between rounded-md border px-4 py-2 text-sm"
            >
              <span className="truncate">{productName(i.product)}</span>
              <span className="shrink-0 tabular-nums">
                {formatPrice(i.priceCents)} × {i.quantity} ={' '}
                <span className="font-semibold">{formatPrice(i.quantity * i.priceCents)}</span>
              </span>
            </div>
          ))}
        </div>

        {/* 买的人 + 付款方式：散客只能全额收款；选了客户可以赊账（与单品出库同款） */}
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="space-y-1">
            <Label>买的人</Label>
            <Select value={custKey} onValueChange={onSelectCustomer}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={walkInKey}>散客（不记账）</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                    {c.outstanding > 0 ? `（还欠 ${formatPrice(c.outstanding)}）` : ''}
                  </SelectItem>
                ))}
                <SelectItem value={newCustKey}>+ 新客户</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {custKey === walkInKey ? (
            <div className="text-sm text-slate-500">散客需全额收款，钱货两清</div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['full', '全额收款'],
                    ['partial', '付一部分'],
                    ['credit', '先欠着'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => onPayModeChange(mode)}
                    className={cn(
                      'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                      payMode === mode
                        ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {payMode === 'partial' && (
                <div className="space-y-1">
                  <Label>这次收了多少钱（元）</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={paidYuan}
                    onChange={(e) => onPaidYuanChange(e.target.value)}
                    className="h-12 text-xl font-bold tabular-nums"
                  />
                </div>
              )}
              {payMode !== 'full' && (
                <div className="text-sm text-red-600">
                  这次先欠{' '}
                  {formatPrice(
                    totalCents -
                      (payMode === 'credit' ? 0 : Math.min(yuanToCents(paidYuan) ?? 0, totalCents)),
                  )}
                  ，记到「{customers.find((c) => String(c.id) === custKey)?.name ?? ''}」账上
                </div>
              )}
            </div>
          )}
          {/* 到账方式：日结按现金/微信/支付宝对账用；「先欠着」不收钱时后端自动不落方式 */}
          {!(custKey !== walkInKey && payMode === 'credit') && (
            <div className="space-y-1">
              <Label>到账方式</Label>
              <div className="grid grid-cols-4 gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m}
                    onClick={() => onPayMethodChange(m)}
                    className={cn(
                      'h-11 cursor-pointer rounded-xl border text-sm font-medium transition-colors',
                      payMethod === m
                        ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
          {confirmError && <div className="text-sm text-red-600">{confirmError}</div>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            className="bg-emerald-600 hover:bg-emerald-700"
            onClick={onExecute}
            disabled={executing || items.length === 0}
          >
            {executing && <Loader2 className="size-4 animate-spin" />}
            {executing ? '开单中...' : `确认开单 ${formatPrice(totalCents)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
