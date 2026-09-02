import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Box,
  CalendarClock,
  Package,
  PackagePlus,
  PackageMinus,
  ClipboardList,
  TriangleAlert,
  Snail,
  CircleDollarSign,
  Truck,
  User,
  Settings,
  PackageSearch,
  KeyRound,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useAppStore } from '@/store/appStore'
import { formatPrice, isToday, productName } from '@/lib/formatters'
import { computeExpiring } from '@/lib/expiry'
import { splitTodayPayments } from '@/lib/paySplit'
import type { ExpiringProduct } from '@/types'
import { backend } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AiPanel } from '@/components/ai/AiPanel'
import { StatCard, type CardSpec } from './dashboard/StatCard'
import { TodaySalesCard } from './dashboard/TodaySalesCard'
import { AdviceCard } from './dashboard/AdviceCard'
import { computeRestockAdvice } from '@/lib/restockAdvice'
import { computeTrend, computeTop } from '@/lib/analytics'
import { EmptyState } from '@/components/EmptyState'

// 海洋系配色：深海蓝→湖蓝→湖水青→水草绿→沙滩金，像海面由深到浅的层次
const PIE_COLORS = ['#1f6bd6', '#22c1d8', '#10b981', '#34d399', '#38bdf8', '#f59e0b', '#0d9488', '#818cf8', '#94a3b8']
const LOW_STOCK_THRESHOLD = 5
const SLOW_DAYS = 90

function dayLabel(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function sameDay(iso: string, offset: number): boolean {
  const d = new Date(iso)
  const target = new Date()
  target.setDate(target.getDate() - offset)
  return (
    d.getFullYear() === target.getFullYear() &&
    d.getMonth() === target.getMonth() &&
    d.getDate() === target.getDate()
  )
}

export function DashboardPage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const transactions = useAppStore((s) => s.transactions)
  const expenses = useAppStore((s) => s.expenses)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const purchaseOrders = useAppStore((s) => s.purchaseOrders)
  const loadPurchaseOrders = useAppStore((s) => s.loadPurchaseOrders)
  const navigate = useNavigate()

  // 待收采购单提醒需要订单列表（loadAll 不含采购单），进仪表盘拉一次
  useEffect(() => {
    void loadPurchaseOrders().catch(() => {})
  }, [loadPurchaseOrders])

  // 临期/过期商品：Electron 走 product:expiring（后端口径），浏览器 mock 本地算（同口径）
  const [expiringRemote, setExpiringRemote] = useState<ExpiringProduct[] | null>(null)
  useEffect(() => {
    if (!backend) return
    backend
      .invoke('product:expiring', { days: 30 })
      .then(setExpiringRemote)
      .catch(() => setExpiringRemote([]))
  }, [])
  const expiringList = useMemo(
    () => (backend ? (expiringRemote ?? []) : computeExpiring(products, totalStockOf, 30)),
    [expiringRemote, products, totalStockOf],
  )
  const expiringCount = expiringList.length
  const expiredCount = expiringList.filter((e) => e.expired).length

  const pendingPOCount = useMemo(
    () => purchaseOrders.filter((o) => o.status === 'sent' || o.status === 'partial').length,
    [purchaseOrders],
  )

  // 经营建议：补货 + 滞销清仓（纯规则，口径见 restockAdvice.ts 文件头）
  const advice = useMemo(
    () => computeRestockAdvice(products, batches, transactions),
    [products, batches, transactions],
  )

  const stats = useMemo(() => {
    const totalStock = batches.reduce((s, b) => s + b.quantity, 0)
    const todayIn = transactions
      .filter((t) => t.type === 'in' && isToday(t.timestamp))
      .reduce((s, t) => s + t.quantity, 0)
    const todayOut = transactions
      .filter((t) => t.type === 'out' && isToday(t.timestamp))
      .reduce((s, t) => s + t.quantity, 0)
    const pendingCount = products.filter((p) => p.status === '待盘点').length
    const lowStockCount = products.filter((p) => totalStockOf(p.id) < (p.min_stock ?? LOW_STOCK_THRESHOLD)).length
    // 滞销：有库存但最近 90 天没有出库记录
    const slowCount = products.filter((p) => {
      if (totalStockOf(p.id) <= 0) return false
      const lastOut = transactions
        .filter((t) => t.type === 'out' && t.product_id === p.id)
        .map((t) => new Date(t.timestamp).getTime())
        .reduce((m, t) => Math.max(m, t), 0)
      const cutoff = Date.now() - SLOW_DAYS * 24 * 3600 * 1000
      return lastOut < cutoff
    }).length
    const stockValue = batches.reduce((s, b) => s + b.quantity * b.cost_price, 0)
    return { totalStock, todayIn, todayOut, pendingCount, lowStockCount, slowCount, stockValue }
  }, [products, batches, transactions, totalStockOf])

  // 今日经营小结：营业额/毛利按出库流水核算（selling_price=售价，unit_price=批次成本）；
  // 退货（不含换货退旧腿）按负收入冲减营业额和毛利——账要和抽屉里的钱对上
  const todaySales = useMemo(() => {
    const outs = transactions
      .filter((t) => t.type === 'out' && isToday(t.timestamp))
      .map((t) => {
        const p = products.find((x) => x.id === t.product_id)
        const revenue = t.selling_price != null ? t.selling_price * t.quantity : null
        const cost = t.unit_price != null ? t.unit_price * t.quantity : null
        return {
          id: t.id,
          kind: 'sale' as const,
          time: t.timestamp,
          name: p ? productName(p) : `#${t.product_id}`,
          sku: p?.sku_code ?? '',
          quantity: t.quantity,
          revenue,
          cost,
          profit: revenue !== null && cost !== null ? revenue - cost : null,
        }
      })
    const returns = transactions
      .filter((t) => t.type === 'return' && t.notes !== '换货退旧' && isToday(t.timestamp))
      .map((t) => {
        const p = products.find((x) => x.id === t.product_id)
        const refund = t.selling_price != null ? t.selling_price * t.quantity : null
        const cost = t.unit_price != null ? t.unit_price * t.quantity : null
        return {
          id: t.id,
          kind: 'return' as const,
          time: t.timestamp,
          name: p ? productName(p) : `#${t.product_id}`,
          sku: p?.sku_code ?? '',
          quantity: -t.quantity,
          revenue: refund !== null ? -refund : null,
          cost: cost !== null ? -cost : null,
          profit: refund !== null && cost !== null ? -(refund - cost) : null,
        }
      })
    const rows = [...outs, ...returns].sort((a, b) => b.time.localeCompare(a.time))
    const qty = outs.reduce((s, r) => s + r.quantity, 0)
    const revenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0)
    const profit = rows.reduce((s, r) => s + (r.profit ?? 0), 0)
    const margin = revenue > 0 ? profit / revenue : null
    return { rows, outs, qty, revenue, profit, margin }
  }, [transactions, products])

  // 今日到账按收款方式拆分（现金/微信/支付宝/其他 + 未记录 + 新增赊账），日结对账一眼对上
  const paySplit = useMemo(
    () => splitTodayPayments(transactions.filter((t) => isToday(t.timestamp))),
    [transactions],
  )

  // 本月经营：老板最关心的"这个月赚了多少"——营业额/毛利/支出/净利
  const monthStats = useMemo(() => {
    const now = new Date()
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
    let revenue = 0
    let profit = 0
    for (const t of transactions) {
      if (t.timestamp < mStart || t.timestamp >= mEnd) continue
      if (t.type === 'out') {
        if (t.selling_price != null) revenue += t.selling_price * t.quantity
        if (t.selling_price != null && t.unit_price != null) profit += (t.selling_price - t.unit_price) * t.quantity
      } else if (t.type === 'return' && t.notes !== '换货退旧') {
        if (t.selling_price != null) revenue -= t.selling_price * t.quantity
        if (t.selling_price != null && t.unit_price != null) profit -= (t.selling_price - t.unit_price) * t.quantity
      }
    }
    // 本月支出（expenses 按 expense_date 本地日期记）
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const expense = expenses
      .filter((e) => (e.expense_date || '').startsWith(monthKey))
      .reduce((s, e) => s + e.amount, 0)
    return { revenue, profit, expense, netProfit: profit - expense }
  }, [transactions, expenses])

  // AI 一句话打烊日报：仅在已配置 Key 且有成交时请求；失败静默隐藏，数字报表兜底
  const [aiConfigured, setAiConfigured] = useState(false)
  const [aiText, setAiText] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)

  useEffect(() => {
    if (!backend) return
    backend
      .invoke('ai:status')
      .then((s) => setAiConfigured(!!s?.configured))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!backend || !aiConfigured || todaySales.outs.length === 0) return
    // 卖得最好的前 3 个（按件数）
    const byName = new Map<string, number>()
    for (const r of todaySales.outs) byName.set(r.name, (byName.get(r.name) ?? 0) + r.quantity)
    const topItems = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, quantity]) => ({ name, quantity }))
    // 库存告急的前 3 个
    const lowStock = products
      .filter((p) => p.status !== '停产')
      .map((p) => ({ name: productName(p), total: totalStockOf(p.id), threshold: p.min_stock ?? LOW_STOCK_THRESHOLD }))
      .filter((x) => x.total < x.threshold)
      .sort((a, b) => a.total - b.total)
      .slice(0, 3)
    setAiLoading(true)
    backend
      .invoke('ai:dailySummary', {
        stats: {
          date: new Date().toISOString().slice(0, 10),
          qty: todaySales.qty,
          revenue: todaySales.revenue,
          profit: todaySales.profit,
          topItems,
          lowStock,
        },
      })
      .then((r) => setAiText(r?.ok ? r.content : null))
      .catch(() => setAiText(null))
      .finally(() => setAiLoading(false))
  }, [aiConfigured, todaySales.qty, todaySales.revenue]) // eslint-disable-line react-hooks/exhaustive-deps

  const categoryData = useMemo(() => {
    const byCat = new Map<string, number>()
    for (const b of batches) {
      if (b.quantity <= 0) continue
      const p = products.find((x) => x.id === b.product_id)
      if (!p) continue
      byCat.set(p.category, (byCat.get(p.category) ?? 0) + b.quantity)
    }
    return [...byCat.entries()].map(([name, value]) => ({ name, value }))
  }, [products, batches])

  const trendData = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const offset = 6 - i
      const inQty = transactions
        .filter((t) => t.type === 'in' && sameDay(t.timestamp, offset))
        .reduce((s, t) => s + t.quantity, 0)
      const outQty = transactions
        .filter((t) => t.type === 'out' && sameDay(t.timestamp, offset))
        .reduce((s, t) => s + t.quantity, 0)
      return { day: dayLabel(offset), 入库: inQty, 出库: outQty }
    })
  }, [transactions])

  // 营业额&毛利趋势（与 backend analytics:trend 同源）+ 畅销Top
  const [trendRange, setTrendRange] = useState<'7' | '30'>('7')
  const trendSeries = useMemo(
    () => computeTrend(transactions, trendRange === '7' ? 7 : 30).map((d) => ({ ...d, day: d.date.slice(5) })),
    [transactions, trendRange],
  )
  const topProducts = useMemo(() => computeTop(transactions, products, 10), [transactions, products])

  const int = (v: number) => String(Math.round(v))
  const cards: CardSpec[] = [
    { title: '总SKU', value: products.length, format: int, unit: '个商品', icon: Box,
      cardClass: 'border border-slate-200 bg-white', iconClass: 'bg-brand-50 text-brand-600', numClass: 'text-slate-900',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '总库存', value: stats.totalStock, format: (v) => Math.round(v).toLocaleString(), unit: '件商品', icon: Package,
      cardClass: 'border border-slate-200 bg-white', iconClass: 'bg-brand-50 text-brand-600', numClass: 'text-slate-900',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '今日入库', value: stats.todayIn, format: (v) => `+${Math.round(v)}`, unit: '件入库', icon: PackagePlus,
      cardClass: 'border border-slate-200 bg-white', iconClass: 'bg-brand-50 text-brand-600', numClass: 'text-slate-900',
      action: () => navigate('/inbound'), actionHint: '去入库' },
    { title: '今日出库', value: stats.todayOut, format: (v) => `-${Math.round(v)}`, unit: '件出库', icon: PackageMinus,
      cardClass: 'border border-slate-200 bg-white', iconClass: 'bg-brand-50 text-brand-600', numClass: 'text-slate-900',
      action: () => navigate('/outbound'), actionHint: '去出库' },
    { title: '待盘点', value: stats.pendingCount, format: int, unit: '个SKU', icon: ClipboardList,
      cardClass: 'border border-slate-200 bg-white', iconClass: 'bg-brand-50 text-brand-600', numClass: 'text-slate-900',
      action: () => navigate('/inventory?status=' + encodeURIComponent('待盘点')), actionHint: '去处理' },
    { title: '低库存', value: stats.lowStockCount, format: int, unit: '个预警', icon: TriangleAlert,
      cardClass: 'border border-red-100 bg-red-50/70', iconClass: 'bg-red-100 text-red-600', numClass: 'text-red-600',
      pulse: stats.lowStockCount > 0,
      action: () => navigate('/inventory?filter=low'), actionHint: '去补货' },
    // 临期商品：0 个时是绿色安心态；有已过期时数字变红
    { title: '临期商品', value: expiringCount, format: int,
      unit: expiringCount === 0 ? '没有临期商品' : expiredCount > 0 ? `其中 ${expiredCount} 个已过期` : '30 天内到期',
      icon: CalendarClock,
      cardClass: expiredCount > 0 ? 'border border-red-100 bg-red-50/70' : 'border border-slate-200 bg-white',
      iconClass: expiredCount > 0 ? 'bg-red-100 text-red-600' : 'bg-brand-50 text-brand-600',
      numClass: expiredCount > 0 ? 'text-red-600' : 'text-slate-900',
      pulse: expiredCount > 0,
      action: () => navigate('/inventory?filter=expiring'), actionHint: expiringCount > 0 ? '去处理' : '查看' },
    { title: '滞销品', value: stats.slowCount, format: int, unit: `>${SLOW_DAYS}天未动销`, icon: Snail,
      cardClass: 'border border-amber-100 bg-amber-50/60', iconClass: 'bg-amber-100 text-amber-600', numClass: 'text-amber-700',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '库存总值', value: stats.stockValue, format: (v) => formatPrice(Math.round(v)), unit: '按批次进价核算', icon: CircleDollarSign,
      cardClass: 'bg-[#0d1b30]', iconClass: 'bg-white/15 text-white', numClass: 'text-white', featured: true,
      action: () => navigate('/inventory'), actionHint: '查看' },
    // 本月赚了多少：个体户最关心的一眼数字（毛利-支出）
    { title: '本月净利', value: monthStats.netProfit, format: (v) => formatPrice(Math.round(v)), unit: `毛利 ${formatPrice(monthStats.profit)} · 支出 ${formatPrice(monthStats.expense)}`, icon: CircleDollarSign,
      cardClass: 'bg-[#0d1b30]', iconClass: 'bg-white/15 text-white', numClass: 'text-white', featured: true,
      action: () => navigate('/reports'), actionHint: '看明细' },
  ]

  return (
    <div className="space-y-6">
      {/* 数据看板头：一个主行动 + 今日关键信息（Direction A：数据先行、去装饰） */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">经营看板</div>
          <div className="mt-1.5 flex items-baseline gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">今日经营</h1>
            <span className="text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400">
              {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">数据来自本地库存与流水 · 实时</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button onClick={() => navigate('/outbound')} className="gap-1.5">
            <PackageMinus className="size-4" /> 开单
          </Button>
          <Button variant="outline" onClick={() => navigate('/inbound')} className="gap-1.5">
            <PackagePlus className="size-4" /> 入库
          </Button>
        </div>
      </div>

      {/* 签名看板元素：今日经营语义条（营业额 = 成本 + 毛利），一眼看清今天赚了多少 */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-500">今日经营</div>
            <div className="mt-1 text-3xl font-bold tabular-nums tracking-tight text-slate-900 dark:text-white">
              {formatPrice(todaySales.revenue)}
            </div>
            <div className="mt-1 text-sm text-slate-500">{todaySales.qty} 件卖出 · 数据来自本地流水</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">毛利</div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-emerald-600">{formatPrice(todaySales.profit)}</div>
            <div className="mt-1 text-xs text-slate-400">{todaySales.margin !== null ? `毛利率 ${(todaySales.margin * 100).toFixed(1)}%` : '还没有成交'}</div>
          </div>
        </div>
        <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="bg-[#cbd5e1]" style={{ width: (todaySales.revenue > 0 ? Math.max(0, (todaySales.revenue - todaySales.profit) / todaySales.revenue) : 0) * 100 + '%' }} />
          <div className="bg-emerald-500" style={{ width: (todaySales.revenue > 0 ? Math.max(0, todaySales.profit / todaySales.revenue) : 0) * 100 + '%' }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
          <span>成本 {formatPrice(todaySales.revenue - todaySales.profit)}</span>
          <span className="text-emerald-600">毛利 {formatPrice(todaySales.profit)}</span>
        </div>
      </div>

      {/* AI 助手卡：M2-1 前置——一打开就看见 AI 能帮他补货（AI 是能力不是页面） */}
      <AiPanel />

      {/* 通用版快捷入口（AI 已并入首页卡 + 全局浮层，不再单列） */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          { to: '/inbound-hub', label: '入库', desc: '进货/收货/供应商', icon: PackagePlus },
          { to: '/sales-hub', label: '销售', desc: '开单/客户/收款', icon: PackageMinus },
          { to: '/stock-hub', label: '库存', desc: '查询/盘点/报损', icon: PackageSearch },
          { to: '/mine-hub', label: '我的', desc: '报表/备份/云同步', icon: User },
          { to: '/account', label: '账号', desc: '登录/同步/远程看店', icon: KeyRound },
          { to: '/settings', label: '设置', desc: '行业/主题/系统', icon: Settings },
        ].map((q) => (
          <Link
            key={q.to}
            to={q.to}
            className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-md"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
              <q.icon className="size-4.5" />
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-bold text-slate-900">{q.label}</div>
              <div className="truncate text-xs text-slate-500">{q.desc}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((spec, i) => (
          <StatCard key={spec.title} spec={spec} index={i} />
        ))}
      </div>

      {/* 有待收货的采购单时提醒一句，点一下跳到采购页收货 */}
      {pendingPOCount > 0 && (
        <Link
          to="/purchase"
          className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3.5 text-sm text-amber-800 transition-colors hover:bg-amber-100"
        >
          <Truck className="size-5 shrink-0" />
          <span>
            有 <span className="font-bold">{pendingPOCount}</span> 张采购单待收货，货到了别忘了点「收货入库」
          </span>
          <span className="ml-auto font-medium">去收货 →</span>
        </Link>
      )}

      {/* 临期/滞销主动提醒：这批货快过期了 / 压着钱没动，主动催老板处理 */}
      {(expiringCount > 0 || stats.slowCount > 0) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-3.5 text-sm text-red-800">
          {expiringCount > 0 && (
            <Link to="/inventory?filter=expiring" className="flex items-center gap-2 hover:underline">
              <CalendarClock className="size-5 shrink-0" />
              <span><span className="font-bold">{expiredCount > 0 ? `${expiredCount} 个已过期` : `${expiringCount} 个快过期`}</span>，别让商品放过期了</span>
              <span className="ml-1 font-medium">去处理 →</span>
            </Link>
          )}
          {stats.slowCount > 0 && (
            <Link to="/inventory" className="flex items-center gap-2 hover:underline">
              <Snail className="size-5 shrink-0" />
              <span><span className="font-bold">{stats.slowCount} 个</span>超{SLOW_DAYS}天没卖动，压着钱该处理了</span>
              <span className="ml-1 font-medium">看看 →</span>
            </Link>
          )}
        </div>
      )}

      {/* 经营建议：该补货了 / 该清仓了（头号王牌，放今日小结之前） */}
      <AdviceCard advice={advice} products={products} />

      {/* 今日经营小结：打烊前看一眼，今天赚了多少 */}
      <TodaySalesCard summary={todaySales} paySplit={paySplit} aiLoading={aiLoading} aiText={aiText} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">品类库存占比</CardTitle>
          </CardHeader>
          <CardContent>
            {categoryData.length === 0 ? (
              <EmptyState compact title="还没有库存" desc="入几件货，这里就能看到各品类的占比了" />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={categoryData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={95}
                    paddingAngle={2}
                  >
                    {categoryData.map((entry, i) => (
                      <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, name) => [`${v} 件`, name]} />
                  <Legend
                    layout="horizontal"
                    align="center"
                    verticalAlign="bottom"
                    wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">最近 7 天出入库趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={trendData} barCategoryGap={10}>
                <XAxis dataKey="day" fontSize={11} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8' }} />
                <YAxis fontSize={10} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8' }} width={28} />
                <Tooltip cursor={{ fill: 'rgba(2,6,23,0.03)' }} contentStyle={{ border: 'none', boxShadow: '0 8px 24px -14px rgba(2,6,23,0.35)', borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />
                <Bar dataKey="入库" fill="#06b6d4" radius={[3, 3, 0, 0]} maxBarSize={26} />
                <Bar dataKey="出库" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* 营业额 & 毛利趋势（近7/30天，与 analytics API 同源） */}
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">营业额 & 毛利趋势</CardTitle>
            <div className="flex overflow-hidden rounded-lg border">
              {(['7', '30'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setTrendRange(r)}
                  className={`cursor-pointer px-3 py-1 text-xs transition-colors ${
                    trendRange === r ? 'bg-brand-600 font-medium text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  {r === '7' ? '近7天' : '近30天'}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trendSeries}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1f6bd6" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#1f6bd6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" fontSize={11} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8' }} />
                <YAxis fontSize={10} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8' }} width={44} />
                <Tooltip contentStyle={{ border: 'none', boxShadow: '0 8px 24px -14px rgba(2,6,23,0.35)', borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />
                <Area type="monotone" dataKey="revenue" name="营业额" stroke="#1f6bd6" strokeWidth={2} fill="url(#revGrad)" />
                <Area type="monotone" dataKey="profit" name="毛利" stroke="#10b981" strokeWidth={2} fill="url(#profGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* 畅销 Top 10（按营业额） */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">畅销 Top 10（按营业额）</CardTitle>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <EmptyState compact title="还没有销售记录" desc="开始卖货后这里会排出畅销榜" />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={topProducts} layout="vertical" margin={{ left: 8 }}>
                  <XAxis type="number" fontSize={10} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8' }} />
                  <YAxis type="category" dataKey="name" width={120} fontSize={11} tickLine={false} axisLine={false} tick={{ fill: '#64748b' }} />
                  <Tooltip contentStyle={{ border: 'none', boxShadow: '0 8px 24px -14px rgba(2,6,23,0.35)', borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="revenue" name="营业额" fill="#1f6bd6" radius={[0, 3, 3, 0]} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
