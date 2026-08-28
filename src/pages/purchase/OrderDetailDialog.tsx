import { motion } from 'motion/react'
import { ClipboardList, Truck } from 'lucide-react'

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
import { PO_STATUS_LABELS, type POStatus, type PurchaseOrderDetail } from '@/types'
import { PO_STATUS_BADGE_CLASS } from './PurchaseOrderTable'

const canReceive = (status: POStatus) => status === 'sent' || status === 'partial'

interface OrderDetailDialogProps {
  detail: PurchaseOrderDetail | null
  onClose: () => void
  onOpenReceive: (d: PurchaseOrderDetail) => void
  onCancelOrder: (d: PurchaseOrderDetail) => void
}

/** 订单详情 Dialog：明细 + 收货/取消入口 */
export function OrderDetailDialog({ detail, onClose, onOpenReceive, onCancelOrder }: OrderDetailDialogProps) {
  return (
    <Dialog open={detail !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <ClipboardList className="size-5 text-brand-500" />
            采购单 <span className="font-mono">{detail?.order.po_no}</span>
            {detail && (
              <Badge className={PO_STATUS_BADGE_CLASS[detail.order.status]}>
                {PO_STATUS_LABELS[detail.order.status]}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            供应商：{detail?.order.supplier_name ?? '未指定'} · 下单：
            {detail ? formatDateTime(detail.order.created_at) : ''}
            {detail?.order.notes ? ` · 备注：${detail.order.notes}` : ''}
          </DialogDescription>
        </DialogHeader>
        {detail && (
          <div className="space-y-4">
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>商品</TableHead>
                    <TableHead className="text-right">订了多少</TableHead>
                    <TableHead className="text-right">已收</TableHead>
                    <TableHead className="text-right">还差</TableHead>
                    <TableHead className="text-right">进价</TableHead>
                    <TableHead className="text-right">小计</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map((it) => {
                    const remaining = it.quantity - it.received_qty
                    return (
                      <TableRow key={it.id}>
                        <TableCell>
                          {it.product_name}
                          {it.sku_code && (
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {it.sku_code}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{it.quantity}</TableCell>
                        <TableCell className="text-right">{it.received_qty}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-medium',
                            remaining > 0 ? 'text-amber-600' : 'text-green-700',
                          )}
                        >
                          {remaining > 0 ? remaining : '收齐了'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPrice(it.unit_cost)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPrice(it.quantity * it.unit_cost)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <div className="flex justify-end border-t bg-slate-50 px-4 py-2.5 text-sm">
                总金额：<span className="ml-1 text-base font-bold text-brand-600 tabular-nums">{formatPrice(detail.order.total_cost)}</span>
              </div>
            </div>
            <div className="flex gap-3">
              {canReceive(detail.order.status) && (
                <Button
                  asChild
                  onClick={() => onOpenReceive(detail)}
                  className="bg-green-600 hover:bg-green-700"
                >
                  <motion.button whileTap={{ scale: 0.96 }}>
                    <Truck className="size-4" />
                    收货入库
                  </motion.button>
                </Button>
              )}
              {canReceive(detail.order.status) && (
                <Button
                  variant="outline"
                  className="text-red-600"
                  onClick={() => onCancelOrder(detail)}
                >
                  取消订单
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
