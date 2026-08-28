// 配节管理：主竿-配节关联（断竿梢换节是渔具店售后刚需）。
// 一个商品可以是某主竿的配节（parent_id 指向主竿），配节类型用 part_type 标记（竿梢/手把节/中节等）。
// 配节页按主竿维度看各配节库存，低于预警提示补货。
import { inTransaction, now, productLabel, logAudit } from './helpers.js'

/** 设置/清除配节关系：productId 设为 parentId 的配节，partType 填配节类型；parentId=null 清除 */
export function setPart(db, { productId, parentId, partType, operator }) {
  return inTransaction(db, () => {
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    if (!prod) throw new Error('商品不存在')
    if (parentId != null) {
      const parent = db.prepare('SELECT * FROM products WHERE id = ?').get(parentId)
      if (!parent) throw new Error(`主竿商品不存在（ID：${parentId}）`)
      if (parentId === productId) throw new Error('配节不能指向自己')
    }
    const ts = now()
    db.prepare('UPDATE products SET parent_id = ?, part_type = ?, updated_at = ? WHERE id = ?').run(
      parentId ?? null,
      partType ? String(partType).trim() : null,
      ts,
      productId,
    )
    logAudit(db, '设配节',
      `${productLabel(prod)} → ${parentId != null ? `主竿#${parentId}` : '解除'}`,
      { parentId: parentId ?? null, partType: partType ?? null }, operator)
    return { ok: true }
  })
}

/**
 * 批量设配节（v2.2）：一次把一个主竿的多个配节绑好，省得一根一根点。
 * parts 为 [{ productId, partType }]；整个批次一个事务，任一个非法整批回滚。
 */
export function setPartsMany(db, { parentId, parts, operator }) {
  return inTransaction(db, () => {
    if (parentId == null) throw new Error('请先选择主竿')
    const parent = db.prepare('SELECT * FROM products WHERE id = ?').get(parentId)
    if (!parent) throw new Error(`主竿商品不存在（ID：${parentId}）`)
    const list = Array.isArray(parts) ? parts : []
    if (list.length === 0) throw new Error('至少选一个要设为配节的商品')
    const ts = now()
    const upd = db.prepare(
      'UPDATE products SET parent_id = ?, part_type = ?, updated_at = ? WHERE id = ?',
    )
    let okCount = 0
    for (const it of list) {
      const pid = Number(it?.productId)
      const ptype = String(it?.partType ?? '').trim()
      if (!Number.isInteger(pid)) throw new Error(`配节商品编号非法：${it?.productId}`)
      if (pid === parentId) throw new Error('配节不能指向自己')
      const prod = db.prepare('SELECT id FROM products WHERE id = ?').get(pid)
      if (!prod) throw new Error(`配节商品不存在（ID：${pid}）`)
      upd.run(parentId, ptype || null, ts, pid)
      okCount++
    }
    logAudit(db, '设配节', `主竿#${parentId} 批量绑 ${okCount} 个配节`,
      { parentId, count: okCount, parts: list }, operator)
    return { ok: true, count: okCount }
  })
}

/** 查某主竿的所有配节 + 当前库存 + 缺货线（配节页主维度；min_stock 缺省用默认阈值 5） */
export function partsOf(db, { parentId }) {
  return db
    .prepare(
      `SELECT p.id, p.sku_code, p.brand, p.model, p.part_type, p.cost_price, p.suggest_price, p.min_stock,
              COALESCE((SELECT SUM(quantity) FROM inventory_batches b WHERE b.product_id = p.id), 0) AS stock
       FROM products p WHERE p.parent_id = ? ORDER BY p.part_type, p.model`,
    )
    .all(parentId)
}

/** 所有"是配节"的商品（用于搜索/筛选），可按关键词过滤 */
export function allParts(db, { keyword } = {}) {
  const kw = keyword ? `%${String(keyword).trim()}%` : null
  const rows = kw
    ? db
        .prepare(
          `SELECT p.id, p.sku_code, p.brand, p.model, p.part_type, p.parent_id, p.min_stock,
                  COALESCE((SELECT SUM(quantity) FROM inventory_batches b WHERE b.product_id = p.id), 0) AS stock
           FROM products p WHERE p.parent_id IS NOT NULL
             AND (p.sku_code LIKE ? OR p.brand LIKE ? OR p.model LIKE ?)
           ORDER BY p.part_type, p.model LIMIT 50`,
        )
        .all(kw, kw, kw)
    : db
        .prepare(
          `SELECT p.id, p.sku_code, p.brand, p.model, p.part_type, p.parent_id, p.min_stock,
                  COALESCE((SELECT SUM(quantity) FROM inventory_batches b WHERE b.product_id = p.id), 0) AS stock
           FROM products p WHERE p.parent_id IS NOT NULL
           ORDER BY p.part_type, p.model LIMIT 200`,
        )
        .all()
  // 附带主竿名称
  const parentIds = [...new Set(rows.map((r) => r.parent_id))]
  const parents = {}
  if (parentIds.length > 0) {
    const ph = parentIds.map(() => '?').join(',')
    for (const p of db.prepare(`SELECT id, sku_code, brand, model FROM products WHERE id IN (${ph})`).all(...parentIds)) {
      parents[p.id] = [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code
    }
  }
  return rows.map((r) => ({ ...r, parent_name: parents[r.parent_id] ?? `#${r.parent_id}` }))
}
