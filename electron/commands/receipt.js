// 收款登记与对账（v3.0）：个体户的微信/支付宝是个人码，系统拿不到流水，
// 所以"收款对账闭环" = 收银台自动记应收 + 老板每天手动登记实收 + 系统自动算差异。
// 口径：应收(营业额) = 实收登记(现金/微信/支付宝/其他) + 赊账未收 + 差异
// 差异≈0 说明账对上了；差异大说明有漏记/多记/对不上的钱，老板不用翻支付账单。

const METHODS = ['现金', '微信', '支付宝', '其他']

/** 登记某天某方式的实收（同一天同方式重复登记 = 覆盖） */
export function registerReceipt(db, { date, method, amount, operator }) {
  const d = String(date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('日期格式不对，应该是 YYYY-MM-DD')
  const m = String(method ?? '')
  if (!METHODS.includes(m)) throw new Error(`收款方式必须是：${METHODS.join(' / ')}`)
  const amt = Number(amount)
  if (!Number.isInteger(amt) || amt < 0) throw new Error('金额必须是大于等于 0 的整数（分）')
  db.prepare(
    `INSERT INTO payment_registers (register_date, method, amount, operator) VALUES (?, ?, ?, ?)
     ON CONFLICT(register_date, method) DO UPDATE SET amount = excluded.amount, operator = excluded.operator, created_at = CURRENT_TIMESTAMP`,
  ).run(d, m, amt, String(operator ?? '').trim() || null)
  return { ok: true, date: d, method: m, amount: amt }
}

/** 查某天各方式的实收登记 */
export function listReceipts(db, { date }) {
  const d = String(date ?? '').trim()
  const rows = db
    .prepare('SELECT register_date, method, amount, operator, created_at FROM payment_registers WHERE register_date = ? ORDER BY method')
    .all(d)
  const byMethod = {}
  for (const r of rows) byMethod[r.method] = r.amount
  return { date: d, rows, byMethod }
}

/** 某天对账：应收 vs 实收登记 vs 赊账未收 vs 差异 */
export function reconcileReceipt(db, { date }) {
  const d = String(date ?? '').trim()
  // 应收（营业额）= 当天全部 out 流水售价合计
  const out = db
    .prepare(`SELECT selling_price, quantity, customer_id, paid_amount FROM transactions
              WHERE type = 'out' AND date(timestamp, 'localtime') = ?`)
    .all(d)
  const revenue = out.reduce((s, t) => s + (t.selling_price ?? 0) * t.quantity, 0)

  // 赊账未收 = 有客户的流水里 (总额 - 实收)；paid_amount NULL 视为已全额付清
  const credit = out.reduce((s, t) => {
    if (t.customer_id == null) return s
    const total = (t.selling_price ?? 0) * t.quantity
    const paid = t.paid_amount ?? total
    return s + Math.max(0, total - paid)
  }, 0)

  // 实收登记
  const regs = db.prepare('SELECT method, amount FROM payment_registers WHERE register_date = ?').all(d)
  const byMethod = { 现金: 0, 微信: 0, 支付宝: 0, 其他: 0 }
  let totalReceived = 0
  for (const r of regs) {
    byMethod[r.method] = (byMethod[r.method] ?? 0) + r.amount
    totalReceived += r.amount
  }

  return {
    date: d,
    revenue,
    byMethod,
    totalReceived,
    credit,
    difference: revenue - totalReceived - credit,
    outCount: out.length,
  }
}
