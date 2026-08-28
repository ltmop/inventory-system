import { CalendarClock, Search, TriangleAlert } from 'lucide-react'

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
  filteredCount: number
  allValue: string
}

/** 库存页筛选区：关键词（父组件防抖）+ 品类/状态/低库存/临期 */
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
  filteredCount,
  allValue,
}: InventoryFilterBarProps) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 pt-6">
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
        <span className="text-sm text-muted-foreground">共 {filteredCount} 个商品</span>
      </CardContent>
    </Card>
  )
}
