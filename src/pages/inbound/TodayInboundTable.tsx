import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatPrice, formatTime, productName } from '@/lib/formatters'
import { usePagination } from '@/lib/usePagination'
import type { InventoryBatch, Product, Transaction } from '@/types'

interface TodayInboundTableProps {
  records: Transaction[]
  products: Product[]
  batches: InventoryBatch[]
}

/** 今日入库记录：记录多了按页翻，分页切在数据算好之后 */
export function TodayInboundTable({ records, products, batches }: TodayInboundTableProps) {
  const pg = usePagination(records, [records])
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">今日入库记录（{records.length} 条）</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">今日暂无入库记录</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>品名</TableHead>
                  <TableHead>批次号</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">进价</TableHead>
                  <TableHead>货位</TableHead>
                  <TableHead>操作人</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pg.pageItems.map((t) => {
                  const p = products.find((x) => x.id === t.product_id)
                  const b = batches.find((x) => x.id === t.batch_id)
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{formatTime(t.timestamp)}</TableCell>
                      <TableCell>
                        {p ? productName(p) : `#${t.product_id}`}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{b?.batch_no ?? '-'}</TableCell>
                      <TableCell className="text-right">{t.quantity}</TableCell>
                      <TableCell className="text-right">{formatPrice(t.unit_price)}</TableCell>
                      <TableCell>{b?.location ?? '-'}</TableCell>
                      <TableCell>{t.operator ?? '-'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <Pagination {...pg} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
