import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Loader2, CircleAlert } from 'lucide-react'
import { PageHeader, SuccessBanner, ErrorBanner } from '@/components/feedback'
import { GuestBlockCard } from '@/components/GuestBlockCard'
import { ScanHero } from '@/components/scan/ScanHero'
import { useAppStore } from '@/store/appStore'
import { isToday, productName } from '@/lib/formatters'
import { MetricStrip } from '@/components/layout/MetricStrip'
import { backend } from '@/lib/api'
import { uploadProductPhoto } from '@/lib/photo'
import { playSound } from '@/lib/sounds'
import { useOnline } from '@/lib/useOnline'
import { CATEGORIES, type Category, type Product } from '@/types'
import { validateQty, unitOf, isDecimalUnit } from '@/lib/quantity'
import {
  SPEC_FIELDS, specFieldsFor, requiresExpiry,
  type SpecField,
} from '@/lib/productSpecs'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MatchedProductCard } from './inbound/MatchedProductCard'
import { NewProductDialog, type NewProductForm } from './inbound/NewProductDialog'
import { PhotoDraftDialog, type PhotoDraftItem } from './inbound/PhotoDraftDialog'
import { TodayInboundTable } from './inbound/TodayInboundTable'

const NO_SUPPLIER = '__none__'

// 元字符串转分，非法输入返回 null
function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

// 规格表单初始状态：8 个字段全空串
function emptySpecs(): Record<SpecField, string> {
  return Object.fromEntries(SPEC_FIELDS.map((f) => [f, ''])) as Record<SpecField, string>
}

// 拍照压缩：最长边 1280px、JPEG 0.85，控制发给视觉模型的体积
async function compressImage(file: File): Promise<{ base64: string; mime: string }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return { base64: dataUrl.split(',')[1] ?? '', mime: 'image/jpeg' }
}

export function InboundPage() {
  const findProductByBarcode = useAppStore((s) => s.findProductByBarcode)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const lastCostOf = useAppStore((s) => s.lastCostOf)
  const addInbound = useAppStore((s) => s.addInbound)
  const addProduct = useAppStore((s) => s.addProduct)
  const updateProduct = useAppStore((s) => s.updateProduct)
  const suppliers = useAppStore((s) => s.suppliers)
  const transactions = useAppStore((s) => s.transactions)
  const batches = useAppStore((s) => s.batches)
  const products = useAppStore((s) => s.products)
  const inboundMetrics = useMemo(() => {
    const todayIn = transactions.filter((t) => t.type === 'in' && isToday(t.timestamp))
    const todayQty = todayIn.reduce((s, t) => s + t.quantity, 0)
    const pending = products.filter((p) => p.status === '待盘点').length
    const low = products.filter((p) => totalStockOf(p.id) <= (p.min_stock ?? 5)).length
    return { todayQty, todayCnt: todayIn.length, pending, low, suppliers: suppliers.length }
  }, [transactions, products, totalStockOf, suppliers])

  const inputRef = useRef<HTMLInputElement>(null)
  const [barcode, setBarcode] = useState('')
  const [matched, setMatched] = useState<Product | null>(null)
  const [notFound, setNotFound] = useState(false)
  // 模糊搜索候选（输入商品名不是条码时，多个匹配让老板点选，不误判"新建"）
  const [candidates, setCandidates] = useState<Product[]>([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // P0-1：所有写库按钮统一防重复 + 失败兜底
  const [submitting, setSubmitting] = useState(false)

  // 入库表单
  const [quantity, setQuantity] = useState('1')
  const [costYuan, setCostYuan] = useState('')
  const [location, setLocation] = useState('')
  const [supplierId, setSupplierId] = useState(NO_SUPPLIER)
  // 员工登录（v0.1）后默认记登录人；没开员工登录保持老板名
  const [operator, setOperator] = useState(() => useAppStore.getState().currentUser?.name ?? '店长')
  // 到期日（保质期商品用，可选）：饵料/小药/活饵等入库时填"该批到期日"，临期预警按批次算
  const [expiryDate, setExpiryDate] = useState('')

  // 新建商品 Dialog（元字符串表单；安全库存空串=不单独设，按默认 5 预警）
  const [dialogOpen, setDialogOpen] = useState(false)
  const [npForm, setNpForm] = useState<NewProductForm>({
    category: '其他',
    subCategory: '',
    brand: '',
    brandCustom: '',
    model: '',
    costYuan: '',
    suggestYuan: '',
    location: '',
    minStock: '',
    unit: '件',
    specs: emptySpecs(),
    photoDataUrl: null,
  })
  const patchNpForm = (patch: Partial<NewProductForm>) => setNpForm((f) => ({ ...f, ...patch }))

  // 拍送货单（AI 多模态识别 → 入库草稿，人工逐行核对后落库）
  const [aiEnabled, setAiEnabled] = useState(false)
  const [photoParsing, setPhotoParsing] = useState(false)
  const [photoDraft, setPhotoDraft] = useState<PhotoDraftItem[] | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)
  // AI 识别需要联网，离线时按钮置灰
  const online = useOnline()

  useEffect(() => {
    if (!backend) return
    backend
      .invoke('ai:status')
      .then((s) => setAiEnabled(!!s?.configured))
      .catch(() => {})
  }, [])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  const focusInput = () => inputRef.current?.focus()

  const prefillForm = (p: Product) => {
    const last = lastCostOf(p.id)
    setQuantity('1')
    setCostYuan(last !== null ? (last / 100).toFixed(2) : '')
    setLocation(p.location ?? '')
    setSupplierId(NO_SUPPLIER)
  }

  const handleSearch = () => {
    const code = barcode.trim()
    setError('')
    if (!code) return
    // 1) 先精确匹配条码（扫码枪扫出来的码走这条路）
    const exact = findProductByBarcode(code)
    if (exact) {
      playSound('scan')
      setMatched(exact)
      setNotFound(false)
      setCandidates([])
      prefillForm(exact)
      return
    }
    // 2) 没匹配到条码 → 模糊搜品牌/型号/SKU/子类（老板手输商品名也能找到，不误判成"新建"）
    const kw = code.toLowerCase()
    const fuzzy = products.filter((p) =>
      [p.sku_code, p.brand, p.model, p.sub_category, p.barcode]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(kw)),
    )
    if (fuzzy.length === 1) {
      playSound('scan')
      setMatched(fuzzy[0])
      setNotFound(false)
      setCandidates([])
      prefillForm(fuzzy[0])
      return
    }
    if (fuzzy.length > 1) {
      // 多个候选 → 让老板点选，而不是直接"新建"
      setMatched(null)
      setNotFound(false)
      setCandidates(fuzzy.slice(0, 8))
      return
    }
    // 3) 真没有 → 才提示新建
    playSound('error')
    setMatched(null)
    setCandidates([])
    setNotFound(true)
  }

  const pickCandidate = (p: Product) => {
    setMatched(p)
    setNotFound(false)
    setCandidates([])
    prefillForm(p)
  }

  const handleConfirm = async () => {
    if (!matched || submitting) return
    const qty = validateQty(Number(quantity), unitOf(matched))
    if (qty === null) {
      setError(isDecimalUnit(matched) ? '入库数量要大于 0，且最多 1 位小数' : '入库数量必须是 ≥1 的整数')
      playSound('error')
      return
    }
    const cost = yuanToCents(costYuan)
    if (cost === null) {
      setError('进价格式不正确')
      playSound('error')
      return
    }
    // 保质期商品（有保质期的商品）必须填该批次的到期日，否则临期预警白搭
    if (requiresExpiry(matched.category) && !expiryDate.trim()) {
      setError(`${productName(matched)} 是保质期商品，必须填该批次的到期日`)
      playSound('error')
      return
    }
    setSubmitting(true)
    try {
      await addInbound({
        productId: matched.id,
        quantity: qty,
        costPrice: cost,
        location: location.trim() || null,
        supplierId: supplierId === NO_SUPPLIER ? null : Number(supplierId),
        operator: operator.trim() || '未署名',
        expiryDate: expiryDate.trim() || undefined,
      })
      playSound('success')
      setSuccess(`已入库：${productName(matched)} × ${qty}`)
      setMatched(null)
      setNotFound(false)
      setBarcode('')
      setError('')
      focusInput()
    } catch (e) {
      playSound('error')
      setError(`入库失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = () => {
    setMatched(null)
    setNotFound(false)
    setCandidates([])
    setError('')
    focusInput()
  }

  const handleCreateProduct = async () => {
    if (submitting) return
    const cost = yuanToCents(npForm.costYuan)
    if (cost === null) {
      setError('新建商品：进价格式不正确')
      return
    }
    const suggest = npForm.suggestYuan.trim() === '' ? null : yuanToCents(npForm.suggestYuan)
    if (npForm.suggestYuan.trim() !== '' && suggest === null) {
      setError('新建商品：建议售价格式不正确')
      return
    }
    // 安全库存：留空=默认 5；填了必须是 ≥0 的整数
    const minStockRaw = npForm.minStock.trim()
    let minStock: number | null = null
    if (minStockRaw !== '') {
      const n = Number(minStockRaw)
      if (!Number.isInteger(n) || n < 0) {
        setError('新建商品：安全库存要是 0 或更大的整数（不想单独设就留空）')
        return
      }
      minStock = n
    }
    // SKU 留空，由后端（浏览器预览时为 mock 路径）按统一的五段式规则自动生成
    const brand = npForm.brand === '__custom__'
      ? (npForm.brandCustom.trim() || null)
      : (npForm.brand.trim() || null)

    setSubmitting(true)
    try {
      const p = await addProduct({
        sku_code: '',
        barcode: barcode.trim() || null,
        category: npForm.category,
        sub_category: npForm.subCategory.trim() || null,
        brand,
        model: npForm.model.trim() || null,
        cost_price: cost,
        suggest_price: suggest,
        location: npForm.location.trim() || null,
        status: '待盘点',
        min_stock: minStock,
        unit: npForm.unit,
        // 只提交当前品类展示的规格字段，避免切换品类后残留旧值混进来
        ...Object.fromEntries(
          specFieldsFor(npForm.category).map((f) => [f, npForm.specs[f].trim() || null]),
        ),
      })
      // 商品图片：建档成功拿到 id 才落盘（选图时已压好）。存不上不挡入库，之后编辑商品再补
      if (npForm.photoDataUrl && backend) {
        try {
          const base64 = npForm.photoDataUrl.split(',')[1] ?? ''
          const fileName = await uploadProductPhoto(p.id, base64)
          await updateProduct(p.id, { photo_path: fileName })
        } catch {
          // 静默降级：入库已成功，图片以后补
        }
      }
      setDialogOpen(false)
      setNotFound(false)
      setMatched(p)
      prefillForm(p)
      // 图片是这件商品专属的，清掉；其他字段保留方便连续录入同类货
      patchNpForm({ photoDataUrl: null })
      setError('')
    } catch (e) {
      setError(`新建商品失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  // 拍送货单：选图 → 压缩 → AI 识别 → 草稿 Dialog
  const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !backend) return
    setPhotoParsing(true)
    setError('')
    try {
      const { base64, mime } = await compressImage(file)
      const r = await backend.invoke('ai:parseInboundNote', { imageBase64: base64, mimeType: mime })
      if (!r?.ok) {
        setError(
          r?.reason === 'no-key'
            ? '请先到设置页填入 Kimi API Key 激活 AI'
            : r?.reason === 'timeout' || r?.reason === 'network'
              ? 'AI 暂时不可用，请检查网络后重试'
              : '没识别出有效内容，换一张更清晰、正对单据的照片试试',
        )
        return
      }
      setPhotoDraft(
        r.items.map((it: any, i: number) => ({
          key: i,
          product_id: it.product_id,
          brand: it.brand,
          model: it.model,
          category: it.category ?? '其他',
          quantity: it.quantity,
          costYuan: it.cost_price_fen ? (it.cost_price_fen / 100).toFixed(2) : '',
          expiryDate: '',
        })),
      )
    } catch {
      setError('照片识别失败，请重试')
    } finally {
      setPhotoParsing(false)
    }
  }

  const patchDraftItem = (key: number, patch: Partial<PhotoDraftItem>) =>
    setPhotoDraft((prev) => prev?.map((it) => (it.key === key ? { ...it, ...patch } : it)) ?? null)

  // 确认草稿：已有商品直接入库；新商品先自动建档（SKU 自动生成）再入库
  const confirmPhotoDraft = async () => {
    if (!photoDraft) return
    setPhotoBusy(true)
    setError('')
    let okCount = 0
    const fails: string[] = []
    for (const it of photoDraft) {
      const label = [it.brand, it.model].filter(Boolean).join(' ') || '未命名商品'
      const cost = it.costYuan.trim() ? Math.round(parseFloat(it.costYuan) * 100) : NaN
      if (!Number.isFinite(cost) || cost <= 0) {
        fails.push(`${label}：进价无效`)
        continue
      }
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        fails.push(`${label}：数量无效`)
        continue
      }
      // 保质期商品（有保质期的商品）必须填该批次到期日
      if (requiresExpiry(it.category) && !it.expiryDate.trim()) {
        fails.push(`${label}：保质期商品必须填到期日`)
        continue
      }
      try {
        let pid = it.product_id
        if (!pid) {
          const p = await addProduct({
            sku_code: '',
            barcode: null,
            category: (CATEGORIES as string[]).includes(it.category) ? (it.category as Category) : '其他',
            sub_category: null,
            brand: it.brand,
            model: it.model,
            cost_price: cost,
            suggest_price: null,
            location: null,
            status: '待盘点',
          })
          pid = p.id
        }
        await addInbound({
          productId: pid,
          quantity: it.quantity,
          costPrice: cost,
          location: null,
          supplierId: null,
          operator,
          expiryDate: it.expiryDate.trim() || undefined,
        })
        okCount++
      } catch (err) {
        fails.push(`${label}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setPhotoBusy(false)
    setPhotoDraft(null)
    if (okCount > 0) setSuccess(`已从送货单入库 ${okCount} 项`)
    if (fails.length > 0) setError(fails.join('；'))
  }

  const todayInbounds = transactions.filter((t) => t.type === 'in' && isToday(t.timestamp))

  return (
    <div className="space-y-6">
      <GuestBlockCard title="入库" />
      <PageHeader
        title="扫码入库"
        subtitle="管理商品入库、新建 SKU 和库存批次"
        action={
          <>
            <Button
              variant="outline"
              onClick={() => photoRef.current?.click()}
              disabled={!aiEnabled || photoParsing || !online}
              title={
                !aiEnabled
                  ? '未配置 AI：请先到「设置」页填入 Kimi API Key'
                  : !online
                    ? '当前离线，AI 识别需要联网'
                    : '拍送货单，AI 自动识别入库'
              }
            >
              {photoParsing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Camera className="size-4" />
              )}
              {photoParsing ? 'AI 识别中...' : '拍送货单'}
            </Button>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhoto}
            />
          </>
        }
      />
      {(!aiEnabled || !online) && (
        <div className="-mt-3 text-xs text-muted-foreground">
          {!aiEnabled
            ? '「拍送货单」需要先配置 AI：到「设置」页填入 Kimi API Key 即可启用'
            : '当前离线：「拍送货单」需要联网，恢复网络后可用'}
        </div>
      )}

      <MetricStrip metrics={[
        { label: '今日入库', value: `+${inboundMetrics.todayQty} 件`, sub: `${inboundMetrics.todayCnt} 笔`, tone: 'accent' },
        { label: '待盘点', value: `${inboundMetrics.pending} 个`, sub: '商品待盘', tone: inboundMetrics.pending > 0 ? 'warning' : 'default' },
        { label: '低库存', value: `${inboundMetrics.low} 个`, sub: '低于预警线', tone: inboundMetrics.low > 0 ? 'danger' : 'default' },
        { label: '供应商', value: `${inboundMetrics.suppliers} 家`, sub: '供货渠道', tone: 'default' },
      ]} />

      {/* 扫码区：全站使用频率最高的交互点，视觉 C 位 */}
      <ScanHero
        inputRef={inputRef}
        autoFocus
        value={barcode}
        onChange={setBarcode}
        onSubmit={handleSearch}
        placeholder="请扫描商品条码或输入条码号，按下 Enter 确认搜索"
        hint="USB 扫码枪即插即用，扫描后自动回车"
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 模糊搜索候选：输入商品名（不是条码）时，多个匹配让老板点选，不误判"新建" */}
      {candidates.length > 0 && (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="h-1.5 bg-gradient-to-r from-brand-400 to-brand-500" />
          <CardContent className="py-4">
            <div className="mb-3 text-sm font-medium text-slate-600">
              找到 <span className="font-bold text-brand-600">{candidates.length}</span> 个商品，点一个选择：
            </div>
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pickCandidate(c)}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{productName(c)}</div>
                    <div className="text-xs text-slate-400">
                      {c.sku_code} · {c.category}
                      {c.sub_category ? ` / ${c.sub_category}` : ''}
                    </div>
                  </div>
                  <span className="ml-2 shrink-0 text-xs text-slate-400">
                    库存 {totalStockOf(c.id)} 件
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-3">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
                都不是，新建商品
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 搜索结果：已匹配商品 —— 全站第二重要界面，视觉升舱 */}
      {matched && (
        <MatchedProductCard
          matched={matched}
          totalStock={totalStockOf(matched.id)}
          lastCost={lastCostOf(matched.id)}
          quantity={quantity}
          onQuantityChange={setQuantity}
          costYuan={costYuan}
          onCostYuanChange={setCostYuan}
          location={location}
          onLocationChange={setLocation}
          supplierId={supplierId}
          onSupplierIdChange={setSupplierId}
          noSupplierValue={NO_SUPPLIER}
          suppliers={suppliers}
          operator={operator}
          onOperatorChange={setOperator}
          expiryDate={expiryDate}
          onExpiryDateChange={setExpiryDate}
          expiryRequired={requiresExpiry(matched.category)}
          submitting={submitting}
          onConfirm={handleConfirm}
          onOpenCreate={() => setDialogOpen(true)}
          onCancel={handleCancel}
        />
      )}

      {/* 搜索结果：未找到 */}
      {notFound && (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="h-1.5 bg-gradient-to-r from-amber-400 to-amber-500" />
          <CardContent className="flex items-center justify-between py-5">
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
                <CircleAlert className="size-3.5" />
                未找到该商品
              </span>
              <span>
                条码 <span className="font-mono font-medium">{barcode.trim()}</span>{' '}
                不在库存中，是否新建？
              </span>
            </div>
            <div className="flex gap-3">
              <Button onClick={() => setDialogOpen(true)}>新建商品</Button>
              <Button variant="ghost" onClick={handleCancel}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 今日入库记录 */}
      <TodayInboundTable records={todayInbounds} products={products} batches={batches} />

      {/* 新建商品 Dialog */}
      <NewProductDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        barcode={barcode.trim()}
        form={npForm}
        onFormChange={patchNpForm}
        submitting={submitting}
        onSubmit={handleCreateProduct}
      />

      {/* 拍送货单识别草稿：人工逐行核对后确认入库 */}
      <PhotoDraftDialog
        draft={photoDraft}
        onClose={() => setPhotoDraft(null)}
        onPatchItem={patchDraftItem}
        busy={photoBusy}
        onConfirm={confirmPhotoDraft}
      />
    </div>
  )
}
