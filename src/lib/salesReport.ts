import type { PaymentMethod, Transaction } from '@/types'

/** 一天的经营数字（金额单位都是分） */
export interface DayReport {
  date: string // 本地日期 YYYY-MM-DD
  qty: number // 净卖出件数（出库 − 退货）
  revenue: number // 营业额（出库应收 − 退货退款，换货退旧不算）
  profit: number // 毛利（卖价 − 批次成本，退货按负冲减）
  refundAmount: number // 退货退款金额（信息项，含在 revenue 冲减里）
  byMethod: Partial<Record<PaymentMethod, number>> // 各收款方式净到账
  unrecorded: number // 收到钱但没记方式（老数据）
  credit: number // 新增赊账（应付 − 实收）
}

export interface RangeReport {
  days: DayReport[] // 升序，只有成交的日子会出现
  totals: DayReport & { margin: number | null } // 区间合计 + 综合毛利率
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 流水的本地日期键（timestamp 是 UTC ISO，必须按本地日归类，否则凌晨单会算到昨天） */
export function localDayKey(ts: string): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayKey(): string {
  return localDayKey(new Date().toISOString())
}

function emptyDay(date: string): DayReport {
  return { date, qty: 0, revenue: 0, profit: 0, refundAmount: 0, byMethod: {}, unrecorded: 0, credit: 0 }
}

/**
 * 区间日结报表：把 [from, to]（本地日期 YYYY-MM-DD，含两端）内的流水按天聚合。
 * 口径与仪表盘今日销售 + todayPaymentSplit 完全一致：
 * - 营业额/毛利：出库 − 退货（换货退旧腿不算销售）
 * - 到账拆分：paid_amount 为 null 视为全额付清；退货真退钱按方式记负，冲减欠款的跳过
 */
export function buildRangeReport(transactions: Transaction[], from: string, to: string): RangeReport {
  const byDay = new Map<string, DayReport>()
  for (const t of transactions) {
    if (t.type !== 'out' && t.type !== 'return') continue
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const day = localDayKey(t.timestamp)
    if (day < from || day > to) continue
    const r = byDay.get(day) ?? emptyDay(day)
    const sign = t.type === 'return' ? -1 : 1
    r.qty += t.quantity * sign
    if (t.selling_price != null) {
      const amount = t.quantity * t.selling_price * sign
      r.revenue += amount
      if (t.type === 'return') r.refundAmount += t.quantity * t.selling_price
      if (t.unit_price != null) {
        r.profit += amount - t.quantity * t.unit_price * sign
      }
      // 到账拆分（同 splitTodayPayments）
      if (t.type === 'out') {
        const paid = t.paid_amount == null ? amount : t.paid_amount
        r.credit += amount - paid
        if (paid > 0) {
          if (t.pay_method == null) r.unrecorded += paid
          else r.byMethod[t.pay_method] = (r.byMethod[t.pay_method] ?? 0) + paid
        }
      } else if (t.pay_method != null) {
        r.byMethod[t.pay_method] = (r.byMethod[t.pay_method] ?? 0) - t.quantity * t.selling_price
      }
    }
    byDay.set(day, r)
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
  const totals = emptyDay(from)
  for (const d of days) {
    totals.qty += d.qty
    totals.revenue += d.revenue
    totals.profit += d.profit
    totals.refundAmount += d.refundAmount
    totals.unrecorded += d.unrecorded
    totals.credit += d.credit
    for (const [m, v] of Object.entries(d.byMethod)) {
      const k = m as PaymentMethod
      totals.byMethod[k] = (totals.byMethod[k] ?? 0) + (v ?? 0)
    }
  }
  const margin = totals.revenue > 0 ? totals.profit / totals.revenue : null
  return { days, totals: { ...totals, date: `${from} ~ ${to}`, margin } }
}

/** 常用区间预设（返回 [from, to] 本地日期键） */
export function rangePreset(key: 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth'): [string, string] {
  const now = new Date()
  const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  switch (key) {
    case 'today':
      return [keyOf(now), keyOf(now)]
    case 'yesterday': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      return [keyOf(d), keyOf(d)]
    }
    case 'last7': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
      return [keyOf(d), keyOf(now)]
    }
    case 'last30': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
      return [keyOf(d), keyOf(now)]
    }
    case 'thisMonth':
      return [keyOf(new Date(now.getFullYear(), now.getMonth(), 1)), keyOf(now)]
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return [keyOf(first), keyOf(last)]
    }
  }
}
