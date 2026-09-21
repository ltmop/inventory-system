// 报表：分级库存预警 / 今日收款方式拆分 / 过期预警
import { parseExpiryDate } from './helpers.js'
// 欠款口径直接用 customers.js 那一份，绝不在这里再写一遍 —— 两套口径迟早对不上
import { listCustomers } from './customers.js'
// 补货建议用**已有的**销量驱动算法，不再自己写一套「低于预警线」的笨规则
import { computeRestockAdvice } from '../lib/restockAdvice.js'

// ---------- 分级库存预警 ----------
// 口径（全站统一）：商品总库存 < COALESCE(products.min_stock, 默认阈值) 即预警；
// min_stock 为 NULL 表示没单独设过，用默认阈值。仪表盘/库存页/手机端共用这一口径。

export const DEFAULT_MIN_STOCK = 5

/** 低库存商品列表：总库存 < 各自预警线（min_stock ?? 默认），升序，最缺的在前 */
export function lowStockProducts(db) {
  return db
    .prepare(
      `SELECT p.id, p.sku_code, p.brand, p.model, p.location, p.min_stock,
              COALESCE(s.q, 0) AS stock, COALESCE(p.min_stock, ?) AS threshold
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE COALESCE(s.q, 0) < COALESCE(p.min_stock, ?)
       ORDER BY stock ASC, p.id ASC`,
    )
    .all(DEFAULT_MIN_STOCK, DEFAULT_MIN_STOCK)
}

// ---------- 今日收款方式拆分（日结对账用） ----------

/**
 * 今日收款方式拆分（单位：分），桌面仪表盘与手机看店共用同一口径：
 * - byMethod：按流水 pay_method 聚合——出库实收记正、退货退款记负（换货退旧腿、冲减欠款的退货不算现金移动）
 * - unrecorded：收到钱但没记方式的净额（老数据/未选方式）
 * - credit：今日新增赊账（应付 − 实收）
 */
export function todayPaymentSplit(db) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const rows = db
    .prepare(
      `SELECT type, quantity, selling_price, paid_amount, pay_method, notes FROM transactions
       WHERE timestamp >= ? AND selling_price IS NOT NULL AND type IN ('out', 'return')`,
    )
    .all(start.toISOString())
  const byMethod = {}
  let unrecorded = 0
  let credit = 0
  for (const t of rows) {
    if (t.type === 'return') {
      if (t.notes === '换货退旧' || t.pay_method == null) continue
      byMethod[t.pay_method] = (byMethod[t.pay_method] ?? 0) - t.quantity * t.selling_price
      continue
    }
    const due = t.quantity * t.selling_price
    const paid = t.paid_amount == null ? due : t.paid_amount // NULL=全额付清
    credit += due - paid
    if (paid > 0) {
      if (t.pay_method == null) unrecorded += paid
      else byMethod[t.pay_method] = (byMethod[t.pay_method] ?? 0) + paid
    }
  }
  return { byMethod, unrecorded, credit }
}

// ---------- 过期预警（饵料等保质期商品） ----------

/**
 * 临期/过期预警（按批次算）：同一商品多个批次各自有到期日，分别预警。
 * 只统计批次级 expiry_date（入/收货时记录），且该批次剩余库存 > 0，按过期日升序。
 * 返回：名称/SKU/批次号/过期日/剩余天数（负=已过期）/该批次库存量/expired 标记
 * 兼容：保留商品级 id 字段，前端可按商品聚合也可按批次看明细。
 */
export function expiringProducts(db, { days = 30 } = {}) {
  const n = Math.max(parseInt(days, 10) || 30, 0)
  // 批次级（主）：每个有到期日的批次一条，剩余量 = 该批次数量
  const rows = db
    .prepare(
      `SELECT b.id AS batch_id, b.batch_no, b.expiry_date, b.quantity AS stock,
              p.id, p.sku_code, p.brand, p.model
       FROM inventory_batches b
       JOIN products p ON p.id = b.product_id
       WHERE b.expiry_date IS NOT NULL AND b.expiry_date <> '' AND b.quantity > 0`,
    )
    .all()
  // 商品级兜底（老数据）：商品有 expiry_date 但所有批次都没填到期日 → 按商品级日期预警
  const legacyRows = db
    .prepare(
      `SELECT p.id, p.sku_code, p.brand, p.model, p.expiry_date, COALESCE(s.q, 0) AS stock
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE p.expiry_date IS NOT NULL AND p.expiry_date <> '' AND COALESCE(s.q, 0) > 0
         AND NOT EXISTS (
           SELECT 1 FROM inventory_batches b
           WHERE b.product_id = p.id AND b.expiry_date IS NOT NULL AND b.expiry_date <> ''
         )`,
    )
    .all()
  const todayMid = new Date()
  todayMid.setHours(0, 0, 0, 0)
  const out = []
  for (const r of rows) {
    const exp = parseExpiryDate(r.expiry_date)
    if (!exp) continue // 无法识别的保质期写法不参与预警
    const daysLeft = Math.round((exp.getTime() - todayMid.getTime()) / 86400000)
    if (daysLeft > n) continue
    out.push({
      id: r.id,
      batch_id: r.batch_id,
      batch_no: r.batch_no,
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
      sku: r.sku_code,
      expiry_date: r.expiry_date,
      daysLeft,
      expired: daysLeft < 0,
      stock: r.stock,
      _sort: exp.getTime(),
    })
  }
  for (const r of legacyRows) {
    const exp = parseExpiryDate(r.expiry_date)
    if (!exp) continue
    const daysLeft = Math.round((exp.getTime() - todayMid.getTime()) / 86400000)
    if (daysLeft > n) continue
    out.push({
      id: r.id,
      batch_id: null,
      batch_no: null,
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
      sku: r.sku_code,
      expiry_date: r.expiry_date,
      daysLeft,
      expired: daysLeft < 0,
      stock: r.stock,
      _sort: exp.getTime(),
    })
  }
  out.sort((a, b) => a._sort - b._sort)
  return out.map(({ _sort, ...rest }) => rest)
}


// ================= 「今天该做的事」=================
// 老板 2026-09-21：「软件通知这个问题，要自动」。
//
// 这套系统以前全是「用户想起来才打开」的工具；个体户忙起来根本不会主动打开。
// 所以把账里**已经有的数据**算成几句人话，让 APP 和微信主动找他：
//   ① 该补什么货（库存 ≤ 自己的预警线，缺得最狠的在前面）
//   ② 该催谁的款（有欠款的客户，附上次来店时间）
//   ③ 哪里不对（今天比上周同一天明显偏少 / 有单没记收款方式 / 有货待盘点 / 有货临期）
//
// 🔴 全部用规则算，**不调大模型**：
//   规则算出来的结果是确定的，店主信得过；模型一旦算错一次，他就再也不看这条了。
//   钱的账上不能出现"可能"。
//
// 口径说明：
//   · 库存/预警线 → lowStockProducts（与本文件、手机端、仪表盘同一份）
//   · 欠款       → listCustomers（customers.js 的唯一口径，本文件不重写）
//   · 营业额     → 只算 out 售价×数量，退货按非「换货退旧」冲减（与报表/今日经营同口径）

/** 某一天的营业额（本地日，单位分）。dateOffset：0=今天，-7=上周同一天 */
function revenueOfDay(db, dateOffset) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM((CASE WHEN t.type='return' THEN -1 ELSE 1 END) * t.selling_price * t.quantity), 0) AS v
       FROM transactions t
       WHERE COALESCE(t.notes,'') != '换货退旧'
         AND COALESCE(t.selling_price, 0) > 0
         AND date(t.timestamp, 'localtime') = date('now', 'localtime', ?)`,
    )
    .get(dateOffset + ' days')
  return Number(row && row.v) || 0
}

/**
 * @returns {{ date:string, restock:Array, collect:Array, anomalies:Array, counts:object, headline:string }}
 */
export function dailyTodo(db) {
  // ⚠️ 实测发现（2026-09-21）：这家店 126 个商品里 121 个都低于预警线（大多数库存是 0），
  //    所以"低于预警线"这个信号本身**没有区分度** —— 只报"补 5 样"等于每天说同一句废话。
  //    所以这里同时给出**总数**，让标题说实话（"共 121 样低于预警线，最缺的 5 样是…"），
  //    老板才有判断：是先补最缺的，还是这批 0 库存本来就该停售/清理。
  // ⚠️ 2026-09-21 改：老板指出「贵的鱼竿库存少不警告，清 0 再说；卖得多的才警告」——
  //    上一版我用的是「低于预警线就提醒」，跑真实数据是「补货 121 样」，全是噪音（库里大多库存是 0 又没卖过）。
  //    正确口径是**已有的 restockAdvice**：按近 90 天真实销量算「还能卖几天」，快断才提醒；
  //    卖不动的不会进补货，而是进滞销（压着多少钱）—— 贵的鱼竿本来就该走滞销那条。
  const advice = computeRestockAdvice(
    db.prepare('SELECT * FROM products').all(),
    db.prepare('SELECT * FROM inventory_batches').all(),
    db.prepare('SELECT product_id, type, quantity, notes, timestamp FROM transactions').all(),
  )
  const pById = new Map(db.prepare('SELECT id, sku_code, brand, model, suggest_price, unit FROM products').all().map((x) => [x.id, x]))
  // 老板还说「可以按价格来区分」：贵货压的是大钱，不到快断不催（<15 天才提醒）；普通货按常规 30 天。
  const EXPENSIVE_FEN = 20000
  const DAYS_LEFT_EXPENSIVE = 15
  const restockAll = advice.restock.filter((r) => {
    const pr = pById.get(r.productId) || {}
    const expensive = Number(pr.suggest_price || 0) >= EXPENSIVE_FEN
    return r.daysOfStock < (expensive ? DAYS_LEFT_EXPENSIVE : 30)
  })
  const restockTotal = restockAll.length
  const restock = restockAll
    .slice(0, 5)
    .map((r) => {
      const pr = pById.get(r.productId) || {}
      return {
        productId: r.productId,
        name: [pr.brand, pr.model].filter(Boolean).join(' ') || pr.sku_code || '商品',
        sku: pr.sku_code || '',
        stock: r.stock,
        threshold: null,
        daysLeft: Math.floor(r.daysOfStock),
        suggestQty: r.suggestedQty,
      }
    })

  // 欠款：直接取 customers 的唯一口径，别在这重写
  let cust = []
  try { cust = listCustomers(db) } catch { cust = [] }
  const collect = cust
    .filter((c) => Number(c.outstanding) > 0)
    .sort((a, b) => Number(b.outstanding) - Number(a.outstanding))
    .slice(0, 5)
    .map((c) => ({
      customerId: c.id,
      name: c.name,
      phone: c.phone || '',
      outstanding: Number(c.outstanding),
      lastDealAt: c.last_deal_at || null,
    }))

  const anomalies = []
  // 滞销压资金（卖不动但占着钱）—— 贵的鱼竿就该出现在这里，而不是"该补货"里
  if (advice.deadStock.length && advice.totalTiedCapital >= 100000) {
    const top = advice.deadStock[0]
    const tp = pById.get(top.productId) || {}
    anomalies.push({
      kind: 'dead-stock',
      text: '有 ' + advice.deadStock.length + ' 样货卖不动、压着 ¥' + (advice.totalTiedCapital / 100).toFixed(0) + '（最多的是「' + ([tp.brand, tp.model].filter(Boolean).join(' ') || tp.sku_code || '商品') + '」）',
    })
  }
  // ① 今天 vs 上周同一天（同一星期几比才有意义）
  const todayRev = revenueOfDay(db, 0)
  const lastWeekRev = revenueOfDay(db, -7)
  if (lastWeekRev >= 10000 && todayRev < lastWeekRev * 0.5) {
    anomalies.push({
      kind: 'revenue-drop',
      text: '今天营业额 ' + (todayRev / 100).toFixed(0) + ' 元，上周同一天是 ' + (lastWeekRev / 100).toFixed(0) + ' 元，差得有点多——是下雨没人，还是有单没记？',
    })
  }
  // ② 有单没记收款方式（对账会对不上）
  try {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE type='out' AND date(timestamp,'localtime') = date('now','localtime')
           AND (pay_method IS NULL OR TRIM(pay_method) = '')`,
      )
      .get()
    if (r && r.n > 0) anomalies.push({ kind: 'no-paymethod', text: '今天有 ' + r.n + ' 笔没记收款方式，日结对账会对不上' })
  } catch { /* 老库没这列就跳过 */ }
  // ③ 有货待盘点
  try {
    const r = db.prepare("SELECT COUNT(*) AS n FROM products WHERE status = '待盘点'").get()
    if (r && r.n > 0) anomalies.push({ kind: 'pending-stocktake', text: '有 ' + r.n + " 个商品还是「待盘点」，盘一次账才准" })
  } catch { /* 忽略 */ }
  // ④ 临期（30 天内）
  try {
    const exp = expiringProducts(db, { days: 30 })
    if (exp && exp.length > 0) anomalies.push({ kind: 'expiring', text: '有 ' + exp.length + ' 样货 30 天内到期，先卖临期的' })
  } catch { /* 忽略 */ }

  const d = new Date(Date.now() + 8 * 3600000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const dateStr = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())

  // 一句话标题（微信推送和 APP 顶部条都用它）
  const bits = []
  if (restockTotal) bits.push('补货 ' + restockTotal + ' 样')
  if (collect.length) bits.push('催款 ' + collect.length + ' 位')
  if (anomalies.length) bits.push(anomalies.length + ' 处不对')
  const headline = bits.length ? ('今天该做的事：' + bits.join(' · ')) : '今天没有要处理的事，安心做生意'

  return {
    date: dateStr,
    restock,
    collect,
    anomalies,
    headline,
    counts: {
      restock: restock.length,
      restockTotal,
      collect: collect.length,
      anomalies: anomalies.length,
      pendingCollect: collect.reduce((s, c) => s + c.outstanding, 0),
    },
  }
}
