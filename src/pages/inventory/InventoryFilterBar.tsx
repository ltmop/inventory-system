import { useState } from 'react'
import { CalendarClock, RotateCcw, Search, SlidersHorizontal, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CATEGORIES, PRODUCT_STATUSES } from '@/types'

interface InventoryFilterBarProps {
  keyword: string
  onKeywordChange: (v: string) => void
  category: string
  onCategoryChange: (v: string) => void
  status: string
  onStatusChange: (v: string) => void
  lowOnly: boolean
  onToggleLowOnly: () => void
  expiringOnly: boolean
  onToggleExpiringOnly: () => void
  brand: string
  onBrandChange: (v: string) => void
  brands: string[]
  location: string
  onLocationChange: (v: string) => void
  locations: string[]
  stockMin: string
  onStockMinChange: (v: string) => void
  stockMax: string
  onStockMaxChange: (v: string) => void
  onReset: () => void
  filteredCount: number
  allValue: string
}

/** 库存页筛选区：关键词（父组件防抖）+ 品类/状态/低库存/临期 + 高级筛选（品牌/货位/库存区间） */
export function InventoryFilterBar({
  keyword,
  onKeywordChange,
  category,
  onCategoryChange,
  status,
  onStatusChange,
  lowOnly,
  onToggleLowOnly,
  expiringOnly,
  onToggleExpiringOnly,
  brand,
  onBrandChange,
  brands,
  location,
  onLocationChange,
  locations,
  stockMin,
  onStockMinChange,
  stockMax,
  onStockMaxChange,
  onReset,
  filteredCount,
  allValue,
}: InventoryFilterBarProps) {
  const [advanced, setAdvanced] = useState(false)
  const activeAdvanced =
    (brand !== allValue ? 1 : 0) + (location !== allValue ? 1 : 0) + (stockMin !== '' ? 1 : 0) + (stockMax !== '' ? 1 : 0)

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => onKeywordChange(e.target.value)}
              placeholder="搜索SKU/品牌/型号/条码..."
              className="pl-9"
            />
          </div>
          <Select value={category} onValueChange={onCategoryChange}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="品类" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allValue}>全部品类</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allValue}>全部状态</SelectItem>
              {PRODUCT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={lowOnly ? 'destructive' : 'outline'}
            onClick={onToggleLowOnly}
            title="只看库存低于预警线的商品（未单独设置预警线的按 5 件算）"
          >
            <TriangleAlert className="size-4" />
            低库存
          </Button>
          <Button
            variant="outline"
            className={expiringOnly ? 'border-amber-500 bg-amber-500 text-white hover:bg-amber-600 hover:text-white' : ''}
            onClick={onToggleExpiringOnly}
            title="只看 30 天内到期或已经过期的商品"
          >
            <CalendarClock className="size-4" />
            临期
          </Button>
          <Button
            variant={advanced ? 'default' : 'outline'}
            onClick={() => setAdvanced((v) => !v)}
            className="gap-1.5"
            title="按品牌/货位/库存区间组合筛选"
          >
            <SlidersHorizontal className="size-4" />
            高级筛选
            {activeAdvanced > 0 && (
              <span className="ml-0.5 rounded-full bg-brand-600 px-1.5 text-xs font-bold text-white">{activeAdvanced}</span>
            )}
          </Button>
          <span className="text-sm text-muted-foreground">共 {filteredCount} 个商品</span>
        </div>

        {advanced && (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
            <Select value={brand} onValueChange={onBrandChange}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="品牌" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={allValue}>全部品牌</SelectItem>
                {brands.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={location} onValueChange={onLocationChange}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="货位" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={allValue}>全部货位</SelectItem>
                {locations.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-slate-500">库存</span>
              <Input
                type="number"
                min={0}
                value={stockMin}
                onChange={(e) => onStockMinChange(e.target.value)}
                placeholder="最少"
                className="w-24"
              />
              <span className="text-slate-400">—</span>
              <Input
                type="number"
                min={0}
                value={stockMax}
                onChange={(e) => onStockMaxChange(e.target.value)}
                placeholder="最多"
                className="w-24"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={onReset} className="gap-1 text-slate-500">
              <RotateCcw className="size-3.5" />
              重置筛选
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
