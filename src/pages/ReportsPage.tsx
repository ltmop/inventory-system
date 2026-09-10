import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, CircleDollarSign, Download, Package, TrendingUp, Trophy, Users } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { formatDateTime, formatPrice, productName, csvCell } from '@/lib/formatters'
import { DailyReconcileCard } from '@/pages/reports/DailyReconcileCard'
import { localDayKey, rangePreset } from '@/lib/salesReport'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { Transaction } from '@/types'

// 老板版报表：砍掉花图表，只留四张看得懂的表 —— 赚了多少 / 什么最赚钱 / 谁欠我钱 / 什么压着钱

interface Stats {
  revenue: number // 营业额（分，含退货冲减）
  profit: number // 毛利（分）
  margin: number | null // 毛利率
  qty: number // 售出件数
}

/** 营业额/毛利口径与旧报表一致：出库 + 退货（换货退旧不算销售），退货按负数冲减 */
function aggregate(txs: Transaction[]): Stats & {
  byProduct: Map<number, { productId: number; qty: number; revenue: number; profit: number }>
} {
  let revenue = 0
  let profit = 0
  let qty = 0
  const byProduct = new Map<number, { productId: number; qty: number; revenue: number; profit: number }>()
  for (const t of txs) {
    const sign = t.type === 'return' ? -1 : 1
    const r = (t.selling_price ?? 0) * t.quantity * sign
    const p = ((t.selling_price ?? 0) - (t.unit_price ?? 0)) * t.quantity * sign
    const q = t.quantity * sign
    revenue += r
    profit += p
    qty += q
    const cur = byProduct.get(t.product_id)
    if (cur) {
      cur.qty += q
      cur.revenue += r
      cur.profit += p
    } else {
      byProduct.set(t.product_id, { productId: t.product_id, qty: q, revenue: r, profit: p })
    }
  }
  return { revenue, profit, margin: revenue > 0 ? profit / revenue : null, qty, byProduct }
}

/** 参与销售统计的流水：out + return（换货退旧腿不算） */
function isSaleTx(t: Transaction): boolean {
  if (t.type === 'out') return true
  if (t.type === 'return' && t.notes !== '换货退旧') return true
  return false
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0)
}

function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function marginText(m: number | null): string {
  return m === null ? '-' : `${(m * 100).toFixed(1)}%`
}

function StatCard({ title, stats, expense, footnote }: { title: string; stats: Stats; expense: number; footnote?: string }) {
  const net = stats.profit - expense
  return (
    <Card className="h-full">
      <CardContent className="pt-6">
        <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
          <CircleDollarSign className="size-4 text-brand-600" />
          {title}
        </div>
        <div className="text-[32px] font-bold leading-tight tabular-nums text-slate-800">
          {formatPrice(Math.round(stats.revenue))}
        </div>
        <div className="mt-1 text-xs text-slate-400">营业额（含退货冲减）</div>
        <div className="mt-4 flex items-end justify-between border-t pt-3">
          <div>
            <div className="text-xs text-slate-500">毛利</div>
            <div
              className={`text-xl font-bold tabular-nums ${stats.profit >= 0 ? 'text-green-700' : 'text-red-600'}`}
            >
              {formatPrice(Math.round(stats.profit))}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">毛利率</div>
            <div className="text-xl font-bold tabular-nums text-slate-700">{marginText(stats.margin)}</div>
          </div>
        </div>
        {/* 净利 = 毛利 − 支出：老板真正落袋的钱 */}
        <div className="mt-3 flex items-end justify-between border-t pt-3">
          <div>
            <div className="text-xs text-slate-500">支出</div>
            <div className="text-xl font-bold tabular-nums text-slate-700">
              {formatPrice(Math.round(expense))}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">净利（毛利 − 支出）</div>
            <div
              className={`text-2xl font-bold tabular-nums ${net >= 0 ? 'text-brand-700' : 'text-red-600'}`}
            >
              {formatPrice(Math.round(net))}
            </div>
          </div>
        </div>
        {footnote && (
          <div className="mt-3 border-t pt-2 text-xs text-slate-500">{footnote}</div>
        )}
      </CardContent>
    </Card>
  )
}

type ProfitSortKey = 'qty' | 'profit' | 'margin'

export function ReportsPage() {
  const transactions = useAppStore((s) => s.transactions)
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const customers = useAppStore((s) => s.customers)
  const expenses = useAppStore((s) => s.expenses)
  const loadCustomers = useAppStore((s) => s.loadCustomers)
  const navigate = useNavigate()

  const [profitSort, setProfitSort] = useState<ProfitSortKey>('profit')
  const [profitAsc, setProfitAsc] = useState(false)
  const [range, setRange] = useState<[string, string]>(() => rangePreset('last7'))
  const [from, to] = range

  // 「谁欠我钱」走 customer:list（loadAll 不含客户）
  useEffect(() => {
    void loadCustomers().catch(() => {})
  }, [loadCustomers])

  const saleTxs = useMemo(() => transactions.filter(isSaleTx), [transactions])

  const now = new Date()
  const todayStats = useMemo(() => {
    const start = dayStart(new Date())
    return aggregate(saleTxs.filter((t) => new Date(t.timestamp) >= start))
  }, [saleTxs])
  const monthStats = useMemo(() => {
    const d = new Date()
    const start = new Date(d.getFullYear(), d.getMonth(), 1)
    return aggregate(saleTxs.filter((t) => new Date(t.timestamp) >= start))
  }, [saleTxs])

  // 支出（按 expense_date 本地日期归天，与上面流水同区间）：净利 = 毛利 − 支出
  const todayExpense = useMemo(() => {
    const today = dateKey(new Date())
    return expenses.filter((e) => e.expense_date === today).reduce((s, e) => s + e.amount, 0)
  }, [expenses])
  const monthExpense = useMemo(() => {
    const d = new Date()
    const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
    return expenses.filter((e) => e.expense_date.startsWith(prefix)).reduce((s, e) => s + e.amount, 0)
  }, [expenses])

  // ========== 上月同期（月度环比，v0.1） ==========
  const lastMonthStats = useMemo(() => {
    const d = new Date()
    const lm = d.getMonth() === 0 ? { y: d.getFullYear() - 1, m: 12 } : { y: d.getFullYear(), m: d.getMonth() }
    const start = new Date(lm.y, lm.m - 1, 1)
    const end = new Date(d.getFullYear(), d.getMonth(), 1)
    return aggregate(saleTxs.filter((t) => {
      const ts = new Date(t.timestamp)
      return ts >= start && ts < end
    }))
  }, [saleTxs])
  const lastMonthExpense = useMemo(() => {
    const d = new Date()
    const lm = d.getMonth() === 0 ? { y: d.getFullYear() - 1, m: 12 } : { y: d.getFullYear(), m: d.getMonth() }
    const prefix = `${lm.y}-${String(lm.m).padStart(2, '0')}-`
    return expenses.filter((e) => e.expense_date.startsWith(prefix)).reduce((s, e) => s + e.amount, 0)
  }, [expenses])
  /** 本月 vs 上月营业额环比文案（上月为 0 时只报金额不报百分比） */
  const momText = useMemo(() => {
    if (lastMonthStats.revenue <= 0) return monthStats.revenue > 0 ? '上月没开张，本月有生意了' : '上月和本月都还没开张'
    const delta = (monthStats.revenue - lastMonthStats.revenue) / lastMonthStats.revenue
    const pct = `${Math.abs(delta * 100).toFixed(0)}%`
    return delta >= 0
      ? `本月比上月营业额 ↑${pct}（上月 ${formatPrice(Math.round(lastMonthStats.revenue))}）`
      : `本月比上月营业额 ↓${pct}（上月 ${formatPrice(Math.round(lastMonthStats.revenue))}）`
  }, [monthStats.revenue, lastMonthStats.revenue])

  // ========== 老客户多久没来了（v0.1）：有欠账/买过货的客户，超过 30 天没来 ==========
  const lapsedCustomers = useMemo(() => {
    const per = new Map<number, { last: string; total: number }>()
    for (const t of saleTxs) {
      if (t.customer_id == null) continue
      const cur = per.get(t.customer_id) ?? { last: t.timestamp, total: 0 }
      if (t.timestamp > cur.last) cur.last = t.timestamp
      cur.total += (t.selling_price ?? 0) * t.quantity
      per.set(t.customer_id, cur)
    }
    const cutoff = Date.now() - 30 * 86400_000
    return [...per.entries()]
      .map(([id, v]) => ({ customer: customers.find((c) => c.id === id), ...v }))
      .filter((x) => x.customer && new Date(x.last).getTime() < cutoff)
      .sort((a, b) => a.last.localeCompare(b.last))
      .slice(0, 10)
  }, [saleTxs, customers])

  // ========== 区间聚合：整页统一区间（日结卡选择，什么最赚钱跟随同一区间） ==========
  const rangeStats = useMemo(
    () =>
      aggregate(
        saleTxs.filter((t) => {
          const dk = localDayKey(t.timestamp)
          return dk >= from && dk <= to
        }),
      ),
    [saleTxs, from, to],
  )

  // ========== 什么最赚钱：区间商品毛利排行 TOP20（可点表头排序） ==========
  const profitTop = useMemo(() => {
    const rows = [...rangeStats.byProduct.values()].map((x) => ({
      ...x,
      margin: x.revenue > 0 ? x.profit / x.revenue : null,
    }))
    const dir = profitAsc ? 1 : -1
    rows.sort((a, b) => {
      if (profitSort === 'qty') return (a.qty - b.qty) * dir
      if (profitSort === 'margin') return ((a.margin ?? -Infinity) - (b.margin ?? -Infinity)) * dir
      return (a.profit - b.profit) * dir
    })
    return rows.slice(0, 20)
  }, [rangeStats, profitSort, profitAsc])

  const toggleProfitSort = (key: ProfitSortKey) => {
    if (profitSort === key) setProfitAsc(!profitAsc)
    else {
      setProfitSort(key)
      setProfitAsc(false)
    }
  }

  const SortHead = ({ label, k }: { label: string; k: ProfitSortKey }) => (
    <TableHead className="text-right">
      <button
        onClick={() => toggleProfitSort(k)}
        className="inline-flex cursor-pointer items-center gap-1 hover:text-slate-900"
      >
        {label}
        {profitSort === k &&
          (profitAsc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  )

  // ========== 谁欠我钱：欠款客户（点行进客户页） ==========
  const debtors = useMemo(
    () => customers.filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding),
    [customers],
  )
  const totalOwed = debtors.reduce((s, c) => s + c.outstanding, 0)

  // ========== 什么压着钱：库存金额排行 TOP20（占用资金 = 库存 × 批次成本价） ==========
  const inventoryRows = useMemo(() => {
    const byProduct = new Map<number, { qty: number; value: number }>()
    for (const b of batches) {
      if (b.quantity <= 0) continue
      const cur = byProduct.get(b.product_id) ?? { qty: 0, value: 0 }
      cur.qty += b.quantity
      cur.value += b.quantity * b.cost_price
      byProduct.set(b.product_id, cur)
    }
    return [...byProduct.entries()].map(([productId, v]) => ({ productId, ...v }))
  }, [batches])
  const inventoryTop = useMemo(
    () => [...inventoryRows].sort((a, b) => b.value - a.value).slice(0, 20),
    [inventoryRows],
  )
  const inventoryTotal = inventoryRows.reduce((s, r) => s + r.value, 0)

  // ========== 什么卖不动（v0.1）：还有库存但 60 天没卖出，按占用资金排 ==========
  // 沉睡资金（周掌柜审计升级 2026-08-28）：90天滞销 / 180天死亡 两档，按占用资金倒序
  const slowMoving = useMemo(() => {
    const lastSale = new Map<number, string>()
    for (const t of transactions) {
      if (t.type !== 'out') continue
      const cur = lastSale.get(t.product_id)
      if (!cur || t.timestamp > cur) lastSale.set(t.product_id, t.timestamp)
    }
    const cutoff90 = Date.now() - 90 * 86400_000
    const cutoff180 = Date.now() - 180 * 86400_000
    return inventoryRows
      .map((r) => {
        const ls = lastSale.get(r.productId)
        const lastMs = ls ? new Date(ls).getTime() : null
        const stale = !lastMs || lastMs < cutoff90
        const tier: '180天+' | '90天+' = !lastMs || lastMs < cutoff180 ? '180天+' : '90天+'
        return { ...r, lastSaleAt: ls ?? null, stale, tier }
      })
      .filter((x) => x.stale)
      .sort((a, b) => b.value - a.value)
      .slice(0, 20)
  }, [transactions, inventoryRows])
  const slowValue = slowMoving.reduce((s, r) => s + r.value, 0)
  const slowValue180 = slowMoving.filter((x) => x.tier === '180天+').reduce((s, r) => s + r.value, 0)

  // ========== 清仓建议（决策层 MVP-1）：沉睡档 × 压货成本 × 临期叠加 → P0/P1/P2（每账号只读，不出自动价） ==========
  const clearance = useMemo(() => {
    const MIN_TIED_YUAN = 500, EXPIRY_URGENT = 60, GUARD_DAYS = 30
    const pad = (n: number) => String(n).padStart(2, '0')
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const dayDiff = (from: string, to: string) => Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86400000)
    const lastSale = new Map<number, string>()
    const recentOut30 = new Map<number, number>()
    const cutoff30 = now.getTime() - GUARD_DAYS * 86400000
    for (const t of transactions) {
      if (t.type !== 'out') continue
      const ls = lastSale.get(t.product_id)
      if (!ls || t.timestamp > ls) lastSale.set(t.product_id, t.timestamp)
      if (new Date(t.timestamp).getTime() >= cutoff30) recentOut30.set(t.product_id, (recentOut30.get(t.product_id) || 0) + 1)
    }
    const agg = new Map<number, { stock: number; tied: number; earliest: string | null }>()
    for (const b of batches) {
      const cur = agg.get(b.product_id) || { stock: 0, tied: 0, earliest: null as string | null }
      cur.stock += b.quantity || 0
      cur.tied += (b.quantity || 0) * (b.cost_price || 0)
      if (b.expiry_date && (!cur.earliest || b.expiry_date < cur.earliest)) cur.earliest = b.expiry_date
      agg.set(b.product_id, cur)
    }
    const R = { P0: [0.6, 0.85], P1: [0.8, 1.0], P2: [0.9, 1.0] }
    const round2 = (x: number) => Math.round(x * 100) / 100
    const rank: Record<string, number> = { P0: 0, P1: 1, P2: 2 }
    const items: any[] = []
    for (const pr of products) {
      const b = agg.get(pr.id)
      if (!b || b.stock <= 0) continue
      const tiedYuan = round2(b.tied / 100)
      if (tiedYuan < MIN_TIED_YUAN) continue
      const ls = lastSale.get(pr.id)
      const noOut = ls ? dayDiff(ls.slice(0, 10), todayStr) : Infinity
      if (noOut < 90) continue
      const expiryInDays = b.earliest ? dayDiff(todayStr, b.earliest) : null
      const dead = noOut >= 180
      const expiring = expiryInDays != null && expiryInDays <= EXPIRY_URGENT
      let priority = dead && expiring ? 'P0' : dead ? 'P1' : expiring ? 'P1' : 'P2'
      let guard: { note: string } | null = null
      if ((recentOut30.get(pr.id) || 0) > 0) {
        const down = priority === 'P0' ? 'P1' : priority === 'P1' ? 'P2' : null
        guard = { note: '近30天有动销，降为' + (down || '排除（在动，不建议清）') }
        if (down) priority = down
        else continue
      }
      let action = ''
      let suggestRange: { low: number; high: number } | null = null
      if (priority === 'P0') {
        if (expiryInDays != null && expiryInDays <= 0) action = '移出货架/报废核销'
        else { action = '降价出清'; suggestRange = { low: round2(tiedYuan * R.P0[0]), high: round2(tiedYuan * R.P0[1]) } }
      } else if (priority === 'P1') { action = '降价/捆绑搭售'; suggestRange = { low: round2(tiedYuan * R.P1[0]), high: round2(tiedYuan * R.P1[1]) } }
      else { action = '观察/挪动线'; suggestRange = { low: round2(tiedYuan * R.P2[0]), high: round2(tiedYuan * R.P2[1]) } }
      const reason: string[] = []
      if (noOut >= 180) reason.push('180天无出库')
      else reason.push('90天无出库')
      if (expiryInDays != null && expiryInDays <= 0) reason.push('已过期')
      else if (expiryInDays != null && expiryInDays <= EXPIRY_URGENT) reason.push('临期' + expiryInDays + '天')
      if (pr.is_clearance) reason.push('已标记清仓')
      const name = [pr.brand, pr.model].filter(Boolean).join(' ').trim() || pr.sku_code || ('#' + pr.id)
      items.push({ id: pr.id, name, category: String(pr.category ?? ''), stock: b.stock, tiedCostYuan: tiedYuan, lastSaleDaysAgo: ls ? noOut : null, dormantTier: noOut >= 180 ? '180天+' : '90天+', expiryInDays, priority, action, suggestRange, reason, guard })
    }
    items.sort((a, b) => rank[a.priority] - rank[b.priority] || b.tiedCostYuan - a.tiedCostYuan)
    return {
      items,
      totalCandidate: items.length,
      recoverableCost: round2(items.reduce((s, i) => s + i.tiedCostYuan, 0)),
      byPriority: { P0: items.filter((i) => i.priority === 'P0').length, P1: items.filter((i) => i.priority === 'P1').length, P2: items.filter((i) => i.priority === 'P2').length },
    }
  }, [products, batches, transactions])

  // 真实数据驱动：经 IPC 调命令层单一来源 buildClearance（Electron 下出真实库候选；无 IPC 回退内联）
  interface ClearanceItem { id: number; name: string; category: string; stock: number; tiedCostYuan: number; lastSaleDaysAgo: number | null; dormantTier: string; expiryInDays: number | null; priority: string; action: string; suggestRange: { low: number; high: number } | null; reason: string[]; guard: { note: string } | null }
  const [clearanceData, setClearanceData] = useState<null | { items: ClearanceItem[]; totalCandidate: number; recoverableCost: number; byPriority: { P0: number; P1: number; P2: number } }>(null)
  useEffect(() => {
    const fi = (window as any).fi
    if (fi && typeof fi.invoke === 'function') {
      fi.invoke('clearance:get').then((d: any) => { if (d && Array.isArray(d.items)) setClearanceData(d) }).catch(() => {})
    }
  }, [])
  const CL = clearanceData ?? clearance

  // ========== 定价建议（决策层 MVP-2）：亏本在售 / 毛利偏低 / 可降价促动销 → 给区间不给自动价 ==========
  // 口径只走命令层 buildPricing（IPC `pricing:get` 单一来源）；前端不复制规则，避免出现第二套口径。
  interface PricingItem {
    id: number; name: string; category: string; stock: number
    unitCostYuan: number; refPriceYuan: number; refPriceSource: string; suggestPriceYuan: number | null
    marginPct: number; tiedCostYuan: number; lastSaleDaysAgo: number | null; recentOut30: number
    priority: string; action: string; suggestRange: { low: number; high: number } | null
    tiers: { tier: string; priceYuan: number }[]; reason: string[]; guard: { note: string } | null
  }
  interface PricingData {
    items: PricingItem[]
    totalCandidate: number
    byPriority: { P0: number; P1: number; P2: number }
    avgMarginPct: number | null
    basis?: string
    dataWindowOk?: boolean
    note?: string
    skipped?: { noCost: number; noPrice: number; clearance: number; guardMove: number; normal: number }
  }
  const [pricingData, setPricingData] = useState<PricingData | null>(null)
  useEffect(() => {
    const fi = (window as any).fi
    if (fi && typeof fi.invoke === 'function') {
      fi.invoke('pricing:get').then((d: any) => { if (d && Array.isArray(d.items)) setPricingData(d) }).catch(() => {})
    }
  }, [])

  function exportPricingCSV() {
    if (!pricingData) return
    const lines = ['\uFEFF定价建议（P0亏本在售/P1毛利偏低/P2可降价促动销）', '优先级,商品,分类,库存,单位成本(元),参考价(元),参考价来源,毛利率%,建议区间(元),动作,原因']
    for (const i of pricingData.items) {
      const range = i.suggestRange ? i.suggestRange.low + '-' + i.suggestRange.high : '-'
      lines.push([i.priority, csvCell(i.name), csvCell(i.category), i.stock, i.unitCostYuan.toFixed(2), i.refPriceYuan.toFixed(2), csvCell(i.refPriceSource), i.marginPct, range, csvCell(i.action), i.reason.join(';')].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '定价建议_' + dateKey(new Date()) + '.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function exportClearanceCSV() {
    const lines = ['\uFEFF清仓建议（P0紧急清/P1应清/P2观察清）', '优先级,商品,分类,库存,压货成本(元),建议区间(元),动作,原因,护栏']
    for (const i of CL.items) {
      const range = i.suggestRange ? i.suggestRange.low + '-' + i.suggestRange.high : '-'
      lines.push([i.priority, csvCell(i.name), csvCell(i.category), i.stock, i.tiedCostYuan.toFixed(2), range, csvCell(i.action), i.reason.join(';'), i.guard ? i.guard.note : ''].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '清仓建议_' + dateKey(new Date()) + '.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // ========== CSV 导出（与新报表同内容） ==========
  function exportCSV() {
    const yuan = (cents: number) => (cents / 100).toFixed(2)
    const lines = [
      '\uFEFF赚了多少',
      '区间,营业额(元),毛利(元),毛利率,支出(元),净利(元),售出件数',
      [
        '今天',
        yuan(todayStats.revenue),
        yuan(todayStats.profit),
        marginText(todayStats.margin),
        yuan(todayExpense),
        yuan(todayStats.profit - todayExpense),
        todayStats.qty,
      ].join(','),
      [
        '本月',
        yuan(monthStats.revenue),
        yuan(monthStats.profit),
        marginText(monthStats.margin),
        yuan(monthExpense),
        yuan(monthStats.profit - monthExpense),
        monthStats.qty,
      ].join(','),
      [
        '上月',
        yuan(lastMonthStats.revenue),
        yuan(lastMonthStats.profit),
        marginText(lastMonthStats.margin),
        yuan(lastMonthExpense),
        yuan(lastMonthStats.profit - lastMonthExpense),
        lastMonthStats.qty,
      ].join(','),
      ['本月比上月', momText].join(','),
      '',
      '什么最赚钱（本月 Top20）',
      '商品名称,SKU,售出件数,营业额(元),毛利(元),毛利率',
      ...profitTop.map((x) => {
        const p = products.find((pr) => pr.id === x.productId)
        return [
          p ? productName(p) : `#${x.productId}`,
          p?.sku_code ?? '-',
          x.qty,
          yuan(x.revenue),
          yuan(x.profit),
          marginText(x.margin),
        ]
          .map(csvCell)
          .join(',')
      }),
      '',
      '谁欠我钱',
      '客户,电话,欠的钱(元),最近交易',
      ...debtors.map((c) =>
        [c.name, c.phone ?? '-', yuan(c.outstanding), c.last_deal_at ? formatDateTime(c.last_deal_at) : '-']
          .map(csvCell)
          .join(','),
      ),
      '',
      '什么压着钱（库存金额 Top20）',
      '商品名称,SKU,库存数量,占用资金(元)',
      ...inventoryTop.map((x) => {
        const p = products.find((pr) => pr.id === x.productId)
        return [p ? productName(p) : `#${x.productId}`, p?.sku_code ?? '-', x.qty, yuan(x.value)]
          .map(csvCell)
          .join(',')
      }),
      `库存总值,,,${yuan(inventoryTotal)}`,
      '',
      '老客户多久没来了（超过30天）',
      '客户,电话,累计买过(元),最近来店',
      ...lapsedCustomers.map((x) =>
        [x.customer?.name ?? '-', x.customer?.phone ?? '-', yuan(x.total), formatDateTime(x.last)]
          .map(csvCell)
          .join(','),
      ),
      '',
      '什么卖不动（60天没卖出）',
      '商品名称,SKU,库存数量,占用资金(元),上次卖出',
      ...slowMoving.map((x) => {
        const p = products.find((pr) => pr.id === x.productId)
        return [
          p ? productName(p) : `#${x.productId}`,
          p?.sku_code ?? '-',
          x.qty,
          yuan(x.value),
          x.lastSaleAt ? formatDateTime(x.lastSaleAt) : '从没卖出过',
        ]
          .map(csvCell)
          .join(',')
      }),
      `滞销占用资金合计,,,,${yuan(slowValue)}`,
    ].join('\n')

    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `经营报表_${dateKey(now)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {/* 标题行（Direction A 统一）+ 导出动作 */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">经营报表</div>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">赚了多少</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">什么最赚钱、谁欠我钱、什么压着钱 · 数据来自库存与流水</p>
        </div>
        <button
          onClick={exportCSV}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-brand-300 hover:text-brand-700"
        >
          <Download className="size-4" />
          导出 CSV
        </button>
      </div>

      {/* 赚了多少：今天 / 本月 / 上月并排大数字（含支出与净利 + 月度环比） */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard title="今天赚了多少" stats={todayStats} expense={todayExpense} />
        <StatCard title="本月赚了多少" stats={monthStats} expense={monthExpense} footnote={momText} />
        <StatCard title="上月赚了多少" stats={lastMonthStats} expense={lastMonthExpense} />
      </div>

      {/* 日结对账：任意区间看每天的营业额/毛利/收款方式/赊账 */}
      <DailyReconcileCard transactions={transactions} from={from} to={to} onRangeChange={(f, t) => setRange([f, t])} />

      {/* 什么最赚钱 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Trophy className="mr-2 inline-block size-4 text-amber-500" />
            什么最赚钱（{from} ~ {to} Top 20）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {profitTop.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {from} ~ {to} 还没有成交记录，开始卖货后这里会排出最赚钱的商品
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>商品</TableHead>
                  <SortHead label="卖了多少件" k="qty" />
                  <TableHead className="text-right">营业额</TableHead>
                  <SortHead label="毛利" k="profit" />
                  <SortHead label="毛利率" k="margin" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {profitTop.map((x, i) => {
                  const p = products.find((pr) => pr.id === x.productId)
                  return (
                    <TableRow key={x.productId}>
                      <TableCell className="text-xs font-medium text-muted-foreground">{i + 1}</TableCell>
                      <TableCell>
                        <span>{p ? productName(p) : `#${x.productId}`}</span>
                        {p && (
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{x.qty}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPrice(x.revenue)}</TableCell>
                      <TableCell
                        className={`text-right font-medium tabular-nums ${x.profit >= 0 ? 'text-green-700' : 'text-red-600'}`}
                      >
                        {formatPrice(x.profit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{marginText(x.margin)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 谁欠我钱 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            <Users className="mr-2 inline-block size-4 text-red-500" />
            谁欠我钱
          </CardTitle>
          {debtors.length > 0 && (
            <span className="text-sm text-red-600">
              合计欠 <span className="font-bold tabular-nums">{formatPrice(totalOwed)}</span>
            </span>
          )}
        </CardHeader>
        <CardContent>
          {debtors.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              没人欠钱，账目清爽
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>电话</TableHead>
                  <TableHead className="text-right">欠多少</TableHead>
                  <TableHead className="text-right">最近交易</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {debtors.map((c) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => navigate('/customers')}
                    title="点我去客户页记还账"
                  >
                    <TableCell className="font-medium text-lake-700">{c.name}</TableCell>
                    <TableCell>{c.phone ?? '-'}</TableCell>
                    <TableCell className="text-right text-lg font-bold tabular-nums text-red-600">
                      {formatPrice(c.outstanding)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {c.last_deal_at ? formatDateTime(c.last_deal_at) : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 什么压着钱 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            <Package className="mr-2 inline-block size-4 text-slate-500" />
            什么压着钱（库存金额 Top 20）
          </CardTitle>
          <span className="text-sm text-slate-600">
            库存总值 <span className="font-bold tabular-nums">{formatPrice(inventoryTotal)}</span>
          </span>
        </CardHeader>
        <CardContent>
          {inventoryTop.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">仓库是空的</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>商品</TableHead>
                  <TableHead className="text-right">库存数量</TableHead>
                  <TableHead className="text-right">占用资金</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventoryTop.map((x, i) => {
                  const p = products.find((pr) => pr.id === x.productId)
                  return (
                    <TableRow key={x.productId}>
                      <TableCell className="text-xs font-medium text-muted-foreground">{i + 1}</TableCell>
                      <TableCell>
                        <span>{p ? productName(p) : `#${x.productId}`}</span>
                        {p && (
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{x.qty}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-slate-700">
                        {formatPrice(x.value)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 老客户多久没来了（v0.1）：30 天没来的老客户，提醒回访 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            <Users className="mr-2 inline-block size-4 text-lake-500" />
            老客户多久没来了（超过 30 天）
          </CardTitle>
          {lapsedCustomers.length > 0 && (
            <span className="text-sm text-slate-500">按最久没来的排，最多看 10 位</span>
          )}
        </CardHeader>
        <CardContent>
          {lapsedCustomers.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              老客户最近都来过，关系维护得不错
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>电话</TableHead>
                  <TableHead className="text-right">累计买过</TableHead>
                  <TableHead className="text-right">最近来店</TableHead>
                  <TableHead className="text-right">多久没来</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lapsedCustomers.map((x) => {
                  const days = Math.floor((Date.now() - new Date(x.last).getTime()) / 86400_000)
                  return (
                    <TableRow key={x.customer!.id}>
                      <TableCell className="font-medium text-lake-700">{x.customer!.name}</TableCell>
                      <TableCell>{x.customer!.phone ?? '-'}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPrice(x.total)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDateTime(x.last)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-amber-600">
                        {days} 天
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 什么卖不动（v0.1）：60 天没卖出且还有库存，按占用资金排 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            <Package className="mr-2 inline-block size-4 text-amber-600" />
            沉睡资金榜（90/180 天没卖出）
          </CardTitle>
          {slowMoving.length > 0 && (
            <span className="text-sm text-slate-600">
              压着 <span className="font-bold tabular-nums">{formatPrice(slowValue)}</span>，
              其中 <span className="font-bold text-red-600 tabular-nums">{formatPrice(slowValue180)}</span> 超 180 天没动
            </span>
          )}
        </CardHeader>
        <CardContent>
          {slowMoving.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              没有积压货，库存周转健康
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>商品</TableHead>
                  <TableHead className="text-right">库存数量</TableHead>
                  <TableHead className="text-right">占用资金</TableHead>
                  <TableHead className="text-right">上次卖出</TableHead>
                  <TableHead className="text-right">档位</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slowMoving.map((x, i) => {
                  const p = products.find((pr) => pr.id === x.productId)
                  return (
                    <TableRow key={x.productId}>
                      <TableCell className="text-xs font-medium text-muted-foreground">{i + 1}</TableCell>
                      <TableCell>
                        <span>{p ? productName(p) : `#${x.productId}`}</span>
                        {p && (
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{x.qty}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-slate-700">
                        {formatPrice(x.value)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {x.lastSaleAt ? formatDateTime(x.lastSaleAt) : '从没卖出过'}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={'rounded px-1.5 py-0.5 text-xs font-bold ' + (x.tier === '180天+' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')}>
                          {x.tier}
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 清仓建议（决策层 MVP-1）：沉睡×压货×临期 → P0/P1/P2，给区间不给自动价；纯建议，不自动改价 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            <Trophy className="mr-2 inline-block size-4 text-red-600" />
            清仓建议（谁该清 / 按什么力度清 / 先清谁）
          </CardTitle>
          <div className="flex items-center gap-2">
            {CL.totalCandidate > 0 && (
              <span className="text-sm text-slate-600">
                可收回 ≈ <span className="font-bold tabular-nums">{formatPrice(Math.round(CL.recoverableCost * 100))}</span>
                ，P0 {CL.byPriority.P0} · P1 {CL.byPriority.P1} · P2 {CL.byPriority.P2}
              </span>
            )}
            {CL.totalCandidate > 0 && (
              <button
                onClick={exportClearanceCSV}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                <Download className="size-3.5" /> 导出 CSV
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {CL.totalCandidate === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              没有需要清仓的积压货，库存周转健康
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>商品</TableHead>
                  <TableHead>优先级</TableHead>
                  <TableHead className="text-right">压货成本</TableHead>
                  <TableHead className="text-right">建议区间</TableHead>
                  <TableHead>建议动作</TableHead>
                  <TableHead>原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {CL.items.map((x, i) => (
                  <TableRow key={x.id}>
                    <TableCell className="text-xs font-medium text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <span>{x.name}</span>
                      {x.guard && <div className="text-xs text-amber-600">{x.guard.note}</div>}
                    </TableCell>
                    <TableCell>
                      <span className={'rounded px-1.5 py-0.5 text-xs font-bold ' + (x.priority === 'P0' ? 'bg-red-100 text-red-700' : x.priority === 'P1' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
                        {x.priority === 'P0' ? 'P0 紧急' : x.priority === 'P1' ? 'P1 应清' : 'P2 观察'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-slate-700">{formatPrice(Math.round(x.tiedCostYuan * 100))}</TableCell>
                    <TableCell className="text-right tabular-nums text-slate-700">
                      {x.suggestRange ? `${formatPrice(Math.round(x.suggestRange.low * 100))} - ${formatPrice(Math.round(x.suggestRange.high * 100))}` : '-'}
                    </TableCell>
                    <TableCell className="text-sm">{x.action}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {x.reason.map((r: string) => <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{r}</span>)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 定价建议（决策层 MVP-2）：亏本/毛利偏低/可降价 → 给区间不给自动价；近30天有动销不做降价建议 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            <CircleDollarSign className="mr-2 inline-block size-4 text-blue-600" />
            定价建议（谁定低了 / 谁定高了 / 该调到多少）
          </CardTitle>
          <div className="flex items-center gap-2">
            {pricingData && pricingData.totalCandidate > 0 && (
              <span className="text-sm text-slate-600">
                亏本 {pricingData.byPriority.P0} · 毛利偏低 {pricingData.byPriority.P1} · 可降价 {pricingData.byPriority.P2}
                {pricingData.avgMarginPct != null && <>，候选均毛利率 {pricingData.avgMarginPct}%</>}
              </span>
            )}
            {pricingData && pricingData.totalCandidate > 0 && (
              <button
                onClick={exportPricingCSV}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                <Download className="size-3.5" /> 导出 CSV
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!pricingData ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              定价建议在桌面端运行（口径取自命令层单一来源，网页版不重复计算）
            </div>
          ) : pricingData.totalCandidate === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              没有需要调价的商品：在售商品毛利都在健康区间（15%~60%）
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>商品</TableHead>
                  <TableHead>优先级</TableHead>
                  <TableHead className="text-right">单位成本</TableHead>
                  <TableHead className="text-right">参考价</TableHead>
                  <TableHead className="text-right">毛利率</TableHead>
                  <TableHead className="text-right">建议区间</TableHead>
                  <TableHead>建议动作</TableHead>
                  <TableHead>原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pricingData.items.map((x, i) => (
                  <TableRow key={x.id}>
                    <TableCell className="text-xs font-medium text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <span>{x.name}</span>
                      {x.stock > 0 && <span className="ml-1 text-xs text-muted-foreground">库存 {x.stock}</span>}
                    </TableCell>
                    <TableCell>
                      <span className={'rounded px-1.5 py-0.5 text-xs font-bold ' + (x.priority === 'P0' ? 'bg-red-100 text-red-700' : x.priority === 'P1' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
                        {x.priority === 'P0' ? 'P0 亏本' : x.priority === 'P1' ? 'P1 毛利低' : 'P2 偏高'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-slate-700">{formatPrice(Math.round(x.unitCostYuan * 100))}</TableCell>
                    <TableCell className="text-right tabular-nums text-slate-700">{formatPrice(Math.round(x.refPriceYuan * 100))}</TableCell>
                    <TableCell className={'text-right font-medium tabular-nums ' + (x.marginPct < 0 ? 'text-red-600' : x.marginPct < 15 ? 'text-amber-600' : 'text-slate-700')}>{x.marginPct}%</TableCell>
                    <TableCell className="text-right tabular-nums text-slate-700">
                      {x.suggestRange ? `${formatPrice(Math.round(x.suggestRange.low * 100))} - ${formatPrice(Math.round(x.suggestRange.high * 100))}` : '-'}
                    </TableCell>
                    <TableCell className="text-sm">{x.action}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {x.reason.map((r: string) => <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{r}</span>)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {pricingData?.note && <div className="mt-2 text-xs text-amber-600">{pricingData.note}</div>}
        </CardContent>
      </Card>

      {/* 毛利口径说明（老板看得懂的一句话） */}
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <TrendingUp className="size-3.5" />
        毛利 = 卖价 − 进货成本；净利 = 毛利 − 支出（支出在「支出记账」页维护）；退货按负数冲减；换货不影响营业额
      </div>
    </div>
  )
}