import { Minus, Plus, ShoppingCart, Trash2, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { formatPrice, productName } from '@/lib/formatters'
import { unitOf } from '@/lib/quantity'
import { cn } from '@/lib/utils'
import type { Product } from '@/types'

/** 购物清单一行：商品 + 数量 + 单价（分） */
export interface CartItem {
  product: Product
  quantity: number
  priceCents: number
}

interface CartPanelProps {
  items: CartItem[]
  totalStockOf: (productId: number) => number
  onQtyChange: (productId: number, quantity: number) => void
  onPriceChange: (productId: number, priceCents: number | null) => void
  onRemove: (productId: number) => void
  onClear: () => void
  onCheckout: () => void
}

/** 购物清单面板：一单多商品的暂存区，数量/单价可改，去开单统一收款 */
export function CartPanel({
  items,
  totalStockOf,
  onQtyChange,
  onPriceChange,
  onRemove,
  onClear,
  onCheckout,
}: CartPanelProps) {
  if (items.length === 0) return null
  const totalCents = items.reduce((s, i) => s + i.quantity * i.priceCents, 0)
  const totalCount = items.reduce((s, i) => s + i.quantity, 0)
  return (
    <Card className="gap-0 overflow-hidden border-brand-300 py-0 shadow-card-hover">
      <div className="h-1.5 bg-gradient-to-r from-emerald-500 via-emerald-600 to-emerald-700" />
      <CardHeader className="pt-5">
        <CardTitle className="flex items-center gap-3 text-lg">
          <ShoppingCart className="size-5 text-emerald-600" />
          购物清单
          <Badge className="bg-emerald-600">{items.length} 样 / 共 {totalCount}</Badge>
          <span className="ml-auto text-xl font-bold tabular-nums text-emerald-700">
            合计 {formatPrice(totalCents)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pb-5">
        {items.map((i) => {
          const stock = totalStockOf(i.product.id)
          const over = i.quantity > stock
          // 米商品（鱼线）步进 0.5，件商品步进 1
          const step = unitOf(i.product) === '米' ? 0.5 : 1
          return (
            <div
              key={i.product.id}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm',
                over && 'border-red-400 bg-red-50',
              )}
            >
              <div className="min-w-40 flex-1">
                <div className="font-medium">{productName(i.product)}</div>
                <div className="text-xs text-muted-foreground">
                  库存 {stock} {unitOf(i.product)}{over && <span className="ml-1 font-medium text-red-600">超出库存！</span>}
                </div>
              </div>
              {/* 单价（元）：直接改，默认带的是零售档/建议价 */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">单价</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={(i.priceCents / 100).toFixed(2)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    onPriceChange(
                      i.product.id,
                      e.target.value === '' || Number.isNaN(n) || n < 0 ? null : Math.round(n * 100),
                    )
                  }}
                  className="h-9 w-24 text-right tabular-nums"
                />
              </div>
              {/* 数量步进器 */}
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8"
                  disabled={i.quantity <= step}
                  onClick={() => onQtyChange(i.product.id, Math.round((i.quantity - step) * 10) / 10)}
                >
                  <Minus className="size-3.5" />
                </Button>
                <span className={cn('w-10 text-center text-base font-semibold tabular-nums', over && 'text-red-600')}>
                  {i.quantity}
                </span>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8"
                  disabled={i.quantity >= stock}
                  onClick={() => onQtyChange(i.product.id, Math.round((i.quantity + step) * 10) / 10)}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
              <span className="w-24 text-right font-semibold tabular-nums">
                {formatPrice(i.quantity * i.priceCents)}
              </span>
              <Button size="icon" variant="ghost" className="size-8 text-slate-400 hover:text-red-600" onClick={() => onRemove(i.product.id)}>
                <X className="size-4" />
              </Button>
            </div>
          )
        })}
        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" className="text-slate-500" onClick={onClear}>
            <Trash2 className="size-4" />
            清空清单
          </Button>
          <Button
            className="h-12 bg-emerald-600 px-8 text-base font-semibold hover:bg-emerald-700"
            disabled={items.some((i) => i.priceCents <= 0 || i.quantity > totalStockOf(i.product.id))}
            onClick={onCheckout}
          >
            去开单（{items.length} 样，{formatPrice(totalCents)}）
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
