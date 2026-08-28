import { useMemo } from 'react'

import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Pagination } from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDateTime, productName } from '@/lib/formatters'
import { unitOf } from '@/lib/quantity'
import { usePagination } from '@/lib/usePagination'
import { useAppStore } from '@/store/appStore'
import type { Product, Transaction, TransactionType } from '@/types'

// 流水类型中文名 + 进出方向：入=绿、出=红，一眼分清
const TYPE_META: Record<TransactionType, { label: string; badge: string; sign: '+' | '-' | '' }> = {
  in: { label: '入库', badge: 'bg-green-100 text-green-700', sign: '+' },
  out: { label: '出库', badge: 'bg-red-100 text-red-700', sign: '-' },
  return: { label: '退货', badge: 'bg-green-100 text-green-700', sign: '+' },
  // 换货退差价流水不动库存（只记钱），数量不带正负号
  exchange: { label: '换货', badge: 'bg-slate-100 text-slate-600', sign: '' },
  waste: { label: '报损', badge: 'bg-red-100 text-red-700', sign: '-' },
}

interface ProductHistoryDialogProps {
  product: Product | null
  onClose: () => void
}

/**
 * 库存变动历史：该商品的全部流水（纯前端筛选 loadAll 的 transactions，不走后端）。
 * 顶部平衡行：累计入 / 累计出 / 当前库存；每页 20 条。
 */
export function ProductHistoryDialog({ product, onClose }: ProductHistoryDialogProps) {
  const transactions = useAppStore((s) => s.transactions)
  const totalStockOf = useAppStore((s) => s.totalStockOf)

  // transactions 已按时间倒序（loadAll 口径）；数据大时只 filter 一次（useMemo）
  const rows = useMemo<Transaction[]>(
    () => (product ? transactions.filter((t) => t.product_id === product.id) : []),
    [transactions, product],
  )
  const pg = usePagination(rows, [rows], 20)

  const totals = useMemo(() => {
    let inQty = 0
    let outQty = 0
    for (const t of rows) {
      if (t.type === 'in' || t.type === 'return') inQty += t.quantity
      // 报损跟出库一样是减库存，计入"累计出"
      else if (t.type === 'out' || t.type === 'waste') outQty += t.quantity
      // exchange 只记差价不动库存，不进进出平衡
    }
    return { inQty, outQty }
  }, [rows])

  return (
    <Dialog open={product !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>库存变动历史{product ? `：${productName(product)}` : ''}</DialogTitle>
          {product && (
            <DialogDescription>
              累计入 <span className="font-medium text-green-600">{totals.inQty} {unitOf(product)}</span>
              {' / '}累计出 <span className="font-medium text-red-600">{totals.outQty} {unitOf(product)}</span>
              {' / '}当前库存 <span className="font-medium">{totalStockOf(product.id)} {unitOf(product)}</span>
            </DialogDescription>
          )}
        </DialogHeader>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            这个商品还没有任何出入库记录
          </div>
        ) : (
          <>
            <div className="max-h-[50vh] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead>经手人</TableHead>
                    <TableHead>备注</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pg.pageItems.map((t) => {
                    const meta = TYPE_META[t.type]
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(t.timestamp)}</TableCell>
                        <TableCell>
                          <Badge className={meta.badge}>{meta.label}</Badge>
                        </TableCell>
                        <TableCell
                          className={
                            meta.sign === '+'
                              ? 'text-right font-medium text-green-600'
                              : meta.sign === '-'
                                ? 'text-right font-medium text-red-600'
                                : 'text-right text-slate-500'
                          }
                        >
                          {meta.sign}
                          {t.quantity}
                        </TableCell>
                        <TableCell>{t.operator ?? '-'}</TableCell>
                        <TableCell className="max-w-48 truncate" title={t.notes ?? ''}>
                          {t.notes ?? '-'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <Pagination {...pg} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
