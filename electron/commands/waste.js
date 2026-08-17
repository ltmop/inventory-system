// 报损登记：活饵死亡 / 饵料临期报废 / 破损等损耗。
// 报损 = 从批次扣库存（优先最早到期批次，临期先处理）+ 记 waste_logs（带该批次的进价，供成本报表按批算）
//      + 写一条 type='waste' 流水，让报损像出入库一样能在"商品进出记录"里翻到（哪天、谁、报损了啥）。
import { assertQuantity, inTransaction, now, productLabel, logAudit } from './helpers.js'

/** 登记报损：减少批次库存 + 记损耗 + 写报损流水。数量必须 ≥1，库存不足直接拒绝 */
export function createWaste(db, { productId, quantity: rawQuantity, reason, operator }) {
  // 计量单位：米商品（鱼线）允许小数报损
  const prod0 = db.prepare('SELECT unit FROM products WHERE id = ?').get(productId)
  if (!prod0) throw new Error('商品不存在')
  const quantity = assertQuantity(rawQuantity, '报损数量', prod0.unit === '米' ? '米' : '件')
  return inTransaction(db, () => {
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    if (!prod) throw new Error('商品不存在')
    // 优先扣最早到期的批次（临期先报废，别把新鲜的先报损了）
    const batches = db
      .prepare(
        `SELECT * FROM inventory_batches WHERE product_id = ? AND quantity > 0
         ORDER BY
           CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
           expiry_date ASC,
           id ASC`,
      )
      .all(productId)
    const total = batches.reduce((s, b) => s + b.quantity, 0)
    if (total < quantity) throw new Error(`库存不足：${productLabel(prod)} 只有 ${total} 件，报损不了 ${quantity} 件`)
    const ts = now()
    const reasonText = String(reason ?? '').trim()
    let remaining = quantity
    const allocations = []
    const updBatch = db.prepare('UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ?')
    const insLog = db.prepare(
      `INSERT INTO waste_logs (product_id, batch_id, quantity, cost_price, reason, operator, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insTx = db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
       VALUES (?, ?, 'waste', ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)`,
    )
    for (const b of batches) {
      if (remaining <= 0) break
      const deduct = Math.min(b.quantity, remaining)
      updBatch.run(deduct, b.id)
      // 每扣一个批次记一条损耗：cost_price = 该批次进价（哪批报损按哪批的成本算）
      insLog.run(productId, b.id, deduct, b.cost_price, reasonText, operator ?? null, ts)
      // 同时写一条 type='waste' 流水，进出记录里能查到
      insTx.run(productId, b.id, deduct, b.cost_price, ts, operator ?? null, reasonText)
      allocations.push({ batchId: b.id, quantity: deduct, costPrice: b.cost_price })
      remaining -= deduct
    }
    logAudit(db, '报损', `${productLabel(prod)} x${quantity}`,
      { quantity, reason: reasonText, costPrice: prod.cost_price }, operator)
    return { ok: true, allocations }
  })
}

/** 报损记录（带商品信息），按时间倒序；成本取该批次进价，老数据无成本时回退商品最近进价 */
export function listWastes(db, { limit = 100 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)
  return db
    .prepare(
      `SELECT w.*, p.sku_code, p.brand, p.model, COALESCE(w.cost_price, p.cost_price) AS cost_price
       FROM waste_logs w JOIN products p ON p.id = w.product_id
       ORDER BY w.created_at DESC, w.id DESC LIMIT ?`,
    )
    .all(n)
}

/** 损耗成本汇总：某时间段内报损数量 × 该批次进价（老数据无批次进价回退商品最近进价） */
export function wasteSummary(db, { from, to } = {}) {
  const conds = []
  const args = []
  if (from) { conds.push("date(w.created_at) >= date(?)"); args.push(from) }
  if (to) { conds.push("date(w.created_at) <= date(?)"); args.push(to) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT w.product_id, p.sku_code, p.brand, p.model, COALESCE(w.cost_price, p.cost_price) AS cost_price,
              SUM(w.quantity) AS total_qty,
              SUM(w.quantity * COALESCE(w.cost_price, p.cost_price)) AS total_cost
       FROM waste_logs w JOIN products p ON p.id = w.product_id
       ${where}
       GROUP BY w.product_id ORDER BY total_cost DESC`,
    )
    .all(...args)
  const totalQty = rows.reduce((s, r) => s + r.total_qty, 0)
  const totalCost = rows.reduce((s, r) => s + r.total_cost, 0)
  return { totalQty, totalCost, items: rows }
}
