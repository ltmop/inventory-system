// 客户与赊账（客户余额模型）
//
// 欠款口径（全站统一，listCustomers / recordPayment / customerStatement 共用）：
//   赊销净额 = Σ out 流水(quantity*selling_price - COALESCE(paid_amount, quantity*selling_price))
//              - Σ return 流水(quantity*selling_price)
//              + Σ exchange 流水(paid_amount)
//   · out 流水 paid_amount 为 NULL = 全额付清，贡献 0（赊账前的老数据、散客单都是 NULL，天然不纳入）
//   · selling_price 为 NULL 的老流水不纳入（没有售价就谈不上赊销）
//   · return 流水只要带了 customer_id 且记了退款金额，就按负数冲减（见 createReturn 注释）
//   · exchange 流水=换货退差价（见 createExchange）：paid_amount 为负退款额，记了 customer_id
//     的就是冲减欠款（负贡献），退现金的记 customer_id=NULL 天然不纳入
//   当前欠款 outstanding = 赊销净额 - 还款累计；允许为负，负值即预收（老板多收/先收的钱）
import {
  assertPositiveInt,
  assertPriceLevel,
  PAYMENT_METHODS,
  inTransaction,
  now,
  logAudit,
  outstandingOf,
} from './helpers.js'

/** 新建客户：姓名去空白后非空；同名客户拒绝建档（老板容易重复建）；price_level 可空（NULL=零售默认） */
export function createCustomer(db, { name, phone, notes, price_level, preferences }) {
  const n = name?.trim()
  if (!n) throw new Error('客户姓名不能为空')
  assertPriceLevel(price_level)
  return inTransaction(db, () => {
    const dup = db.prepare('SELECT id FROM customers WHERE name = ?').get(n)
    if (dup) throw new Error(`已存在同名客户「${n}」，请勿重复建档`)
    const info = db
      .prepare('INSERT INTO customers (name, phone, notes, price_level, preferences, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(n, phone?.trim() || null, notes?.trim() || null, price_level ?? null, preferences?.trim() || null, now())
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid)
    logAudit(db, '新建客户', n, { phone: row.phone, price_level: row.price_level }, null)
    return row
  })
}

/** 修改客户资料：只传要改的字段；改名时同样做同名查重（排除自己）；price_level 传 null 清除（回零售默认） */
export function updateCustomer(db, { id, name, phone, notes, price_level, preferences }) {
  assertPriceLevel(price_level)
  return inTransaction(db, () => {
    const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(id)
    if (!cur) throw new Error('客户不存在')
    const n = name !== undefined ? name.trim() : cur.name
    if (!n) throw new Error('客户姓名不能为空')
    if (n !== cur.name) {
      const dup = db.prepare('SELECT id FROM customers WHERE name = ? AND id != ?').get(n, id)
      if (dup) throw new Error(`已存在同名客户「${n}」`)
    }
    db.prepare('UPDATE customers SET name = ?, phone = ?, notes = ?, price_level = ?, preferences = ? WHERE id = ?').run(
      n,
      phone !== undefined ? phone?.trim() || null : cur.phone,
      notes !== undefined ? notes?.trim() || null : cur.notes,
      price_level !== undefined ? price_level ?? null : cur.price_level,
      preferences !== undefined ? preferences?.trim() || null : cur.preferences,
      id,
    )
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id)
  })
}

/** 删除客户：有流水或还款记录的拒绝删除（删了赊账历史就对不上账了） */
export function deleteCustomer(db, { id }) {
  return inTransaction(db, () => {
    const cur = db.prepare('SELECT id FROM customers WHERE id = ?').get(id)
    if (!cur) return { ok: false, reason: '客户不存在' }
    const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE customer_id = ?').get(id).n
    const payCount = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE customer_id = ?').get(id).n
    if (txCount > 0 || payCount > 0) {
      return { ok: false, reason: `该客户有 ${txCount} 条流水、${payCount} 条还款记录，不能删除（删除会弄丢赊账历史）` }
    }
    db.prepare('DELETE FROM customers WHERE id = ?').run(id)
    return { ok: true }
  })
}

/**
 * 客户列表：每个客户带 outstanding（当前欠款，分；负=预收）、total_credit（赊销净额）、
 * total_paid_back（累计还款）、last_deal_at（最近交易/还款时间）
 */
export function listCustomers(db) {
  const creditRows = db
    .prepare(
      `SELECT customer_id,
         SUM(CASE
           WHEN type = 'out' AND selling_price IS NOT NULL
             THEN quantity * selling_price - COALESCE(paid_amount, quantity * selling_price)
           WHEN type = 'return' AND selling_price IS NOT NULL
             THEN -quantity * selling_price
           WHEN type = 'exchange' AND paid_amount IS NOT NULL
             THEN paid_amount
           ELSE 0 END) AS net_credit,
         MAX(timestamp) AS last_tx_at
       FROM transactions WHERE customer_id IS NOT NULL GROUP BY customer_id`,
    )
    .all()
  const payRows = db
    .prepare(
      `SELECT customer_id, SUM(amount) AS total_paid_back, MAX(created_at) AS last_pay_at
       FROM payments GROUP BY customer_id`,
    )
    .all()
  const creditMap = new Map(creditRows.map((r) => [r.customer_id, r]))
  const payMap = new Map(payRows.map((r) => [r.customer_id, r]))
  return db
    .prepare('SELECT * FROM customers ORDER BY id')
    .all()
    .map((c) => {
      const cr = creditMap.get(c.id)
      const pb = payMap.get(c.id)
      const total_credit = cr?.net_credit ?? 0
      const total_paid_back = pb?.total_paid_back ?? 0
      const lasts = [cr?.last_tx_at, pb?.last_pay_at].filter(Boolean)
      return {
        ...c,
        total_credit,
        total_paid_back,
        outstanding: total_credit - total_paid_back,
        last_deal_at: lasts.length > 0 ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
      }
    })
}

/**
 * 还款登记：金额必须正整数（分）；方式限 现金/微信/支付宝/其他，默认现金。
 * 允许还款超过当前欠款（老板可能多收/预收），返回值里用 overpaid/prepaid 标注，
 * outstanding 为还款后的欠款（负值=预收）。
 */
export function recordPayment(db, { customerId, amount, method, notes }) {
  assertPositiveInt(amount, '还款金额')
  const m = method ?? '现金'
  if (!PAYMENT_METHODS.includes(m)) {
    throw new Error(`还款方式必须是：${PAYMENT_METHODS.join(' / ')}`)
  }
  return inTransaction(db, () => {
    const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
    if (!cust) throw new Error('客户不存在')
    const before = outstandingOf(db, customerId)
    const info = db
      .prepare('INSERT INTO payments (customer_id, amount, method, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(customerId, amount, m, notes?.trim() || null, now())
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid)
    const outstanding = before - amount
    const custName = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId).name
    logAudit(db, '还账', `${custName} 还 ${(amount / 100).toFixed(2)} 元`,
      { amount, method: m, before, outstanding }, null)
    return {
      ok: true,
      payment,
      outstanding,
      overpaid: amount > Math.max(before, 0), // 本次还款超过了之前欠的钱
      prepaid: outstanding < 0, // 还完后变成预收
    }
  })
}

/**
 * 客户对账单：
 * - sales：该客户全部带售价的 out/return 流水明细（时间/商品/数量/应付/已付/欠），
 *   out 行 欠=应付-实收（全额付清的为 0），return 行 欠=-退款额（冲减），按时间倒序
 * - payments：还款记录（时间/金额/方式/备注），按时间倒序
 * - 汇总字段与 listCustomers 同口径
 */
export function customerStatement(db, { customerId }) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId)
  if (!customer) throw new Error('客户不存在')
  const sales = db
    .prepare(
      `SELECT t.id, t.timestamp, t.type, t.product_id, t.quantity, t.selling_price, t.paid_amount,
              p.brand, p.model, p.sku_code
       FROM transactions t JOIN products p ON p.id = t.product_id
       WHERE t.customer_id = ? AND t.type IN ('out', 'return') AND t.selling_price IS NOT NULL
       ORDER BY t.timestamp DESC, t.id DESC`,
    )
    .all(customerId)
    .map((r) => {
      const due = r.quantity * r.selling_price
      const paid = r.type === 'out' ? (r.paid_amount ?? due) : 0
      return {
        id: r.id,
        timestamp: r.timestamp,
        type: r.type,
        product_id: r.product_id,
        product_name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
        quantity: r.quantity,
        due,
        paid,
        owed: r.type === 'out' ? due - paid : -due,
      }
    })
  const payments = db
    .prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC, id DESC')
    .all(customerId)
  const summary = listCustomers(db).find((c) => c.id === customerId)
  return {
    customer,
    sales,
    payments,
    total_credit: summary.total_credit,
    total_paid_back: summary.total_paid_back,
    outstanding: summary.outstanding,
  }
}
