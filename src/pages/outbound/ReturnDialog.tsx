import { Loader2, RotateCcw } from 'lucide-react'

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
import { productName } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { PAYMENT_METHODS, type Customer, type PaymentMethod, type Product } from '@/types'

interface ReturnDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  keyword: string
  onKeywordChange: (v: string) => void
  candidates: Product[]
  selected: Product | null
  onSelect: (p: Product | null) => void
  qty: string
  onQtyChange: (v: string) => void
  refund: string
  onRefundChange: (v: string) => void
  creditCustomer: Customer | null
  useCredit: boolean
  onToggleUseCredit: () => void
  payMethod: PaymentMethod
  onPayMethodChange: (m: PaymentMethod) => void
  busy: boolean
  onSubmit: () => void
  totalStockOf: (productId: number) => number
}

/** 退货登记 Dialog：退回来的货重新入架，退款金额入账 */
export function ReturnDialog({
  open,
  onOpenChange,
  keyword,
  onKeywordChange,
  candidates,
  selected,
  onSelect,
  qty,
  onQtyChange,
  refund,
  onRefundChange,
  creditCustomer,
  useCredit,
  onToggleUseCredit,
  payMethod,
  onPayMethodChange,
  busy,
  onSubmit,
  totalStockOf,
}: ReturnDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="size-5 text-brand-500" />
            退货登记
          </DialogTitle>
          <DialogDescription>
            退回来的商品会加回库存（计入最近一次入库的批次），退款金额记入今日账目
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!selected ? (
            <div className="relative space-y-1">
              <Label>搜索退货商品 *</Label>
              <Input
                autoFocus
                value={keyword}
                onChange={(e) => onKeywordChange(e.target.value)}
                placeholder="输入 SKU/品牌/型号搜索..."
              />
              {candidates.length > 0 && (
                <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
                  {candidates.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        onSelect(p)
                        onKeywordChange('')
                      }}
                      className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-50"
                    >
                      <span>
                        {productName(p)}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {p.sku_code}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        库存 {totalStockOf(p.id)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
                <div className="text-sm">
                  <span className="font-medium text-slate-800">{productName(selected)}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {selected.sku_code}
                  </span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
                  换一个
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>退货数量 *</Label>
                  <Input
                    type="number"
                    min={1}
                    value={qty}
                    onChange={(e) => onQtyChange(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>退款金额（元）*</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={refund}
                    onChange={(e) => onRefundChange(e.target.value)}
                    placeholder="退给顾客多少钱"
                  />
                </div>
              </div>
              {/* 赊账销售的退货：记到原客户账上，退货后他少欠；不是他的可以点掉 */}
              {creditCustomer && (
                <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
                  {useCredit ? (
                    <span>
                      「{creditCustomer.name}」赊账买过这个，这次退货记到他账上，退货后他少欠
                    </span>
                  ) : (
                    <span>这次退货不记到任何人账上</span>
                  )}
                  <Button variant="ghost" size="sm" onClick={onToggleUseCredit}>
                    {useCredit ? '不是他的' : '记到他账上'}
                  </Button>
                </div>
              )}
              {/* 退款方式：真退钱才记；记到客户账上（冲减欠款）没有现金移动不显示 */}
              {!useCredit && (
                <div className="space-y-1">
                  <Label>退款方式</Label>
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
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={!selected || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? '登记中...' : '确认退货入库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
