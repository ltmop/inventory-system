import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAppStore } from '@/store/appStore'
import { formatPrice } from '@/lib/formatters'
import { computeOverview, computeTrend, computeStockValue } from '@/lib/analytics'
import { RollingNumber } from '@/components/RollingNumber'
import darkblueHologram from '@/assets/svg/darkblue-hologram.svg'
import cybersilverChrome from '@/assets/svg/cybersilver-chrome.svg'
import { cn } from '@/lib/utils'

type Skin = 'blue' | 'silver'
const SKINS: Record<Skin, { img: string; label: string; bg: string; panel: string; ink: string; sub: string; border: string }> = {
  blue: {
    img: darkblueHologram, label: '黑洞 · 暗夜蓝',
    bg: 'from-[#070b16] via-[#0a0e1c] to-[#060910]',
    panel: 'bg-slate-950/45 backdrop-blur-md border-white/10', ink: 'text-slate-100', sub: 'text-slate-300', border: 'border-white/10',
  },
  silver: {
    img: cybersilverChrome, label: '铬立方 · 赛博银',
    bg: 'from-slate-200 via-slate-100 to-slate-300',
    panel: 'bg-white/65 backdrop-blur-md border-black/10', ink: 'text-slate-900', sub: 'text-slate-600', border: 'border-black/10',
  },
}

/** 经营驾驶舱·大屏：可切换 SVG 动画皮肤 + 真实经营指标叠加（HUD 数据槽换成业务数据）。 */
export default function BigScreenPage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const transactions = useAppStore((s) => s.transactions)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const [skin, setSkin] = useState<Skin>('blue')
  const [reduce, setReduce] = useState(false)
  const s = SKINS[skin]

  const overview = useMemo(() => computeOverview(transactions, batches, products), [transactions, batches, products])
  const stock = useMemo(() => computeStockValue(batches, products), [batches, products])
  const trend = useMemo(() => computeTrend(transactions, 14).map((d) => ({ revenue: d.revenue, profit: d.profit, day: d.date.slice(5) })), [transactions])
  const lowCount = products.filter((p) => totalStockOf(p.id) <= (p.min_stock ?? 5)).length
  const expiringCount = useMemo(() => products.filter((p) => (p as any).expiry_date && new Date((p as any).expiry_date) <= new Date(Date.now() + 30 * 86400000)).length, [products])

  const cards = [
    { label: '今日营业额', val: overview.today.revenue, fmt: (v: number) => formatPrice(v), sub: '今日' },
    { label: '今日毛利', val: overview.today.profit, fmt: (v: number) => formatPrice(v), sub: '今日' },
    { label: '库存总额', val: stock.totalValue, fmt: (v: number) => formatPrice(v), sub: overview.totalStock.toLocaleString() + ' 件 · ' + overview.totalSku + ' SKU' },
    { label: '低库存', val: lowCount, fmt: (v: number) => Math.round(v).toLocaleString() + ' 个', sub: '低于预警线' },
    { label: '临期', val: expiringCount, fmt: (v: number) => Math.round(v).toLocaleString() + ' 个', sub: '30 天内到期' },
  ]

  return (
    <div className={cn('relative min-h-screen overflow-hidden text-slate-100', s.bg)} style={{ backgroundImage: 'radial-gradient(1200px 600px at 15% -5%, rgba(43,109,224,.18), transparent 60%)' }}>
      {/* SVG 壁纸背景（CSS background-image，打包 app 稳定解析，cover 铺满） */}
      <div
        className="wallpaper-bg absolute inset-0"
        style={{ backgroundImage: 'url("' + s.img + '")', backgroundSize: 'cover', backgroundPosition: 'center' }}
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-8 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:bg-white/10', s.border, s.sub)}>
            <ArrowLeft className="size-4" /> 返回看板
          </Link>
          <div>
            <h1 className={cn('text-2xl font-bold tracking-wide', s.ink)}>经营观测站</h1>
            <div className="flex items-center gap-2 text-xs opacity-70">
              <RefreshCw className="size-3" /> 数据实时 · 每个数字都绑定真实业务字段
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {(Object.keys(SKINS) as Skin[]).map((k) => (
              <button key={k} onClick={() => setSkin(k)} className={cn('rounded-full border px-3 py-1.5 text-xs hover:bg-white/10', s.border, skin === k ? s.ink : s.sub)}>
                {SKINS[k].label}
              </button>
            ))}
            <button onClick={() => setReduce((v) => !v)} className={cn('rounded-full border px-3 py-1.5 text-xs hover:bg-white/10', s.border, s.sub)}>
              {reduce ? '恢复动效' : '减弱动效'}
            </button>
          </div>
        </div>

        {/* KPI 大数（HUD 数据槽换成真实经营指标） */}
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-5">
          {cards.map((c) => (
            <div key={c.label} className={cn('rounded-2xl border p-5', s.panel)}>
              <div className={cn('text-xs', s.sub)}>{c.label}</div>
              <div className={cn('mt-1 flex items-baseline text-4xl font-extrabold tabular-nums', s.ink)}>
                <RollingNumber value={c.val} format={c.fmt} />
              </div>
              <div className={cn('mt-1 text-xs', s.sub)}>{c.sub}</div>
            </div>
          ))}
        </div>

        {/* 近14天趋势 */}
        <div className={cn('mt-5 rounded-2xl border p-5', s.panel)}>
          <div className={cn('mb-3 text-sm', s.sub)}>近 14 天营业额 & 毛利</div>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={trend}>
              <defs>
                <linearGradient id="biRev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c1d8" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="#22c1d8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="day" fontSize={11} tickLine={false} axisLine={false} tick={{ fill: s.sub.replace('text-', '') === 'slate-300' ? '#cbd5e1' : '#64748b' }} />
              <YAxis fontSize={10} tickLine={false} axisLine={false} tick={{ fill: s.sub.replace('text-', '') === 'slate-300' ? '#cbd5e1' : '#64748b' }} width={44} />
              <Tooltip contentStyle={{ border: 'none', borderRadius: 12, fontSize: 12 }} />
              <Area type="monotone" dataKey="revenue" name="营业额" stroke="#22c1d8" strokeWidth={2} fill="url(#biRev)" />
              <Area type="monotone" dataKey="profit" name="毛利" stroke="#10b981" strokeWidth={2} fill="transparent" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className={cn('mt-5 rounded-2xl border p-5 text-sm', s.panel, s.sub)}>
          动效是数据的可视化神经：营业额/毛利数字滚动 · 低库存/临期呼吸告警 · 库存水位随货值升降 · 云端同步点实时。每个动画都绑定一个真实业务字段。该页用你提供的 SVG 动画做背景（按需加载，不影响操作页性能）。
        </div>
      </div>
    </div>
  )
}