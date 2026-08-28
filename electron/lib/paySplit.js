// 今日收款方式拆分（与 src/lib/paySplit.ts 同一口径的纯 JS 版；主进程/手机端专用）
// 注意：打包只含 electron/**，主进程不得引用 src/**——算法修改需与 src/lib/paySplit.ts 同步
export function splitTodayPayments(transactions) {
  const byMethod = {}
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
