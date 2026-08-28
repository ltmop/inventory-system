import { ChevronLeft, ChevronRight } from 'lucide-react'

import { pageNumbers } from '@/lib/usePagination'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export const PAGE_SIZE_OPTIONS = [20, 50, 100]

interface PaginationProps {
  page: number // 当前页（1 起）
  pageCount: number // 总页数
  pageSize: number
  total: number // 总条数
  start: number // 当前页第一条的下标（0 起）
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  className?: string
}

/** 通用分页条：左边「第 X-Y 条，共 N 条」，右边每页条数 + 上一页/页码/下一页 */
function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  start,
  onPageChange,
  onPageSizeChange,
  className,
}: PaginationProps) {
  const end = Math.min(start + pageSize, total)
  return (
    <div
      data-slot="pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3 pt-4', className)}
    >
      <span className="text-sm text-muted-foreground">
        {total === 0 ? '共 0 条' : `第 ${start + 1}-${end} 条，共 ${total} 条`}
      </span>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">每页</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
          <SelectTrigger className="h-8 w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} 条
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          title="上一页"
        >
          <ChevronLeft className="size-4" />
        </Button>
        {pageNumbers(page, pageCount).map((n, i) =>
          n === '…' ? (
            <span key={`ellipsis-${i}`} className="px-1 text-sm text-muted-foreground">
              …
            </span>
          ) : (
            <Button
              key={n}
              variant={n === page ? 'default' : 'outline'}
              size="icon"
              className="size-8"
              onClick={() => onPageChange(n)}
            >
              {n}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          title="下一页"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}

export { Pagination }
