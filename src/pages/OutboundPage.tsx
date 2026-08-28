import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, PackageOpen, Printer, RotateCcw } from 'lucide-react'
import { PageHeader, SuccessBanner, ErrorBanner } from '@/components/feedback'
import { GuestBlockCard } from '@/components/GuestBlockCard'
import { ReceiptDialog, makeReceiptNo, type ReceiptData } from '@/components/Receipt'
import { ScanHero } from '@/components/scan/ScanHero'
import { VoiceSearchButton } from '@/components/voice/VoiceSearchButton'
import { useAppStore, priceForCustomer } from '@/store/appStore'
import { previewFifo } from '@/lib/fifo'
import { validateQty, unitOf, isDecimalUnit } from '@/lib/quantity'
import { playSound } from '@/lib/sounds'
import { formatPrice, isToday, productName } from '@/lib/formatters'
import type { CreditOptions } from '@/store/appStore'
import { type Customer, type PaymentMethod, type PriceLevel, type Product } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CartPanel, type CartItem } from './outbound/CartPanel'
import { CheckoutDialog } from './outbound/CheckoutDialog'
import { ConfirmOutboundDialog } from './outbound/ConfirmOutboundDialog'
import { ExchangeDialog, type ExchangeOldPrice } from './outbound/ExchangeDialog'
import { QuickCustomerDialog } from './outbound/QuickCustomerDialog'
import { SelectedProductCard } from './outbound/SelectedProductCard'
import { ReturnDialog } from './outbound/ReturnDialog'
import { TodayRecordsTable } from './outbound/TodayRecordsTable'

function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

export function OutboundPage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const transactions = useAppStore((s) => s.transactions)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const batchesOf = useAppStore((s) => s.batchesOf)
  const confirmOutbound = useAppStore((s) => s.confirmOutbound)
  const checkout = useAppStore((s) => s.checkout)
  const addReturn = useAppStore((s) => s.addReturn)
  const addExchange = useAppStore((s) => s.addExchange)
  const customers = useAppStore((s) => s.customers)
  const loadCustomers = useAppStore((s) => s.loadCustomers)
  const addCustomer = useAppStore((s) => s.addCustomer)
  const kits = useAppStore((s) => s.kits)
  const kitDetail = useAppStore((s) => s.kitDetail)
  // 多级定价：选中商品若设了档次价，确认出库时可一键带出
  const priceTiers = useAppStore((s) => s.priceTiers)

  // 赊账要选客户：进页面先拉客户列表（loadAll 不含客户）
  useEffect(() => {
    void loadCustomers().catch(() => {})
  }, [loadCustomers])

  const inputRef = useRef<HTMLInputElement>(null)
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Product | null>(null)
  const [quantity, setQuantity] = useState('')
  const [priceYuan, setPriceYuan] = useState('')
  // 当前售价来自哪个价格档（手动改价后为 null=自定义价）
  const [activeTier, setActiveTier] = useState<PriceLevel | null>(null)
  // 员工登录（v0.1）后默认记登录人；没开员工登录保持老板名
  const [operator, setOperator] = useState(() => useAppStore.getState().currentUser?.name ?? '店长')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [executing, setExecuting] = useState(false)
  // 无库存强制出库确认（店里实际有货但没录库存时用）
  const [noStockConfirm, setNoStockConfirm] = useState(false)
  // 上一单小票：出库成功后留档，成功横幅消失后仍可补打
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [receiptOpen, setReceiptOpen] = useState(false)

  // 购物清单（一单多商品收银台）：扫码/搜索 → 加入清单 → 去开单统一收款
  const [cart, setCart] = useState<CartItem[]>([])
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [checkoutExecuting, setCheckoutExecuting] = useState(false)

  // 组合商品一键开单：搜索组合名，点一下把里面的商品按现价全加进清单
  const [kitKw, setKitKw] = useState('')
  const kitCandidates = kitKw.trim()
    ? kits.filter((k) => k.name.toLowerCase().includes(kitKw.trim().toLowerCase())).slice(0, 6)
    : []
  const addKitToCart = async (kitId: number) => {
    try {
      const { kit, items } = await kitDetail(kitId)
      // 组成件先按现价（散客零售档 → 建议价）算合计
      const lines = items
        .map((it) => {
          const p = products.find((x) => x.id === it.product_id)
          if (!p) return null
          const { price } = priceForCustomer(p, priceTiers, null)
          return { product: p, quantity: it.quantity, priceCents: price ?? 0 }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
      const sum = lines.reduce((s, i) => s + i.priceCents * i.quantity, 0)
      // 打包价（v2.2）：一口价优先，其次总折扣；按比例折算到每行，取整误差补到最后一行
      let target = sum
      let priceNote = ''
      if (kit.price != null) {
        target = kit.price
        priceNote = `一口价 ${(kit.price / 100).toFixed(2)} 元`
      } else if (kit.discount_percent != null) {
        target = Math.round((sum * kit.discount_percent) / 100)
        priceNote = `${kit.discount_percent} 折`
      }
      if (target > 0 && sum > 0 && target !== sum) {
        const ratio = target / sum
        lines.forEach((l) => {
          l.priceCents = Math.max(1, Math.round(l.priceCents * ratio))
        })
        const after = lines.reduce((s, i) => s + i.priceCents * i.quantity, 0)
        if (lines.length > 0 && after !== target) {
          const last = lines[lines.length - 1]
          last.priceCents = Math.max(1, last.priceCents + Math.round((target - after) / last.quantity))
        }
      }
      setCart((prev) => {
        const byId = new Map(prev.map((i) => [i.product.id, i]))
        for (const l of lines) {
          const existing = byId.get(l.product.id)
          byId.set(l.product.id, existing ? { ...existing, quantity: existing.quantity + l.quantity, priceCents: l.priceCents } : l)
        }
        return [...byId.values()]
      })
      setKitKw('')
      playSound('success')
      setSuccess(
        kit.price != null || kit.discount_percent != null
          ? `组合「${kit.name}」${priceNote}已加进清单（组成件按打包价折算）`
          : `组合「${kit.name}」的 ${lines.length} 样商品已加进清单，可改数量/价格后去开单`,
      )
    } catch (e) {
      playSound('error')
      setError(`组合加载失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 赊账包：确认出库时选客户 + 付款方式（散客只能全额收款）
  const WALK_IN = '__walkin__'
  const NEW_CUST = '__new__'
  const [custKey, setCustKey] = useState(WALK_IN)
  const [payMode, setPayMode] = useState<'full' | 'partial' | 'credit'>('full')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('现金')
  const [paidYuan, setPaidYuan] = useState('')
  const [confirmError, setConfirmError] = useState('')
  // 「+ 新客户」快捷建档
  const [quickCustOpen, setQuickCustOpen] = useState(false)
  const [quickName, setQuickName] = useState('')
  const [quickPhone, setQuickPhone] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [quickError, setQuickError] = useState('')

  // 退货登记（P2-1）：顾客退货重新入架，退款金额入账
  const [returnOpen, setReturnOpen] = useState(false)
  const [retKeyword, setRetKeyword] = useState('')
  const [retSelected, setRetSelected] = useState<Product | null>(null)
  const [retQty, setRetQty] = useState('')
  const [retRefund, setRetRefund] = useState('')
  const [retBusy, setRetBusy] = useState(false)
  // 赊账销售的退货：记到原赊账客户账上（后端冲减他的欠款），可手动取消
  const [retUseCredit, setRetUseCredit] = useState(true)
  const [retPayMethod, setRetPayMethod] = useState<PaymentMethod>('现金')

  // 换货登记（清单第 15 项）：先退旧货再出新货，同一事务
  const [exchOpen, setExchOpen] = useState(false)
  const [exchOld, setExchOld] = useState<Product | null>(null)
  const [exchNew, setExchNew] = useState<Product | null>(null)
  const [exchOldKw, setExchOldKw] = useState('')
  const [exchNewKw, setExchNewKw] = useState('')
  const [exchQty, setExchQty] = useState('')
  const [exchPrice, setExchPrice] = useState('')
  const [exchBusy, setExchBusy] = useState(false)
  // 换货差价：谁换的货（散客=当场结清）；补的钱可以选「先欠着」记客户账上
  const [exchCustKey, setExchCustKey] = useState(WALK_IN)
  const [exchDiffPaid, setExchDiffPaid] = useState('')
  const [exchDiffOnCredit, setExchDiffOnCredit] = useState(false)

  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 搜索候选：条码精确匹配优先，其次 SKU/品牌/型号模糊匹配，最多 8 条
  const candidates = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw || selected) return []
    const exact = products.filter((p) => p.barcode === keyword.trim())
    if (exact.length > 0) return exact
    return products
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
      .slice(0, 8)
  }, [keyword, products, selected])

  const productBatches = useMemo(
    () => (selected ? batchesOf(selected.id).filter((b) => b.quantity > 0) : []),
    [selected, batchesOf],
  )

  // 选中商品设了哪些档次价（没设档的商品不显示档位按钮）
  const selectedTiers = useMemo(
    () => (selected ? priceTiers.filter((t) => t.product_id === selected.id) : []),
    [selected, priceTiers],
  )

  // 计量单位（通用版）：允许小数单位出库小数（最多 1 位）
  const qtyNum = Number(quantity)
  const qtyValid = selected ? validateQty(qtyNum, unitOf(selected)) !== null : false
  const qty = qtyValid ? qtyNum : NaN
  const totalStock = selected ? totalStockOf(selected.id) : 0
  const { plan, byBatch } = useMemo(
    () => (selected && qtyValid ? previewFifo(productBatches, qty) : { plan: null, byBatch: new Map<number, number>() }),
    [selected, qtyValid, productBatches, qty],
  )
  const overStock = qtyValid && plan !== null && !plan.ok

  const selectProduct = (p: Product) => {
    setSelected(p)
    setKeyword('')
    setQuantity('')
    // 默认带「零售」档价；没设零售档就用建议售价
    const retail = priceTiers.find((t) => t.product_id === p.id && t.tier === 'retail')
    const fallback = p.suggest_price
    const prefill = retail?.price ?? fallback
    setPriceYuan(prefill !== null && prefill !== undefined ? (prefill / 100).toFixed(2) : '')
    setActiveTier(retail ? 'retail' : null)
    setError('')
  }

  // 点了价格档：带出这档的价格（仍可手改）
  const applyTier = (tier: PriceLevel) => {
    const t = selectedTiers.find((x) => x.tier === tier)
    if (!t) return
    setPriceYuan((t.price / 100).toFixed(2))
    setActiveTier(tier)
  }

  // 价格档自动化：确认框里选了客户就按他的默认档出价（设了档必须自动生效，伙计不该手动输价）；
  // 商品没设这档 → 回退建议价，不报错；散客/没设档的客户按零售价
  const applyCustomerPrice = (cust: Customer | null) => {
    if (!selected) return
    const { price, tier } = priceForCustomer(selected, priceTiers, cust)
    setPriceYuan(price != null ? (price / 100).toFixed(2) : '')
    setActiveTier(tier)
    // 「付一部分」的默认实收跟着新价走
    if (qtyValid && price != null) setPaidYuan(((qty * price) / 100).toFixed(2))
  }

  const resetSelection = () => {
    setSelected(null)
    setQuantity('')
    setActiveTier(null)
    setError('')
    inputRef.current?.focus()
  }

  const handleConfirmClick = () => {
    if (!selected) return
    if (!qtyValid) {
      setError(isDecimalUnit(selected) ? '出库数量要大于 0，且最多 1 位小数' : '出库数量必须是 ≥1 的整数')
      playSound('error')
      return
    }
    if (overStock) {
      setError(`出库数量超过当前库存（还差 ${plan!.shortage} ${unitOf(selected)}）`)
      playSound('error')
      return
    }
    // 售价必填且必须大于 0（清单第 14 项）：营业额和毛利报表都靠它记账
    const price = yuanToCents(priceYuan)
    if (priceYuan.trim() === '' || price === null || price <= 0) {
      setError('请填写实际售价（必须大于 0 元）——营业额和毛利报表都靠它记账')
      playSound('error')
      return
    }
    setError('')
    // 打开确认框前重置赊账选项：默认散客全额收款，「付一部分」默认填应付总额
    setCustKey(WALK_IN)
    setPayMode('full')
    setPayMethod('现金')
    setPaidYuan(((qty * price) / 100).toFixed(2))
    setConfirmError('')
    setConfirmOpen(true)
  }

  // 确认框里切换客户：「+ 新客户」走快捷建档；其余按他的默认档联动出价
  const handleSelectCustomer = (v: string) => {
    if (v === NEW_CUST) {
      setQuickName('')
      setQuickPhone('')
      setQuickError('')
      setQuickCustOpen(true)
    } else {
      setCustKey(v)
      setPayMode('full')
      setConfirmError('')
      // 切客户价格联动刷新：有默认档自动按他的档出价，散客回零售价
      applyCustomerPrice(
        v === WALK_IN ? null : (customers.find((c) => String(c.id) === v) ?? null),
      )
    }
  }

  // 确认框里选中「+ 新客户」：快捷建档，建完自动选中
  const handleQuickCreate = async () => {
    if (quickBusy) return
    if (!quickName.trim()) {
      setQuickError('客户姓名不能为空')
      return
    }
    setQuickBusy(true)
    try {
      const c: Customer = await addCustomer({ name: quickName, phone: quickPhone, notes: '' })
      setQuickCustOpen(false)
      setCustKey(String(c.id))
      applyCustomerPrice(c)
      playSound('success')
    } catch (e) {
      playSound('error')
      setQuickError(e instanceof Error ? e.message : String(e))
    } finally {
      setQuickBusy(false)
    }
  }

  const handleExecute = async (forceNoStock = false) => {
    if (!selected || !qtyValid || executing) return
    const price = yuanToCents(priceYuan)
    if (priceYuan.trim() === '' || price === null || price <= 0) {
      setError('售价必须大于 0 元')
      setConfirmOpen(false)
      return
    }
    const total = qty * price
    const custId = custKey === WALK_IN || custKey === NEW_CUST ? null : Number(custKey)
    // 散客全额收款只带到账方式；客户「全额收款」只传 customerId（paidAmount 省略=全额）
    let credit: CreditOptions | undefined
    if (custId !== null) {
      if (payMode === 'credit') {
        credit = { customerId: custId, paidAmount: 0 }
      } else if (payMode === 'partial') {
        const paid = yuanToCents(paidYuan)
        if (paid === null || paid <= 0) {
          setConfirmError('请填写这次收了多少钱（大于 0 元）')
          return
        }
        if (paid > total) {
          setConfirmError(`收的钱不能超过应付总额 ${formatPrice(total)}`)
          return
        }
        credit = paid === total ? { customerId: custId } : { customerId: custId, paidAmount: paid }
      } else {
        credit = { customerId: custId }
      }
    }
    // 到账方式：纯赊账不收钱时后端自动不落（与 mock 同口径）
    if (!(custId !== null && payMode === 'credit')) {
      credit = { ...(credit ?? {}), payMethod }
    }
    // 带上当前选中的价格档：显式售价优先，档仅作兜底/留痕（与后端 tier 口径一致）
    if (credit && activeTier) credit.tier = activeTier
    setExecuting(true)
    try {
      let result = await confirmOutbound(selected.id, qty, price, operator.trim() || '未署名', forceNoStock ? { ...credit, allowNoStock: true } : credit)
      setConfirmOpen(false)
      // 过期拦截：默认不卖过期商品；老板确认要临期/过期处理时二次确认后放行
      if (!result.ok && 'expired' in result && result.expired) {
        const desc = (result.expiredBatches ?? [])
          .map((b: { batch_no: string; expiry_date: string }) => `${b.batch_no}（${b.expiry_date}）`)
          .join('，')
        const confirmed = window.confirm(
          `⚠ 这个商品有已过期批次要出（${desc}）\n\n确认继续出库吗？临期/过期商品低价处理可继续。`,
        )
        if (!confirmed) {
          playSound('error')
          setError('已取消：出库被拦截（含已过期批次），可用「报损登记」处理过期货')
          setExecuting(false)
          return
        }
        result = await confirmOutbound(selected.id, qty, price, operator.trim() || '未署名', { ...credit, allowExpired: true })
        if (!result.ok) {
          playSound('error')
          setError(
            'expired' in result && result.expired
              ? '仍被拦截，请先处理过期批次'
              : 'shortage' in result
                ? `库存不足，还差 ${result.shortage} 个`
                : '出库失败',
          )
          setExecuting(false)
          return
        }
      }
      if (!result.ok) {
        playSound('error')
        if ('shortage' in result) {
          setError('库存不足，还差 ' + result.shortage + ' 个')
          setNoStockConfirm(true) // 给「无库存也出库」确认
        } else {
          setError('出库失败')
        }
        return
      }
      playSound('success')
      const custName = custId !== null ? (customers.find((c) => c.id === custId)?.name ?? null) : null
      const owed = credit?.paidAmount != null ? total - credit.paidAmount : 0
      // 留档小票数据：实收 null=全额收款（散客/客户全额）；赊账=只付了一部分或全欠
      setReceipt({
        receiptNo: makeReceiptNo(),
        time: new Date().toISOString(),
        operator: operator.trim() || '未署名',
        items: [{ name: productName(selected), quantity: qty, unitPrice: price, unit: unitOf(selected) }],
        paid: credit?.paidAmount ?? null,
        customerName: custName,
      })
      if (custName && owed > 0) {
        setSuccess(`已记账：${custName} 欠 ${formatPrice(owed)}（${productName(selected)} × ${qty}）`)
      } else if (custName) {
        setSuccess(`已出库：${productName(selected)} × ${qty}，${custName} 已全额付款`)
      } else {
        setSuccess(`已出库：${productName(selected)} × ${qty}`)
      }
      setSelected(null)
      setQuantity('')
      setActiveTier(null)
      setNoStockConfirm(false) // 出库成功，清除无库存确认
      inputRef.current?.focus()
    } catch (e) {
      setConfirmOpen(false)
      playSound('error')
      setError(`出库失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExecuting(false)
    }
  }

  // 加入清单：校验同单品出库；同商品已在清单里则合并数量（单价用最新一次录入的）
  const addToCart = () => {
    if (!selected) return
    if (!qtyValid) {
      setError(isDecimalUnit(selected) ? '出库数量要大于 0，且最多 1 位小数' : '出库数量必须是 ≥1 的整数')
      playSound('error')
      return
    }
    const price = yuanToCents(priceYuan)
    if (priceYuan.trim() === '' || price === null || price <= 0) {
      setError('请填写实际售价（必须大于 0 元）——营业额和毛利报表都靠它记账')
      playSound('error')
      return
    }
    const unit = unitOf(selected)
    const stock = totalStockOf(selected.id)
    const existing = cart.find((i) => i.product.id === selected.id)
    const mergedQty = (existing?.quantity ?? 0) + qty
    if (mergedQty > stock) {
      setError(`清单里已有 ${existing?.quantity ?? 0} ${unit}，再加 ${qty} ${unit}超过当前库存（共 ${stock} ${unit}）`)
      playSound('error')
      return
    }
    setCart((c) =>
      existing
        ? c.map((i) => (i.product.id === selected.id ? { ...i, quantity: mergedQty, priceCents: price } : i))
        : [...c, { product: selected, quantity: qty, priceCents: price }],
    )
    playSound('success')
    setSuccess(`已加入清单：${productName(selected)} × ${qty}`)
    resetSelection()
  }

  const cartQtyChange = (productId: number, quantity: number) => {
    const stock = totalStockOf(productId)
    const p = products.find((x) => x.id === productId)
    const min = p && isDecimalUnit(p) ? 0.5 : 1
    setCart((c) =>
      c.map((i) =>
        i.product.id === productId
          ? { ...i, quantity: Math.max(min, Math.min(Math.round(quantity * 10) / 10, stock)) }
          : i,
      ),
    )
  }
  const cartPriceChange = (productId: number, priceCents: number | null) => {
    // 输入框清空时保持原价不动，避免 0 价混进开单
    if (priceCents === null) return
    setCart((c) => c.map((i) => (i.product.id === productId ? { ...i, priceCents } : i)))
  }
  const cartRemove = (productId: number) => setCart((c) => c.filter((i) => i.product.id !== productId))
  const cartClear = () => setCart([])

  const cartTotal = cart.reduce((s, i) => s + i.quantity * i.priceCents, 0)

  // 打开开单确认框：默认散客全额收款，实收默认填清单合计
  const openCheckout = () => {
    if (cart.length === 0) return
    setCustKey(WALK_IN)
    setPayMode('full')
    setPayMethod('现金')
    setPaidYuan((cartTotal / 100).toFixed(2))
    setConfirmError('')
    setCheckoutOpen(true)
  }

  // 统一开单：多行商品一次出库，任一行缺货后端整单回滚
  const handleCheckoutExecute = async () => {
    if (cart.length === 0 || checkoutExecuting) return
    const custId = custKey === WALK_IN || custKey === NEW_CUST ? null : Number(custKey)
    let credit: CreditOptions | undefined
    if (custId !== null) {
      if (payMode === 'credit') {
        credit = { customerId: custId, paidAmount: 0 }
      } else if (payMode === 'partial') {
        const paid = yuanToCents(paidYuan)
        if (paid === null || paid <= 0) {
          setConfirmError('请填写这次收了多少钱（大于 0 元）')
          return
        }
        if (paid > cartTotal) {
          setConfirmError(`收的钱不能超过应付总额 ${formatPrice(cartTotal)}`)
          return
        }
        credit = paid === cartTotal ? { customerId: custId } : { customerId: custId, paidAmount: paid }
      } else {
        credit = { customerId: custId }
      }
    }
    // 到账方式：纯赊账不收钱时后端自动不落（与单品出库同口径）
    if (!(custId !== null && payMode === 'credit')) {
      credit = { ...(credit ?? {}), payMethod }
    }
    setCheckoutExecuting(true)
    try {
      const lines = cart.map((i) => ({ productId: i.product.id, quantity: i.quantity, sellingPrice: i.priceCents }))
      let result = await checkout(lines, operator.trim() || '未署名', credit)
      // 过期拦截（收银台）：单子里有商品含已过期批次 → 确认后放行
      if (!result.ok && 'expired' in result && result.expired) {
        const names = (result.expiredProducts ?? [])
          .map((p: { name: string; expiredBatches: { batch_no: string; expiry_date: string }[] }) => {
            const bs = p.expiredBatches.map((b) => `${b.batch_no}（${b.expiry_date}）`).join('，')
            return `${p.name}【${bs}】`
          })
          .join('；')
        const confirmed = window.confirm(`⚠ 单子里有商品含已过期批次：\n${names}\n\n确认继续开单吗？临期/过期商品低价处理可继续。`)
        if (!confirmed) {
          setCheckoutOpen(false)
          playSound('error')
          setError('已取消：开单被拦截（含已过期批次），可用「报损登记」处理过期货')
          return
        }
        result = await checkout(lines, operator.trim() || '未署名', { ...credit, allowExpired: true })
        if (!result.ok) {
          setCheckoutOpen(false)
          playSound('error')
          setError(
            'expired' in result && result.expired
              ? '仍被拦截，请先处理过期批次'
              : 'shortages' in result
                ? `库存不足：${result.shortages.map((s) => `${s.name} 还差 ${s.shortage} ${unitOf(products.find((p) => p.id === s.productId))}`).join('；')}，开单未记账`
                : '开单失败，请重试',
          )
          return
        }
      }
      if (!result.ok) {
        setCheckoutOpen(false)
        playSound('error')
        setError(
          'shortages' in result
            ? `库存不足：${result.shortages.map((s) => `${s.name} 还差 ${s.shortage} ${unitOf(products.find((p) => p.id === s.productId))}`).join('；')}，开单未记账`
            : '开单失败，请重试',
        )
        return
      }
      setCheckoutOpen(false)
      playSound('success')
      const custName = custId !== null ? (customers.find((c) => c.id === custId)?.name ?? null) : null
      const owed = credit?.paidAmount != null ? cartTotal - credit.paidAmount : 0
      // 留档小票：一单多样逐行打印
      setReceipt({
        receiptNo: makeReceiptNo(),
        time: new Date().toISOString(),
        operator: operator.trim() || '未署名',
        items: cart.map((i) => ({ name: productName(i.product), quantity: i.quantity, unitPrice: i.priceCents, unit: unitOf(i.product) })),
        paid: credit?.paidAmount ?? null,
        customerName: custName,
      })
      const summary = cart.map((i) => `${productName(i.product)} × ${i.quantity}`).join('，')
      if (custName && owed > 0) {
        setSuccess(`已开单：${summary}；${custName} 欠 ${formatPrice(owed)}`)
      } else if (custName) {
        setSuccess(`已开单：${summary}；${custName} 已全额付款`)
      } else {
        setSuccess(`已开单：${summary}`)
      }
      setCart([])
      inputRef.current?.focus()
    } catch (e) {
      setCheckoutOpen(false)
      playSound('error')
      setError(`开单失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCheckoutExecuting(false)
    }
  }

  // 今日流水：出库 + 退货 + 换货（换货双腿已按 return/out 记账，退差价按 exchange 记账，天然包含）
  const todayRecords = transactions.filter(
    (t) => (t.type === 'out' || t.type === 'return' || t.type === 'exchange') && isToday(t.timestamp),
  )

  // 退货候选：与出库搜索同规则
  const retCandidates = useMemo(() => {
    const kw = retKeyword.trim().toLowerCase()
    if (!kw || retSelected) return []
    return products
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
      .slice(0, 6)
  }, [retKeyword, products, retSelected])

  // 该商品最近一次赊账出库的客户：退货记到他账上，后端冲减他的欠款
  const retCreditCustomer = useMemo(() => {
    if (!retSelected) return null
    let best: (typeof transactions)[number] | null = null
    for (const t of transactions) {
      if (t.type === 'out' && t.product_id === retSelected.id && t.customer_id != null) {
        if (!best || t.timestamp > best.timestamp) best = t
      }
    }
    if (!best) return null
    return customers.find((c) => c.id === best!.customer_id) ?? null
  }, [retSelected, transactions, customers])

  const openReturnDialog = () => {
    setRetKeyword('')
    setRetSelected(null)
    setRetQty('')
    setRetRefund('')
    setRetUseCredit(true)
    setRetPayMethod('现金')
    setError('')
    setReturnOpen(true)
  }

  const handleReturnSubmit = async () => {
    if (!retSelected || retBusy) return
    const q = validateQty(Number(retQty), unitOf(retSelected))
    if (q === null) {
      setError(isDecimalUnit(retSelected) ? '退货数量要大于 0，且最多 1 位小数' : '退货数量必须是 ≥1 的整数')
      return
    }
    const refund = yuanToCents(retRefund)
    if (retRefund.trim() === '' || refund === null) {
      setError('请填写退款金额（元）——退给顾客多少钱要记账')
      return
    }
    const creditCust = retUseCredit ? retCreditCustomer : null
    setRetBusy(true)
    try {
      await addReturn(retSelected.id, q, refund, operator.trim() || '未署名', creditCust?.id ?? null, creditCust ? null : retPayMethod)
      setReturnOpen(false)
      playSound('success')
      setSuccess(
        creditCust
          ? `已登记退货：${productName(retSelected)} × ${q}，库存已加回；退货后 ${creditCust.name} 少欠 ${formatPrice(refund * q)}`
          : `已登记退货：${productName(retSelected)} × ${q}，库存已加回`,
      )
      setRetSelected(null)
    } catch (e) {
      playSound('error')
      setError(`退货登记失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRetBusy(false)
    }
  }

  // 换货候选搜索（旧/新商品各自独立）
  const searchProducts = (kw: string, excludeId: number | null) => {
    const k = kw.trim().toLowerCase()
    if (!k) return []
    return products
      .filter((p) => p.id !== excludeId)
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(k),
      )
      .slice(0, 5)
  }

  const openExchangeDialog = () => {
    setExchOld(null)
    setExchNew(null)
    setExchOldKw('')
    setExchNewKw('')
    setExchQty('')
    setExchPrice('')
    setExchCustKey(WALK_IN)
    setExchDiffPaid('')
    setExchDiffOnCredit(false)
    setError('')
    setExchOpen(true)
  }

  // 换货客户（散客=当场结清，不能赊差价）
  const exchCustomer =
    exchCustKey === WALK_IN ? null : (customers.find((c) => String(c.id) === exchCustKey) ?? null)

  // 选新货时自动出价：换货客户有默认档按他的档，否则零售档，都没设回退建议价
  const selectExchNew = (p: Product | null) => {
    setExchNew(p)
    if (p) {
      const { price } = priceForCustomer(p, priceTiers, exchCustomer)
      setExchPrice(price != null ? (price / 100).toFixed(2) : '')
    }
  }

  // 切换换货客户：新货价格联动刷新
  const selectExchCustomer = (v: string) => {
    setExchCustKey(v)
    const cust = v === WALK_IN ? null : (customers.find((c) => String(c.id) === v) ?? null)
    if (exchNew) {
      const { price } = priceForCustomer(exchNew, priceTiers, cust)
      setExchPrice(price != null ? (price / 100).toFixed(2) : '')
    }
  }

  // 旧腿原售价（与后端 createExchange 同口径）：最近一条带售价的出库流水 → 建议零售价 → 0
  const exchOldPrice = useMemo<ExchangeOldPrice | null>(() => {
    if (!exchOld) return null
    const tx = transactions.find(
      (t) => t.product_id === exchOld.id && t.type === 'out' && t.selling_price != null,
    )
    if (tx) return { unitPrice: tx.selling_price!, source: 'transaction', tx }
    if (exchOld.suggest_price != null) {
      return { unitPrice: exchOld.suggest_price, source: 'suggest', tx: null }
    }
    return { unitPrice: 0, source: 'none', tx: null }
  }, [exchOld, transactions])

  // 差价试算：新腿售价合计 - 旧腿原售价合计（与后端一致）；换货数量按新货计量单位校验
  const exchQtyN = Number(exchQty)
  const exchQtyValid = exchNew ? validateQty(exchQtyN, unitOf(exchNew)) !== null : false
  const exchNewPriceCents = yuanToCents(exchPrice)
  const exchDiff =
    exchOld && exchNew && exchQtyValid && exchNewPriceCents != null && exchOldPrice
      ? exchQtyN * exchNewPriceCents - exchQtyN * exchOldPrice.unitPrice
      : null

  // 要补钱时实收默认全补（改了数量/价格自动跟着变，手动改过也会被刷新，避免对不上账）
  useEffect(() => {
    if (exchDiff != null && exchDiff > 0 && !exchDiffOnCredit) {
      setExchDiffPaid((exchDiff / 100).toFixed(2))
    }
  }, [exchDiff, exchDiffOnCredit])

  // 要退钱时的处理方式预览（与后端 refundHandling 同口径）：原单赊账未付清 → 冲减欠款，否则退现金
  const exchRefundOffsetCust = useMemo(() => {
    if (exchDiff == null || exchDiff >= 0 || !exchOldPrice?.tx) return null
    const t = exchOldPrice.tx
    if (t.customer_id == null) return null
    const unpaid =
      t.quantity * t.selling_price! - (t.paid_amount ?? t.quantity * t.selling_price!)
    if (unpaid <= 0) return null
    return customers.find((c) => c.id === t.customer_id) ?? null
  }, [exchDiff, exchOldPrice, customers])

  const handleExchangeSubmit = async () => {
    if (!exchOld || !exchNew || exchBusy) return
    if (exchOld.id === exchNew.id) {
      setError('换货的旧商品和新商品不能是同一个')
      return
    }
    const q = exchNew ? validateQty(Number(exchQty), unitOf(exchNew)) : null
    if (q === null) {
      setError(exchNew && isDecimalUnit(exchNew) ? '换货数量要大于 0，且最多 1 位小数' : '换货数量必须是 ≥1 的整数')
      return
    }
    const price = yuanToCents(exchPrice)
    if (exchPrice.trim() === '' || price === null || price <= 0) {
      setError('请填写新货售价（必须大于 0 元）')
      return
    }
    // 差价实收：省略=全额付清；部分付/先欠着=差价赊账，必须选客户（与后端口径一致）
    const custId = exchCustomer?.id ?? null
    let diffPaidAmount: number | null = null
    if (exchDiff != null && exchDiff > 0) {
      const paid = exchDiffOnCredit ? 0 : yuanToCents(exchDiffPaid)
      if (paid === null) {
        setError('请填写补的钱实收多少（元）')
        return
      }
      if (paid > exchDiff) {
        setError(`补的钱不能超过差价 ${formatPrice(exchDiff)}`)
        return
      }
      if (paid < exchDiff && custId === null) {
        setError('补的钱要赊账，必须先在上面选一个客户')
        return
      }
      diffPaidAmount = paid >= exchDiff ? null : paid
    }
    setExchBusy(true)
    try {
      const r = await addExchange(exchOld.id, exchNew.id, q, price, operator.trim() || '未署名', {
        customerId: custId,
        diffPaidAmount,
      })
      if (!r.ok) {
        playSound('error')
        setError(`新货「${productName(exchNew)}」库存不足，还差 ${r.shortage} ${unitOf(exchNew)}，换货未记账`)
        return
      }
      setExchOpen(false)
      playSound('success')
      const custName =
        exchCustomer?.name ??
        (r.refundCustomerId != null
          ? (customers.find((c) => c.id === r.refundCustomerId)?.name ?? null)
          : null)
      // 成功提示带差价结果：补钱/退钱一眼看清
      let msg = `换货完成：退回 ${productName(exchOld)} × ${q}，出新 ${productName(exchNew)} × ${q}`
      if (r.diff != null && r.diff > 0) {
        msg =
          r.diffCredit > 0
            ? `换货完成，${custName ?? '顾客'} 补了 ${formatPrice(r.diffPaid ?? 0)}，剩下 ${formatPrice(r.diffCredit)} 记他账上`
            : `换货完成，${custName ?? '顾客'} 还补了 ${formatPrice(r.diff)}`
      } else if (r.diff != null && r.diff < 0) {
        msg =
          r.refundHandling === 'credit_offset'
            ? `换货完成，差价 ${formatPrice(r.refund ?? -r.diff)} 已从他欠款里扣掉`
            : `换货完成，差价 ${formatPrice(r.refund ?? -r.diff)} 已退现金给${custName ?? '顾客'}`
      }
      setSuccess(msg)
    } catch (e) {
      playSound('error')
      setError(`换货失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExchBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <GuestBlockCard title="销售" />
      <PageHeader
        title="销售出库"
        subtitle="按先进先出（FIFO）规则扣减批次库存"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={openReturnDialog}>
              <RotateCcw className="size-4" />
              退货登记
            </Button>
            <Button variant="outline" onClick={openExchangeDialog}>
              <ArrowLeftRight className="size-4" />
              换货登记
            </Button>
          </div>
        }
      />

      {/* 搜索区：与入库页同款 ScanHero，回车选中首个候选（适配扫码枪） */}
      <ScanHero
        inputRef={inputRef}
        autoFocus
        icon="search"
        value={keyword}
        onChange={(v) => {
          setKeyword(v)
          if (selected) setSelected(null)
        }}
        action={
          <VoiceSearchButton
            onText={(text) => {
              setKeyword(text)
              setSelected(null)
            }}
          />
        }
        onSubmit={() => {
          if (candidates.length > 0) {
            playSound('scan')
            selectProduct(candidates[0])
          } else if (keyword.trim()) {
            playSound('error')
          }
        }}
        placeholder="扫码或输入 SKU/品牌/型号搜索商品，按下 Enter 选中..."
        hint="提示：扫码枪扫条码后回车即选中商品；模糊搜索从下拉列表点选"
      >
        {candidates.length > 0 && (
          <div className="absolute inset-x-6 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
            {candidates.map((p) => (
              <button
                key={p.id}
                onClick={() => selectProduct(p)}
                className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-50"
              >
                <span>
                  {productName(p)}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {p.sku_code}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  库存 {totalStockOf(p.id)}
                </span>
              </button>
            ))}
          </div>
        )}
      </ScanHero>

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 无库存强制出库确认：店里实际有货但没录库存时，确认后照常出库（记负库存提醒补录） */}
      {noStockConfirm && selected && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm text-amber-800">
            <span className="font-bold">「{productName(selected)}」库存不够，但店里实际有货？</span>
            <span className="ml-1 text-amber-700">可先出库，系统会记「负库存」提醒你补录入库单。</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => { setNoStockConfirm(false); void handleExecute(true) }}
            >
              无库存也出库
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNoStockConfirm(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* 组合一键开单：先建好组合（组合商品页），这里搜一下全进清单 */}
      {kits.length > 0 && (
        <div className="rounded-xl border border-lake-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
              <PackageOpen className="size-4 text-lake-500" />
              组合商品一键开单
            </span>
            <Input
              value={kitKw}
              onChange={(e) => { setKitKw(e.target.value); setError('') }}
              placeholder="搜索组合名，点一下全进清单..."
              className="h-9 max-w-md"
            />
          </div>
          {kitCandidates.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {kitCandidates.map((k) => (
                <button
                  key={k.id}
                  onClick={() => addKitToCart(k.id)}
                  className="cursor-pointer rounded-lg border border-lake-200 bg-lake-50 px-3 py-1.5 text-sm text-lake-700 transition-colors hover:bg-lake-100"
                >
                  {k.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 上一单小票：成功横幅 3 秒消失后，这里还能补打 */}
      {receipt && (
        <div className="flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm">
          <span>上一单已出库，需要的话打张小票给顾客</span>
          <Button size="sm" variant="outline" onClick={() => setReceiptOpen(true)}>
            <Printer className="size-4" />
            打印小票
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReceipt(null)}>
            不用了
          </Button>
        </div>
      )}

      {/* 选中商品：与入库匹配卡片同款升舱处理 */}
      {selected && (
        <SelectedProductCard
          selected={selected}
          totalStock={totalStock}
          productBatches={productBatches}
          byBatch={byBatch}
          quantity={quantity}
          onQuantityChange={setQuantity}
          overStock={overStock}
          plan={plan}
          priceYuan={priceYuan}
          onPriceChange={(v) => {
            setPriceYuan(v)
            // 手动改价后：还和某档价格一致就算那档，否则算自定义价
            const cents = yuanToCents(v)
            setActiveTier(
              cents !== null
                ? (selectedTiers.find((t) => t.price === cents)?.tier ?? null)
                : null,
            )
          }}
          activeTier={activeTier}
          operator={operator}
          onOperatorChange={setOperator}
          onConfirm={handleConfirmClick}
          onAddToCart={addToCart}
          onCancel={resetSelection}
        />
      )}

      {/* 购物清单（一单多商品）：扫码加入后在这里改数量/单价，去开单统一收款 */}
      <CartPanel
        items={cart}
        totalStockOf={totalStockOf}
        onQtyChange={cartQtyChange}
        onPriceChange={cartPriceChange}
        onRemove={cartRemove}
        onClear={cartClear}
        onCheckout={openCheckout}
      />

      {/* 今日出入账记录（出库/退货/换货） */}
      <TodayRecordsTable
        records={todayRecords}
        products={products}
        batches={batches}
        customers={customers}
      />

      {/* 出库确认 Dialog（危险操作二次确认） */}
      <ConfirmOutboundDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        selected={selected}
        quantity={quantity}
        qty={qty}
        qtyValid={qtyValid}
        priceYuan={priceYuan}
        plan={plan}
        selectedTiers={selectedTiers}
        activeTier={activeTier}
        onApplyTier={applyTier}
        custKey={custKey}
        walkInKey={WALK_IN}
        newCustKey={NEW_CUST}
        onSelectCustomer={handleSelectCustomer}
        payMode={payMode}
        onPayModeChange={(mode) => {
          setPayMode(mode)
          setConfirmError('')
        }}
        paidYuan={paidYuan}
        onPaidYuanChange={setPaidYuan}
        payMethod={payMethod}
        onPayMethodChange={setPayMethod}
        confirmError={confirmError}
        customers={customers}
        executing={executing}
        onExecute={handleExecute}
      />

      {/* 一单多商品开单确认 Dialog：清单明细 + 统一收款 */}
      <CheckoutDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        items={cart}
        totalCents={cartTotal}
        custKey={custKey}
        walkInKey={WALK_IN}
        newCustKey={NEW_CUST}
        onSelectCustomer={handleSelectCustomer}
        payMode={payMode}
        onPayModeChange={(mode) => {
          setPayMode(mode)
          setConfirmError('')
        }}
        payMethod={payMethod}
        onPayMethodChange={setPayMethod}
        paidYuan={paidYuan}
        onPaidYuanChange={setPaidYuan}
        confirmError={confirmError}
        customers={customers}
        executing={checkoutExecuting}
        onExecute={handleCheckoutExecute}
      />

      {/* 「+ 新客户」快捷建档 Dialog：只填姓名电话，建完自动选中 */}
      <QuickCustomerDialog
        open={quickCustOpen}
        onOpenChange={setQuickCustOpen}
        name={quickName}
        onNameChange={setQuickName}
        phone={quickPhone}
        onPhoneChange={setQuickPhone}
        busy={quickBusy}
        error={quickError}
        onSubmit={handleQuickCreate}
      />

      {/* 退货登记 Dialog：退回来的货重新入架，退款金额入账 */}
      <ReturnDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        keyword={retKeyword}
        onKeywordChange={setRetKeyword}
        candidates={retCandidates}
        selected={retSelected}
        onSelect={setRetSelected}
        qty={retQty}
        onQtyChange={setRetQty}
        refund={retRefund}
        onRefundChange={setRetRefund}
        creditCustomer={retCreditCustomer}
        useCredit={retUseCredit}
        onToggleUseCredit={() => setRetUseCredit(!retUseCredit)}
        payMethod={retPayMethod}
        onPayMethodChange={setRetPayMethod}
        busy={retBusy}
        onSubmit={handleReturnSubmit}
        totalStockOf={totalStockOf}
      />

      {/* 换货登记 Dialog：先退旧货再出新货，同一事务，失败整体回滚 */}
      <ExchangeDialog
        open={exchOpen}
        onOpenChange={setExchOpen}
        exchOld={exchOld}
        onSelectOld={setExchOld}
        exchNew={exchNew}
        onSelectNew={selectExchNew}
        oldKw={exchOldKw}
        onOldKwChange={setExchOldKw}
        newKw={exchNewKw}
        onNewKwChange={setExchNewKw}
        qty={exchQty}
        onQtyChange={setExchQty}
        price={exchPrice}
        onPriceChange={setExchPrice}
        customers={customers}
        custKey={exchCustKey}
        walkInKey={WALK_IN}
        onSelectCustomer={selectExchCustomer}
        customer={exchCustomer}
        diff={exchDiff}
        oldPrice={exchOldPrice}
        diffPaid={exchDiffPaid}
        onDiffPaidChange={setExchDiffPaid}
        diffOnCredit={exchDiffOnCredit}
        onToggleDiffOnCredit={() => setExchDiffOnCredit(!exchDiffOnCredit)}
        refundOffsetCust={exchRefundOffsetCust}
        busy={exchBusy}
        onSubmit={handleExchangeSubmit}
        searchProducts={searchProducts}
        totalStockOf={totalStockOf}
      />

      {/* 小票预览/打印 Dialog：出库成功后从「打印小票」按钮打开 */}
      <ReceiptDialog data={receipt} open={receiptOpen} onOpenChange={setReceiptOpen} />
    </div>
  )
}
