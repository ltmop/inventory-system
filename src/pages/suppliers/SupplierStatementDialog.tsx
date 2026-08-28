import { useState } from 'react'
import { Banknote, Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Pagination } from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, formatPrice } from '@/lib/formatters'
import { usePagination } from '@/lib/usePagination'
import { PAYMENT_METHODS, type PaymentMethod, type Supplier, type SupplierStatement } from '@/types'

interface SupplierStatementDialogProps {
  stmtFor: Supplier | null
  stmt: SupplierStatement | null
  loading: boolean
  onClose: () => void
  /** 登记付款（父组件调 store 后刷新对账单） */
  onPay: (supplierId: number, input: { amount: number; method: string; note: string | null; payDate?: string }) => Promise<void>
}

/** 供应商对账单 Dialog：汇总头（含已付/还欠 v0.1）+ 进货明细 + 付款登记与记录（样式参照客户对账单） */
export function SupplierStatementDialog({ stmtFor, stmt, loading, onClose, onPay }: SupplierStatementDialogProps) {
  // 换供应商/重新加载时回第 1 页
  const pg = usePagination(stmt?.lines ?? [], [stmt])

  // 付款登记表单（v0.1）：金额元 + 方式 + 备注
  const [payYuan, setPayYuan] = useState('')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('现金')
  const [payNote, setPayNote] = useState('')
  const [payBusy, setPayBusy] = useState(false)
  const [payError, setPayError] = useState('')

  const submitPay = async () => {
    if (!stmtFor || payBusy) return
    const yuan = Number(payYuan)
    if (!Number.isFinite(yuan) || yuan <= 0) {
      setPayError('付款金额要大于 0')
      return
    }
    setPayBusy(true)
    setPayError('')
    try {
      await onPay(stmtFor.id, {
        amount: Math.round(yuan * 100),
        method: payMethod,
        note: payNote.trim() || null,
      })
      setPayYuan('')
      setPayNote('')
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e))
    } finally {
      setPayBusy(false)
    }
  }

  return (
    <Dialog open={stmtFor !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {stmtFor?.name}
            {stmtFor?.phone && (
              <span className="text-sm font-normal text-muted-foreground">{stmtFor.phone}</span>
            )}
          </DialogTitle>
          <DialogDescription>从他家进的每一批货、每一笔付款都在这儿</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在翻进货账...
          </div>
        )}

        {!loading && stmt && (
          <>
            {/* 汇总头：累计进货 / 已付款 / 还欠 / 待收货 */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-xs text-slate-500">累计进货</div>
                <div className="text-xl font-bold tabular-nums text-slate-800">
                  {formatPrice(stmt.totalAmount)}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">共 {stmt.totalQty} 件</div>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-xs text-slate-500">已付款</div>
                <div className="text-xl font-bold tabular-nums text-slate-800">
                  {formatPrice(stmt.totalPaid)}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">{stmt.payments.length} 笔</div>
              </div>
              <div
                className={`rounded-xl px-4 py-3 ${
                  stmt.outstanding > 0 ? 'bg-amber-50' : 'bg-slate-50'
                }`}
              >
                <div className={`text-xs ${stmt.outstanding > 0 ? 'text-amber-600' : 'text-slate-500'}`}>
                  还欠{stmt.outstanding < 0 ? '（多付/预付）' : ''}
                </div>
                <div
                  className={`text-xl font-bold tabular-nums ${
                    stmt.outstanding > 0 ? 'text-amber-700' : 'text-slate-400'
                  }`}
                >
                  {formatPrice(Math.abs(stmt.outstanding))}
                </div>
              </div>
              <div className={`rounded-xl px-4 py-3 ${stmt.pendingPoAmount > 0 ? 'bg-amber-50' : 'bg-slate-50'}`}>
                <div className={`text-xs ${stmt.pendingPoAmount > 0 ? 'text-amber-600' : 'text-slate-500'}`}>
                  待收货
                </div>
                <div
                  className={`text-xl font-bold tabular-nums ${
                    stmt.pendingPoAmount > 0 ? 'text-amber-700' : 'text-slate-400'
                  }`}
                >
                  {stmt.pendingPoAmount > 0 ? formatPrice(stmt.pendingPoAmount) : '没有待收'}
                </div>
              </div>
            </div>

            {/* 付款登记（v0.1） */}
            <div className="rounded-xl border border-brand-100 bg-brand-50/50 px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
                <Banknote className="size-4 text-brand-500" />
                登记付款
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={payYuan}
                  onChange={(e) => setPayYuan(e.target.value)}
                  placeholder="付款金额（元）"
                  className="w-36"
                />
                <Select value={payMethod} onValueChange={(v) => setPayMethod(v as PaymentMethod)}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="备注（如：还6月货款）"
                  className="w-56"
                />
                <Button
                  onClick={submitPay}
                  disabled={payBusy || !payYuan.trim()}
                  className="bg-brand-600 hover:bg-brand-700"
                >
                  {payBusy ? '登记中...' : '记一笔'}
                </Button>
                <span className="text-xs text-slate-400">
                  最近进货 {stmt.lastInboundAt ? formatDate(stmt.lastInboundAt) : '—'}
                </span>
              </div>
              {payError && <div className="mt-1.5 text-xs text-red-600">{payError}</div>}
            </div>

            <div className="max-h-[34vh] overflow-y-auto pr-1">
              <div className="mb-2 text-sm font-medium text-slate-700">
                进货明细（共 {stmt.lines.length} 批）
              </div>
              {stmt.lines.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  还没有从他家进过货
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>商品</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead className="text-right">单价</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                      <TableHead>单号</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pg.pageItems.map((l) => (
                      <TableRow key={l.batch_id}>
                        <TableCell className="whitespace-nowrap">{formatDate(l.date)}</TableCell>
                        <TableCell>
                          <span className="mr-2">{l.product_name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{l.sku}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPrice(l.cost_price)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatPrice(l.amount)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {l.po_no ?? l.batch_no}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            {stmt.lines.length > 0 && (
              <Pagination {...pg} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} />
            )}

            {/* 付款记录（v0.1） */}
            <div className="max-h-[24vh] overflow-y-auto pr-1">
              <div className="mb-2 text-sm font-medium text-slate-700">
                付款记录（共 {stmt.payments.length} 笔）
              </div>
              {stmt.payments.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
                  还没记过付款。进货多、付款少的时候，这里能算出"还欠多少"
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>日期</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                      <TableHead>方式</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>经手</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stmt.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="whitespace-nowrap">{formatDate(p.pay_date)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatPrice(p.amount)}
                        </TableCell>
                        <TableCell>{p.method}</TableCell>
                        <TableCell className="max-w-52 truncate text-slate-500">
                          {p.note ?? '—'}
                        </TableCell>
                        <TableCell className="text-slate-500">{p.operator ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
