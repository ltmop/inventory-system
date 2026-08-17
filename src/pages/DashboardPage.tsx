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
} from 'lucide-react'
import {
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
import { AiPanel } from '@/components/ai/AiPanel'
import { StatCard, type CardSpec } from './dashboard/StatCard'
import { TodaySalesCard } from './dashboard/TodaySalesCard'
import { AdviceCard } from './dashboard/AdviceCard'
import { computeRestockAdvice } from '@/lib/restockAdvice'
import { EmptyState } from '@/components/EmptyState'

// 海洋系配色：深海蓝→湖蓝→湖水青→水草绿→沙滩金，像海面由深到浅的层次
const PIE_COLORS = ['#1d4ed8', '#0ea5e9', '#10b981', '#34d399', '#38bdf8', '#f59e0b', '#0d9488', '#818cf8', '#94a3b8']
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
      .filter((p) => p.status !== '停售')
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

  const int = (v: number) => String(Math.round(v))
  const cards: CardSpec[] = [
    { title: '总SKU', value: products.length, format: int, unit: '个商品', icon: Box,
      cardClass: 'bg-brand-50 dark:bg-brand-900/25 dark:border dark:border-brand-800/60', iconClass: 'bg-gradient-to-br from-brand-100 to-brand-50 text-brand-600 ring-1 ring-brand-500/10', numClass: 'text-brand-600 dark:text-brand-300 dark:text-gold-400',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '总库存', value: stats.totalStock, format: (v) => Math.round(v).toLocaleString(), unit: '件商品', icon: Package,
      cardClass: 'bg-green-50 dark:bg-lake-900/25 dark:border dark:border-lake-800/60', iconClass: 'bg-gradient-to-br from-green-100 to-green-50 text-green-600 ring-1 ring-green-500/10', numClass: 'text-green-600 dark:text-green-300 dark:text-lake-400',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '今日入库', value: stats.todayIn, format: (v) => `+${Math.round(v)}`, unit: '件入库', icon: PackagePlus,
      cardClass: 'bg-purple-50 dark:bg-purple-900/25 dark:border dark:border-purple-800/60', iconClass: 'bg-gradient-to-br from-purple-100 to-purple-50 text-purple-600 ring-1 ring-purple-500/10', numClass: 'text-purple-600 dark:text-purple-300 dark:text-purple-400',
      action: () => navigate('/inbound'), actionHint: '去入库' },
    { title: '今日出库', value: stats.todayOut, format: (v) => `-${Math.round(v)}`, unit: '件出库', icon: PackageMinus,
      cardClass: 'bg-orange-50 dark:bg-orange-900/25 dark:border dark:border-orange-800/60', iconClass: 'bg-gradient-to-br from-orange-100 to-orange-50 text-orange-600 ring-1 ring-orange-500/10', numClass: 'text-orange-600 dark:text-orange-300 dark:text-orange-400',
      action: () => navigate('/outbound'), actionHint: '去出库' },
    { title: '待盘点', value: stats.pendingCount, format: int, unit: '个SKU', icon: ClipboardList,
      cardClass: 'bg-yellow-50 dark:bg-yellow-900/25 dark:border dark:border-yellow-800/60', iconClass: 'bg-gradient-to-br from-yellow-100 to-yellow-50 text-yellow-600 ring-1 ring-yellow-500/10', numClass: 'text-yellow-600 dark:text-yellow-300 dark:text-yellow-400',
      action: () => navigate('/inventory?status=' + encodeURIComponent('待盘点')), actionHint: '去处理' },
    { title: '低库存', value: stats.lowStockCount, format: int, unit: '个预警', icon: TriangleAlert,
      cardClass: 'bg-red-50 dark:bg-red-900/25 dark:border dark:border-red-800/60', iconClass: 'bg-gradient-to-br from-red-100 to-red-50 text-red-600 ring-1 ring-red-500/10', numClass: 'text-red-600 dark:text-red-300 dark:text-red-400',
      pulse: stats.lowStockCount > 0,
      action: () => navigate('/inventory?filter=low'), actionHint: '去补货' },
    // 临期商品：0 个时是绿色安心态；有已过期时数字变红
    { title: '临期商品', value: expiringCount, format: int,
      unit: expiringCount === 0 ? '没有临期商品' : expiredCount > 0 ? `其中 ${expiredCount} 个已过期` : '30 天内到期',
      icon: CalendarClock,
      cardClass: expiringCount === 0 ? 'bg-green-50 dark:bg-lake-900/25 dark:border dark:border-lake-800/60' : 'bg-amber-50 dark:bg-amber-900/25 dark:border dark:border-amber-800/60',
      iconClass: expiringCount === 0 ? 'bg-gradient-to-br from-green-100 to-green-50 text-green-600 ring-1 ring-green-500/10' : 'bg-gradient-to-br from-amber-100 to-amber-50 text-amber-600 dark:text-amber-300 ring-1 ring-amber-500/10',
      numClass: expiredCount > 0 ? 'text-red-600' : expiringCount === 0 ? 'text-green-600' : 'text-amber-600',
      pulse: expiredCount > 0,
      action: () => navigate('/inventory?filter=expiring'), actionHint: expiringCount > 0 ? '去处理' : '查看' },
    { title: '滞销品', value: stats.slowCount, format: int, unit: `>${SLOW_DAYS}天未动销`, icon: Snail,
      cardClass: 'bg-slate-100 dark:bg-slate-800/30 dark:border dark:border-slate-700/60', iconClass: 'bg-gradient-to-br from-slate-200 to-slate-100 text-slate-500 ring-1 ring-slate-500/10', numClass: 'text-slate-500 dark:text-slate-400',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '库存总值', value: stats.stockValue, format: (v) => formatPrice(Math.round(v)), unit: '按批次进价核算', icon: CircleDollarSign,
      cardClass: 'bg-brand-700 dark:bg-gradient-to-br dark:from-gold-500 dark:to-gold-600', iconClass: 'bg-gradient-to-br from-white/25 to-white/10 text-white ring-1 ring-white/20', numClass: 'text-white dark:text-[#0a1628]', featured: true,
      action: () => navigate('/inventory'), actionHint: '查看' },
  ]

  return (
    <div className="space-y-6">
      {/* 页面横幅：深色渐变 + 金色光晕，一进来就有"高端渔具店"的气场 */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200/60 bg-gradient-to-r from-[#0d1b30] via-[#122038] to-[#0a1628] px-6 py-7 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.3)] dark:border-[#1e3049]">
        <div className="pointer-events-none absolute -right-16 -top-16 size-52 rounded-full bg-gold-500/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-10 left-1/3 size-40 rounded-full bg-lake-500/10 blur-3xl" />
        <div className="relative">
          <h1 className="text-2xl font-bold text-white">仪表盘</h1>
          <p className="mt-1.5 text-[13px] text-slate-300">门店经营概览 · 数据实时来自库存与流水</p>
        </div>
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

      {/* 经营建议：该补货了 / 该清仓了（头号王牌，放今日小结之前） */}
      <AdviceCard advice={advice} products={products} />

      {/* 今日经营小结：打烊前看一眼，今天赚了多少 */}
      <TodaySalesCard summary={todaySales} paySplit={paySplit} aiLoading={aiLoading} aiText={aiText} />

      {/* AI 问答面板：仅已激活时渲染（组件自检） */}
      <AiPanel />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">品类库存占比</CardTitle>
          </CardHeader>
          <CardContent>
            {categoryData.length === 0 ? (
              <EmptyState compact title="还没有库存" desc="入几件货，这里就能看到各品类的占比了" />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
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
                  <Legend layout="vertical" align="right" verticalAlign="middle" />
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
              <BarChart data={trendData}>
                <XAxis dataKey="day" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis fontSize={10} allowDecimals={false} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(37, 99, 235, 0.06)' }} />
                <Legend />
                <Bar dataKey="入库" fill="#1d4ed8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="出库" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
