import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDateTime, formatPrice } from '@/lib/formatters'
import { usePagination } from '@/lib/usePagination'
import { cn } from '@/lib/utils'
import { PO_STATUS_LABELS, type POStatus, type PurchaseOrderListItem } from '@/types'

// 状态徽章配色：待收货-黄、部分收货-蓝、已完成-绿、已取消-灰
export const PO_STATUS_BADGE_CLASS: Record<POStatus, string> = {
  draft: 'bg-slate-200 text-slate-500',
  sent: 'bg-yellow-100 text-yellow-700',
  partial: 'bg-blue-100 text-blue-700',
  complete: 'bg-green-100 text-green-700',
  cancelled: 'bg-slate-200 text-slate-500',
}

interface PurchaseOrderTableProps {
  /** 已「先筛选后排序」好的订单列表，分页切在最后 */
  orders: PurchaseOrderListItem[]
  /** 一张采购单都没有（区别于"这个状态下没有"），空态文案不同 */
  allEmpty: boolean
  statusFilter: string
  onStatusFilterChange: (v: string) => void
  allValue: string
  onOpenDetail: (o: PurchaseOrderListItem) => void
}

/** 采购单列表：状态筛选 + 点开明细；单子多了按页翻 */
export function PurchaseOrderTable({
  orders,
  allEmpty,
  statusFilter,
  onStatusFilterChange,
  allValue,
  onOpenDetail,
}: PurchaseOrderTableProps) {
  const pg = usePagination(orders, [orders])
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={onStatusFilterChange}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allValue}>全部状态</SelectItem>
              <SelectItem value="sent">待收货</SelectItem>
              <SelectItem value="partial">部分收货</SelectItem>
              <SelectItem value="complete">已完成</SelectItem>
              <SelectItem value="cancelled">已取消</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">共 {orders.length} 张单</span>
        </div>
        {orders.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {allEmpty
              ? '还没有采购单，点右上角「新建采购单」给供应商下第一张订货单'
              : '这个状态下没有单子，换个筛选看看'}
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>单号</TableHead>
                  <TableHead>供应商</TableHead>
                  <TableHead className="text-right">订了几种货</TableHead>
                  <TableHead className="text-right">总金额</TableHead>
                  <TableHead>收货进度</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>下单时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pg.pageItems.map((o) => (
                  <TableRow
                    key={o.id}
                    className="cursor-pointer"
                    onClick={() => onOpenDetail(o)}
                    title="点开看明细、收货"
                  >
                    <TableCell className="font-mono text-xs">{o.po_no}</TableCell>
                    <TableCell>{o.supplier_name ?? '未指定'}</TableCell>
                    <TableCell className="text-right">{o.item_count} 种</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(o.total_cost)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'tabular-nums',
                          o.received_qty >= o.total_qty ? 'text-green-700' : 'text-slate-700',
                        )}
                      >
                        已收 {o.received_qty}/{o.total_qty} 件
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge className={PO_STATUS_BADGE_CLASS[o.status]}>
                        {PO_STATUS_LABELS[o.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(o.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination {...pg} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
