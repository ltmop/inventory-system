// 共享工具与常量：被各功能命令模块复用，不承载具体业务写命令。
// 原为 electron/commands.js 的顶层/内部工具，拆分后集中在这里统一 export。

// now() 保持 UTC ISO 时间戳不变；today() 用本地日期（批次号/盘点单号按门店本地日期取当天序号）
export const now = () => new Date().toISOString()
export const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

/** 校验数量必须是正整数（拒绝 0/负数/小数/NaN/null/undefined） */
export function assertPositiveInt(v, name) {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`${name}必须是正整数，收到：${v}`)
  }
}

/** 归一化数量到 1 位小数（件商品整数不变；米商品 3.5 米归一后仍是 3.5） */
export function roundQty(v) {
  return Math.round((Number(v) + Number.EPSILON) * 10) / 10
}

/**
 * 按商品计量单位校验数量（v2.2）：
 * - 件（默认）：必须是正整数（与 assertPositiveInt 同口径）
 * - 米：必须是有限正数，且最多 1 位小数（roundQty 归一后无精度损失）
 * 非法直接 throw，合法返回归一化数量。
 */
export function assertQuantity(v, name, unit) {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name}必须是数字，收到：${v}`)
  if (unit === '米') {
    if (n <= 0) throw new Error(`${name}必须大于 0，收到：${v}`)
    const rounded = roundQty(n)
    if (Math.abs(rounded - n) >= 1e-9) {
      throw new Error(`${name}最多 1 位小数，收到：${v}`)
    }
    return rounded
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name}必须是正整数，收到：${v}`)
  }
  return n
}

/** 校验金额（单位：分）必须是非负整数 */
export function assertFen(v, name) {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`${name}必须是非负整数（单位：分），收到：${v}`)
  }
}

// 收款方式白名单（出库收款 / 退货退款 / 客户还款共用）
export const PAYMENT_METHODS = ['现金', '微信', '支付宝', '其他']

/** 校验收款方式：null/undefined 放行（表示未记录），给了必须在白名单里 */
export function assertPayMethod(v, name = '收款方式') {
  if (v == null) return null
  if (!PAYMENT_METHODS.includes(v)) {
    throw new Error(`${name}必须是：${PAYMENT_METHODS.join(' / ')}，收到：${v}`)
  }
  return v
}

/** 最低库存预警线归一：留空/null → NULL（用默认阈值 5），否则必须是非负整数 */
export function minStockOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`最低库存预警线必须是非负整数或留空，收到：${v}`)
  }
  return n
}

// ---------- 操作日志（audit_log） ----------
// 埋点规则：日志 INSERT 与业务写入在同一事务里，一起提交/一起回滚；
// 校验失败/提前 return（库存不足等）时零写入，自然也不留日志。

/** 写一条操作日志（仅供各写命令在事务内调用） */
export function logAudit(db, action, entity, detail, operator) {
  db.prepare(
    'INSERT INTO audit_log (action, entity, detail, operator, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    action,
    entity ?? null,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    operator ?? null,
    now(),
  )
}

/** 商品显示名：品牌+型号，都没有回退 SKU（与 customerStatement / server.js 同口径） */
export function productLabel(p) {
  return [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code
}

export function pad(n, w = 3) {
  return String(n).padStart(w, '0')
}

/** 批次号：PO{YYYYMMDD}-{当日序号} */
export function nextBatchNo(db) {
  const prefix = `PO${today().replaceAll('-', '')}-`
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE batch_no LIKE ?')
    .get(`${prefix}%`)
  return `${prefix}${pad(row.n + 1)}`
}

/** 盘点单号：ST{YYYYMMDD}-{当日序号} */
export function nextTakeNo(db) {
  const prefix = `ST${today().replaceAll('-', '')}-`
  const row = db.prepare('SELECT COUNT(*) AS n FROM stock_takes WHERE take_no LIKE ?').get(`${prefix}%`)
  return `${prefix}${pad(row.n + 1)}`
}

/** 多语句写操作的事务包装 */
export function inTransaction(db, fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// 品类代码速查（与 src/types/index.ts 的 CATEGORY_CODES 保持一致）；SKU 规则简化后
// 这里只用于品类合法性校验（importBatch / createStockTake），不再参与 SKU 生成
export const CATEGORY_CODES = {
  '鱼竿': 'FG', '鱼线': 'XL', '鱼钩': 'YG', '渔轮': 'YL',
  浮漂: 'FP', 铅坠: 'QZ', 饵料: 'ER', 路亚假饵: 'JL',
  渔网: 'WL', 钓箱钓椅: 'ZX', '伞/遮阳': 'SP', 支架: 'ZJ',
  服装穿戴: 'FZ', 灯具: 'DJ', 工具配件: 'GJ', 收纳包具: 'BN',
  增氧保鲜: 'ZY', 活饵: 'HE', 小药: 'XY', 其他: 'QT',
}

/**
 * 生成纯数字 SKU（无条码商品用）：从 1001 开始，取现有纯数字 SKU 的 max+1。
 * 注意：条码直接当 SKU 的也是纯数字（EAN-13 是 13 位），不参与这个序列，
 * 所以只统计 6 位以内的纯数字编号；老五段式 SKU（JC-*）天然不含在内。
 * @param {Set<string>} [reserved] 本次导入已占用、尚未落库的编号（importBatch 用）
 */
export function nextNumericSku(db, reserved) {
  const row = db
    .prepare(
      `SELECT MAX(CAST(sku_code AS INTEGER)) AS m FROM products
       WHERE sku_code <> '' AND sku_code NOT GLOB '*[^0-9]*' AND CAST(sku_code AS INTEGER) < 1000000`,
    )
    .get()
  let n = Math.max(1001, (row.m ?? 0) + 1)
  const exists = db.prepare('SELECT 1 FROM products WHERE sku_code = ?')
  while (exists.get(String(n)) || reserved?.has(String(n))) n++
  return String(n)
}

// 商品规格字段（通用版，全部可空）：颜色/材质/保质期等
export const SPEC_FIELDS = [
  'rod_length', 'rod_action', 'power_rating', 'line_number',
  'hook_size', 'color', 'material', 'expiry_date',
]

/** 规格字段归一：去首尾空白，空串/undefined 一律落 NULL（与 nullable 字段同口径） */
export function specOrNull(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

// 商品状态枚举（与 schema CHECK 一致）
export const PRODUCT_STATUSES = ['待盘点', '已盘点', '在售', '已售罄', '停产']

/** 退货/换货共用：把数量加回最近入库的批次；无批次则新建"退货回补"批次。返回 { batchId, unitCost } */
export function addBackToLatestBatch(db, productId, quantity) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
  if (!product) throw new Error('商品不存在')
  const latest = db
    .prepare(
      `SELECT * FROM inventory_batches WHERE product_id = ?
       ORDER BY inbound_date DESC, id DESC LIMIT 1`,
    )
    .get(productId)
  if (latest) {
    db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(
      latest.quantity + quantity,
      latest.id,
    )
    return { batchId: latest.id, unitCost: latest.cost_price }
  }
  const unitCost = product.cost_price ?? 0
  const batchNo = nextBatchNo(db)
  const info = db
    .prepare(
      `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
       VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(productId, batchNo, quantity, unitCost, today())
  return { batchId: Number(info.lastInsertRowid), unitCost }
}

/** 单个客户的赊销净额（分）：out 未付部分 - return 冲减 + exchange 退差价冲减 */
export function netCreditOf(db, customerId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
         WHEN type = 'out' AND selling_price IS NOT NULL
           THEN quantity * selling_price - COALESCE(paid_amount, quantity * selling_price)
         WHEN type = 'return' AND selling_price IS NOT NULL
           THEN -quantity * selling_price
         WHEN type = 'exchange' AND paid_amount IS NOT NULL
           THEN paid_amount
         ELSE 0 END), 0) AS net
       FROM transactions WHERE customer_id = ?`,
    )
    .get(customerId)
  return row.net
}

/** 单个客户的当前欠款（分）= 赊销净额 - 还款累计；可为负（预收） */
export function outstandingOf(db, customerId) {
  const paid = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE customer_id = ?')
    .get(customerId).total
  return netCreditOf(db, customerId) - paid
}

/** 采购单号：PO{YYYYMMDD}-{当日序号}（与批次号同风格，独立序号互不影响） */
export function nextPoNo(db) {
  const prefix = `PO${today().replaceAll('-', '')}-`
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE po_no LIKE ?')
    .get(`${prefix}%`)
  return `${prefix}${pad(row.n + 1)}`
}

// 多级定价（v2.0）：tier 取值与 schema CHECK 一致：retail/regular/VIP/wholesale/promo
export const PRICE_TIERS = ['retail', 'regular', 'VIP', 'wholesale', 'promo']

/** 客户价格档校验：NULL=零售默认，否则必须是五档之一 */
export function assertPriceLevel(v) {
  if (v != null && !PRICE_TIERS.includes(v)) {
    throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${v}`)
  }
}

/**
 * 解析保质期文本为本地日期（只认两种写法，其余返回 null 跳过）：
 * 'YYYY-MM' → 当月最后一天（保质"到几月"的常识口径）；'YYYY-MM-DD' → 当天
 */
export function parseExpiryDate(s) {
  const text = String(s ?? '').trim()
  let m = /^(\d{4})-(\d{2})$/.exec(text)
  if (m) return new Date(Number(m[1]), Number(m[2]), 0) // 当月最后一天
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return null
}

export const EXPENSE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
