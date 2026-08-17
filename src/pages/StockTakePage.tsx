import { useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { formatDateTime } from '@/lib/formatters'
import { type Category, type StockTake } from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/feedback'
import { playSound } from '@/lib/sounds'
import { allocSkuToBatches } from '@/lib/stocktakeAlloc'
import { CreateStockTakeDialog } from './stocktake/CreateStockTakeDialog'
import { statusBadge, takeScopeLabel } from './stocktake/shared'
import { StockTakeExecute, type TakeEdits } from './stocktake/StockTakeExecute'

const WHOLE_SHOP = '__all__'

// takeScopeLabel 重新导出：保持原有对外入口不变
export { takeScopeLabel }

export function StockTakePage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const suppliers = useAppStore((s) => s.suppliers)
  const stockTakes = useAppStore((s) => s.stockTakes)
  const stockTakeItems = useAppStore((s) => s.stockTakeItems)
  const createStockTake = useAppStore((s) => s.createStockTake)
  const submitStockTake = useAppStore((s) => s.submitStockTake)

  const [activeTakeId, setActiveTakeId] = useState<number | null>(null)
  const [keyword, setKeyword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pageError, setPageError] = useState('')
  // 提交进度展示："正在保存第 X 项，共 Y 项"（实际写入是单事务，失败整体回滚）
  const [progress, setProgress] = useState<{ cur: number; total: number } | null>(null)

  // 新建盘点 Dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [area, setArea] = useState(WHOLE_SHOP)
  const [category, setCategory] = useState(WHOLE_SHOP)
  const [supplierKey, setSupplierKey] = useState(WHOLE_SHOP)
  const [mode, setMode] = useState<'batch' | 'sku'>('batch')
  const [operator, setOperator] = useState('阿东')

  // 完成盘点确认 Dialog
  const [finishOpen, setFinishOpen] = useState(false)

  // 盘点录入的本地暂存，完成时统一提交
  const [edits, setEdits] = useState<TakeEdits>({})

  // 从现有货位提取区域前缀（如 "A区"）
  const areas = useMemo(() => {
    const set = new Set<string>()
    for (const loc of [...products.map((p) => p.location), ...batches.map((b) => b.location)]) {
      const m = loc?.match(/^.+?区/)
      if (m) set.add(m[0])
    }
    return [...set].sort()
  }, [products, batches])

  const activeTake = stockTakes.find((t) => t.id === activeTakeId) ?? null
  const activeItems = useMemo(
    () => stockTakeItems.filter((it) => it.stock_take_id === activeTakeId),
    [stockTakeItems, activeTakeId],
  )

  const openTake = (t: StockTake) => {
    setActiveTakeId(t.id)
    setKeyword('')
    const init: TakeEdits = {}
    for (const it of stockTakeItems) {
      if (it.stock_take_id === t.id) {
        init[it.id] = { qty: it.actual_qty === null ? '' : String(it.actual_qty), reason: it.reason }
      }
    }
    setEdits(init)
  }

  const handleCreate = async () => {
    if (submitting) return
    setSubmitting(true)
    setPageError('')
    try {
      const take = await createStockTake(area === WHOLE_SHOP ? null : area, operator.trim() || '未署名', {
        category: category === WHOLE_SHOP ? null : (category as Category),
        supplierId: supplierKey === WHOLE_SHOP ? null : Number(supplierKey),
        mode,
      })
      setCreateOpen(false)
      openTake(take)
    } catch (e) {
      setCreateOpen(false)
      setPageError(`创建盘点单失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  const filteredItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return activeItems
    return activeItems.filter((it) => {
      const p = products.find((x) => x.id === it.product_id)
      return [p?.sku_code, p?.brand, p?.model, p?.barcode]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(kw)
    })
  }, [activeItems, keyword, products])

  // 差异汇总（基于本地录入）
  const summary = useMemo(() => {
    let counted = 0
    let surplus = 0
    let shortage = 0
    for (const it of activeItems) {
      const edit = edits[it.id]
      if (!edit || edit.qty.trim() === '') continue
      const actual = Number(edit.qty)
      // 计量单位（v2.2）：米商品允许小数实盘数
      const isMeter = products.find((x) => x.id === it.product_id)?.unit === '米'
      const valid = isMeter
        ? Number.isFinite(actual) && actual >= 0 && Math.round(actual * 10) === actual * 10
        : Number.isInteger(actual) && actual >= 0
      if (!valid) continue
      counted++
      const diff = actual - it.system_qty
      if (diff > 0) surplus += diff
      else shortage += diff
    }
    return { counted, surplus, shortage, total: surplus + shortage }
  }, [activeItems, edits])

  const uncounted = activeItems.length - summary.counted

  const handleFinish = async () => {
    if (!activeTake || submitting) return
    setSubmitting(true)
    setPageError('')
    // 原子提交：实盘数 + 完成盘点一个事务搞定，中途失败整体回滚
    const isSku = activeTake.mode === 'sku'
    const items = activeItems.flatMap((it) => {
      const edit = edits[it.id]
      if (!edit || edit.qty.trim() === '') return []
      const actual = Number(edit.qty)
      // 计量单位（v2.2）：米商品允许小数实盘数
      const isMeter = products.find((x) => x.id === it.product_id)?.unit === '米'
      const valid = isMeter
        ? Number.isFinite(actual) && actual >= 0 && Math.round(actual * 10) === actual * 10
        : Number.isInteger(actual) && actual >= 0
      if (!valid) return []
      // sku 模式：把摊完的每批次目标数量一起带上，前端预览即所见（后端兜底按比例分摊）
      let batchAllocations: { batchId: number; quantity: number }[] | undefined
      if (isSku && it.batch_id === null) {
        const productBatches = batches
          .filter((b) => b.product_id === it.product_id)
          .sort((a, b) => a.id - b.id)
          .map((b) => ({ id: b.id, quantity: b.quantity }))
        batchAllocations = allocSkuToBatches(productBatches, actual, it.system_qty)
      }
      return [{ itemId: it.id, actualQty: actual, reason: edit.reason.trim(), ...(batchAllocations ? { batchAllocations } : {}) }]
    })
    // 进度呈现：单事务写入很快，这里用匀速计数让老板看到"正在一条条存"
    setProgress({ cur: 1, total: Math.max(items.length, 1) })
    const timer = setInterval(() => {
      setProgress((p) => (p && p.cur < p.total ? { ...p, cur: p.cur + 1 } : p))
    }, 90)
    try {
      await submitStockTake(activeTake.id, items)
      playSound('success')
      setFinishOpen(false)
      setActiveTakeId(null)
    } catch (e) {
      setFinishOpen(false)
      playSound('error')
      setPageError(`盘点提交失败：${e instanceof Error ? e.message : String(e)}（已整体回滚，库存未被改动）`)
    } finally {
      clearInterval(timer)
      setProgress(null)
      setSubmitting(false)
    }
  }

  // ───────── 盘点执行视图 ─────────
  if (activeTake) {
    return (
      <StockTakeExecute
        take={activeTake}
        suppliers={suppliers}
        products={products}
        batches={batches}
        keyword={keyword}
        onKeywordChange={setKeyword}
        items={filteredItems}
        allItems={activeItems}
        edits={edits}
        onEditsChange={setEdits}
        summary={summary}
        uncounted={uncounted}
        pageError={pageError}
        finishOpen={finishOpen}
        onFinishOpenChange={setFinishOpen}
        submitting={submitting}
        progress={progress}
        onFinish={handleFinish}
        onBack={() => setActiveTakeId(null)}
      />
    )
  }

  // ───────── 盘点单列表视图 ─────────
  return (
    <div className="space-y-6">
      <PageHeader
        title="盘点管理"
        subtitle="创建盘点单、录入实盘数量、差异落实到批次库存"
        action={<Button onClick={() => setCreateOpen(true)}>+ 新建盘点</Button>}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">盘点单（{stockTakes.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {stockTakes.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无盘点单，点击右上角新建
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>盘点单号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>盘点范围</TableHead>
                  <TableHead>开始时间</TableHead>
                  <TableHead>完成时间</TableHead>
                  <TableHead>操作人</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stockTakes.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.take_no}</TableCell>
                    <TableCell>{statusBadge(t.status)}</TableCell>
                    <TableCell>{takeScopeLabel(t, suppliers)}</TableCell>
                    <TableCell>{formatDateTime(t.started_at)}</TableCell>
                    <TableCell>{formatDateTime(t.completed_at)}</TableCell>
                    <TableCell>{t.operator}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => openTake(t)}>
                        {t.status === '进行中' ? (
                          <>
                            <Play className="size-3" />
                            进入盘点
                          </>
                        ) : (
                          '查看'
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新建盘点 Dialog */}
      <CreateStockTakeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        area={area}
        onAreaChange={setArea}
        category={category}
        onCategoryChange={setCategory}
        supplierKey={supplierKey}
        onSupplierKeyChange={setSupplierKey}
        operator={operator}
        onOperatorChange={setOperator}
        mode={mode}
        onModeChange={setMode}
        areas={areas}
        suppliers={suppliers}
        wholeShopValue={WHOLE_SHOP}
        submitting={submitting}
        onSubmit={handleCreate}
      />
    </div>
  )
}
