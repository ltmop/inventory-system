import { Pencil, Trash2, Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
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
import type { CustomerWithStats } from '@/types'

/** 欠款列：欠钱红字大字；不欠钱灰色；多还了（预收）绿色 */
function OutstandingCell({ outstanding }: { outstanding: number }) {
  if (outstanding > 0) {
    return <span className="text-lg font-bold tabular-nums text-red-600">{formatPrice(outstanding)}</span>
  }
  if (outstanding < 0) {
    return <span className="tabular-nums text-emerald-600">预收 {formatPrice(-outstanding)}</span>
  }
  return <span className="text-slate-400">不欠钱</span>
}

interface CustomerTableProps {
  /** 已按欠款排好序的客户列表，分页切在最后 */
  customers: CustomerWithStats[]
  onOpenDetail: (c: CustomerWithStats) => void
  onEdit: (c: CustomerWithStats) => void
  onDelete: (c: CustomerWithStats) => void
}

/** 客户列表：点名字看对账单；人多了按页翻 */
export function CustomerTable({ customers, onOpenDetail, onEdit, onDelete }: CustomerTableProps) {
  const pg = usePagination(customers, [customers])
  return (
    <Card>
      <CardContent className="pt-6">
        {customers.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <Users className="mx-auto mb-3 size-8 text-slate-300" />
            还没有客户，点右上角「新增客户」建一个；赊账卖货时就能记到他名下
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>电话</TableHead>
                  <TableHead className="text-right">欠的钱</TableHead>
                  <TableHead>最近交易</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pg.pageItems.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => onOpenDetail(c)}>
                    <TableCell>
                      <button className="font-medium text-sky-700 hover:underline cursor-pointer">
                        {c.name}
                      </button>
                      {c.notes && <div className="text-xs text-muted-foreground">{c.notes}</div>}
                    </TableCell>
                    <TableCell>{c.phone ?? '-'}</TableCell>
                    <TableCell className="text-right">
                      <OutstandingCell outstanding={c.outstanding} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.last_deal_at ? formatDateTime(c.last_deal_at) : '没有交易'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                        <Button variant="outline" size="sm" onClick={() => onEdit(c)}>
                          <Pencil className="size-3" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => onDelete(c)}
                        >
                          <Trash2 className="size-3" />
                          删除
                        </Button>
                      </div>
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
