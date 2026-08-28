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
import type { FifoPlan } from '@/lib/fifo'
import { formatPrice, productName } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { PRICE_LEVEL_LABELS, PAYMENT_METHODS, type CustomerWithStats, type PaymentMethod, type PriceLevel, type PriceTier, type Product } from '@/types'

function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

interface ConfirmOutboundDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: Product | null
  quantity: string
  qty: number
  qtyValid: boolean
  priceYuan: string
  plan: FifoPlan | null
  selectedTiers: PriceTier[]
  activeTier: PriceLevel | null
  onApplyTier: (tier: PriceLevel) => void
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

/** 出库确认 Dialog（危险操作二次确认）：FIFO 扣减预览 + 价格档 + 赊账选项 */
export function ConfirmOutboundDialog({
  open,
  onOpenChange,
  selected,
  quantity,
  qty,
  qtyValid,
  priceYuan,
  plan,
  selectedTiers,
  activeTier,
  onApplyTier,
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
}: ConfirmOutboundDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认出库</DialogTitle>
          <DialogDescription>
            {selected ? productName(selected) : ''} × {quantity}
            {qtyValid && yuanToCents(priceYuan) !== null && (
              <>
                ，应付 <span className="font-semibold text-slate-700">{formatPrice(qty * (yuanToCents(priceYuan) ?? 0))}</span>
              </>
            )}
            ，将按 FIFO 扣减以下批次：
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {plan?.allocations.map((a) => (
            <div
              key={a.batch_id}
              className="flex items-center justify-between rounded-md border px-4 py-2 text-sm"
            >
              <span className="font-mono text-xs">{a.batch_no}</span>
              <span>
                扣 <span className="font-medium text-red-600">{a.deduct}</span> → 剩{' '}
                {a.remaining_after}
              </span>
            </div>
          ))}
        </div>

        {/* 价格档：该商品设了档次价才显示；点一下带出这档价格，售价仍可回主界面手改 */}
        {selectedTiers.length > 0 && (
          <div className="space-y-2">
            <Label>按哪档价格卖</Label>
            <div className="flex flex-wrap gap-2">
              {selectedTiers.map((t) => (
                <button
                  key={t.tier}
                  onClick={() => onApplyTier(t.tier)}
                  className={cn(
                    'h-12 min-w-24 cursor-pointer rounded-xl border px-4 text-base font-medium transition-colors',
                    activeTier === t.tier
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
                  )}
                >
                  {PRICE_LEVEL_LABELS[t.tier]}{' '}
                  <span className="tabular-nums">{formatPrice(t.price)}</span>
                </button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              当前售价 {formatPrice(yuanToCents(priceYuan))}
              {yuanToCents(priceYuan) !== null &&
                (activeTier !== null ? `（${PRICE_LEVEL_LABELS[activeTier]}价）` : '（自定义价）')}
            </div>
          </div>
        )}

        {/* 买的人 + 付款方式：散客只能全额收款；选了客户可以赊账 */}
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
              {payMode !== 'full' && qtyValid && yuanToCents(priceYuan) !== null && (
                <div className="text-sm text-red-600">
                  这次先欠{' '}
                  {formatPrice(
                    qty * (yuanToCents(priceYuan) ?? 0) -
                      (payMode === 'credit' ? 0 : Math.min(yuanToCents(paidYuan) ?? 0, qty * (yuanToCents(priceYuan) ?? 0))),
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
          <Button variant="destructive" onClick={onExecute} disabled={executing}>
            {executing && <Loader2 className="size-4 animate-spin" />}
            {executing ? '执行中...' : '确认执行出库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
