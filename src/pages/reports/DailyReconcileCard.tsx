import { useMemo, useState } from 'react'
import { CalendarDays, Download } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { buildRangeReport, rangePreset, type DayReport } from '@/lib/salesReport'
import { csvCell, formatPrice } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { PAYMENT_METHODS, type Transaction } from '@/types'

type PresetKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom'

const PRESETS: { key: Exclude<PresetKey, 'custom'>; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'last7', label: '近 7 天' },
  { key: 'last30', label: '近 30 天' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
]

/** 0 显示成 '-'，表更干净 */
function money(v: number): string {
  return v === 0 ? '-' : formatPrice(v)
}

/** 日结对账卡：按区间看每天的营业额/毛利/收款方式/赊账，钱从哪来到哪去一眼对清 */
export function DailyReconcileCard({ transactions }: { transactions: Transaction[] }) {
  const [preset, setPreset] = useState<PresetKey>('last7')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const [from, to] = useMemo<[string, string]>(() => {
    if (preset === 'custom') {
      if (customFrom && customTo && customFrom <= customTo) return [customFrom, customTo]
      if (customFrom && customTo) return [customTo, customFrom] // 选反了自动交换
      return rangePreset('today')
    }
    return rangePreset(preset)
  }, [preset, customFrom, customTo])

  const report = useMemo(() => buildRangeReport(transactions, from, to), [transactions, from, to])
  const t = report.totals
  const received =
    Object.values(t.byMethod).reduce((s, v) => s + (v ?? 0), 0) + t.unrecorded

  // 表格最新一天在最上
  const daysDesc = useMemo(() => [...report.days].reverse(), [report.days])

  function exportCSV() {
    const yuan = (cents: number) => (cents / 100).toFixed(2)
    const header = [
      '日期', '卖出件数', '营业额(元)', '毛利(元)',
      ...PAYMENT_METHODS.map((m) => `${m}(元)`),
      '未记录方式(元)', '新增赊账(元)', '退货退款(元)',
    ]
    const rowOf = (d: DayReport) =>
      [
        d.date, d.qty, yuan(d.revenue), yuan(d.profit),
        ...PAYMENT_METHODS.map((m) => yuan(d.byMethod[m] ?? 0)),
        yuan(d.unrecorded), yuan(d.credit), yuan(d.refundAmount),
      ]
        .map(csvCell)
        .join(',')
    const lines = [
      `日结明细 ${from} ~ ${to}`,
      header.join(','),
      ...report.days.map(rowOf),
      rowOf({ ...t, date: '合计' }),
    ].join('\n')
    const blob = new Blob(['﻿' + lines], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `日结明细_${from}_${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          <CalendarDays className="mr-2 inline-block size-4 text-brand-600" />
          日结对账（每天的钱去哪了）
        </CardTitle>
        <button
          onClick={exportCSV}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
        >
          <Download className="size-3.5" />
          导出这段明细
        </button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 区间选择：预设一排 + 自定义起止 */}
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={cn(
                'h-9 cursor-pointer rounded-lg border px-3.5 text-sm font-medium transition-colors',
                preset === p.key
                  ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100',
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setPreset('custom')}
            className={cn(
              'h-9 cursor-pointer rounded-lg border px-3.5 text-sm font-medium transition-colors',
              preset === 'custom'
                ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100',
            )}
          >
            自定义
          </button>
          {preset === 'custom' && (
            <span className="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 rounded-lg border border-slate-200 px-2 text-sm"
              />
              到
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 rounded-lg border border-slate-200 px-2 text-sm"
              />
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            当前：{from} ~ {to}
          </span>
        </div>

        {/* 区间合计条 */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {[
            { label: '营业额', value: formatPrice(t.revenue), cls: 'text-slate-800' },
            {
              label: `毛利${t.margin !== null ? `（${(t.margin * 100).toFixed(1)}%）` : ''}`,
              value: formatPrice(t.profit),
              cls: t.profit >= 0 ? 'text-green-700' : 'text-red-600',
            },
            { label: '实际收到', value: formatPrice(received), cls: 'text-emerald-700' },
            { label: '新增赊账', value: t.credit === 0 ? '-' : formatPrice(t.credit), cls: 'text-red-600' },
            { label: '退货退款', value: t.refundAmount === 0 ? '-' : formatPrice(t.refundAmount), cls: 'text-amber-700' },
            { label: '卖出件数', value: `${t.qty} 件`, cls: 'text-slate-800' },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
              <div className="text-xs text-slate-500">{s.label}</div>
              <div className={cn('mt-0.5 text-lg font-bold tabular-nums', s.cls)}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* 收款方式拆分：与仪表盘今日口径一致 */}
        <div className="flex flex-wrap gap-2 text-sm">
          {PAYMENT_METHODS.map((m) => (
            <span key={m} className="rounded-full bg-emerald-50 px-3 py-1 tabular-nums text-emerald-700">
              {m} {money(t.byMethod[m] ?? 0)}
            </span>
          ))}
          <span className="rounded-full bg-slate-100 px-3 py-1 tabular-nums text-slate-600">
            未记方式 {money(t.unrecorded)}
          </span>
        </div>

        {/* 按天明细（可滚动，最新在上） */}
        {daysDesc.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            这段时间没有成交记录
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 bg-white">
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead className="text-right">件数</TableHead>
                  <TableHead className="text-right">营业额</TableHead>
                  <TableHead className="text-right">毛利</TableHead>
                  {PAYMENT_METHODS.map((m) => (
                    <TableHead key={m} className="text-right">{m}</TableHead>
                  ))}
                  <TableHead className="text-right">未记方式</TableHead>
                  <TableHead className="text-right">赊账</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {daysDesc.map((d) => (
                  <TableRow key={d.date}>
                    <TableCell className="font-medium tabular-nums">{d.date}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.qty}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPrice(d.revenue)}</TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        d.profit >= 0 ? 'text-green-700' : 'text-red-600',
                      )}
                    >
                      {formatPrice(d.profit)}
                    </TableCell>
                    {PAYMENT_METHODS.map((m) => (
                      <TableCell key={m} className="text-right tabular-nums text-emerald-700">
                        {money(d.byMethod[m] ?? 0)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums text-slate-500">
                      {money(d.unrecorded)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-red-600">
                      {money(d.credit)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
