// 采购订单（v2.0）
//
// 状态机（schema CHECK：draft/sent/partial/complete/cancelled）：
//   建单即 sent（待收货：货已向供应商订出，draft 预留给以后的草稿功能）
//   sent --收货(未收齐)--> partial --收货(收齐)--> complete
//   sent/partial --取消--> cancelled（partial 取消：已收的部分保留，剩余未收作废）
//   complete/cancelled 为终态：不能再收货、不能再取消（重复收货/重复取消报中文错）
import {
  assertPositiveInt,
  assertFen,
  inTransaction,
  now,
  nextPoNo,
  nextBatchNo,
  today,
  logAudit,
} from './helpers.js'

/**
 * 新建采购订单：供应商/商品必须存在；数量正整数、进价非负整数分；
 * 初始状态 sent（待收货），total_cost = Σ 数量×进价（分）
 */
export function createPurchaseOrder(db, { supplierId, items, notes, expectedDate, operator }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('采购明细不能为空')
  return inTransaction(db, () => {
    const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)
    if (!sup) throw new Error('供应商不存在')
    const ts = now()
    const poNo = nextPoNo(db)
    let totalCost = 0
    const lines = []
    for (const it of items) {
      assertPositiveInt(it.quantity, '采购数量')
      assertFen(it.costPrice, '采购进价')
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(it.productId)
      if (!prod) throw new Error(`商品不存在（ID：${it.productId}）`)
      totalCost += it.quantity * it.costPrice
      lines.push({ prod, quantity: it.quantity, unitCost: it.costPrice })
    }
    const info = db
      .prepare(
        `INSERT INTO purchase_orders (po_no, supplier_id, status, expected_arrival, total_cost, created_at, updated_at, operator, notes)
         VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?)`,
      )
      .run(poNo, supplierId, expectedDate ?? null, totalCost, ts, ts, operator ?? null, notes ?? null)
    const poId = Number(info.lastInsertRowid)
    const insItem = db.prepare(
      `INSERT INTO purchase_order_items (po_id, product_id, product_desc, category, quantity, received_qty, unit_cost, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    for (const l of lines) {
      const desc = [l.prod.brand, l.prod.model].filter(Boolean).join(' ') || l.prod.sku_code
      insItem.run(poId, l.prod.id, desc, l.prod.category, l.quantity, l.unitCost, ts)
    }
    return db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId)
  })
}

/** 采购单列表：按时间倒序，带供应商名/明细条数/总金额/已收进度 */
export function listPurchaseOrders(db, { status } = {}) {
  const rows = db
    .prepare(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS item_count,
              (SELECT COALESCE(SUM(i.quantity), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS total_qty,
              (SELECT COALESCE(SUM(i.received_qty), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS received_qty
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
       ORDER BY po.created_at DESC, po.id DESC`,
    )
    .all()
  return status == null ? rows : rows.filter((r) => r.status === status)
}

/** 采购单详情：订单头 + 明细（每条带商品名/SKU/订了多少/已收多少） */
export function purchaseOrderDetail(db, { id }) {
  const order = db
    .prepare(
      `SELECT po.*, s.name AS supplier_name
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = ?`,
    )
    .get(id)
  if (!order) throw new Error('采购订单不存在')
  const items = db
    .prepare(
      `SELECT i.*, p.sku_code, p.brand, p.model
       FROM purchase_order_items i LEFT JOIN products p ON p.id = i.product_id
       WHERE i.po_id = ? ORDER BY i.id`,
    )
    .all(id)
    .map((r) => ({
      ...r,
      product_name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code || r.product_desc,
    }))
  return { order, items }
}

/**
 * 采购收货入库（核心）：每条明细本次收货数量 > 0 且 ≤ 剩余待收，超订报错；
 * 每条收货建独立批次（成本=订单进价、供应商=订单供应商）+ type='in' 流水（notes 标注采购单号），
 * 并同步商品最近进价（与手动入库同口径）；收齐 → complete，部分 → partial。
 * 整个操作同一事务：任一明细失败整单不记（批次/流水零写入）。
 */
export function receivePurchaseOrder(db, { id, items, operator }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('收货明细不能为空')
  return inTransaction(db, () => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id)
    if (!po) throw new Error('采购订单不存在')
    if (po.status === 'complete') throw new Error(`采购单 ${po.po_no} 已完成，不能重复收货`)
    if (po.status === 'cancelled') throw new Error(`采购单 ${po.po_no} 已取消，不能收货`)

    const ts = now()
    for (const it of items) {
      assertPositiveInt(it.quantity, '收货数量')
      const line = db.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(it.itemId)
      if (!line || line.po_id !== id) throw new Error(`明细 ${it.itemId} 不属于采购单 ${po.po_no}`)
      const remaining = line.quantity - line.received_qty
      if (it.quantity > remaining) {
        throw new Error(
          `超订：明细「${line.product_desc}」订 ${line.quantity} 已收 ${line.received_qty}，本次收 ${it.quantity} 超出剩余待收 ${remaining}`,
        )
      }
      // 入库：批次成本=订单进价，流水 notes 标注采购单号（与 createInbound 同口径，内联避免嵌套事务）
      // 到期日可选：it.expiryDate 传了且格式对才落库，否则该批次无保质期
      let expiry = null
      if (it.expiryDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(it.expiryDate))) throw new Error('到期日格式不对，应该是 YYYY-MM-DD')
        expiry = String(it.expiryDate)
      }
      const batchNo = nextBatchNo(db)
      const batchInfo = db
        .prepare(
          `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id, expiry_date)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(line.product_id, batchNo, it.quantity, line.unit_cost, today(), po.supplier_id, expiry)
      const batchId = Number(batchInfo.lastInsertRowid)
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
         VALUES (?, ?, 'in', ?, ?, NULL, ?, ?, ?)`,
      ).run(line.product_id, batchId, it.quantity, line.unit_cost, ts, operator ?? null, `采购收货 ${po.po_no}`)
      db.prepare('UPDATE products SET cost_price = ?, updated_at = ? WHERE id = ?').run(line.unit_cost, ts, line.product_id)
      db.prepare('UPDATE purchase_order_items SET received_qty = ? WHERE id = ?').run(
        line.received_qty + it.quantity,
        line.id,
      )
      logAudit(db, '采购收货', `${line.product_desc} x${it.quantity}`,
        { poNo: po.po_no, batchNo, quantity: it.quantity, unitCost: line.unit_cost }, operator)
    }

    // 全部明细收齐 → 已完成，否则 → 部分收货
    const left = db
      .prepare('SELECT COALESCE(SUM(quantity - received_qty), 0) AS n FROM purchase_order_items WHERE po_id = ?')
      .get(id).n
    const status = left === 0 ? 'complete' : 'partial'
    db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id)
    return { ok: true, status, poNo: po.po_no }
  })
}

/**
 * 取消采购订单：仅 sent（待收货）/partial（部分收货）可取消；complete/cancelled 报中文错。
 * partial 取消时剩余未收部分作废、已收的部分保留（返回值 message 明示）。
 */
export function cancelPurchaseOrder(db, { id }) {
  return inTransaction(db, () => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id)
    if (!po) throw new Error('采购订单不存在')
    if (po.status === 'complete') throw new Error(`采购单 ${po.po_no} 已完成，不能取消`)
    if (po.status === 'cancelled') throw new Error(`采购单 ${po.po_no} 已取消，不能重复取消`)
    const hadReceived = po.status === 'partial'
    db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id)
    return {
      ok: true,
      poNo: po.po_no,
      message: hadReceived ? '采购单已取消：已收的部分保留，剩余未收部分作废' : '采购单已取消',
    }
  })
}
