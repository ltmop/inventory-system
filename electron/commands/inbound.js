// 入库
import {
  assertQuantity,
  assertFen,
  inTransaction,
  now,
  nextBatchNo,
  today,
  productLabel,
  logAudit,
} from './helpers.js'

export function createInbound(db, { productId, quantity, costPrice, location, supplierId, operator, expiryDate }) {
  // 计量单位（v2.2）：米商品（鱼线）允许小数入库，如 500 米 / 3.5 米
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
  if (!prod) throw new Error('商品不存在')
  const qty = assertQuantity(quantity, '入库数量', prod.unit === '米' ? '米' : '件')
  assertFen(costPrice, '入库成本价')
  // 到期日可选：YYYY-MM-DD；填了非法格式直接报错（保质期商品防手误）
  let expiry = null
  if (expiryDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(expiryDate))) throw new Error('到期日格式不对，应该是 YYYY-MM-DD（如 2026-08-31）')
    expiry = String(expiryDate)
  }
  return inTransaction(db, () => {
    const ts = now()
    const batchNo = nextBatchNo(db)
    const batchInfo = db
      .prepare(
        `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(productId, batchNo, qty, costPrice, location ?? null, today(), supplierId ?? null, expiry)
    const batchId = Number(batchInfo.lastInsertRowid)

    db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
       VALUES (?, ?, 'in', ?, ?, NULL, ?, ?, NULL)`,
    ).run(productId, batchId, qty, costPrice, ts, operator ?? null)

    // 商品主表同步最近进价
    db.prepare('UPDATE products SET cost_price = ?, updated_at = ? WHERE id = ?').run(
      costPrice,
      ts,
      productId,
    )
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    logAudit(db, '入库', `${prod ? productLabel(prod) : `#${productId}`} x${qty}`,
      { batchNo, quantity: qty, costPrice, supplierId: supplierId ?? null }, operator)
    return { batchId, batchNo }
  })
}
