import { ArrowLeftRight, Loader2 } from 'lucide-react'

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
import type { CustomerWithStats, Product, Transaction } from '@/types'

/** 旧腿原售价（与后端 createExchange 同口径）：最近一条带售价的出库流水 → 建议零售价 → 0 */
export interface ExchangeOldPrice {
  unitPrice: number
  source: 'transaction' | 'suggest' | 'none'
  tx: Transaction | null
}

/** 换货对话框里的商品选择器（搜索 → 点选） */
function ExchangeProductPicker({
  label,
  selected,
  onSelect,
  keyword,
  onKeywordChange,
  excludeId,
  searchProducts,
  totalStockOf,
}: {
  label: string
  selected: Product | null
  onSelect: (p: Product | null) => void
  keyword: string
  onKeywordChange: (v: string) => void
  excludeId: number | null
  searchProducts: (kw: string, excludeId: number | null) => Product[]
  totalStockOf: (productId: number) => number
}) {
  return (
    <div className="relative space-y-1">
      <Label>{label} *</Label>
      {selected ? (
        <div className="flex items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5">
          <div className="text-sm">
            <span className="font-medium text-slate-800">{productName(selected)}</span>
            <span className="ml-2 font-mono text-xs text-muted-foreground">{selected.sku_code}</span>
            <span className="ml-2 text-xs text-muted-foreground">库存 {totalStockOf(selected.id)}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
            换一个
          </Button>
        </div>
      ) : (
        <>
          <Input value={keyword} onChange={(e) => onKeywordChange(e.target.value)} placeholder="输入 SKU/品牌/型号搜索..." />
          {keyword.trim() && (
            <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
              {searchProducts(keyword, excludeId).map((p) => (
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
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">库存 {totalStockOf(p.id)}</span>
                </button>
              ))}
              {searchProducts(keyword, excludeId).length === 0 && (
                <div className="px-4 py-3 text-sm text-muted-foreground">没有匹配的商品</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

interface ExchangeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  exchOld: Product | null
  onSelectOld: (p: Product | null) => void
  exchNew: Product | null
  onSelectNew: (p: Product | null) => void
  oldKw: string
  onOldKwChange: (v: string) => void
  newKw: string
  onNewKwChange: (v: string) => void
  qty: string
  onQtyChange: (v: string) => void
  price: string
  onPriceChange: (v: string) => void
  customers: CustomerWithStats[]
  custKey: string
  walkInKey: string
  onSelectCustomer: (key: string) => void
  customer: CustomerWithStats | null
  diff: number | null
  oldPrice: ExchangeOldPrice | null
  diffPaid: string
  onDiffPaidChange: (v: string) => void
  diffOnCredit: boolean
  onToggleDiffOnCredit: () => void
  refundOffsetCust: CustomerWithStats | null
  busy: boolean
  onSubmit: () => void
  searchProducts: (kw: string, excludeId: number | null) => Product[]
  totalStockOf: (productId: number) => number
}

/** 换货登记 Dialog：先退旧货再出新货，同一事务，失败整体回滚 */
export function ExchangeDialog({
  open,
  onOpenChange,
  exchOld,
  onSelectOld,
  exchNew,
  onSelectNew,
  oldKw,
  onOldKwChange,
  newKw,
  onNewKwChange,
  qty,
  onQtyChange,
  price,
  onPriceChange,
  customers,
  custKey,
  walkInKey,
  onSelectCustomer,
  customer,
  diff,
  oldPrice,
  diffPaid,
  onDiffPaidChange,
  diffOnCredit,
  onToggleDiffOnCredit,
  refundOffsetCust,
  busy,
  onSubmit,
  searchProducts,
  totalStockOf,
}: ExchangeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-5 text-brand-500" />
            换货登记
          </DialogTitle>
          <DialogDescription>
            旧货退回库存、新货按 FIFO 出库，两步一笔账；新货库存不足时不会动账
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ExchangeProductPicker
            label="退回的旧商品"
            selected={exchOld}
            onSelect={onSelectOld}
            keyword={oldKw}
            onKeywordChange={onOldKwChange}
            excludeId={exchNew?.id ?? null}
            searchProducts={searchProducts}
            totalStockOf={totalStockOf}
          />
          <ExchangeProductPicker
            label="换出的新商品"
            selected={exchNew}
            onSelect={onSelectNew}
            keyword={newKw}
            onKeywordChange={onNewKwChange}
            excludeId={exchOld?.id ?? null}
            searchProducts={searchProducts}
            totalStockOf={totalStockOf}
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>数量 *</Label>
              <Input
                type="number"
                min={1}
                value={qty}
                onChange={(e) => onQtyChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>
                新货售价（元）<span className="text-red-500">*</span>
              </Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => onPriceChange(e.target.value)}
              />
            </div>
          </div>

          {/* 谁换的货：补的钱要赊账必须选客户；退差价冲欠款按原单客户自动认 */}
          <div className="space-y-1">
            <Label>谁换的货</Label>
            <Select value={custKey} onValueChange={onSelectCustomer}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={walkInKey}>散客（当场结清）</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                    {c.outstanding > 0 ? `（还欠 ${formatPrice(c.outstanding)}）` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 差价试算：选好新旧货和数量后实时显示 */}
          {diff != null && oldPrice && (
            <div
              className={cn(
                'space-y-1 rounded-xl border px-4 py-3 text-[15px]',
                diff > 0
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : diff < 0
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600',
              )}
            >
              <div className="font-medium">
                {diff > 0
                  ? `新货比旧货贵 ${formatPrice(diff)}，要补钱`
                  : diff < 0
                    ? `新货比旧货便宜 ${formatPrice(-diff)}，要退钱`
                    : '新旧货一样价，不用补也不用退'}
              </div>
              <div className="text-xs opacity-80">
                旧货按 {formatPrice(oldPrice.unitPrice)} 算
                {oldPrice.source !== 'transaction' && '（没找到售价记录，按建议价算）'}
              </div>
            </div>
          )}

          {/* 补钱：实收默认全补，可选「补的钱也先欠着」（必须选客户） */}
          {diff != null && diff > 0 && (
            <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="space-y-1">
                <Label>补的钱实收多少（元）</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={diffOnCredit ? '0.00' : diffPaid}
                  onChange={(e) => onDiffPaidChange(e.target.value)}
                  disabled={diffOnCredit}
                  className="h-12 text-xl font-bold tabular-nums"
                />
              </div>
              <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
                <span>
                  {diffOnCredit
                    ? `补的钱先欠着，记到「${customer?.name ?? '—'}」账上`
                    : '补的钱当场收'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onToggleDiffOnCredit}
                >
                  {diffOnCredit ? '改成当场收' : '补的钱也先欠着'}
                </Button>
              </div>
              {diffOnCredit && !customer && (
                <div className="text-sm text-red-600">
                  先在上面选一个客户，才能把补的钱记他账上
                </div>
              )}
            </div>
          )}

          {/* 退钱：处理方式说明（原单赊账未付清的冲欠款，否则退现金） */}
          {diff != null && diff < 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              {refundOffsetCust
                ? `原单是「${refundOffsetCust.name}」赊的还没付清，差价 ${formatPrice(-diff)} 从他欠的钱里扣`
                : `差价 ${formatPrice(-diff)} 退现金给顾客`}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={!exchOld || !exchNew || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? '换货中...' : '确认换货'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
