import { motion } from 'motion/react'
import { PackageMinus, ShoppingCart } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { FifoPlan } from '@/lib/fifo'
import { formatDate, formatPrice, productName } from '@/lib/formatters'
import { unitOf } from '@/lib/quantity'
import { cn } from '@/lib/utils'
import { PRICE_LEVEL_LABELS, type InventoryBatch, type PriceLevel, type Product } from '@/types'

interface SelectedProductCardProps {
  selected: Product
  totalStock: number
  productBatches: InventoryBatch[]
  byBatch: Map<number, number>
  quantity: string
  onQuantityChange: (v: string) => void
  overStock: boolean
  plan: FifoPlan | null
  priceYuan: string
  onPriceChange: (v: string) => void
  activeTier: PriceLevel | null
  operator: string
  onOperatorChange: (v: string) => void
  onConfirm: () => void
  onAddToCart: () => void
  onCancel: () => void
}

/** 选中商品卡片：批次库存（FIFO 预览）+ 数量/售价/操作人表单 */
export function SelectedProductCard({
  selected,
  totalStock,
  productBatches,
  byBatch,
  quantity,
  onQuantityChange,
  overStock,
  plan,
  priceYuan,
  onPriceChange,
  activeTier,
  operator,
  onOperatorChange,
  onConfirm,
  onAddToCart,
  onCancel,
}: SelectedProductCardProps) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="h-1.5 bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700" />
      <CardHeader className="pt-5">
        <CardTitle className="flex items-center gap-3 text-lg">
          {productName(selected)}
          <Badge variant="secondary">{selected.category}</Badge>
          <span className="text-sm font-normal text-muted-foreground">
            当前总库存：<span className="font-semibold text-brand-600">{totalStock} {unitOf(selected)}</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pb-5">
        <div className="space-y-2">
          <div className="text-sm text-slate-600">批次库存（FIFO，按入库日期排列）：</div>
          {productBatches.length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              该商品暂无库存，无法出库
            </div>
          ) : (
            productBatches.map((b, idx) => {
              const deduct = byBatch.get(b.id) ?? 0
              return (
                <div
                  key={b.id}
                  className={cn(
                    'relative flex items-center gap-4 rounded-md border px-4 py-2 text-sm',
                    idx === 0 && 'border-l-4 border-l-green-500',
                    deduct > 0 && 'bg-slate-100/70',
                  )}
                >
                  <span className="font-mono text-xs">{b.batch_no}</span>
                  {idx === 0 && <Badge className="bg-green-600">最早批次</Badge>}
                  <span>库存 {b.quantity}</span>
                  <span>{formatPrice(b.cost_price)}</span>
                  <span className="text-muted-foreground">{b.location ?? '-'}</span>
                  <span className="text-muted-foreground">{formatDate(b.inbound_date)}</span>
                  {deduct > 0 && (
                    <span className="ml-auto font-medium text-red-600">
                      扣 {deduct} → 剩 {b.quantity - deduct}
                    </span>
                  )}
                </div>
              )
            })
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="space-y-1">
            <Label>出库数量 *（{unitOf(selected)}）</Label>
            <Input
              type="number"
              min={unitOf(selected) === '米' ? 0.1 : 1}
              step={unitOf(selected) === '米' ? 0.1 : 1}
              value={quantity}
              onChange={(e) => onQuantityChange(e.target.value)}
              className={cn(overStock && 'border-red-500 focus-visible:ring-red-500')}
            />
            {overStock && (
              <div className="text-xs text-red-600">
                出库数量超过当前库存（还差 {plan!.shortage} {unitOf(selected)}）
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label>
              售价（元）<span className="text-red-500">*</span>
              {activeTier && (
                <Badge className="ml-2 bg-brand-100 text-brand-700">
                  {PRICE_LEVEL_LABELS[activeTier]}价
                </Badge>
              )}
            </Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={priceYuan}
              onChange={(e) => onPriceChange(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>操作人</Label>
            <Input value={operator} onChange={(e) => onOperatorChange(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-3">
          <Button asChild onClick={onConfirm} disabled={productBatches.length === 0}>
            <motion.button whileTap={{ scale: 0.96 }}>
            <PackageMinus className="size-4" />
            确认出库
            </motion.button>
          </Button>
          {/* 一单多商品：这样先放清单里，继续扫下一样，最后统一开单收款 */}
          <Button
            variant="outline"
            className="border-emerald-600 text-emerald-700 hover:bg-emerald-50"
            onClick={onAddToCart}
            disabled={productBatches.length === 0}
          >
            <ShoppingCart className="size-4" />
            加入清单
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
