import { Link } from 'react-router-dom'
import { Lightbulb, PackagePlus, Snail } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatPrice, productName } from '@/lib/formatters'
import type { RestockAdvice } from '@/lib/restockAdvice'
import {
  ADVICE_MIN_LISTED_DAYS,
  ADVICE_RESTOCK_DAYS_LEFT,
  ADVICE_TARGET_DAYS,
  ADVICE_WINDOW_DAYS,
} from '@/lib/restockAdvice'
import type { Product } from '@/types'

// 经营建议卡：该补货了 / 该清仓了。纯规则算出（不依赖 AI），每个数字老板都能复核

interface AdviceCardProps {
  advice: RestockAdvice
  products: Product[]
}

export function AdviceCard({ advice, products }: AdviceCardProps) {
  const nameOf = (id: number) => {
    const p = products.find((x) => x.id === id)
    return p ? productName(p) : `#${id}`
  }
  const restockTop = advice.restock.slice(0, 6)
  const deadTop = advice.deadStock.slice(0, 6)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-blue-500" />
          经营建议
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* 该补货了 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <PackagePlus className="size-4 text-brand-600" />
                该补货了
              </div>
              {advice.restock.length > 0 && (
                <span className="text-xs text-slate-500">
                  合计建议补 <span className="font-bold text-brand-700">{advice.totalSuggestedQty}</span> 件
                </span>
              )}
            </div>
            {restockTop.length === 0 ? (
              <div className="rounded-lg bg-slate-50 px-4 py-5 text-center text-sm text-muted-foreground">
                库存健康，暂时没有要补的货
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {restockTop.map((r) => (
                  <li key={r.productId}>
                    <Link to="/inventory" className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800">{nameOf(r.productId)}</div>
                        <div className="text-xs text-muted-foreground">
                          {ADVICE_WINDOW_DAYS} 天卖 {r.sales90} 件 · 库存 {r.stock} 件
                          {r.stock === 0 ? '（已断货）' : `（还能卖 ${Math.floor(r.daysOfStock)} 天）`}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700">
                        补 {r.suggestedQty} 件
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {advice.restock.length > restockTop.length && (
              <div className="mt-1 text-xs text-muted-foreground">
                还有 {advice.restock.length - restockTop.length} 个商品建议补货，去库存页看全部 →
              </div>
            )}
          </div>

          {/* 该清仓了 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <Snail className="size-4 text-blue-600" />
                该清仓了
              </div>
              {advice.deadStock.length > 0 && (
                <span className="text-xs text-slate-500">
                  合计压着 <span className="font-bold text-amber-700">{formatPrice(advice.totalTiedCapital)}</span>
                </span>
              )}
            </div>
            {deadTop.length === 0 ? (
              <div className="rounded-lg bg-slate-50 px-4 py-5 text-center text-sm text-muted-foreground">
                没有滞销压货，货都在走动
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {deadTop.map((d) => (
                  <li key={d.productId}>
                    <Link to="/inventory" className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800">{nameOf(d.productId)}</div>
                        <div className="text-xs text-muted-foreground">
                          上架 {d.daysListed} 天 · {ADVICE_WINDOW_DAYS} 天零销量 · 库存 {d.stock} 件
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700">
                        压着 {formatPrice(d.tiedCapital)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {advice.deadStock.length > deadTop.length && (
              <div className="mt-1 text-xs text-muted-foreground">
                还有 {advice.deadStock.length - deadTop.length} 个商品压着钱，去库存页看全部 →
              </div>
            )}
          </div>
        </div>

        {/* 规则口径：老板可以复核每个数字怎么来的 */}
        <div className="mt-4 border-t pt-3 text-xs text-slate-400">
          规则：按最近 {ADVICE_WINDOW_DAYS} 天销量算消耗速度，库存撑不到 {ADVICE_RESTOCK_DAYS_LEFT} 天建议补到{' '}
          {ADVICE_TARGET_DAYS} 天用量；上架满 {ADVICE_MIN_LISTED_DAYS} 天且零销量的算滞销，压资金额 = 库存 × 最近进价
        </div>
      </CardContent>
    </Card>
  )
}
