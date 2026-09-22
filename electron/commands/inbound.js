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
  DEFAULT_COST_FEN,
} from './helpers.js'
import { pushUndo } from './undo.js'

/** 新建入库单（进货入库）。 */
export function createInbound(db, { productId, quantity, costPrice, location, supplierId, operator, expiryDate }) {
  // 计量单位（通用版）：允许小数单位（斤/米）入库小数
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
  if (!prod) throw new Error('商品不存在')
  const qty = assertQuantity(quantity, '入库数量', prod.unit === '米' ? '米' : '件')
  assertFen(costPrice, '入库成本价')
  // 成本兜底（老板 2026-09-22：「先默认成本价为 2 块钱」）。
  // 毛利 = 售价 − **批次成本**，所以入库这一步不给进价，卖出去的毛利就等于营业额（虚高）。
  // 这里把"没填进价"统一落成 ¥2；商品档案上挂着"默认价"标记，界面会提醒人去改。
  const cost = Number(costPrice) > 0 ? Number(costPrice) : DEFAULT_COST_FEN
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
      .run(productId, batchNo, qty, cost, location ?? null, today(), supplierId ?? null, expiry)
    const batchId = Number(batchInfo.lastInsertRowid)

    const txInfo = db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
       VALUES (?, ?, 'in', ?, ?, NULL, ?, ?, NULL)`,
    ).run(productId, batchId, qty, cost, ts, operator ?? null)

    // 商品主表同步最近进价 —— **只在真的填了进价时才覆盖**。
    // 2026-09-22 查出来的坑：这里原来无条件覆盖，而 AI 建档/快速入库传的成本是 0，
    // 于是把商品已经录好的成本价冲成了 0 → 毛利全部虚高成营业额（178 个商品里 119 个中招）。
    // 同时把状态落成「已盘点」：入库就是你亲手点过的数，不该再挂着待盘点。
    if (Number(costPrice) > 0) {
      db.prepare('UPDATE products SET cost_price = ?, cost_is_default = 0, status = ?, updated_at = ? WHERE id = ?').run(
        cost,
        '已盘点',
        ts,
        productId,
      )
    } else {
      db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run('已盘点', ts, productId)
    }
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    logAudit(db, '入库', `${prod ? productLabel(prod) : `#${productId}`} x${qty}`,
      { batchNo, quantity: qty, costPrice, supplierId: supplierId ?? null }, operator)
    // 可撤回快照：整批撤回（这批只要被卖过/报损过就会被拒，见 undo.js）
    pushUndo(db, {
      channel: 'inbound:create',
      label: `${prod ? productLabel(prod) : '#' + productId} x${qty}`,
      detail: '入库 ' + batchNo,
      undo: { kind: 'inbound', batchId, txId: Number(txInfo.lastInsertRowid), quantity: qty },
      operator,
    })
    return { batchId, batchNo }
  })
}
