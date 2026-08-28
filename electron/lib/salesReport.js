// 区间日结报表（与 src/lib/salesReport.ts 同一口径的纯 JS 版；主进程/手机端专用）
// 注意：打包只含 electron/**，主进程不得引用 src/**——算法修改需与 src/lib/salesReport.ts 同步
const pad = (n) => String(n).padStart(2, '0')

/** 流水的本地日期键（timestamp 是 UTC ISO，必须按本地日归类） */
export function localDayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayKey() {
  return localDayKey(new Date().toISOString())
}

function emptyDay(date) {
  return { date, qty: 0, revenue: 0, profit: 0, refundAmount: 0, byMethod: {}, unrecorded: 0, credit: 0 }
}

/** 把 [from, to]（本地日期，含两端）内的流水按天聚合：出库 − 退货（换货退旧不算） */
export function buildRangeReport(transactions, from, to) {
  const byDay = new Map()
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
      totals.byMethod[m] = (totals.byMethod[m] ?? 0) + (v ?? 0)
    }
  }
  const margin = totals.revenue > 0 ? totals.profit / totals.revenue : null
  return { days, totals: { ...totals, date: `${from} ~ ${to}`, margin } }
}
