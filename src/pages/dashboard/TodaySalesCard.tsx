import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatPrice, formatTime } from '@/lib/formatters'
import { RollingNumber } from '@/components/RollingNumber'
import type { TodayPaymentSplit } from '@/lib/paySplit'
import { PAYMENT_METHODS } from '@/types'

/** 今日经营小结的一行（出库为正、退货为负冲减） */
export interface TodaySalesRow {
  id: number
  kind: 'sale' | 'return'
  time: string
  name: string
  sku: string
  quantity: number
  revenue: number | null
  cost: number | null
  profit: number | null
}

export interface TodaySalesSummary {
  rows: TodaySalesRow[]
  qty: number
  revenue: number
  profit: number
  margin: number | null
}

interface TodaySalesCardProps {
  summary: TodaySalesSummary
  paySplit: TodayPaymentSplit
  aiLoading: boolean
  aiText: string | null
}

/** 今日经营小结：营业额/毛利/毛利率/件数 + 收款方式拆分 + AI 打烊日报 + 出入账明细表 */
export function TodaySalesCard({ summary, paySplit, aiLoading, aiText }: TodaySalesCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">今日经营小结</CardTitle>
        <Link
          to="/outbound"
          className="text-xs font-normal text-brand-600 hover:underline"
        >
          查看全部 →
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            今天还没开单，第一单卖出去后这里会实时算出营业额和毛利
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="text-xs text-slate-500">今日营业额</div>
                <div className="text-xl font-bold text-slate-900 tabular-nums">
                  <RollingNumber value={summary.revenue} format={(v) => formatPrice(v)} />
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="text-xs text-slate-500">今日毛利</div>
                <div className="text-xl font-bold text-slate-900 tabular-nums">
                  <RollingNumber value={summary.profit} format={(v) => formatPrice(v)} />
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="text-xs text-slate-500">毛利率</div>
                <div className="text-xl font-bold text-slate-900 tabular-nums">
                  {summary.margin !== null ? `${(summary.margin * 100).toFixed(1)}%` : '-'}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="text-xs text-slate-500">售出件数</div>
                <div className="text-xl font-bold text-slate-900 tabular-nums">
                  {summary.qty}
                </div>
              </div>
            </div>
            {/* 今日到账按方式拆分：打烊对账——抽屉现金、微信余额、新增赊账一眼对上 */}
            {(PAYMENT_METHODS.some((m) => paySplit.byMethod[m]) ||
              paySplit.unrecorded !== 0 ||
              paySplit.credit !== 0) && (
              <div className="flex flex-wrap gap-2">
                {PAYMENT_METHODS.filter((m) => paySplit.byMethod[m]).map((m) => (
                  <span
                    key={m}
                    className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700 tabular-nums"
                  >
                    {m} {formatPrice(paySplit.byMethod[m]!)}
                  </span>
                ))}
                {paySplit.unrecorded !== 0 && (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600 tabular-nums">
                    未记录方式 {formatPrice(paySplit.unrecorded)}
                  </span>
                )}
                {paySplit.credit !== 0 && (
                  <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 tabular-nums">
                    新增赊账 {formatPrice(paySplit.credit)}
                  </span>
                )}
              </div>
            )}
            {(aiLoading || aiText) && (
              <div className="flex items-start gap-3 rounded-xl bg-gradient-to-r from-brand-700 to-brand-600 px-5 py-4 text-white shadow-card">
                <Sparkles className="mt-0.5 size-5 shrink-0 text-white/80" />
                <div>
                  <div className="text-xs text-white/70">AI 打烊日报 · 由 Kimi 生成</div>
                  <div className="mt-1 text-[15px] leading-relaxed">
                    {aiLoading ? 'AI 正在算今天的账…' : aiText}
                  </div>
                </div>
              </div>
            )}
            {summary.rows.length > 6 && (
              <div className="text-xs text-muted-foreground">
                共 {summary.rows.length} 条出入账记录，表格内下滑查看全部
              </div>
            )}
            <div className="max-h-80 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">时间</TableHead>
                    <TableHead>商品</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">营业额</TableHead>
                    <TableHead className="text-right">毛利</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.rows.map((r) => (
                    <TableRow key={`${r.kind}-${r.id}`} className={r.kind === 'return' ? 'bg-red-50/60' : ''}>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatTime(r.time)}
                      </TableCell>
                      <TableCell>
                        {r.kind === 'return' && (
                          <span className="mr-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">
                            退货
                          </span>
                        )}
                        <span className="mr-2">{r.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{r.sku}</span>
                      </TableCell>
                      <TableCell
                        className={`text-right ${r.kind === 'return' ? 'text-red-600' : ''}`}
                      >
                        {r.quantity}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${r.kind === 'return' ? 'text-red-600' : ''}`}
                      >
                        {r.revenue !== null ? formatPrice(r.revenue) : '-'}
                      </TableCell>
                      <TableCell
                        className={`text-right font-medium tabular-nums ${
                          r.profit !== null && r.profit < 0 ? 'text-red-600' : 'text-green-700'
                        }`}
                      >
                        {r.profit !== null ? formatPrice(r.profit) : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
