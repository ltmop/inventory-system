import { Badge } from '@/components/ui/badge'
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
import { cn } from '@/lib/utils'
import type { Customer, InventoryBatch, Product, Transaction } from '@/types'

// 流水类型标签：优先用 notes 识别换货双腿/退差价
function txKindLabel(t: Transaction): string {
  if (t.notes === '换货出新') return '换货出新'
  if (t.notes === '换货退旧') return '换货退旧'
  if (t.notes === '换货退差价') return '退差价'
  return t.type === 'return' ? '退货' : t.type === 'exchange' ? '退差价' : '出库'
}

interface TodayRecordsTableProps {
  records: Transaction[]
  products: Product[]
  batches: InventoryBatch[]
  customers: Customer[]
}

/** 今日出入账记录（出库/退货/换货）：记录多了按页翻，分页切在数据算好之后 */
export function TodayRecordsTable({ records, products, batches, customers }: TodayRecordsTableProps) {
  const pg = usePagination(records, [records])
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">今日出入账记录（{records.length} 条）</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">今日暂无出入账记录</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>品名</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead>批次号</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">成本价</TableHead>
                  <TableHead className="text-right">售价/退款</TableHead>
                  <TableHead className="text-right">毛利</TableHead>
                  <TableHead>操作人</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pg.pageItems.map((t) => {
                  const p = products.find((x) => x.id === t.product_id)
                  const b = batches.find((x) => x.id === t.batch_id)
                  const isReturn = t.type === 'return'
                  const isExchangeDiff = t.type === 'exchange' // 换货退差价：不动库存，paid_amount 为负退款额
                  // 退货按负毛利冲减：退款 − 批次成本，取负
                  const profit =
                    t.selling_price != null && t.unit_price != null
                      ? (t.selling_price - t.unit_price) * t.quantity * (isReturn ? -1 : 1)
                      : null
                  const kind = txKindLabel(t)
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{formatTime(t.timestamp)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={isReturn || isExchangeDiff ? 'destructive' : 'secondary'}
                          className={cn(kind.startsWith('换货') && !isReturn && 'bg-brand-100 text-brand-700')}
                        >
                          {kind}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {p ? productName(p) : `#${t.product_id}`}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const cust = t.customer_id != null ? customers.find((c) => c.id === t.customer_id) : null
                          // 赊账标：赊账单后端会写实收金额，欠 = 应付 − 实收
                          const owed =
                            !isReturn && t.paid_amount != null && t.selling_price != null
                              ? t.quantity * t.selling_price - t.paid_amount
                              : 0
                          return cust ? (
                            <span>
                              {cust.name}
                              {owed > 0 && (
                                <Badge variant="destructive" className="ml-2">
                                  赊 {formatPrice(owed)}
                                </Badge>
                              )}
                            </span>
                          ) : (
                            <span className="text-slate-400">散客</span>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{b?.batch_no ?? '-'}</TableCell>
                      <TableCell className={cn('text-right', isReturn && 'text-red-600')}>
                        {isExchangeDiff ? '-' : isReturn ? `-${t.quantity}` : t.quantity}
                      </TableCell>
                      <TableCell className="text-right">{formatPrice(t.unit_price)}</TableCell>
                      <TableCell className={cn('text-right', (isReturn || isExchangeDiff) && 'text-red-600')}>
                        {isExchangeDiff ? formatPrice(t.paid_amount) : formatPrice(t.selling_price)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          profit !== null && profit >= 0 ? 'text-green-700' : 'text-red-600',
                        )}
                      >
                        {profit !== null ? formatPrice(profit) : '-'}
                      </TableCell>
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
