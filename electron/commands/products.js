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
  DEFAULT_COST_FEN,
} from './helpers.js'
import { enforceSkuQuota } from '../license.js'
import { assertOwnerAction } from './users.js'
import { pushUndo } from './undo.js'
import { ensureUnit } from './units.js'
import { ensureCategory } from './categories.js'
import { createInbound } from './inbound.js'
import { normalizeSpecName } from './specTemplates.js'

/** 新增商品（会校验 SKU 额度；单位/分类不存在时会自动建档）。 */
export function createProduct(db, input) {
  const ts = now()
  const minStock = minStockOrNull(input.min_stock)
  // 成本价：没填/填 0 一律落兜底价，并打标记让界面提醒人去改（0 会让毛利虚高成营业额）
  const rawCost = Number(input.cost_price)
  const costIsDefault = rawCost > 0 ? 0 : 1
  const costPrice = costIsDefault ? DEFAULT_COST_FEN : rawCost
  // 盘点状态：建档时填了数量（含批量上传）＝这个数已经录过了，直接算已盘点，不再要人手动点一次
  const initialQty = Number(input.quantity ?? input.stock ?? 0)
  const status = input.status ?? (initialQty > 0 ? '已盘点' : '待盘点')
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
        costPrice,
        input.suggest_price ?? null,
        input.location ?? null,
        status,
        ...SPEC_FIELDS.map((f) => specOrNull(input[f])),
        minStock,
        unit,
        ts,
        ts,
      )
    if (costIsDefault) db.prepare('UPDATE products SET cost_is_default = 1 WHERE id = ?').run(info.lastInsertRowid)
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid)
    // 自定义分类/单位自动补录（分类管理、单位管理即时可见）
    ensureCategory(db, row.category)
    ensureUnit(db, row.unit, input.unit_decimal ? 1 : 0)
    logAudit(db, '新建商品', productLabel(row), { sku: row.sku_code, cost_price: row.cost_price, min_stock: minStock }, input.operator)
    return row
  })
}


/**
 * 编辑商品时决定 status（2026-09-22 老板口径）：
 *   「已经批量上传了商品的规格和数量，这种情况下应该是默认已盘点才对，但仍然显示待盘点」。
 * 所以只要这个商品**有数量不为 0 的批次**，编辑动作就不许把它打回「待盘点」——
 * 否则店主改个售价，盘点状态就莫名其妙退回去了。
 */
function statusOfUpdate(v, db, id) {
  const want = v.status ?? '待盘点'
  if (want !== '待盘点') return want
  try {
    const r = db.prepare('SELECT 1 FROM inventory_batches WHERE product_id = ? AND quantity <> 0 LIMIT 1').get(id)
    return r ? '已盘点' : '待盘点'
  } catch (e) { return want }
}

/** 修改商品基本信息；SKU 一经创建不可修改（避免历史流水对不上） */
export function updateProduct(db, id, input) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
  if (!cur) throw new Error('商品不存在')
  // 与现有行合并，允许前端只传要改的字段；SKU 创建后不可改
  const v = { ...cur, ...input, id: cur.id, sku_code: cur.sku_code }
  // 与新建同一条成本规则：人工填了真进价就采信并摘掉"默认价"标记；
  // 留空/填 0 就落兜底 ¥2 并继续挂着标记，界面会提醒人去改（0 会让毛利虚高成营业额）。
  const rawCost = Number(v.cost_price)
  const costIsDefault = rawCost > 0 ? 0 : 1
  const costPrice = costIsDefault ? DEFAULT_COST_FEN : rawCost
  const minStock = minStockOrNull(v.min_stock)
  const unit = String(v.unit || '件').trim() || '件'
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE products SET category = ?, sub_category = ?, brand = ?, model = ?, cost_price = ?, cost_is_default = ?, suggest_price = ?, location = ?, status = ?, rod_length = ?, rod_action = ?, power_rating = ?, line_number = ?, hook_size = ?, color = ?, material = ?, expiry_date = ?, min_stock = ?, unit = ?, photo_path = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      v.category,
      v.sub_category ?? null,
      v.brand ?? null,
      v.model ?? null,
      costPrice,
      costIsDefault,
      v.suggest_price ?? null,
      v.location ?? null,
      statusOfUpdate(v, db, id),
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
    if (cur) {
      logAudit(db, '删商品', productLabel(cur), { sku: cur.sku_code }, operator)
      // 留一份可撤回快照：删错了能一键恢复（连原 id 一起恢复，条码/引用不断链）
      pushUndo(db, {
        channel: 'product:delete',
        label: productLabel(cur),
        detail: '删除商品 ' + (cur.sku_code || ('#' + cur.id)),
        undo: { kind: 'product', row: cur },
        operator,
      })
    }
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
 * 按成本批量定价（2026-09-20）：导入的库存常常只有成本、没有售价，导致开单每次都要现场输价。
 * 规则：售价 = round(成本 × ratio)，最常见的是 ratio=2（成本×2），老板觉得不合适再单个改。
 * - onlyEmpty=true（默认）：只补「还没定价」的（suggest_price 为 NULL 或 ≤0），不动已定过价的；
 * - 成本 ≤0 的跳过并计数（×2 还是 0，定了也没法卖），返回 skippedNoCost 让界面如实说。
 * 一次事务 + 一条审计，不逐个请求（省得撞写限流）。
 */
export function priceFromCost(db, { ratio = 2, onlyEmpty = true, ids = null, operator = null } = {}) {
  const r = Number(ratio)
  if (!(r > 1)) throw new Error('加价倍数必须大于 1（例如 2 表示成本×2）')
  const list = Array.isArray(ids) && ids.length ? ids : null
  const where = []
  const params = []
  if (list) { where.push('id IN (' + list.map(() => '?').join(',') + ')'); params.push(...list) }
  const rows = db.prepare('SELECT id, sku_code, brand, model, cost_price, suggest_price FROM products' + (where.length ? ' WHERE ' + where.join(' AND ') : '')).all(...params)
  let skippedNoCost = 0, skippedPriced = 0
  const targets = []
  for (const p of rows) {
    const cost = Number(p.cost_price) || 0
    if (cost <= 0) { skippedNoCost++; continue }
    if (onlyEmpty && p.suggest_price != null && Number(p.suggest_price) > 0) { skippedPriced++; continue }
    targets.push({ id: p.id, price: Math.max(1, Math.round(cost * r)) })
  }
  if (!targets.length) return { ok: true, updated: 0, skippedNoCost, skippedPriced, ratio: r }
  return inTransaction(db, () => {
    const ts = now()
    const upd = db.prepare('UPDATE products SET suggest_price = ?, updated_at = ? WHERE id = ?')
    for (const t of targets) upd.run(t.price, ts, t.id)
    logAudit(db, '按成本定价', `按成本×${r} 给 ${targets.length} 个商品补售价`,
      { count: targets.length, ratio: r, onlyEmpty, skippedNoCost }, operator)
    return { ok: true, updated: targets.length, skippedNoCost, skippedPriced, ratio: r }
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


/**
 * 一次建好一个商品的多个规格 —— 老板 2026-09-22 的核心诉求。
 *
 * 他的原话：「一个品牌的产品，规格很多，但却要每一个都录入，而且还得拍照，规格命名格式不同一」
 *          「我点击了一个狼王的鱼竿的一个商品，商品下面就可以出来很多规格让我选择」
 *          「就像一个文件夹一样…而且名字是统一的」
 *
 * 设计（对着他的话来的）：
 *   · 品牌 + 商品名 = **文件夹名**；规格 = 文件夹里的文件；名字统一由 specTemplates 归一；
 *   · brand / model / category / unit / 进价 / 售价 / **照片** 是这一族共用的，填一次；
 *   · 每个规格只填「名字 + 数量」（价格可以单独覆盖）；
 *   · **共用一张照片**：同款不同规格本来长得一样，不用一个一个拍（这就是他最烦的那步）；
 *   · 全部先校验再建：规格名去重、同族已有规格拦截、SKU 配额一次性查；
 *     中途某条失败不会把前面的回滚掉（inTransaction 不支持嵌套），所以逐条报清楚哪条失败。
 */
export function createProductSpecs(db, input) {
  const brand = String(input?.brand ?? '').trim()
  const model = String(input?.model ?? '').trim()
  if (!brand) throw new Error('先填品牌 —— 「品牌 + 商品名」就是这一族的文件夹名')
  if (!model) throw new Error('先填商品名（型号），规格都挂在它下面')
  const raw = Array.isArray(input?.specs) ? input.specs : []
  const specs = raw
    .map((s) => ({
      name: normalizeSpecName(input.category, s && s.name),
      qty: Math.max(0, Number(s && s.quantity) || 0),
      price: s && s.suggest_price != null && s.suggest_price !== '' ? s.suggest_price : null,
      cost: s && s.cost_price != null && s.cost_price !== '' ? s.cost_price : null,
    }))
    .filter((s) => s.name)
  if (!specs.length) throw new Error('至少要填一个规格')
  const seen = new Set()
  for (const s of specs) {
    if (seen.has(s.name)) throw new Error('规格「' + s.name + '」填了两次 —— 同一族里规格名不能重复')
    seen.add(s.name)
  }
  // 同族已有的规格拦下来，别悄悄建出重复档案
  const dup = []
  for (const s of specs) {
    const hit = db
      .prepare("SELECT id FROM products WHERE COALESCE(brand,'') = ? AND COALESCE(model,'') = ? AND COALESCE(sub_category,'') = ?")
      .get(brand, model, s.name)
    if (hit) dup.push(s.name)
  }
  if (dup.length) throw new Error('这几个规格已经有了：' + dup.join('、') + '（要改就到库存里点它）')
  enforceSkuQuota(db, specs.length)   // 配额一次性查，别建到一半才报

  const photo = input?.photo_path ? String(input.photo_path) : null
  const ok = []
  const failed = []
  for (const s of specs) {
    try {
      const row = createProduct(db, {
        brand,
        model,
        category: input.category,
        sub_category: s.name,
        unit: input.unit || '件',
        cost_price: s.cost != null ? s.cost : input.cost_price,
        suggest_price: s.price != null ? s.price : input.suggest_price,
        quantity: s.qty,
        status: input.status,
        operator: input.operator,
      })
      // 共用一张图：整族都挂同一张，省掉 N 次拍照
      if (photo) db.prepare('UPDATE products SET photo_path = ? WHERE id = ?').run(photo, row.id)
      if (s.qty > 0) {
        createInbound(db, {
          productId: row.id,
          quantity: s.qty,
          costPrice: s.cost != null ? s.cost : input.cost_price,
          operator: input.operator,
        })
      }
      ok.push({ id: row.id, name: s.name, quantity: s.qty, sku_code: row.sku_code })
    } catch (e) {
      failed.push({ name: s.name, reason: String(e?.message ?? e) })
    }
  }
  if (ok.length) {
    logAudit(db, '批量建规格', brand + ' ' + model, { brand, model, count: ok.length, specs: ok.map((x) => x.name + '×' + x.quantity) }, input.operator)
  }
  return { ok: true, brand, model, photo_path: photo, created: ok, failed }
}
