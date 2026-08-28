import { CheckSquare, Tag, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface BatchActionBarProps {
  /** 已选中的商品数 */
  count: number
  busy: boolean
  onPrice: () => void
  onStatus: () => void
  onClear: () => void
}

/** 批量操作条：表格里勾选商品后浮出，提供批量改价/批量改状态/取消选择 */
export function BatchActionBar({ count, busy, onPrice, onStatus, onClear }: BatchActionBarProps) {
  return (
    <Card className="border-brand-200 bg-brand-50">
      <CardContent className="flex flex-wrap items-center gap-3 py-3">
        <span className="flex items-center gap-2 font-medium">
          <CheckSquare className="size-5 text-brand-600" />
          已选 {count} 个商品
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={onPrice} disabled={busy}>
            <Tag className="size-4" />
            批量改价
          </Button>
          <Button size="sm" variant="outline" onClick={onStatus} disabled={busy}>
            批量改状态
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
            <X className="size-4" />
            取消选择
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
