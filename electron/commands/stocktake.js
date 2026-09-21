// 盘点
import {
  CATEGORY_CODES,
  inTransaction,
  now,
  nextTakeNo,
  logAudit,
  roundQty,
  productLabel,
  nextBatchNo,
  today,
} from './helpers.js'

/**
 * 创建盘点单：可按货位（locationFilter，前缀匹配）、品类（category，精确匹配）、
 * 供应商（supplierId，按批次的进货供应商匹配）筛选，三个条件取交集，都不传=全店盘点。
 * 筛选条件随盘点单落库（category_filter / supplier_filter / location_filter），方便事后回看盘点范围。
 *
 * mode（盘点模式，v2.1）：
 * - 'batch'（默认）：按批次逐行生成明细，店员分别填每个批次的实盘数（多批次商品拆多行）
 * - 'sku'：按商品合并成一行（batch_id 记 NULL），店员只填"这个商品一共多少个"，
 *   提交时系统把差异按各批次数量比例摊到批次。适合货架上分不清批次的场景。
 */
export function createStockTake(db, { locationFilter, category, supplierId, operator, mode }) {
  if (category != null && !CATEGORY_CODES[category]) throw new Error(`品类非法：${category}`)
  const takeMode = mode === 'sku' ? 'sku' : 'batch'
  return inTransaction(db, () => {
    if (supplierId != null) {
      const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)
      if (!sup) throw new Error('供应商不存在')
    }
    const ts = now()
    const takeNo = nextTakeNo(db)
    const info = db
      .prepare(
        `INSERT INTO stock_takes (take_no, status, location_filter, category_filter, supplier_filter, started_at, completed_at, operator, mode)
         VALUES (?, '进行中', ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(takeNo, locationFilter ?? null, category ?? null, supplierId ?? null, ts, operator ?? '', takeMode)
    const takeId = Number(info.lastInsertRowid)

    // 按筛选条件取批次：货位匹配（批次货位或商品默认货位）+ 品类 + 供应商，三者取交集
    const inArea = (loc) => !locationFilter || (loc !== null && loc.startsWith(locationFilter))
    const batches = db
      .prepare(
        `SELECT b.id AS batch_id, b.product_id, b.quantity, b.location AS batch_loc, b.supplier_id,
                p.location AS product_loc, p.category
         FROM inventory_batches b JOIN products p ON p.id = b.product_id
         WHERE b.quantity > 0`,
      )
      .all()
      .filter(
        (r) =>
          (inArea(r.batch_loc) || inArea(r.product_loc)) &&
          (category == null || r.category === category) &&
          (supplierId == null || r.supplier_id === supplierId),
      )

    if (takeMode === 'sku') {
      // 按商品合并：一个商品一行，system_qty = 该商品符合条件的所有批次数量之和，batch_id 记 NULL
      const byProduct = new Map()
      for (const r of batches) {
        byProduct.set(r.product_id, (byProduct.get(r.product_id) ?? 0) + r.quantity)
      }
      const insItem = db.prepare(
        `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
         VALUES (?, ?, NULL, ?, NULL, '')`,
      )
      for (const [pid, qty] of byProduct) insItem.run(takeId, pid, qty)
    } else {
      const insItem = db.prepare(
        `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
         VALUES (?, ?, ?, ?, NULL, '')`,
      )
      for (const r of batches) insItem.run(takeId, r.product_id, r.batch_id, r.quantity)
    }

    return db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(takeId)
  })
}

/** 更新盘点单里的一项：记实盘数并算出差异（完成盘点时才正式落账）。 */
export function updateStockTakeItem(db, { itemId, actualQty, reason }) {
  // 与 submitStockTake 同一套校验：实盘数必须是非负数（米商品允许小数），
  // 负数/非法小数/非数字一律拒绝，不允许落库
  const row = db
    .prepare(
      `SELECT i.product_id, p.unit FROM stock_take_items i JOIN products p ON p.id = i.product_id WHERE i.id = ?`,
    )
    .get(itemId)
  if (!row) throw new Error('盘点明细不存在')
  const unit = row.unit === '米' ? '米' : '件'
  const qty = Number(actualQty)
  if (unit === '米') {
    if (!Number.isFinite(qty) || qty < 0 || Math.abs(roundQty(qty) - qty) >= 1e-9) {
      throw new Error(`实盘数量最多 1 位小数且不能为负，收到：${actualQty}`)
    }
  } else if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`实盘数量必须是非负整数，收到：${actualQty}`)
  }
  db.prepare('UPDATE stock_take_items SET actual_qty = ?, reason = ? WHERE id = ?').run(
    roundQty(qty),
    reason ?? '',
    itemId,
  )
}

/** 完成盘点：把实盘数落实到批次库存，盘点单置为已完成 */
export function completeStockTake(db, takeId) {
  return inTransaction(db, () => {
    const items = db
      .prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ? AND actual_qty IS NOT NULL AND batch_id IS NOT NULL')
      .all(takeId)
    const upd = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
    for (const it of items) upd.run(it.actual_qty, it.batch_id)
    db.prepare("UPDATE stock_takes SET status = '已完成', completed_at = ? WHERE id = ?").run(now(), takeId)
  })
}

/**
 * 盘点一次性原子提交：把前端暂存的实盘数写入明细 + 完成盘点，同一事务。
 * 替代"前端逐条 updateStockTakeItem + 最后 complete"的两段式流程——
 * 那种流程中途崩溃会留下改了明细没落实库存的半成品状态。
 * @param {{ takeId: number, items: Array<{ itemId: number, actualQty: number, reason: string }> }} payload
 */
export function submitStockTake(db, { takeId, items, operator }) {
  // 事务只开一层：helpers.inTransaction **不是可重入的**（嵌套 BEGIN 会直接报错），
  // 所以把落账逻辑抽到 applyStockTake，由调用方决定事务边界。
  return inTransaction(db, () => applyStockTake(db, takeId, items, operator))
}

/**
 * 盘点落账的**唯一实现**（本身不开事务，事务边界由调用方负责）。
 * 抽出来是为了让「单品改库存」adjustProductStock 复用同一段摊批次逻辑 ——
 * 否则单品改库存另写一套比例分摊，两边会算出不同的库存，那就是口径分叉。
 */
function applyStockTake(db, takeId, items, operator) {
  const take = db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(takeId)
  if (!take) throw new Error('盘点单不存在')
  const isSkuMode = take.mode === 'sku'
  const updItem = db.prepare(
    'UPDATE stock_take_items SET actual_qty = ?, reason = ? WHERE id = ? AND stock_take_id = ?',
  )
  // 计量单位校验：允许小数单位实盘数可小数
  const itemUnit = db.prepare(
    'SELECT p.unit FROM stock_take_items i JOIN products p ON p.id = i.product_id WHERE i.id = ?',
  )
  for (const it of items ?? []) {
    const qty = Number(it.actualQty)
    if (!Number.isFinite(qty) || qty < 0) continue
    const unitRow = itemUnit.get(Number(it.itemId))
    const unit = unitRow?.unit === '米' ? '米' : '件'
    const valid =
      unit === '米' ? Math.abs(roundQty(qty) - qty) < 1e-9 : Number.isInteger(qty)
    if (valid) updItem.run(roundQty(qty), String(it.reason ?? ''), it.itemId, takeId)
  }
  if (isSkuMode) {
    // 按 SKU 合并：一个商品一行（batch_id NULL），把商品实盘总数按各批次数量比例摊回批次库存
    const skuRows = db
      .prepare(
        `SELECT id, product_id, system_qty, actual_qty FROM stock_take_items
         WHERE stock_take_id = ? AND actual_qty IS NOT NULL AND batch_id IS NULL`,
      )
      .all(takeId)
    // 前端带上的 batchAllocations（v2.2）：摊完结果已预览给老板看，直接落这批，兜底才走比例分摊
    const allocByItem = new Map()
    for (const it of items ?? []) {
      if (Array.isArray(it.batchAllocations) && it.batchAllocations.length > 0) {
        allocByItem.set(Number(it.itemId), it.batchAllocations)
      }
    }
    const updBatch = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
    let batchCount = 0
    for (const r of skuRows) {
      const explicit = allocByItem.get(r.id)
      if (explicit) {
        for (const a of explicit) {
          if (a.batchId != null && a.quantity != null) {
            updBatch.run(roundQty(Number(a.quantity)), Number(a.batchId))
            batchCount++
          }
        }
        continue
      }
      const target = r.actual_qty
      const sys = r.system_qty || 0
      const batchList = db
        .prepare(
          'SELECT id, quantity FROM inventory_batches WHERE product_id = ? ORDER BY id ASC',
        )
        .all(r.product_id)
      if (batchList.length === 0) continue
      if (sys <= 0) {
        // 系统库存为 0 但盘出有货：全部记到第一个批次（新建时 batch_id 若为空则无法落，仅标记差异）
        updBatch.run(target, batchList[0].id)
        batchCount++
        continue
      }
      // 允许小数单位目标带小数 → 每批按 1 位小数摊；其余整数摊
      const precision = Number.isInteger(target) ? 1 : 10
      let allocated = 0
      for (let i = 0; i < batchList.length; i++) {
        const b = batchList[i]
        // 按数量比例分摊，最后一个批次补平取整误差
        const share =
          i === batchList.length - 1
            ? target - allocated
            : Math.max(0, Math.round(((target * b.quantity) / sys) * precision) / precision)
        updBatch.run(roundQty(Math.max(0, share)), b.id)
        allocated += share
        batchCount++
      }
    }
    db.prepare("UPDATE stock_takes SET status = '已完成', completed_at = ? WHERE id = ?").run(now(), takeId)
    logAudit(db, '盘点', take.take_no ?? `盘点单#${takeId}`, { counted: skuRows.length, mode: 'sku' }, operator)
    return
  }
  const rows = db
    .prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ? AND actual_qty IS NOT NULL AND batch_id IS NOT NULL')
    .all(takeId)
  const updBatch = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
  for (const r of rows) updBatch.run(r.actual_qty, r.batch_id)
  db.prepare("UPDATE stock_takes SET status = '已完成', completed_at = ? WHERE id = ?").run(now(), takeId)
  logAudit(db, '盘点', take.take_no ?? `盘点单#${takeId}`, { counted: rows.length, mode: 'batch' }, operator)
  return { takeId }
}

/**
 * 单品改库存（老板 2026-09-21：「库存里无法改数量」）。
 *
 * 实现上就是**给这一个商品开一张只有一行的盘点单**（sku 模式），再走同一套落账逻辑：
 *   · 和「盘点管理」里盘出来的差异完全同源 —— 同样摊批次、同样写 audit_log、同样能在盘点单里回看；
 *   · 绝不直接 UPDATE inventory_batches：库存是账，绕过盘点就没有差异记录，
 *     事后谁也说不清这批货为什么少了（这正是 stock.js 里「优选仓」那件事的教训）。
 *
 * @param {{productId:number, actualQty:number, reason?:string, operator?:string}} p
 * @returns {{productId:number, product:string, before:number, after:number, diff:number, takeNo:string}}
 */
export function adjustProductStock(db, { productId, actualQty, reason, operator } = {}) {
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(productId))
  if (!prod) throw new Error('商品不存在')
  const target = Number(actualQty)
  if (!Number.isFinite(target) || target < 0) throw new Error('数量要填 0 或更大的数')
  // 小数只允许「可小数」单位（与 units.allow_decimal 同口径，和入库/盘点一致）
  const unitRow = db.prepare('SELECT allow_decimal FROM units WHERE name = ?').get(prod.unit || '件')
  const allowDec = !!(unitRow && unitRow.allow_decimal)
  if (!allowDec && !Number.isInteger(target)) throw new Error('「' + (prod.unit || '件') + '」只能填整数')
  const sumRow = db.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_batches WHERE product_id = ?').get(prod.id)
  const before = sumRow ? Number(sumRow.q) : 0
  if (before === target) throw new Error('库存本来就是 ' + before + '，没有变化')
  const why = String(reason ?? '').trim() || '手机端改库存'
  return inTransaction(db, () => {
    // ⚠️ applyStockTake 的 sku 分支遇到「这个商品一条批次都没有」会 continue 跳过（盘点时那是合理的：
    //    没批次就等于没进过货）。但改数量不能这样 —— 老板填了 5 就得是 5，
    //    否则界面说改好了、账上没动。所以先补一条数量 0 的批次当容器，随后被写成目标值。
    const batchN = db.prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE product_id = ?').get(prod.id)
    if (!batchN || Number(batchN.n) === 0) {
      if (target > 0) {
        db.prepare(
          `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id, expiry_date, notes)
           VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, ?)`,
        ).run(prod.id, nextBatchNo(db), prod.cost_price ?? 0, prod.location ?? null, today(), '手机端改库存补建批次')
      } else {
        return { productId: prod.id, product: productLabel(prod), before, after: 0, diff: -before, takeNo: '' }
      }
    }
    const takeNo = nextTakeNo(db)
    const info = db
      .prepare(
        `INSERT INTO stock_takes (take_no, status, location_filter, category_filter, supplier_filter, started_at, completed_at, operator, mode)
         VALUES (?, '进行中', NULL, NULL, NULL, ?, NULL, ?, 'sku')`,
      )
      .run(takeNo, now(), operator ?? '')
    const takeId = Number(info.lastInsertRowid)
    const item = db
      .prepare(
        `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      )
      .run(takeId, prod.id, before, target, why)
    applyStockTake(db, takeId, [{ itemId: Number(item.lastInsertRowid), actualQty: target, reason: why }], operator)
    return { productId: prod.id, product: productLabel(prod), before, after: target, diff: target - before, takeNo }
  })
}
