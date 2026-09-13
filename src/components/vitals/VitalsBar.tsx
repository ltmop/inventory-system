import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { TriangleAlert, Boxes } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'
import { countLowStock } from '@/lib/stockVitals'

/**
 * 首页体征条（2026-09-14 扁平化重做）。
 *
 * 原先这里有 **4 张卡**：今日成交 / 库存水位 / 库存警戒 / 云同步新鲜度。三个问题：
 *   ① 「今日成交 0 笔」与下面「今天赚了多少」的卡片数字重复；
 *   ② 「云同步新鲜度」看的是**云账号**（cloud.paired），于是中心库模式下
 *      顶栏写「已连接中心库」、这张卡却写「未连接云端」—— **同一个画面两种结论**；
 *   ③ 「库存水位（约 ¥584 万）」+ 百分比进度条 + 「低于 30% 变红」是内部指标，
 *      老板看不懂，而且 ¥100,000 当"满水位"是个拍出来的常数。
 * 现在只留老板真正会看的两件事，用大白话：**该补什么货** / **店里的货**。
 * 连接状态归顶栏（那里已经有「已连接中心库」），不再重复。
 */
export function VitalsBar() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const totalStockOf = useAppStore((s) => s.totalStockOf)

  // 低库存：**唯一判据**在 lib/stockVitals.ts（此前这里用 `<=`、顶栏用 `<`，
  // 同屏出现「顶栏 28 缺货」和「首页低库存 42」，已统一为 `<`）
  const lowCount = useMemo(() => countLowStock(products, totalStockOf), [products, totalStockOf])

  const { totalQty, totalValue } = useMemo(() => {
    let q = 0
    let v = 0
    for (const b of batches) {
      if (b.quantity > 0) {
        q += b.quantity
        v += b.quantity * b.cost_price
      }
    }
    return { totalQty: q, totalValue: v }
  }, [batches])

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {/* 该补什么货 */}
      <Link
        to="/inventory?filter=low"
        className={cn(
          'flex items-center gap-4 rounded-2xl border px-5 py-4 transition-colors',
          lowCount > 0
            ? 'border-red-200 bg-red-50 hover:bg-red-100'
            : 'border-slate-200 bg-white hover:bg-slate-50',
        )}
      >
        <div
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-xl',
            lowCount > 0 ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-400',
          )}
        >
          <TriangleAlert className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-slate-500">该补什么货</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className={cn('text-2xl font-bold tabular-nums', lowCount > 0 ? 'text-red-600' : 'text-slate-900')}>
              {lowCount}
            </span>
            <span className="text-sm text-slate-500">个快卖完了{lowCount > 0 ? '，点这里看是哪些' : ''}</span>
          </div>
        </div>
      </Link>

      {/* 店里的货 */}
      <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <Boxes className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-slate-500">店里的货</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-slate-900">
              {Math.round(totalQty).toLocaleString()}
            </span>
            <span className="text-sm text-slate-500">件</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-400">
            按进价算约 ¥{Math.round(totalValue / 10000)} 万 · 共 {products.length} 种商品
          </div>
        </div>
      </div>
    </div>
  )
}
