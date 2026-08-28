// 商品 CRUD 与批量修改
import {
  now,
  minStockOrNull,
  nextNumericSku,
  inTransaction,
  SPEC_FIELDS,
  specOrNull,
  logAudit,
  productLabel,
  assertPositiveInt,
  PRODUCT_STATUSES,
} from './helpers.js'
import { enforceSkuQuota } from '../license.js'
import { assertOwnerAction } from './users.js'
import { ensureUnit } from './units.js'
import { ensureCategory } from './categories.js'

export function createProduct(db, input) {
  const ts = now()
  const minStock = minStockOrNull(input.min_stock)
  const unit = String(input.unit || '件').trim() || '件'
  // SKU 规则（简化版）：显式传入的原样用（如 CSV 导入、老五段式）；
  // 留空时有条码直接用条码（扫码枪扫出来就是它），无条码用纯数字编号（1001 起递增）
  let skuCode = input.sku_code?.trim()
  if (!skuCode && input.barcode?.trim()) {
    skuCode = input.barcode.trim()
    if (db.prepare('SELECT 1 FROM products WHERE sku_code = ?').get(skuCode)) {
      throw new Error(`该条码已被其他商品用作编码：${skuCode}`)
    }
  }
  if (!skuCode) skuCode = nextNumericSku(db)
  return inTransaction(db, () => {
    // v3.0 SKU 配额：超过当前版本商品上限直接拒绝（普通300/进阶1000/大师无限）
    enforceSkuQuota(db, 1)
    const info = db
      .prepare(
        `INSERT INTO products (sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, status, rod_length, rod_action, power_rating, line_number, hook_size, color, material, expiry_date, min_stock, unit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skuCode,
        input.barcode ?? null,
        input.category,
        input.sub_category ?? null,
        input.brand ?? null,
        input.model ?? null,
        input.cost_price,
        input.suggest_price ?? null,
        input.location ?? null,
        input.status ?? '待盘点',
        ...SPEC_FIELDS.map((f) => specOrNull(input[f])),
        minStock,
        unit,
        ts,
        ts,
      )
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid)
    // 自定义分类/单位自动补录（分类管理、单位管理即时可见）
    ensureCategory(db, row.category)
    ensureUnit(db, row.unit, input.unit_decimal ? 1 : 0)
    logAudit(db, '新建商品', productLabel(row), { sku: row.sku_code, cost_price: row.cost_price, min_stock: minStock }, input.operator)
    return row
  })
}

/** 修改商品基本信息；SKU 一经创建不可修改（避免历史流水对不上） */
export function updateProduct(db, id, input) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
  if (!cur) throw new Error('商品不存在')
  // 与现有行合并，允许前端只传要改的字段；SKU 创建后不可改
  const v = { ...cur, ...input, id: cur.id, sku_code: cur.sku_code }
  const minStock = minStockOrNull(v.min_stock)
  const unit = String(v.unit || '件').trim() || '件'
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE products SET category = ?, sub_category = ?, brand = ?, model = ?, cost_price = ?, suggest_price = ?, location = ?, status = ?, rod_length = ?, rod_action = ?, power_rating = ?, line_number = ?, hook_size = ?, color = ?, material = ?, expiry_date = ?, min_stock = ?, unit = ?, photo_path = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      v.category,
      v.sub_category ?? null,
      v.brand ?? null,
      v.model ?? null,
      v.cost_price,
      v.suggest_price ?? null,
      v.location ?? null,
      v.status ?? '待盘点',
      ...SPEC_FIELDS.map((f) => specOrNull(v[f])),
      minStock,
      unit,
      // 图片相对文件名（images 目录内）；与现有行合并，不传 photo_path 时保持原值
      v.photo_path ?? null,
      now(),
      id,
    )
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
    ensureCategory(db, row.category)
    ensureUnit(db, row.unit, input.unit_decimal ? 1 : 0)
    logAudit(db, '改商品', productLabel(row), { sku: row.sku_code, cost_price: row.cost_price, min_stock: minStock }, input.operator)
    return row
  })
}

/** 仅允许删除没有任何批次和流水的商品，防止库存历史断链 */
export function deleteProduct(db, id, operator = null) {
  assertOwnerAction(db, '删除商品')
  const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)
  if (!exists) return { ok: false, reason: '商品不存在或已被删除' }
  const batchCount = db.prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE product_id = ?').get(id).n
  const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE product_id = ?').get(id).n
  if (batchCount > 0 || txCount > 0) {
    return { ok: false, reason: `该商品存在 ${batchCount} 个批次、${txCount} 条流水，不能删除；可改为"停产"状态` }
  }
  return inTransaction(db, () => {
    const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
    db.prepare('DELETE FROM products WHERE id = ?').run(id)
    if (cur) logAudit(db, '删商品', productLabel(cur), { sku: cur.sku_code }, operator)
    return { ok: true }
  })
}

/**
 * 批量修改商品：一次事务改一批商品的价格/状态，两者至少传一个。
 * priceMode（可省，二选一）：
 *   { kind: 'ratio', ratio } 统一打折：建议售价与"已设"的各档价格 ×ratio，
 *     分单位四舍五入（最低 1 分，防止打成 0）；没设建议售价/没设档次的保持原样（不补建档次）。
 *   { kind: 'fixed', priceFen } 统一改价：建议售价与已设的各档价格都改成 priceFen。
 * status（可省）：批量改状态，限 5 态之一。
 * 任一商品 id 不存在直接报错、整批回滚（不留半截修改）；
 * 价格/状态各记一条 audit_log（"批量改价 N 个商品"），与写入同事务。
 */
export function batchUpdateProducts(db, { ids, priceMode, status, operator }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('批量修改的商品列表不能为空')
  if (priceMode == null && status == null) throw new Error('批量修改至少要做一件事（改价或改状态）')
  if (priceMode != null) {
    if (priceMode.kind === 'ratio') {
      if (typeof priceMode.ratio !== 'number' || !Number.isFinite(priceMode.ratio) || priceMode.ratio <= 0) {
        throw new Error(`折扣必须是大于 0 的数字（如 0.9 表示 9 折），收到：${priceMode.ratio}`)
      }
    } else if (priceMode.kind === 'fixed') {
      assertPositiveInt(priceMode.priceFen, '统一售价')
    } else {
      throw new Error(`批量改价方式必须是 ratio（打折）或 fixed（统一价），收到：${priceMode.kind}`)
    }
  }
  if (status != null && !PRODUCT_STATUSES.includes(status)) {
    throw new Error(`状态必须是：${PRODUCT_STATUSES.join(' / ')}，收到：${status}`)
  }
  return inTransaction(db, () => {
    const ts = now()
    let tiersUpdated = 0
    for (const id of ids) {
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
      if (!prod) throw new Error(`商品不存在（ID：${id}）`)
      if (priceMode != null) {
        const convert = (p) =>
          priceMode.kind === 'ratio' ? Math.max(1, Math.round(p * priceMode.ratio)) : priceMode.priceFen
        db.prepare('UPDATE products SET suggest_price = ?, updated_at = ? WHERE id = ?').run(
          prod.suggest_price == null ? null : convert(prod.suggest_price),
          ts,
          id,
        )
        // 只动"已设"的档次价；没设档的商品不补建
        const tiers = db.prepare('SELECT * FROM price_tiers WHERE product_id = ?').all(id)
        for (const t of tiers) {
          db.prepare('UPDATE price_tiers SET price = ? WHERE id = ?').run(convert(t.price), t.id)
          tiersUpdated++
        }
      }
      if (status != null) {
        db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id)
      }
    }
    if (priceMode != null) {
      logAudit(db, '批量改价', `批量改价 ${ids.length} 个商品`, {
        count: ids.length,
        mode: priceMode.kind,
        ratio: priceMode.kind === 'ratio' ? priceMode.ratio : null,
        priceFen: priceMode.kind === 'fixed' ? priceMode.priceFen : null,
        tiersUpdated,
      }, operator)
    }
    if (status != null) {
      logAudit(db, '批量改状态', `批量改状态 ${ids.length} 个商品 → ${status}`, { count: ids.length, status }, operator)
    }
    return { ok: true, updated: ids.length, tiersUpdated }
  })
}

/**
 * 手动标记商品：热销（is_hot）/ 处理货（is_clearance）。手机端老板自己标。
 * @param {{ id:number, is_hot?:0|1, is_clearance?:0|1, operator?:string }} input
 */
export function markProduct(db, { id, is_hot = null, is_clearance = null, operator = null }) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
  if (!cur) throw new Error('商品不存在')
  const set = []
  const params = []
  if (is_hot !== null) {
    const v = is_hot ? 1 : 0
    set.push('is_hot = ?')
    params.push(v)
    if (cur.is_hot !== v) {
      logAudit(db, v ? '标热销' : '取消热销', productLabel(cur), { sku: cur.sku_code }, operator)
    }
  }
  if (is_clearance !== null) {
    const v = is_clearance ? 1 : 0
    set.push('is_clearance = ?')
    params.push(v)
    if (cur.is_clearance !== v) {
      logAudit(db, v ? '标处理货' : '取消处理货', productLabel(cur), { sku: cur.sku_code }, operator)
    }
  }
  if (set.length === 0) return { ok: true, unchanged: true }
  params.push(new Date().toISOString(), id)
  db.prepare(`UPDATE products SET ${set.join(', ')}, updated_at = ? WHERE id = ?`).run(...params)
  return { ok: true, id, is_hot: is_hot === null ? cur.is_hot : is_hot ? 1 : 0, is_clearance: is_clearance === null ? cur.is_clearance : is_clearance ? 1 : 0 }
}
