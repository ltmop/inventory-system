import { useMemo } from 'react'
import { HeartPulse, Droplets, TriangleAlert, Cloud } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { isToday } from '@/lib/formatters'
import { cn } from '@/lib/utils'

/** 经营体征条：销售心跳 / 库存水位 / 警戒呼吸 / 云同步新鲜度 —— 每个动画都绑定真实业务字段。 */
export function VitalsBar() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const transactions = useAppStore((s) => s.transactions)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const cloud = useAppStore((s) => s.cloud)

  // 今日成交（销售心跳）
  const todayOutCount = useMemo(
    () => transactions.filter((t) => t.type === 'out' && isToday(t.timestamp)).length,
    [transactions],
  )
  // 库存水位（货值 + 总件数）
  const { totalValue, totalStock } = useMemo(() => {
    let v = 0, q = 0
    for (const b of batches) { if (b.quantity > 0) { q += b.quantity; v += b.quantity * b.cost_price } }
    return { totalValue: v, totalStock: q }
  }, [batches])
  // 水位百分比：以 ¥100,000 为满水位，低于 30% 变红
  const water = Math.min(100, Math.round((totalValue / 100000) * 100))
  const waterLow = water < 30
  // 警戒
  const lowCount = products.filter((p) => totalStockOf(p.id) <= (p.min_stock ?? 5)).length
  const expiringCount = useMemo(
    () => products.filter((p) => (p as any).expiry_date && new Date((p as any).expiry_date) <= new Date(Date.now() + 30 * 86400000)).length,
    [products],
  )
  // 同步新鲜度
  const sync = useMemo(() => {
    if (cloud.syncing) return { cls: 'text-emerald-500', dot: 'bg-emerald-500', label: '正在同步…' }
    if (cloud.error) return { cls: 'text-red-500', dot: 'bg-red-500', label: '同步异常' }
    if (!cloud.paired) return { cls: 'text-amber-500', dot: 'bg-amber-500', label: '未连接云端' }
    if (cloud.lastSyncAt) {
      const mins = Math.round((Date.now() - new Date(cloud.lastSyncAt).getTime()) / 60000)
      const t = mins < 1 ? '刚刚' : mins < 60 ? mins + ' 分钟前' : mins < 1440 ? Math.round(mins / 60) + ' 小时前' : Math.round(mins / 1440) + ' 天前'
      const cls = mins < 5 ? 'text-emerald-500' : mins < 60 ? 'text-amber-500' : 'text-red-500'
      const dot = mins < 5 ? 'bg-emerald-500' : mins < 60 ? 'bg-amber-500' : 'bg-red-500'
      return { cls, dot, label: '已同步 ' + t }
    }
    return { cls: 'text-amber-500', dot: 'bg-amber-500', label: '云端已连接' }
  }, [cloud])

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {/* 销售心跳 */}
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
        <HeartPulse className={cn('size-5', todayOutCount > 0 ? 'text-red-500' : 'text-slate-400')} />
        <div>
          <div className="flex items-center gap-1">
            <span className="relative flex size-2.5">
              {todayOutCount > 0 && <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />}
              <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
            </span>
            <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{todayOutCount}</span>
          </div>
          <div className="text-xs text-slate-500">今日成交 · 来一单快一拍</div>
        </div>
      </div>

      {/* 库存水位 */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Droplets className={cn('size-4', waterLow ? 'text-red-500' : 'text-lake-600')} />
          库存水位（约 ¥{Math.round(totalValue / 10000)} 万）
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
            <div
              className={cn('h-full rounded-full transition-all duration-1000', waterLow ? 'bg-red-500' : 'bg-lake-500')}
              style={{ width: water + '%' }}
            />
          </div>
          <span className={cn('text-sm font-bold tabular-nums', waterLow ? 'text-red-500' : 'text-slate-800 dark:text-slate-100')}>{water}%</span>
        </div>
        <div className="mt-1 text-xs text-slate-400">{totalStock.toLocaleString()} 件 · 低于 30% 变红</div>
      </div>

      {/* 警戒呼吸 */}
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <TriangleAlert className="size-4 text-amber-500" /> 库存警戒
        </div>
        <div className="mt-2 flex gap-2">
          <span className={cn('flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', lowCount > 0 ? 'animate-pulse bg-red-50 text-red-600 dark:bg-red-500/20 dark:text-red-400' : 'bg-slate-50 text-slate-400 dark:bg-white/5')}>
            <span className="size-1.5 rounded-full bg-current" /> 低库存 {lowCount}
          </span>
          <span className={cn('flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', expiringCount > 0 ? 'animate-pulse bg-amber-50 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400' : 'bg-slate-50 text-slate-400 dark:bg-white/5')}>
            <span className="size-1.5 rounded-full bg-current" /> 临期 {expiringCount}
          </span>
        </div>
      </div>

      {/* 云同步新鲜度 */}
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
        <Cloud className={cn('size-5', sync.cls)} />
        <div>
          <div className="flex items-center gap-1.5">
            <span className={cn('size-2.5 animate-pulse rounded-full', sync.dot)} />
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{sync.label}</span>
          </div>
          <div className="text-xs text-slate-500">多台电脑共享 · 数据实时</div>
        </div>
      </div>
    </div>
  )
}
