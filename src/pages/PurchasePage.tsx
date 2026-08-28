import { useEffect, useMemo, useState } from 'react'
import { PackagePlus, Plus } from 'lucide-react'
import { PageHeader, SuccessBanner, ErrorBanner } from '@/components/feedback'
import { GuestBlockCard } from '@/components/GuestBlockCard'
import { useAppStore } from '@/store/appStore'
import { productName } from '@/lib/formatters'
import { playSound } from '@/lib/sounds'
import {
  type Product,
  type PurchaseOrderDetail,
  type PurchaseOrderListItem,
} from '@/types'
import { Button } from '@/components/ui/button'
import { CancelOrderDialog } from './purchase/CancelOrderDialog'
import { CreateOrderDialog, type DraftItem } from './purchase/CreateOrderDialog'
import { OrderDetailDialog } from './purchase/OrderDetailDialog'
import { PurchaseOrderTable } from './purchase/PurchaseOrderTable'
import { ReceiveDialog } from './purchase/ReceiveDialog'

const ALL = '__all__'
const NO_SUPPLIER = '__none__'

// 元字符串转分，非法输入返回 null
function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

export function PurchasePage() {
  const products = useAppStore((s) => s.products)
  const suppliers = useAppStore((s) => s.suppliers)
  const purchaseOrders = useAppStore((s) => s.purchaseOrders)
  const lastCostOf = useAppStore((s) => s.lastCostOf)
  const loadPurchaseOrders = useAppStore((s) => s.loadPurchaseOrders)
  const createPurchaseOrder = useAppStore((s) => s.createPurchaseOrder)
  const purchaseOrderDetail = useAppStore((s) => s.purchaseOrderDetail)
  const receivePurchaseOrder = useAppStore((s) => s.receivePurchaseOrder)
  const cancelPurchaseOrder = useAppStore((s) => s.cancelPurchaseOrder)

  const [statusFilter, setStatusFilter] = useState(ALL)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 新建订单 Dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [supplierId, setSupplierId] = useState(NO_SUPPLIER)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([])
  const [itemKey, setItemKey] = useState(1)
  const [pickerKw, setPickerKw] = useState('')
  const [notes, setNotes] = useState('')
  const [createError, setCreateError] = useState('')

  // 详情 Dialog
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null)

  // 收货 Dialog
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrderDetail | null>(null)
  const [receiveQty, setReceiveQty] = useState<Record<number, string>>({})
  const [receiveError, setReceiveError] = useState('')

  // 取消订单二次确认
  const [cancelTarget, setCancelTarget] = useState<PurchaseOrderDetail | null>(null)

  // Electron 环境进页面拉一次采购单列表（loadAll 不含采购单）
  useEffect(() => {
    void loadPurchaseOrders().catch(() => {})
  }, [loadPurchaseOrders])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 列表按时间倒序 + 状态筛选（分页在 PurchaseOrderTable 内部，切在排序之后）
  const shown = useMemo(() => {
    return [...purchaseOrders]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
      .filter((o) => statusFilter === ALL || o.status === statusFilter)
  }, [purchaseOrders, statusFilter])

  // 新建订单：商品搜索候选（已加进单子的不再出现）
  const pickerCandidates = useMemo(() => {
    const kw = pickerKw.trim().toLowerCase()
    if (!kw) return []
    const inDraft = new Set(draftItems.map((d) => d.product.id))
    return products
      .filter((p) => !inDraft.has(p.id))
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
      .slice(0, 6)
  }, [pickerKw, products, draftItems])

  const draftTotal = draftItems.reduce((s, d) => {
    const qty = Number(d.quantity)
    const cost = yuanToCents(d.costYuan)
    return s + (Number.isInteger(qty) && qty > 0 && cost !== null ? qty * cost : 0)
  }, 0)

  const openCreate = () => {
    setSupplierId(NO_SUPPLIER)
    setDraftItems([])
    setPickerKw('')
    setNotes('')
    setCreateError('')
    setCreateOpen(true)
  }

  const addDraftItem = (p: Product) => {
    const last = lastCostOf(p.id)
    setDraftItems((prev) => [
      ...prev,
      {
        key: itemKey,
        product: p,
        quantity: '1',
        // 默认带该商品最近进价
        costYuan: last !== null ? (last / 100).toFixed(2) : '',
      },
    ])
    setItemKey((k) => k + 1)
    setPickerKw('')
  }

  const patchDraft = (key: number, patch: Partial<DraftItem>) =>
    setDraftItems((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  const handleCreate = async () => {
    if (busy) return
    if (supplierId === NO_SUPPLIER) {
      setCreateError('先选一个供应商——没有的话去「供应商」页加一个')
      playSound('error')
      return
    }
    if (draftItems.length === 0) {
      setCreateError('还没加商品——在上面搜一下要订的货')
      playSound('error')
      return
    }
    const items: { productId: number; quantity: number; costPrice: number }[] = []
    for (const d of draftItems) {
      const qty = Number(d.quantity)
      if (!Number.isInteger(qty) || qty < 1) {
        setCreateError(`「${productName(d.product)}」的数量必须是 ≥1 的整数`)
        playSound('error')
        return
      }
      const cost = yuanToCents(d.costYuan)
      if (cost === null || cost <= 0) {
        setCreateError(`「${productName(d.product)}」的进价没填或不对（要大于 0 元）`)
        playSound('error')
        return
      }
      items.push({ productId: d.product.id, quantity: qty, costPrice: cost })
    }
    setBusy(true)
    try {
      const po = await createPurchaseOrder({
        supplierId: Number(supplierId),
        items,
        notes: notes.trim() || null,
      })
      playSound('success')
      setSuccess(`采购单 ${po.po_no} 已建好，货到了点「收货入库」就行`)
      setCreateOpen(false)
    } catch (e) {
      playSound('error')
      setCreateError(`建单失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (o: PurchaseOrderListItem) => {
    setError('')
    try {
      setDetail(await purchaseOrderDetail(o.id))
    } catch (e) {
      setError(`打开订单失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 刷新详情（收货/取消后弹窗里的数字要跟着变）
  const refreshDetail = async (id: number) => {
    try {
      setDetail(await purchaseOrderDetail(id))
    } catch {
      setDetail(null)
    }
  }

  const openReceive = (d: PurchaseOrderDetail) => {
    // 每条明细默认填剩余待收数量，可改小（分批收货）
    const qty: Record<number, string> = {}
    for (const it of d.items) {
      const remaining = it.quantity - it.received_qty
      if (remaining > 0) qty[it.id] = String(remaining)
    }
    setReceiveQty(qty)
    setReceiveError('')
    setReceiveTarget(d)
  }

  const handleReceive = async () => {
    if (!receiveTarget || busy) return
    const items: { itemId: number; quantity: number }[] = []
    for (const it of receiveTarget.items) {
      const raw = (receiveQty[it.id] ?? '').trim()
      if (raw === '') continue
      const qty = Number(raw)
      const remaining = it.quantity - it.received_qty
      if (!Number.isInteger(qty) || qty < 1) {
        setReceiveError(`「${it.product_name}」的收货数量必须是 ≥1 的整数；这次不收就留空`)
        playSound('error')
        return
      }
      if (qty > remaining) {
        setReceiveError(`「${it.product_name}」最多还能收 ${remaining} 件，不能多收`)
        playSound('error')
        return
      }
      items.push({ itemId: it.id, quantity: qty })
    }
    if (items.length === 0) {
      setReceiveError('这次一件都不收吗？不收就直接关掉这个窗口')
      playSound('error')
      return
    }
    setBusy(true)
    try {
      const r = await receivePurchaseOrder(receiveTarget.order.id, items)
      playSound('success')
      setSuccess(`已入库 ${r.receivedTotal} 件，库存已更新`)
      setReceiveTarget(null)
      await refreshDetail(receiveTarget.order.id)
    } catch (e) {
      playSound('error')
      setReceiveError(`收货失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    if (!cancelTarget || busy) return
    setBusy(true)
    try {
      await cancelPurchaseOrder(cancelTarget.order.id)
      playSound('success')
      setSuccess(`采购单 ${cancelTarget.order.po_no} 已取消`)
      setCancelTarget(null)
      await refreshDetail(cancelTarget.order.id)
    } catch (e) {
      playSound('error')
      setError(`取消失败：${e instanceof Error ? e.message : String(e)}`)
      setCancelTarget(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <GuestBlockCard title="采购" />
      <PageHeader
        title="采购订货"
        subtitle="给供应商下单订货，货到了点「收货入库」自动加库存"
        action={
          <Button onClick={openCreate} className="bg-brand-600 hover:bg-brand-700">
            <Plus className="size-4" />
            新建采购单
          </Button>
        }
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 订单列表 */}
      <PurchaseOrderTable
        orders={shown}
        allEmpty={purchaseOrders.length === 0}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        allValue={ALL}
        onOpenDetail={(o) => void openDetail(o)}
      />

      {/* 新建采购单 Dialog */}
      <CreateOrderDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        suppliers={suppliers}
        supplierId={supplierId}
        onSupplierIdChange={setSupplierId}
        noSupplierValue={NO_SUPPLIER}
        notes={notes}
        onNotesChange={setNotes}
        pickerKw={pickerKw}
        onPickerKwChange={setPickerKw}
        pickerCandidates={pickerCandidates}
        onAddDraftItem={addDraftItem}
        draftItems={draftItems}
        onPatchDraft={patchDraft}
        onRemoveDraft={(key) => setDraftItems((prev) => prev.filter((x) => x.key !== key))}
        lastCostOf={lastCostOf}
        draftTotal={draftTotal}
        error={createError}
        busy={busy}
        onSubmit={handleCreate}
      />

      {/* 订单详情 Dialog */}
      <OrderDetailDialog
        detail={detail}
        onClose={() => setDetail(null)}
        onOpenReceive={openReceive}
        onCancelOrder={setCancelTarget}
      />

      {/* 收货 Dialog：每条明细默认填剩余待收数量，可改小分批收 */}
      <ReceiveDialog
        target={receiveTarget}
        receiveQty={receiveQty}
        onReceiveQtyChange={(itemId, v) => setReceiveQty((q) => ({ ...q, [itemId]: v }))}
        error={receiveError}
        busy={busy}
        onSubmit={handleReceive}
        onClose={() => setReceiveTarget(null)}
      />

      {/* 取消订单二次确认（大白话说明后果） */}
      <CancelOrderDialog
        target={cancelTarget}
        busy={busy}
        onConfirm={handleCancel}
        onClose={() => setCancelTarget(null)}
      />

      {/* 空状态下的小提示：没商品时引导先入库 */}
      {products.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <PackagePlus className="size-4" />
          还没有商品档案，先去「扫码入库」录入商品，再来下采购单
        </div>
      )}
    </div>
  )
}
