import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download, QrCode } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import { PriceLabelDialog } from '@/components/PriceLabel'
import { SellQrLabelDialog } from '@/components/SellQrLabel'
import { productName, csvCell } from '@/lib/formatters'
import { computeExpiring } from '@/lib/expiry'
import {
  SPEC_FIELDS, collectSpecs, specsToForm, type SpecField,
} from '@/lib/productSpecs'
import { PRICE_LEVELS, PRICE_LEVEL_LABELS, PRODUCT_STATUSES, type Category, type PriceLevel, type Product, type ProductStatus, type Unit } from '@/types'
import { Button } from '@/components/ui/button'
import { ErrorBanner, PageHeader, SuccessBanner } from '@/components/feedback'
import { DeleteProductDialog } from './inventory/DeleteProductDialog'
import { EditProductDialog, type EditProductForm } from './inventory/EditProductDialog'
import { InventoryFilterBar } from './inventory/InventoryFilterBar'
import { InventoryTable, LOW_STOCK_THRESHOLD } from './inventory/InventoryTable'
import { BatchActionBar } from './inventory/BatchActionBar'
import { BatchPriceDialog } from './inventory/BatchPriceDialog'
import { BatchStatusDialog } from './inventory/BatchStatusDialog'
import { ProductHistoryDialog } from './inventory/ProductHistoryDialog'
import type { BatchPriceMode } from '@/store/appStore'
import { MetricStrip } from '@/components/layout/MetricStrip'

const ALL = '__all__'

type SortDir = 'asc' | 'desc'

// 排序循环：未排序 → 升序 → 降序 → 取消排序（恢复默认顺序）
function cycleDir(dir: SortDir | null): SortDir | null {
  return dir === null ? 'asc' : dir === 'asc' ? 'desc' : null
}

export function InventoryPage() {
  const products = useAppStore((s) => s.products)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const batchesOf = useAppStore((s) => s.batchesOf)
  const suppliers = useAppStore((s) => s.suppliers)
  const batches = useAppStore((s) => s.batches)

  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [category, setCategory] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  // 低库存快捷筛选：仪表盘「低库存」卡片跳转过来时自动开启
  const [lowOnly, setLowOnly] = useState(false)
  // 临期快捷筛选：仪表盘「临期商品」卡片跳转过来时自动开启
  const [expiringOnly, setExpiringOnly] = useState(false)
  const [brand, setBrand] = useState(ALL)
  const [location, setLocation] = useState(ALL)
  const [stockMin, setStockMin] = useState('')
  const [stockMax, setStockMax] = useState('')
  const [searchParams] = useSearchParams()

  // 临期/过期商品（productId → 详情）：行徽章 + 临期筛选共用；与后端 product:expiring 同口径本地算
  const expiringMap = useMemo(
    () => new Map(computeExpiring(products, totalStockOf, 30).map((e) => [e.id, e])),
    [products, batches, totalStockOf], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // 库存看板指标（Direction A）：总库存 / 低库存 / 临期 / 待盘点
  const inventoryMetrics = useMemo(() => {
    const totalStock = batches.reduce((s, b) => s + b.quantity, 0)
    const lowCount = products.filter((p) => totalStockOf(p.id) <= (p.min_stock ?? LOW_STOCK_THRESHOLD)).length
    const pending = products.filter((p) => p.status === '待盘点').length
    return { totalStock, lowCount, expiring: expiringMap.size, pending }
  }, [products, batches, totalStockOf, expiringMap])

  // 仪表盘跳转参数：?filter=low 只看低库存；?filter=expiring 只看临期；?status=待盘点 按状态筛选（仅初始化一次）
  useEffect(() => {
    const f = searchParams.get('filter')
    if (f === 'low') setLowOnly(true)
    if (f === 'expiring') setExpiringOnly(true)
    const st = searchParams.get('status')
    if (st && (PRODUCT_STATUSES as string[]).includes(st)) setStatus(st)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 命令面板跳转参数：?q=关键词 带入搜索框定位商品。
  // 依赖 searchParams 而非只跑一次：已在库存页时再选另一个商品也能生效；
  // 同时清掉其他筛选，避免"跳过来却看不到货"
  useEffect(() => {
    const q = searchParams.get('q')
    if (q !== null) {
      setKeyword(q)
      setCategory(ALL)
      setStatus(ALL)
      setLowOnly(false)
      setExpiringOnly(false)
    }
  }, [searchParams])

  // 编辑/删除（MISSING-3 前端入口）
  const updateProduct = useAppStore((s) => s.updateProduct)
  const deleteProduct = useAppStore((s) => s.deleteProduct)
  // 多级定价：编辑弹窗里的五档价格（空着=没设这档）
  const priceTiers = useAppStore((s) => s.priceTiers)
  const setPriceTier = useAppStore((s) => s.setPriceTier)
  const deletePriceTier = useAppStore((s) => s.deletePriceTier)
  const [editing, setEditing] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  // 价格标签打印：点商品行里的「打标签」打开预览
  const [labeling, setLabeling] = useState<Product | null>(null)
  // 开单二维码贴纸：批量打印当前筛选出的商品；serverUrl 为空说明手机看店服务没开
  const [qrSheetOpen, setQrSheetOpen] = useState(false)
  const [qrServerUrl, setQrServerUrl] = useState<string | null>(null)
  // 库存变动历史：点商品行里的「历史」打开
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null)
  // 批量操作：多选（跨页保留）+ 改价/改状态弹窗
  const batchUpdateProducts = useAppStore((s) => s.batchUpdateProducts)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [priceDialogOpen, setPriceDialogOpen] = useState(false)
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)

  // 商品列表刷新后把已经不存在的 id 从选中集里剔掉（防删除后误操作）
  useEffect(() => {
    setSelectedIds((prev) => {
      const alive = new Set([...prev].filter((id) => products.some((p) => p.id === id)))
      return alive.size === prev.size ? prev : alive
    })
  }, [products])

  const toggleSelect = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // 表头全选/取消全选：只作用当前页的行，其他页的选中保留
  const togglePage = (ids: number[], checked: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const runBatchPrice = async (priceMode: BatchPriceMode) => {
    if (batchBusy) return
    setBatchBusy(true)
    setPageError('')
    try {
      const ids = [...selectedIds]
      const r = await batchUpdateProducts({ ids, priceMode })
      setPageSuccess(
        priceMode.kind === 'ratio'
          ? `已把 ${r.updated} 个商品的建议售价和档次价都打 ${(priceMode.ratio * 10).toFixed(1).replace(/\.0$/, '')} 折`
          : `已把 ${r.updated} 个商品的建议售价和档次价都改成 ${(priceMode.priceFen / 100).toFixed(2)} 元`,
      )
      setPriceDialogOpen(false)
      setSelectedIds(new Set())
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
      setPriceDialogOpen(false)
    } finally {
      setBatchBusy(false)
    }
  }

  const runBatchStatus = async (status: ProductStatus) => {
    if (batchBusy) return
    setBatchBusy(true)
    setPageError('')
    try {
      const ids = [...selectedIds]
      const r = await batchUpdateProducts({ ids, status })
      setPageSuccess(`已把 ${r.updated} 个商品的状态改成「${status}」`)
      setStatusDialogOpen(false)
      setSelectedIds(new Set())
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
      setStatusDialogOpen(false)
    } finally {
      setBatchBusy(false)
    }
  }
  // 保存防重复：await 期间置 busy，双击不会并发触发两次 updateProduct
  const [saving, setSaving] = useState(false)
  const [pageError, setPageError] = useState('')
  // P0-1：编辑/删除成功也要给绿条反馈
  const [pageSuccess, setPageSuccess] = useState('')

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!pageSuccess) return
    const t = setTimeout(() => setPageSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [pageSuccess])
  const [form, setForm] = useState<EditProductForm>({
    category: '',
    sub_category: '',
    brand: '',
    model: '',
    cost_price: '',
    suggest_price: '',
    location: '',
    status: '',
    min_stock: '', // 安全库存：空串=不单独设，按默认 5 预警
    unit: '',
  })
  // 商品规格表单（颜色/材质/保质期，全部选填）
  const [specForm, setSpecForm] = useState<Record<SpecField, string>>(
    () => specsToForm({}),
  )
  // 价格档次表单：五档各一个元字符串，空串=没设这档
  const emptyTierForm = (): Record<PriceLevel, string> =>
    Object.fromEntries(PRICE_LEVELS.map((t) => [t, ''])) as Record<PriceLevel, string>
  const [tierForm, setTierForm] = useState<Record<PriceLevel, string>>(emptyTierForm)

  const openEdit = (p: Product) => {
    setPageError('')
    setForm({
      category: p.category,
      sub_category: p.sub_category ?? '',
      brand: p.brand ?? '',
      model: p.model ?? '',
      cost_price: (p.cost_price / 100).toString(),
      suggest_price: p.suggest_price !== null ? (p.suggest_price / 100).toString() : '',
      location: p.location ?? '',
      status: p.status,
      min_stock: p.min_stock !== null ? String(p.min_stock) : '',
      unit: p.unit ?? '件',
    })
    setSpecForm(specsToForm(p))
    const tiers = emptyTierForm()
    for (const t of priceTiers.filter((x) => x.product_id === p.id)) {
      tiers[t.tier] = (t.price / 100).toString()
    }
    setTierForm(tiers)
    setEditing(p)
  }

  const saveEdit = async () => {
    if (!editing || saving) return
    const cost = Math.round(parseFloat(form.cost_price) * 100)
    if (!Number.isFinite(cost) || cost <= 0) {
      setPageError('最近进价格式不正确')
      return
    }
    const suggest = form.suggest_price.trim()
      ? Math.round(parseFloat(form.suggest_price) * 100)
      : null
    if (form.suggest_price.trim() && !Number.isFinite(suggest)) {
      setPageError('建议售价格式不正确')
      return
    }
    if (!form.category || !form.status) {
      setPageError('品类和状态不能为空')
      return
    }
    // 安全库存：留空=不单独设（按默认 5）；填了必须是 ≥0 的整数
    const minStockRaw = form.min_stock.trim()
    let minStock: number | null = null
    if (minStockRaw !== '') {
      const n = Number(minStockRaw)
      if (!Number.isInteger(n) || n < 0) {
        setPageError('安全库存要是 0 或更大的整数（不想单独设就留空）')
        return
      }
      minStock = n
    }
    // 价格档次校验：空着=没设这档；填了必须是 >0 的数
    const tierPrices = new Map<PriceLevel, number>()
    for (const t of PRICE_LEVELS) {
      const raw = tierForm[t].trim()
      if (raw === '') continue
      const cents = Math.round(parseFloat(raw) * 100)
      if (!Number.isFinite(cents) || cents <= 0) {
        setPageError(`「${PRICE_LEVEL_LABELS[t]}价」格式不正确（要大于 0 元；不设这档就留空）`)
        return
      }
      tierPrices.set(t, cents)
    }
    setSaving(true)
    try {
      await updateProduct(editing.id, {
        category: form.category as Category,
        sub_category: form.sub_category.trim() || null,
        brand: form.brand.trim() || null,
        model: form.model.trim() || null,
        cost_price: cost,
        suggest_price: suggest,
        location: form.location.trim() || null,
        status: form.status as ProductStatus,
        min_stock: minStock,
        unit: form.unit as Unit,
        ...collectSpecs(specForm),
      })
      // 价格档次落库：填了的 set（新增/覆盖），清空了的 delete
      for (const t of PRICE_LEVELS) {
        const existing = priceTiers.find((x) => x.product_id === editing.id && x.tier === t)
        const next = tierPrices.get(t)
        if (next !== undefined) {
          if (!existing || existing.price !== next) await setPriceTier(editing.id, t, next)
        } else if (existing) {
          await deletePriceTier(editing.id, t)
        }
      }
      setPageSuccess(`已保存「${productName(editing)}」的修改`)
      setEditing(null)
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const target = deleting
    setDeleting(null)
    try {
      await deleteProduct(target.id)
      setPageSuccess(`已删除「${productName(target)}」`)
    } catch (e) {
      // 后端会拒绝有批次/流水的商品，提示引导改「停产」
      setPageError(e instanceof Error ? e.message : String(e))
    }
  }

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300)
    return () => clearTimeout(t)
  }, [keyword])

  const brands = useMemo(() => [...new Set(products.map((p) => p.brand).filter((b): b is string => !!b))].sort(), [products])
  const locations = useMemo(() => [...new Set(products.map((p) => p.location).filter((l): l is string => !!l))].sort(), [products])

  const resetFilters = () => {
    setKeyword('')
    setCategory(ALL)
    setStatus(ALL)
    setLowOnly(false)
    setExpiringOnly(false)
    setBrand(ALL)
    setLocation(ALL)
    setStockMin('')
    setStockMax('')
  }

  const filtered = useMemo(() => {
    return products.filter((p) => {
      if (category !== ALL && p.category !== (category as Category)) return false
      if (status !== ALL && p.status !== (status as ProductStatus)) return false
      if (lowOnly && totalStockOf(p.id) >= (p.min_stock ?? LOW_STOCK_THRESHOLD)) return false
      if (expiringOnly && !expiringMap.has(p.id)) return false
      if (brand !== ALL && p.brand !== (brand as string)) return false
      if (location !== ALL && p.location !== (location as string)) return false
      const stockNow = totalStockOf(p.id)
      if (stockMin !== '' && stockNow < Number(stockMin)) return false
      if (stockMax !== '' && stockNow > Number(stockMax)) return false
      if (debouncedKeyword) {
        const kw = debouncedKeyword.toLowerCase()
        // 规格字段（长度/调性/线号等）也纳入搜索：搜"3.6"能找到 3.6m 的竿
        const haystack = [
          p.sku_code, p.barcode, p.brand, p.model, p.category,
          ...SPEC_FIELDS.map((f) => p[f]),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(kw)) return false
      }
      return true
    })
  }, [products, category, status, debouncedKeyword, lowOnly, expiringOnly, expiringMap, totalStockOf, brand, location, stockMin, stockMax])

  // 表头排序（纯前端，不动数据层）：主表按总库存（批次子表排序在 InventoryTable 内部）
  const [stockSort, setStockSort] = useState<SortDir | null>(null)

  // 先筛选后排序：排序只作用在筛选结果上（分页在 InventoryTable 内部，切在排序之后）
  const sorted = useMemo(() => {
    if (!stockSort) return filtered
    return [...filtered].sort((a, b) => {
      const d = totalStockOf(a.id) - totalStockOf(b.id)
      return (stockSort === 'asc' ? d : -d) || a.id - b.id
    })
  }, [filtered, stockSort, totalStockOf])

  // csvCell 已从 @/lib/formatters 导入（含逗号/引号/换行的字段包引号、引号双写）

  const exportCsv = () => {
    const header = 'SKU,条码,品类,品牌,型号,状态,总库存,货位,最近进价(元),长度,调性,硬度,线号,钩号,颜色,材质,保质期'
    const rows = filtered.map((p) =>
      [
        p.sku_code,
        p.barcode ?? '',
        p.category,
        p.brand ?? '',
        p.model ?? '',
        p.status,
        totalStockOf(p.id),
        p.location ?? '',
        (p.cost_price / 100).toFixed(2),
        p.rod_length ?? '',
        p.rod_action ?? '',
        p.power_rating ?? '',
        p.line_number ?? '',
        p.hook_size ?? '',
        p.color ?? '',
        p.material ?? '',
        p.expiry_date ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
    // 加 BOM 让 Excel 正确识别中文
    const blob = new Blob(['﻿' + [header, ...rows].join('\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `库存导出-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 打开开单码打印：先查手机看店服务地址（贴纸二维码要用）；mock 预览用演示地址
  const openQrSheet = async () => {
    if (backend) {
      try {
        const s = await backend.invoke('server:status')
        setQrServerUrl(s?.running && s?.url ? String(s.url) : null)
      } catch {
        setQrServerUrl(null)
      }
    } else {
      setQrServerUrl('http://192.168.1.100:17532/?token=演示地址')
    }
    setQrSheetOpen(true)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="库存查询"
        subtitle="按商品、批次、货位多维度查询当前库存"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void openQrSheet()} disabled={filtered.length === 0}>
              <QrCode className="size-4" />
              打印开单码
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="size-4" />
              导出CSV
            </Button>
          </div>
        }
      />

      <MetricStrip metrics={[
        { label: '总库存', value: `${Math.round(inventoryMetrics.totalStock).toLocaleString()} 件`, sub: '全部批次', tone: 'accent' },
        { label: '低库存', value: `${inventoryMetrics.lowCount} 个`, sub: '低于预警线', tone: inventoryMetrics.lowCount > 0 ? 'danger' : 'default' },
        { label: '临期商品', value: `${inventoryMetrics.expiring} 个`, sub: '30 天内到期', tone: inventoryMetrics.expiring > 0 ? 'warning' : 'default' },
        { label: '待盘点', value: `${inventoryMetrics.pending} 个`, sub: '商品待盘', tone: inventoryMetrics.pending > 0 ? 'warning' : 'default' },
      ]} />

      {pageSuccess && <SuccessBanner>{pageSuccess}</SuccessBanner>}
      {pageError && <ErrorBanner>{pageError}</ErrorBanner>}

      {/* 筛选区 */}
      <InventoryFilterBar
        keyword={keyword}
        onKeywordChange={setKeyword}
        category={category}
        onCategoryChange={setCategory}
        status={status}
        onStatusChange={setStatus}
        lowOnly={lowOnly}
        onToggleLowOnly={() => setLowOnly((v) => !v)}
        expiringOnly={expiringOnly}
        onToggleExpiringOnly={() => setExpiringOnly((v) => !v)}
        brand={brand}
        onBrandChange={setBrand}
        brands={brands}
        location={location}
        onLocationChange={setLocation}
        locations={locations}
        stockMin={stockMin}
        onStockMinChange={setStockMin}
        stockMax={stockMax}
        onStockMaxChange={setStockMax}
        onReset={resetFilters}
        filteredCount={filtered.length}
        allValue={ALL}
      />

      {/* 批量操作条：勾选商品后出现 */}
      {selectedIds.size > 0 && (
        <BatchActionBar
          count={selectedIds.size}
          busy={batchBusy}
          onPrice={() => setPriceDialogOpen(true)}
          onStatus={() => setStatusDialogOpen(true)}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* 库存表格 */}
      <InventoryTable
        products={sorted}
        allEmpty={products.length === 0}
        totalStockOf={totalStockOf}
        batchesOf={batchesOf}
        suppliers={suppliers}
        expiringMap={expiringMap}
        stockSort={stockSort}
        onToggleStockSort={() => setStockSort((d) => cycleDir(d))}
        onLabel={setLabeling}
        onEdit={openEdit}
        onDelete={(p) => {
          setPageError('')
          setDeleting(p)
        }}
        onHistory={setHistoryProduct}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onTogglePage={togglePage}
      />

      {/* 编辑商品 Dialog：SKU 创建后不可改 */}
      <EditProductDialog
        editing={editing}
        form={form}
        onFormChange={setForm}
        specForm={specForm}
        onSpecFormChange={setSpecForm}
        tierForm={tierForm}
        onTierFormChange={setTierForm}
        saving={saving}
        onSave={saveEdit}
        onClose={() => setEditing(null)}
      />

      {/* 价格标签预览/打印 Dialog：点商品行的「打标签」打开 */}
      <PriceLabelDialog
        product={labeling}
        open={labeling !== null}
        onOpenChange={(open) => !open && setLabeling(null)}
      />

      {/* 开单二维码贴纸：批量打印当前筛选出的商品，微信扫一扫直达开单页 */}
      <SellQrLabelDialog
        open={qrSheetOpen}
        onOpenChange={setQrSheetOpen}
        products={filtered}
        serverUrl={qrServerUrl}
      />

      {/* 删除确认 Dialog（危险操作二次确认） */}
      <DeleteProductDialog
        deleting={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />

      {/* 批量改价 / 批量改状态 Dialog（都有大白话确认话术） */}
      <BatchPriceDialog
        open={priceDialogOpen}
        count={selectedIds.size}
        busy={batchBusy}
        onClose={() => setPriceDialogOpen(false)}
        onConfirm={runBatchPrice}
      />
      <BatchStatusDialog
        open={statusDialogOpen}
        count={selectedIds.size}
        busy={batchBusy}
        onClose={() => setStatusDialogOpen(false)}
        onConfirm={runBatchStatus}
      />

      {/* 库存变动历史 Dialog（纯前端筛选流水） */}
      <ProductHistoryDialog
        product={historyProduct}
        onClose={() => setHistoryProduct(null)}
      />
    </div>
  )
}