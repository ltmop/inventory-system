import type { PaymentMethod, Transaction } from '@/types'

export interface TodayPaymentSplit {
  /** 按收款方式聚合的净到账（分）：出库实收记正、退货退款记负，只含有金额的项 */
  byMethod: Partial<Record<PaymentMethod, number>>
  /** 收到钱但没记方式的净额（老数据/未选方式），单位：分 */
  unrecorded: number
  /** 今日新增赊账（应付 − 实收），单位：分 */
  credit: number
}

/**
 * 今日收款方式拆分（与后端 commands.todayPaymentSplit 同一口径，日结对账用）：
 * - 出库：paid_amount 为 null 视为全额付清；实收>0 的部分按 pay_method 入账，未记方式进 unrecorded
 * - 退货：换货退旧腿、冲减欠款的退货没有现金移动，跳过；真退钱的按 pay_method 记负
 */
export function splitTodayPayments(transactions: Transaction[]): TodayPaymentSplit {
  const byMethod: Partial<Record<PaymentMethod, number>> = {}
  let unrecorded = 0
  let credit = 0
  for (const t of transactions) {
    if (t.selling_price == null) continue
    if (t.type === 'return') {
      if (t.notes === '换货退旧' || t.pay_method == null) continue
      byMethod[t.pay_method] = (byMethod[t.pay_method] ?? 0) - t.quantity * t.selling_price
      continue
    }
    if (t.type !== 'out') continue
    const due = t.quantity * t.selling_price
    const paid = t.paid_amount == null ? due : t.paid_amount // null=全额付清
    credit += due - paid
    if (paid > 0) {
      if (t.pay_method == null) unrecorded += paid
      else byMethod[t.pay_method] = (byMethod[t.pay_method] ?? 0) + paid
    }
  }
  return { byMethod, unrecorded, credit }
}
