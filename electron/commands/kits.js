// 套装（v2.2）：一套多个商品（新手套装/绑钩套装等），开单时一键加清单。
// 打包价（v2.2）：套装可以设"一口价"或"总折扣"，卖的是打包便宜；开单时按打包价把组成件折算进清单。
import { inTransaction, now, assertPositiveInt } from './helpers.js'
import { assertOwnerAction } from './users.js'

/** 归一套装打包价：null/undefined/空串 → null（不设）；否则必须是非负整数（分） */
function kitPriceOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`一口价必须是非负整数（分）或留空，收到：${v}`)
  return n
}

/** 归一套装总折扣：null/undefined/空串 → null（不设）；否则 1~100 的整数 */
function kitDiscountOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`总折扣要是 1~100 的整数（90=9折）或留空，收到：${v}`)
  return n
}

/** 套装列表（带明细条数），按创建时间倒序 */
export function listKits(db) {
  return db
    .prepare(
      `SELECT k.*, (SELECT COUNT(*) FROM kit_items ki WHERE ki.kit_id = k.id) AS item_count
       FROM kits k ORDER BY k.id DESC`,
    )
    .all()
}

/** 套装详情：头 + 明细（带商品名称/SKU/建议售价，供开单加清单） */
export function getKit(db, { id }) {
  const kit = db.prepare('SELECT * FROM kits WHERE id = ?').get(id)
  if (!kit) throw new Error('套装不存在')
  const items = db
    .prepare(
      `SELECT ki.product_id, ki.quantity, p.sku_code, p.brand, p.model, p.suggest_price,
              CASE WHEN p.brand IS NULL OR p.brand = '' THEN p.model ELSE p.brand || ' ' || p.model END AS product_name
       FROM kit_items ki JOIN products p ON p.id = ki.product_id
       WHERE ki.kit_id = ? ORDER BY ki.id`,
    )
    .all(id)
  return { kit, items }
}

/**
 * 保存套装（新建或更新）：一个事务内 upsert 套装 + 重建明细。
 * items 里的商品必须存在、数量必须是正整数；同一套装内商品去重。
 */
export function saveKit(db, { id, name, price, discount_percent, items }) {
  return inTransaction(db, () => {
    const kitName = String(name ?? '').trim()
    if (!kitName) throw new Error('套装名称不能为空')
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('套装至少要包含一个商品')
    }
    const kitPrice = kitPriceOrNull(price)
    const kitDiscount = kitDiscountOrNull(discount_percent)
    if (kitPrice != null && kitDiscount != null) {
      throw new Error('一口价和总折扣只能设一个，别两个都填')
    }
    const dedup = new Map()
    for (const it of items) {
      const pid = Number(it?.productId)
      const qty = Number(it?.quantity)
      if (!Number.isInteger(pid)) throw new Error(`套装明细的商品编号非法：${it?.productId}`)
      assertPositiveInt(qty, '套装商品数量')
      const prod = db.prepare('SELECT id FROM products WHERE id = ?').get(pid)
      if (!prod) throw new Error(`套装里的商品不存在（ID：${pid}）`)
      dedup.set(pid, (dedup.get(pid) ?? 0) + qty)
    }
    const ts = now()
    let kitId = id == null ? null : Number(id)
    if (kitId == null) {
      const info = db
        .prepare('INSERT INTO kits (name, price, discount_percent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(kitName, kitPrice, kitDiscount, ts, ts)
      kitId = Number(info.lastInsertRowid)
    } else {
      const info = db
        .prepare('UPDATE kits SET name = ?, price = ?, discount_percent = ?, updated_at = ? WHERE id = ?')
        .run(kitName, kitPrice, kitDiscount, ts, kitId)
      if (info.changes === 0) throw new Error('套装不存在')
    }
    db.prepare('DELETE FROM kit_items WHERE kit_id = ?').run(kitId)
    const ins = db.prepare(
      'INSERT INTO kit_items (kit_id, product_id, quantity) VALUES (?, ?, ?)',
    )
    for (const [pid, qty] of dedup) ins.run(kitId, pid, qty)
    return { id: kitId }
  })
}

/** 删除套装（明细随外键 CASCADE 一并删） */
export function deleteKit(db, { id }) {
  assertOwnerAction(db, '删除套装')
  const info = db.prepare('DELETE FROM kits WHERE id = ?').run(Number(id))
  if (info.changes === 0) throw new Error('套装不存在')
  return { ok: true }
}
