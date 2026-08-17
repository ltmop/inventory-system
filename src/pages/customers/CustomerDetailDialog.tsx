import { HandCoins, Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDateTime, formatPrice } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import type { CustomerStatement, CustomerWithStats } from '@/types'

interface CustomerDetailDialogProps {
  /** 详情弹窗里的客户（页面已用最新 store 数据刷新过） */
  detail: CustomerWithStats | null
  onClose: () => void
  statement: CustomerStatement | null
  statementLoading: boolean
  onOpenPay: () => void
}

/** 客户详情（对账单）Dialog：拿货明细 + 还账记录 */
export function CustomerDetailDialog({
  detail,
  onClose,
  statement,
  statementLoading,
  onOpenPay,
}: CustomerDetailDialogProps) {
  return (
    <Dialog open={detail !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {detail?.name}
            {detail?.phone && (
              <span className="text-sm font-normal text-muted-foreground">{detail.phone}</span>
            )}
          </DialogTitle>
          <DialogDescription>他名下的每一笔赊账和还账都在这儿</DialogDescription>
        </DialogHeader>

        {detail && (
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
            <div>
              <div className="text-sm text-slate-500">当前欠的钱</div>
              <div
                className={cn(
                  'text-3xl font-bold tabular-nums',
                  detail.outstanding > 0
                    ? 'text-red-600'
                    : detail.outstanding < 0
                      ? 'text-emerald-600'
                      : 'text-slate-400',
                )}
              >
                {detail.outstanding > 0
                  ? formatPrice(detail.outstanding)
                  : detail.outstanding < 0
                    ? `预收 ${formatPrice(-detail.outstanding)}`
                    : '不欠钱'}
              </div>
            </div>
            <Button size="lg" className="h-12 px-6 text-base" onClick={onOpenPay}>
              <HandCoins className="size-5" />
              还账
            </Button>
          </div>
        )}

        {/* 老钓友偏好：记下爱用什么，他来了一眼能看出该推荐啥 */}
        {detail?.preferences && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="text-xs font-medium text-amber-700">偏好</div>
            <div className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{detail.preferences}</div>
          </div>
        )}

        {statementLoading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在翻账本...
          </div>
        )}

        {!statementLoading && statement && (
          <div className="max-h-[46vh] space-y-5 overflow-y-auto pr-1">
            <div>
              <div className="mb-2 text-sm font-medium text-slate-700">
                拿货明细（共 {statement.sales.length} 笔）
              </div>
              {statement.sales.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  还没有拿过货
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>商品</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead className="text-right">应付</TableHead>
                      <TableHead className="text-right">已付</TableHead>
                      <TableHead className="text-right">欠</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.sales.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(s.timestamp)}</TableCell>
                        <TableCell>
                          {s.product_name}
                          {s.type === 'return' && (
                            <Badge variant="destructive" className="ml-2">退货</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.type === 'return' ? `-${s.quantity}` : s.quantity}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatPrice(s.due)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.type === 'return' ? '-' : formatPrice(s.paid)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-medium tabular-nums',
                            s.owed > 0 ? 'text-red-600' : s.owed < 0 ? 'text-emerald-600' : 'text-slate-400',
                          )}
                        >
                          {s.owed > 0 ? formatPrice(s.owed) : s.owed < 0 ? `少欠 ${formatPrice(-s.owed)}` : '付清'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <div>
              <div className="mb-2 text-sm font-medium text-slate-700">
                还账记录（共 {statement.payments.length} 笔，累计还了 {formatPrice(statement.total_paid_back)}）
              </div>
              {statement.payments.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  还没有还过钱
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                      <TableHead>方式</TableHead>
                      <TableHead>备注</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(p.created_at)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums text-emerald-700">
                          {formatPrice(p.amount)}
                        </TableCell>
                        <TableCell>{p.method}</TableCell>
                        <TableCell className="text-muted-foreground">{p.notes ?? '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
