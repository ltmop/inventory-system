// 批量导入
import {
  assertPositiveInt,
  assertFen,
  CATEGORY_CODES,
  inTransaction,
  now,
  nextNumericSku,
  SPEC_FIELDS,
  specOrNull,
  nextBatchNo,
  today,
  PRODUCT_STATUSES,
  minStockOrNull,
  logAudit,
} from './helpers.js'
import { enforceSkuQuota } from '../license.js'

/**
 * 批量导入商品 + 批次，每条商品自动生成批次入库记录。
 * 逐行校验：坏行（数量非法、缺成本价、品类不在 20 大类内）记入 errors 并跳过该行，
 * 不再让一行坏数据导致整批回滚。
 * SKU 规则与手动新建一致：显式 SKU 原样用 > 有条码用条码 > 无条码自动编纯数字号（1001 起）。
 * 合法行仍在同一事务里整体提交，批次号与手动入库同规则。
 *
 * mode：
 * - 'skip'（默认，向后兼容）：已存在的 SKU 跳过（含本次导入内部的重复行）。
 * - 'update'：SKU 已存在 → 更新该商品的可写字段（品牌/型号/成本价/建议售价/规格/状态/min_stock；
 *   SKU 本身、库存数量、批次一律不动），表里留空的列保持原值不覆盖；
 *   SKU 不存在 → 照常按新商品导入（带批次入库）。更新记一条 audit_log（"Excel 更新 N 个商品"）。
 * 返回 { ok, imported, updated, skipped, results, errors }。
 * @param {{ rows: Array<{sku_code?, barcode?, category, sub_category?, brand?, model?, cost_price, suggest_price?, quantity, location?, operator?, rod_length?, rod_action?, power_rating?, line_number?, hook_size?, color?, material?, expiry_date?, status?, min_stock?}>, mode?: 'skip' | 'update' }} input
 */
export function importBatch(db, { rows, mode = 'skip' }) {
  if (mode !== 'skip' && mode !== 'update') {
    throw new Error(`导入模式必须是 skip（只加新商品）或 update（更新老商品），收到：${mode}`)
  }
  return inTransaction(db, () => {
    const ts = now()
    // 先过滤已存在的 SKU（含本次导入内部的重复行）
    const prodBySku = new Map(
      db.prepare('SELECT * FROM products').all().map((r) => [r.sku_code, r]),
    )
    const existing = new Set(prodBySku.keys())
    // 本次导入已处理的 SKU：文件内部重复行只处理第一次（update 模式也只更新一次）
    const seenInFile = new Set()
    const newRows = []
    const updateRows = []
    const errors = []
    let skipped = 0
    for (const [i, r] of rows.entries()) {
      // 逐行校验：坏行记入 errors 并跳过，合法行继续走导入
      try {
        assertPositiveInt(r.quantity, '数量')
        assertFen(r.cost_price, '成本价')
        if (!CATEGORY_CODES[r.category]) throw new Error(`品类非法：${r.category}`)
      } catch (e) {
        errors.push({ row: i + 1, sku_code: r.sku_code ?? null, reason: e.message })
        skipped++
        continue
      }
      // SKU：显式 > 条码 > 纯数字自动编号（existing 兼作本次导入的已占用编号集合）
      let sku = r.sku_code?.trim() || r.barcode?.trim() || nextNumericSku(db, existing)
      if (seenInFile.has(sku)) {
        skipped++ // 文件内部重复
      } else if (existing.has(sku)) {
        // update 模式且是店里已有的 SKU → 更新老商品；其余（skip 模式）跳过
        const prod = prodBySku.get(sku)
        if (mode === 'update' && prod) {
          updateRows.push({ ...r, sku_code: sku, __product: prod })
          seenInFile.add(sku)
        } else {
          skipped++
        }
      } else {
        existing.add(sku)
        seenInFile.add(sku)
        newRows.push({ ...r, sku_code: sku })
      }
    }

    // v3.0 SKU 配额：本次新增商品数 + 现有总数 超过当前版本上限直接拒绝
    enforceSkuQuota(db, newRows.length || 1)
    const insProduct = db.prepare(
      `INSERT INTO products (sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, status, rod_length, rod_action, power_rating, line_number, hook_size, color, material, expiry_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '待盘点', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insBatch = db.prepare(
      `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    const insTx = db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, timestamp, operator, notes)
       VALUES (?, ?, 'in', ?, ?, ?, ?, '批量导入')`,
    )

    const results = []
    for (const r of newRows) {
      const info = insProduct.run(
        r.sku_code, r.barcode ?? null, r.category, r.sub_category ?? null,
        r.brand ?? null, r.model ?? null, r.cost_price, r.suggest_price ?? null,
        r.location ?? null, ...SPEC_FIELDS.map((f) => specOrNull(r[f])), ts, ts,
      )
      const productId = Number(info.lastInsertRowid)
      const batchNo = nextBatchNo(db) // 与手动入库同一套批次号规则
      const qty = r.quantity ?? 0
      const batchInfo = insBatch.run(productId, batchNo, qty, r.cost_price, r.location ?? null, today())
      const batchId = Number(batchInfo.lastInsertRowid)
      insTx.run(productId, batchId, qty, r.cost_price, ts, r.operator ?? '导入')
      results.push({ productId, batchId, batchNo, sku_code: r.sku_code })
    }

    // update 模式：按 SKU 匹配更新老商品资料。空着的列不动原值；SKU/库存/批次一律不碰。
    const updatedSkus = []
    for (const r of updateRows) {
      const prod = r.__product
      const upd = {}
      if (r.brand != null && String(r.brand).trim() !== '') upd.brand = String(r.brand).trim()
      if (r.model != null && String(r.model).trim() !== '') upd.model = String(r.model).trim()
      if (r.cost_price != null) upd.cost_price = r.cost_price
      if (r.suggest_price != null) upd.suggest_price = r.suggest_price
      for (const f of SPEC_FIELDS) {
        const v = specOrNull(r[f])
        if (v != null) upd[f] = v
      }
      if (r.status != null) {
        if (!PRODUCT_STATUSES.includes(r.status)) {
          throw new Error(`状态必须是：${PRODUCT_STATUSES.join(' / ')}，收到：${r.status}（SKU：${r.sku_code}）`)
        }
        upd.status = r.status
      }
      if (r.min_stock != null) upd.min_stock = minStockOrNull(r.min_stock)
      const keys = Object.keys(upd)
      if (keys.length > 0) {
        db.prepare(
          `UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ).run(...keys.map((k) => upd[k]), ts, prod.id)
      }
      updatedSkus.push(r.sku_code)
    }
    if (updatedSkus.length > 0) {
      logAudit(db, 'Excel更新', `Excel 更新 ${updatedSkus.length} 个商品`, { updated: updatedSkus.length, skus: updatedSkus }, rows[0]?.operator ?? '导入')
    }
    return { ok: true, imported: results.length, updated: updatedSkus.length, skipped, results, errors }
  })
}
