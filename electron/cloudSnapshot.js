// 经营快照 JSON 构建：只读查询本地 SQLite 库
// 纯函数，可单测；复用现有 salesReport / paySplit 口径
// 铁律：只读，不许 BEGIN/WAL checkpoint/任何写操作
// 隐私：快照不含客户姓名电话、barcode、成本价明细

import { buildRangeReport, todayKey } from './lib/salesReport.js'
import { splitTodayPayments } from './lib/paySplit.js'
import { computeRestockAdvice } from './lib/restockAdvice.js'

/** 构建单次快照（t+ { from, to } 从 rangePreset 取口径） */
export function buildSnapshot(db, storeName = '我的门店') {
  const now = new Date()
  const today = todayKey()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  // 1. 加载本日/本月交易（走 salesReport 同口径）
  const allTx = loadTransactions(db, today, monthKey)
  const todayReport = buildRangeReport(allTx, today, today)
  const monthReport = buildRangeReport(allTx, monthKey + '-01', today)

  const todayTotals = todayReport.totals
  const monthTotals = monthReport.totals

  // 2. 收款方式（走 paySplit 同口径）
  const todayTx = allTx.filter(tx => tx.timestamp?.slice(0, 10) === today)
  const paySplit = splitTodayPayments(todayTx)

  // 3. 库存总览（直接 SQL）
  const inventory = queryInventory(db)

  // 4. 低库存（走 restockAdvice）
  const products = db.prepare('SELECT * FROM products').all()
  const batches = db.prepare('SELECT * FROM inventory_batches WHERE quantity > 0').all()
  const restockItems = computeRestockAdvice(products, batches, allTx, now).restock || []
  const lowStock = restockItems.slice(0, 5).map(r => {
    const p = products.find(x => x.id === r.productId)
    return { name: productDisplayName(p), qty: r.stock, minStock: 5 }
  })

  // 5. 滞销品
  const deadStock = computeRestockAdvice(products, batches, allTx, now).deadStock || []

  // 6. 应收
  const receivable = queryReceivable(db)

  // 7. 最近流水（最多 20 条）
  const recent = loadRecent(db, today)

  // 8. 本日入库
  const todayInbound = allTx.filter(tx => tx.type === 'in' && tx.timestamp?.slice(0, 10) === today).length

  return {
    v: 1,
    storeName,
    at: now.toISOString(),
    today: {
      date: today,
      orderCount: todayReport.days[0]?.qty || 0,
      revenue: todayTotals.revenue,
      grossMargin: todayTotals.profit,
      paySplit,
      inboundCount: todayInbound,
    },
    month: {
      month: monthKey,
      revenue: monthTotals.revenue,
      grossMargin: monthTotals.profit,
    },
    inventory: {
      skuCount: products.length,
      totalQty: inventory.totalQty,
      totalCostValue: inventory.totalCostValue,
      lowStock,
      stagnantCount: deadStock.length,
    },
    receivable: {
      customerCount: receivable.customerCount,
      totalOwed: receivable.totalOwed,
    },
    recent,
  }
}

// ---------- 工具函数 ----------

function productDisplayName(p) {
  if (!p) return '-'
  return [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code || '-'
}

function loadTransactions(db, today, monthKey) {
  const monthStart = monthKey + '-01'
  return db.prepare(
    `SELECT * FROM transactions WHERE date(timestamp) >= date(?, 'start of month') ORDER BY timestamp DESC`
  ).all(monthStart)
}

function queryInventory(db) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(quantity),0) AS totalQty,
            COALESCE(SUM(quantity * cost_price),0) AS totalCostValue
     FROM inventory_batches WHERE quantity > 0`
  ).get()
  return { totalQty: row.totalQty || 0, totalCostValue: row.totalCostValue || 0 }
}

function queryReceivable(db) {
  const rows = db.prepare(
    `SELECT c.id,
            COALESCE((SELECT SUM(paid_amount) FROM transactions WHERE customer_id = c.id), 0) AS paid,
            COALESCE((SELECT SUM(selling_price * quantity) FROM transactions WHERE customer_id = c.id AND paid_amount IS NOT NULL), 0) AS owed
     FROM customers c`
  ).all()
  let totalOwed = 0
  let count = 0
  for (const r of rows) {
    const outstanding = r.owed - r.paid
    if (outstanding > 0) { totalOwed += outstanding; count++ }
  }
  return { customerCount: count, totalOwed }
}

function loadRecent(db, today) {
  const txRows = db.prepare(
    `SELECT t.type, t.quantity, t.selling_price, t.timestamp, p.brand, p.model, p.sku_code
     FROM transactions t JOIN products p ON p.id = t.product_id
     WHERE date(t.timestamp) = date(?)
     ORDER BY t.timestamp DESC LIMIT 20`
  ).all(today)
  return txRows.map(t => ({
    time: t.timestamp?.slice(11, 16) || '-',
    name: productDisplayName(t),
    type: t.type,
    qty: t.quantity,
    amount: (t.selling_price ?? 0) * t.quantity,
  }))
}
