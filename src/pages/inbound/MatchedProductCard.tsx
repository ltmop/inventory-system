import { motion } from 'motion/react'
import { CheckCircle2, Loader2, PackagePlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { unitOf, isDecimalUnit } from '@/lib/quantity'
import type { Product, Supplier } from '@/types'

interface MatchedProductCardProps {
  matched: Product
  totalStock: number
  lastCost: number | null
  quantity: string
  onQuantityChange: (v: string) => void
  costYuan: string
  onCostYuanChange: (v: string) => void
  location: string
  onLocationChange: (v: string) => void
  supplierId: string
  onSupplierIdChange: (v: string) => void
  noSupplierValue: string
  suppliers: Supplier[]
  operator: string
  onOperatorChange: (v: string) => void
  /** 到期日（保质期商品用）：饵料/小药/活饵/路亚假饵必填，其余可选 */
  expiryDate: string
  onExpiryDateChange: (v: string) => void
  /** 该品类是否必填到期日（保质期商品） */
  expiryRequired: boolean
  submitting: boolean
  onConfirm: () => void
  onOpenCreate: () => void
  onCancel: () => void
}

/** 扫码命中后的入库卡片：商品信息 + 数量/进价/货位/供应商表单 */
export function MatchedProductCard({
  matched,
  totalStock,
  lastCost,
  quantity,
  onQuantityChange,
  costYuan,
  onCostYuanChange,
  location,
  onLocationChange,
  supplierId,
  onSupplierIdChange,
  noSupplierValue,
  suppliers,
  operator,
  onOperatorChange,
  expiryDate,
  onExpiryDateChange,
  expiryRequired,
  submitting,
  onConfirm,
  onOpenCreate,
  onCancel,
}: MatchedProductCardProps) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      {/* 品牌色顶条：一眼区别于普通卡片 */}
      <div className="h-1.5 bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700" />
      <CardHeader className="pt-5">
        <CardTitle className="flex items-center gap-3 text-lg">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
            <CheckCircle2 className="size-3.5" />
            匹配成功
          </span>
          {productName(matched)}
          <span className="text-sm font-normal text-muted-foreground">
            {matched.category}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pb-5">
        {/* 商品信息区：灰底分区，与表单区拉开层级 */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 rounded-xl bg-slate-50 px-5 py-4 text-sm text-slate-600 md:grid-cols-4">
          <div>
            <div className="text-xs text-slate-400">SKU</div>
            <div className="font-mono font-medium text-slate-800">{matched.sku_code}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">条码</div>
            <div className="font-mono font-medium text-slate-800">{matched.barcode ?? '-'}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">当前库存</div>
            <div className="font-semibold text-brand-600">{totalStock} {unitOf(matched)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">最近进价</div>
            <div className="font-semibold text-slate-800">{formatPrice(lastCost)}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
          <div className="space-y-1">
            <Label>入库数量 *（{unitOf(matched)}）</Label>
            <Input
              type="number"
              min={isDecimalUnit(matched) ? 0.1 : 1}
              step={isDecimalUnit(matched) ? 0.1 : 1}
              value={quantity}
              onChange={(e) => onQuantityChange(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>进价（元）*</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={costYuan}
              onChange={(e) => onCostYuanChange(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>货位</Label>
            <Input value={location} onChange={(e) => onLocationChange(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>供应商</Label>
            <Select value={supplierId} onValueChange={onSupplierIdChange}>
              <SelectTrigger>
                <SelectValue placeholder="不指定" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={noSupplierValue}>不指定</SelectItem>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>操作人</Label>
            <Input value={operator} onChange={(e) => onOperatorChange(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>
              到期日{expiryRequired ? ' *' : '（可选）'}
            </Label>
            <Input
              type="date"
              required={expiryRequired}
              value={expiryDate}
              onChange={(e) => onExpiryDateChange(e.target.value)}
              title={
                expiryRequired
                  ? '保质期商品必须填这个批次的到期日，临期预警按批次提醒'
                  : '有保质期的商品填这个批次的到期日，临期预警按批次提醒'
              }
              className={
                expiryRequired && !expiryDate
                  ? 'border-red-400 focus-visible:ring-red-400'
                  : undefined
              }
            />
            {expiryRequired && !expiryDate && (
              <p className="text-xs text-red-600">保质期商品必须填到期日</p>
            )}
          </div>
        </div>
        {/* 操作区沉底：与信息区分层 */}
        <div className="-mx-6 -mb-5 mt-2 flex gap-3 border-t bg-slate-50/60 px-6 py-4">
          <Button
            asChild
            onClick={onConfirm}
            disabled={submitting}
            className="bg-brand-600 hover:bg-brand-700"
          >
            <motion.button whileTap={{ scale: 0.96 }}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PackagePlus className="size-4" />
            )}
            {submitting ? '入库中...' : '确认入库'}
            </motion.button>
          </Button>
          <Button variant="outline" onClick={onOpenCreate}>
            新建商品
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
