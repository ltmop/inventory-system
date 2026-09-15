// 库位调拨（stock transfer）——把货从一个库位搬到另一个库位：
// **不改数量、不改成本、不写销售流水**，只改批次的 location，并留一条 audit_log。
//
// 🔴 为什么必须这样设计（2026-09-15 只读取证，见 docs/待办-优选仓24个商品-20260915.md）：
//   「优选仓备货」过去是用**出库**记的（`channel='优选仓'`、`selling_price` 为空），后果三条：
//     ① 货从账上消失 —— 批次数量被扣成 0（24 个商品结存 0、货值 ¥0）；
//     ② 那 31 笔 out 进了"出库件数"统计，看起来像卖了 120 件；
//     ③ 更要命的是：只要以后有人给这类出库补上售价，它立刻被算成**销售**，
//        营业额与毛利直接虚增（analytics 的三行公式就是按 type='out' 算的）。
//
//   而 `transactions.type` 在 db.js 里有 **CHECK 约束**（只允许 in/out/return/exchange/waste），
//   加不了 'transfer' 这种新类型。所以：
//     **调拨不写 transactions** —— 于是库存总量不变、库存金额不变、营业额/毛利完全不受影响。
//   这是"不破坏既有口径"的最小实现：宁可少记一条流水，也不能让它污染销售口径。
//
// 只读关系：本命令会写 inventory_batches 与 audit_log（在同一个事务里）。

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
// 功能开关（P3）：**在执行点拦**，不只在界面上藏起来 —— 藏 UI 不等于关了，直接调接口照样能写库
import * as flags from '../flags.js'

/** 库位归一：null 与空串都当"未填库位"，避免它们被当成两个不同库位 */
const normLoc = (v) => {
  const s = v == null ? '' : String(v).trim()
  return s
}

/**
 * 把 `quantity` 件货从 `fromLocation` 调到 `toLocation`。
 *
 * @param {object} p
 * @param {number} p.productId
 * @param {number} p.quantity
 * @param {string} [p.fromLocation]  不填 = 从任意库位按先进先出取
 * @param {string} p.toLocation      必填（空字符串代表"清空库位"，一般不用）
 * @param {number} [p.unitCost]      目标批次成本（分）。不填 = 沿用源批次成本（**推荐**）
 * @param {string} [p.operator]
 * @param {string} [p.note]
 * @returns {{ productId:number, product:string, moved:number, unitCosts:number[], fromBatches:Array, toBatches:Array }}
 */
export function transferStock(db, { productId, quantity, fromLocation, toLocation, unitCost, operator, note } = {}) {
  // 开关检查放在**最前面**：关掉时连"商品存不存在"都不该问，更不许写库
  if (!flags.isEnabled('stockTransfer')) throw new Error('「库位调拨」当前已关闭（功能开关）')
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
  if (!prod) throw new Error('商品不存在')
  const qty = assertQuantity(quantity, '调拨数量', prod.unit === '米' ? '米' : '件')
  const to = normLoc(toLocation)
  const from = fromLocation === undefined ? undefined : normLoc(fromLocation)
  if (from !== undefined && from === to) throw new Error('源库位与目标库位相同，不需要调拨')
  if (unitCost != null) assertFen(unitCost, '调拨成本价')

  return inTransaction(db, () => {
    const ts = now()
    // 源批次：先进先出（inbound_date 早的先出；没有日期的排最后）
    const all = db.prepare(
      'SELECT * FROM inventory_batches WHERE product_id = ? AND quantity > 0 ORDER BY (inbound_date IS NULL), inbound_date, id',
    ).all(productId)
    const pool = from === undefined ? all : all.filter((b) => normLoc(b.location) === from)
    if (pool.length === 0) throw new Error(from === undefined ? '这个商品没有任何库存可调' : `库位「${from || '未填'}」里没有这个商品的库存`)

    const total = pool.reduce((s, b) => s + b.quantity, 0)
    if (total < qty) throw new Error(`库存不足：库位「${from ?? '任意'}」只有 ${total} ${prod.unit === '米' ? '米' : '件'}，要调 ${qty}`)

    let left = qty
    const fromBatches = [], toBatches = [], unitCosts = []
    // ⚠️ 两条跨库兼容的硬规矩（2026-09-15 被 schema 抓到）：
    //   ① **不许在 inventory_batches 上写 updated_at / guid** ——
    //      中心库那份表**没有这两列**（本机库有），写了就在中心库直接报错。
    //      现有命令（createInbound / stocktake 的盘盈盘亏）也都刻意不碰它们，这里保持一致。
    //   ② inbound_date 与 cost_price 都是 NOT NULL → 源批次取值要带兜底。
    const updSrc = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
    const insDst = db.prepare(
      `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id, expiry_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const b of pool) {
      if (left <= 0) break
      const take = Math.min(b.quantity, left)
      const cost = unitCost != null ? unitCost : (b.cost_price ?? 0)
      updSrc.run(b.quantity - take, b.id)
      fromBatches.push({ batchId: b.id, batchNo: b.batch_no, taken: take, left: b.quantity - take, costPrice: b.cost_price })
      const batchNo = nextBatchNo(db)
      const info = insDst.run(
        productId, batchNo, take, cost, to || null, b.inbound_date ?? today(), b.supplier_id ?? null,
        b.expiry_date ?? null, `调拨自 ${b.batch_no ?? '#' + b.id}`,
      )
      toBatches.push({ batchId: Number(info.lastInsertRowid), batchNo, quantity: take, costPrice: cost, location: to || null })
      unitCosts.push(cost)
      left -= take
    }

    logAudit(db, '库位调拨', `${productLabel(prod)} x${qty}`,
      { from: from ?? '(任意)', to: to || '(空)', quantity: qty, unitCosts, fromBatches: fromBatches.map((b) => b.batchNo), toBatches: toBatches.map((b) => b.batchNo), note: note ?? null },
      operator)

    return { productId, product: productLabel(prod), moved: qty, unitCosts, fromBatches, toBatches }
  })
}

/**
 * 某商品在各库位的结存（调拨前后自查用；也是"账上货到底在哪"的单一答案）。
 * 只读。
 */
export function stockByLocation(db, productId) {
  const rows = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(location), ''), '(未填)') AS location,
            COUNT(*) AS batches, COALESCE(SUM(quantity), 0) AS qty,
            COALESCE(SUM(quantity * cost_price), 0) AS value
     FROM inventory_batches WHERE product_id = ? GROUP BY 1 ORDER BY qty DESC`,
  ).all(productId)
  return rows.map((r) => ({ ...r, qty: Math.round(r.qty * 1000) / 1000, value: Math.round(r.value) }))
}
