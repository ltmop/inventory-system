import { ArrowLeft, ClipboardCheck, Loader2, Search } from 'lucide-react'
import { Fragment } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { productName } from '@/lib/formatters'
import { allocSkuToBatches } from '@/lib/stocktakeAlloc'
import { cn } from '@/lib/utils'
import type { InventoryBatch, Product, StockTake, StockTakeItem, Supplier } from '@/types'
import { statusBadge, takeScopeLabel } from './shared'

/** 盘点录入的本地暂存（itemId → 实盘数/原因），完成时页面统一提交 */
export type TakeEdits = Record<number, { qty: string; reason: string }>

interface StockTakeExecuteProps {
  take: StockTake
  suppliers: Supplier[]
  products: Product[]
  /** 全量批次（sku 模式预览"摊完每个批次剩多少"用） */
  batches: InventoryBatch[]
  keyword: string
  onKeywordChange: (v: string) => void
  /** 已按关键词筛选好的盘点明细 */
  items: StockTakeItem[]
  /** 未筛选的全部明细（汇总/提交用口径） */
  allItems: StockTakeItem[]
  edits: TakeEdits
  onEditsChange: (updater: (prev: TakeEdits) => TakeEdits) => void
  summary: { counted: number; surplus: number; shortage: number; total: number }
  uncounted: number
  pageError: string
  finishOpen: boolean
  onFinishOpenChange: (open: boolean) => void
  submitting: boolean
  progress: { cur: number; total: number } | null
  onFinish: () => void
  onBack: () => void
}

/** 盘点执行视图：搜索定位、逐行录实盘数、差异汇总、完成盘点二次确认 */
export function StockTakeExecute({
  take,
  suppliers,
  products,
  batches,
  keyword,
  onKeywordChange,
  items,
  allItems,
  edits,
  onEditsChange,
  summary,
  uncounted,
  pageError,
  finishOpen,
  onFinishOpenChange,
  submitting,
  progress,
  onFinish,
  onBack,
}: StockTakeExecuteProps) {
  const readOnly = take.status !== '进行中'
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-2xl font-bold text-slate-800">盘点执行：{take.take_no}</h1>
        <span className="text-sm text-muted-foreground">
          范围：{takeScopeLabel(take, suppliers)}
        </span>
        {statusBadge(take.status)}
      </div>

      {/* 搜索过滤：进行中用于快速定位录入，已完成用于翻查历史明细，都可用 */}
      <Card>
        <CardContent className="flex items-center gap-3 pt-6">
          <Search className="size-5 shrink-0 text-sky-600" />
          <Input
            autoFocus
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder="搜索/扫码商品（SKU/品牌/型号/条码）..."
            className="text-base"
          />
        </CardContent>
      </Card>

      {pageError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {pageError}
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          {items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {allItems.length === 0 ? '该盘点单没有明细' : '没有符合条件的商品'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>品名</TableHead>
                  <TableHead className="text-right">系统库存</TableHead>
                  <TableHead className="w-28 text-right">实际数量</TableHead>
                  <TableHead className="text-right">差异</TableHead>
                  <TableHead>原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it) => {
                  const p = products.find((x) => x.id === it.product_id)
                  const edit = edits[it.id] ?? { qty: '', reason: '' }
                  const actual = edit.qty.trim() === '' ? null : Number(edit.qty)
                  // 计量单位（v2.2）：米商品允许小数实盘数
                  const isMeter = p?.unit === '米'
                  const valid =
                    actual === null ||
                    (isMeter
                      ? Number.isFinite(actual) && actual >= 0 && Math.round(actual * 10) === actual * 10
                      : Number.isInteger(actual) && actual >= 0)
                  const diff = valid && actual !== null ? actual - it.system_qty : null
                  // sku 模式（按总数盘）：算出摊完后每个批次剩多少，让老板看得见
                  const isSku = take.mode === 'sku' && it.batch_id === null
                  let breakdown: { batchId: number; quantity: number }[] = []
                  if (isSku && valid && actual !== null) {
                    const productBatches = batches
                      .filter((b) => b.product_id === it.product_id)
                      .sort((a, b) => a.id - b.id)
                      .map((b) => ({ id: b.id, quantity: b.quantity }))
                    breakdown = allocSkuToBatches(productBatches, actual, it.system_qty)
                  }
                  return (
                    <Fragment key={it.id}>
                      <TableRow>
                        <TableCell className="font-mono text-xs">{p?.sku_code ?? '-'}</TableCell>
                        <TableCell>
                          {p ? productName(p) : `#${it.product_id}`}
                        </TableCell>
                        <TableCell className="text-right">{it.system_qty}</TableCell>
                        <TableCell className="text-right">
                          {readOnly ? (
                            (it.actual_qty ?? '-')
                          ) : (
                            <Input
                              type="number"
                              min={0}
                              value={edit.qty}
                              onChange={(e) =>
                                onEditsChange((prev) => ({
                                  ...prev,
                                  [it.id]: { ...edit, qty: e.target.value },
                                }))
                              }
                              className={cn(
                                'ml-auto w-24 text-right',
                                !valid && 'border-red-500 focus-visible:ring-red-500',
                              )}
                            />
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-medium',
                            diff !== null && diff > 0 && 'text-green-600',
                            diff !== null && diff < 0 && 'text-red-600',
                          )}
                        >
                          {diff === null ? '-' : diff > 0 ? `+${diff}` : diff}
                        </TableCell>
                        <TableCell>
                          {readOnly ? (
                            (it.reason || '-')
                          ) : (
                            <Input
                              value={edit.reason}
                              onChange={(e) =>
                                onEditsChange((prev) => ({
                                  ...prev,
                                  [it.id]: { ...edit, reason: e.target.value },
                                }))
                              }
                              placeholder="差异原因..."
                              className="w-40"
                            />
                          )}
                        </TableCell>
                      </TableRow>
                      {isSku && breakdown.length > 0 && !readOnly && (
                        <TableRow className="bg-slate-50/70">
                          <TableCell colSpan={6} className="px-8 py-1.5 text-xs text-slate-500">
                            摊完后各批次：
                            {breakdown.map((a) => {
                              const b = batches.find((x) => x.id === a.batchId)
                              return (
                                <span key={a.batchId} className="mr-3">
                                  「{b?.batch_no ?? `批次#${a.batchId}`}」→{' '}
                                  <span className="font-semibold text-slate-700">{a.quantity}</span>
                                  <span className="text-slate-400">（原 {b?.quantity ?? '?'}）</span>
                                </span>
                              )
                            })}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between pt-6">
          <div className="text-sm text-slate-600">
            差异汇总：已盘 {summary.counted}/{allItems.length} 项 ｜ 差异总数{' '}
            {summary.total >= 0 ? `+${summary.total}` : summary.total} ｜ 盘盈{' '}
            <span className="text-green-600">+{summary.surplus}</span> ｜ 盘亏{' '}
            <span className="text-red-600">{summary.shortage}</span>
          </div>
          {!readOnly && (
            <Button onClick={() => onFinishOpenChange(true)} disabled={summary.counted === 0 || submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
              {submitting ? '提交中...' : '完成盘点'}
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog open={finishOpen} onOpenChange={onFinishOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>完成盘点</DialogTitle>
            <DialogDescription>
              将把 {summary.counted} 项盘点结果落实到批次库存，差异不可撤销。
              {uncounted > 0 && `另有 ${uncounted} 项未录入实际数量，将保持系统库存不变。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onFinishOpenChange(false)}>
              再想想
            </Button>
            <Button variant="destructive" onClick={onFinish} disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting
                ? progress
                  ? `正在保存第 ${progress.cur} 项，共 ${progress.total} 项`
                  : '提交中...'
                : '确认完成盘点'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
