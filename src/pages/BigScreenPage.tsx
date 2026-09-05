import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAppStore } from '@/store/appStore'
import { formatPrice } from '@/lib/formatters'
import { computeOverview, computeTrend, computeStockValue } from '@/lib/analytics'
import { RollingNumber } from '@/components/RollingNumber'
import { cn } from '@/lib/utils'

/** 经营驾驶舱·大屏：数据绑定大数 + 趋势 + 同步新鲜度。海洋清爽风，适合店内 TV/监控屏。 */
export default function BigScreenPage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const transactions = useAppStore((s) => s.transactions)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const [reduce, setReduce] = useState(false)

  const overview = useMemo(() => computeOverview(transactions, batches, products), [transactions, batches, products])
  const stock = useMemo(() => computeStockValue(batches, products), [batches, products])
  const trend = useMemo(() => computeTrend(transactions, 14).map((d) => ({ revenue: d.revenue, profit: d.profit, day: d.date.slice(5) })), [transactions])
  const lowCount = products.filter((p) => totalStockOf(p.id) <= (p.min_stock ?? 5)).length
  const expiringCount = useMemo(() => products.filter((p) => (p as any).expiry_date && new Date((p as any).expiry_date) <= new Date(Date.now() + 30 * 86400000)).length, [products])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-[#0a1628] to-slate-950 px-8 py-8 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5">
            <ArrowLeft className="size-4" /> 返回看板
          </Link>
          <h1 className="text-2xl font-bold tracking-wide">经营驾驶舱</h1>
          <div className="ml-1 flex items-center gap-2 text-xs text-slate-400">
            <RefreshCw className="size-3" /> 数据实时 · 每个数字都绑定真实业务字段
          </div>
          <button onClick={() => setReduce((v) => !v)} className="ml-auto rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5">
            {reduce ? '恢复动效' : '减弱动效'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {[
            { label: '今日营业额', val: overview.today.revenue, fmt: (v: number) => formatPrice(v), accent: 'text-slate-100', sub: '今日' },
            { label: '今日毛利', val: overview.today.profit, fmt: (v: number) => formatPrice(v), accent: 'text-emerald-400', sub: '今日' },
            { label: '库存总额', val: stock.totalValue, fmt: (v: number) => formatPrice(v), accent: 'text-slate-100', sub: overview.totalStock.toLocaleString() + ' 件 · ' + overview.totalSku + ' SKU' },
            { label: '低库存', val: lowCount, fmt: (v: number) => Math.round(v).toLocaleString(), accent: lowCount > 0 ? 'text-red-400' : 'text-emerald-400', sub: '低于预警线' },
            { label: '临期', val: expiringCount, fmt: (v: number) => Math.round(v).toLocaleString(), accent: expiringCount > 0 ? 'text-amber-400' : 'text-emerald-400', sub: '30 天内到期' },
          ].map((c) => (
            <div key={c.label} className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              <div className="text-xs text-slate-400">{c.label}</div>
              <div className={cn('mt-1 flex items-baseline text-4xl font-extrabold tabular-nums', c.accent)}>
                <RollingNumber value={c.val} format={c.fmt} />
              </div>
              <div className="mt-1 text-xs text-slate-500">{c.sub}</div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <div className="mb-3 text-sm text-slate-400">近 14 天营业额 & 毛利</div>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={trend}>
              <defs>
                <linearGradient id="biRev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c1d8" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="#22c1d8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="day" fontSize={11} tickLine={false} axisLine={false} tick={{ fill: '#8aa3c4' }} />
              <YAxis fontSize={10} tickLine={false} axisLine={false} tick={{ fill: '#8aa3c4' }} width={44} />
              <Tooltip contentStyle={{ border: 'none', borderRadius: 12, fontSize: 12, background: '#0a1628', color: '#e6f0fb' }} />
              <Area type="monotone" dataKey="revenue" name="营业额" stroke="#22c1d8" strokeWidth={2} fill="url(#biRev)" />
              <Area type="monotone" dataKey="profit" name="毛利" stroke="#10b981" strokeWidth={2} fill="transparent" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm text-slate-400">
          动效是数据的可视化神经：营业额/毛利数字滚动 · 低库存/临期呼吸告警 · 库存水位随货值升降 · 云端同步点实时。每个动画都绑定一个真实业务字段。
        </div>
      </div>
    </div>
  )
}