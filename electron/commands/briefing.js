// AI 简报（第一阶段：**只算不推**）——把"这周该动手的事"算成人能看的一小张单子。
//
// 为什么放在命令层（红线①：口径只走 electron/commands/）：
//   下面几块判断全部建立在**已有口径**上，一个都不自己发明：
//     · 低库存 = ./reports.js 的 lowStockProducts（全站统一：总库存 < COALESCE(min_stock, 5)）
//     · 营业额/毛利 = ./analytics.js 头部那三行公式（"换货退旧"要从退货里剔掉）
//     · 结存/库存金额 = Σ inventory_batches.quantity
//   本模块只做**合成**与**建议量**，不改任何口径。
//
// 只读：全部 SELECT。
//
// ⚠️ 2026-09-15 第一版踩到的坑（owner 用它自己店的数据当场证伪）：
//   第一版把**所有 type='out'** 当成"动销"，于是算出 14 条"该补货"——**全是假阳性**。
//   真相：那 31 笔出库是「优选仓发货」（`channel='优选仓'`、`selling_price IS NULL`、`unit_cost=0`、
//   且都是"入 10 当天出 10"），根本不是零售动销。
//   → 修正后的口径铁律：**只有"有售价的出库"才算卖出去**（selling_price 非空）；
//     无售价的出库是**渠道发货**，单独一类，**不参与补货建议**（本机看不到渠道那边的销量）。
//   教训与"宁少勿多"同源：宁可什么都不说，也不能说错 —— 说错一次，店主就再也不看了。

import { lowStockProducts, DEFAULT_MIN_STOCK } from './reports.js'

const DAY_MS = 86400 * 1000

/** 阈值（保守取法，宁少勿多；调用方可覆盖） */
export const BRIEFING_THRESHOLDS = {
  // 数据够不够的门槛：真实零售（有售价的出库）太少时，任何"建议"都是编的
  minRetailSales: 20,
  quietAfterDays: 14,     // 超过这么多天没有真实零售，先说"生意停了/没录进来"
  marginWindowDays: 30,
  marginMinQty: 3,
  marginDropPoints: 10,
  restockWindowDays: 90,
  restockMinSold: 5,
  restockCoverDays: 30,
}

const label = (p) => [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code || ('#' + p.id)
const isRetail = (t) => t.selling_price != null

/**
 * 数据体检：这份账里到底有没有"生意"。
 * 简报的第一段永远是它 —— 数据不够时**直接闭嘴**，而不是硬凑三条建议。
 */
export function assessDataSufficiency(db, opts = {}) {
  const { minRetailSales, quietAfterDays, restockWindowDays } = { ...BRIEFING_THRESHOLDS, ...opts }
  const total = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND selling_price IS NOT NULL").get().n
  const sinceIso = new Date(Date.now() - restockWindowDays * DAY_MS).toISOString()
  const recent = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND selling_price IS NOT NULL AND timestamp >= ?").get(sinceIso).n
  const last = db.prepare("SELECT MAX(timestamp) t FROM transactions WHERE type='out' AND selling_price IS NOT NULL").get().t
  const daysSinceLastSale = last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY_MS) : null
  const reasons = []
  if (total < minRetailSales) reasons.push(`全部历史里只有 ${total} 笔真实零售（门槛 ${minRetailSales} 笔）→ 毛利/动销分析在统计上没有意义`)
  if (daysSinceLastSale != null && daysSinceLastSale > quietAfterDays) reasons.push(`最后一笔真实零售在 ${daysSinceLastSale} 天前 → 要么生意停了，要么单子没录进这个账`)
  if (last == null) reasons.push('一笔真实零售都没有（有售价的出库为 0）')
  return { retailSalesTotal: total, retailSalesInWindow: recent, windowDays: restockWindowDays, lastRetailAt: last, daysSinceLastSale, enough: reasons.length === 0, reasons }
}

/** 净出库量（口径同 analyticsTrend：return 记负、"换货退旧"不算），再按"有没有售价"分成两类 */
function outflowByProduct(db, sinceIso) {
  const rows = db.prepare(
    "SELECT product_id, type, notes, quantity, selling_price FROM transactions WHERE type IN ('out','return') AND timestamp >= ?",
  ).all(sinceIso)
  const retail = new Map()   // 有售价 → 真卖出去了
  const channel = new Map()  // 无售价 → 渠道发货/备货出库，不是零售
  for (const t of rows) {
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const sign = t.type === 'return' ? -1 : 1
    const bag = isRetail(t) ? retail : channel
    bag.set(t.product_id, (bag.get(t.product_id) ?? 0) + t.quantity * sign)
  }
  return { retail, channel }
}

/**
 * ① 账对不上：负库存 / 卖了但从没入库 / 盘点状态 / **渠道商品零库存零成本**
 *   这一类的意义是"先修账再谈别的"：账不对时，补货与毛利建议都不可信。
 */
export function findStockAnomalies(db) {
  const negative = db.prepare(
    `SELECT p.id, p.sku_code, p.brand, p.model, p.location, SUM(b.quantity) AS stock
     FROM inventory_batches b JOIN products p ON p.id = b.product_id
     GROUP BY b.product_id HAVING SUM(b.quantity) < 0 ORDER BY stock ASC`,
  ).all()

  const outNoBatch = db.prepare(
    `SELECT p.id, p.sku_code, p.brand, p.model,
            (SELECT COUNT(*) FROM transactions t WHERE t.product_id = p.id AND t.type = 'out') AS outCount
     FROM products p
     WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.product_id = p.id AND t.type = 'out')
       AND NOT EXISTS (SELECT 1 FROM inventory_batches b WHERE b.product_id = p.id)
     ORDER BY outCount DESC`,
  ).all()

  // 盘点：**必须区分"盘了但没差异"和"还没盘"** —— 第一版把"进行中、盘了 0 项"说成"差异 0 项 ✓"，是误导
  const lastTake = db.prepare('SELECT id, take_no, status, started_at, completed_at FROM stock_takes ORDER BY id DESC LIMIT 1').get()
  let take = null
  if (lastTake) {
    const totalItems = db.prepare('SELECT COUNT(*) n FROM stock_take_items WHERE stock_take_id = ?').get(lastTake.id).n
    const counted = db.prepare('SELECT COUNT(*) n FROM stock_take_items WHERE stock_take_id = ? AND actual_qty IS NOT NULL').get(lastTake.id).n
    const items = counted
      ? db.prepare(
        `SELECT i.system_qty, i.actual_qty, i.reason, p.brand, p.model, p.sku_code
         FROM stock_take_items i JOIN products p ON p.id = i.product_id
         WHERE i.stock_take_id = ? AND i.actual_qty IS NOT NULL AND i.actual_qty != COALESCE(i.system_qty, 0)
         ORDER BY ABS(i.actual_qty - COALESCE(i.system_qty, 0)) DESC`,
      ).all(lastTake.id)
      : []
    take = { ...lastTake, totalItems, counted, notCounted: totalItems - counted, diffCount: items.length, items: items.slice(0, 10) }
  }

  // 渠道商品：出过货、但账上库存 0 且成本 0 —— 货在优选仓，本机账里既没库存也没价值
  const channelZero = db.prepare(
    `SELECT p.id, p.sku_code, p.brand, p.model, p.location,
            COALESCE(s.q, 0) AS stock, COALESCE(s.v, 0) AS value,
            (SELECT COALESCE(SUM(t.quantity), 0) FROM transactions t WHERE t.product_id = p.id AND t.type = 'out' AND t.selling_price IS NULL) AS shipped
     FROM products p
     LEFT JOIN (SELECT product_id, SUM(quantity) q, SUM(quantity * cost_price) v FROM inventory_batches GROUP BY product_id) s ON s.product_id = p.id
     WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.product_id = p.id AND t.type = 'out' AND t.selling_price IS NULL)
       AND COALESCE(s.q, 0) <= 0 AND COALESCE(s.v, 0) <= 0
     ORDER BY shipped DESC`,
  ).all()

  return { negative, outNoBatch, take, channelZero }
}

/**
 * ② 毛利异常：近 N 天 vs 前 N 天，按商品比毛利率（只比两个窗口都卖够件数的）
 *   口径完全按 analytics.js 头部；`selling_price` 为空的行（渠道发货）不参与。
 */
export function findMarginAnomalies(db, opts = {}) {
  const { marginWindowDays: win, marginMinQty: minQty, marginDropPoints: dropPts } = { ...BRIEFING_THRESHOLDS, ...opts }
  const now = Date.now()
  const since = new Date(now - 2 * win * DAY_MS).toISOString()
  const splitAt = now - win * DAY_MS
  const rows = db.prepare(
    `SELECT t.product_id, t.timestamp, t.type, t.notes, t.quantity, t.selling_price, t.unit_price,
            p.brand, p.model, p.sku_code
     FROM transactions t JOIN products p ON p.id = t.product_id
     WHERE t.type IN ('out','return') AND t.selling_price IS NOT NULL AND t.timestamp >= ?`,
  ).all(since)

  const byP = new Map()
  for (const t of rows) {
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const sign = t.type === 'return' ? -1 : 1
    const cur = byP.get(t.product_id) ?? {
      productId: t.product_id, name: label(t), sku: t.sku_code,
      recent: { revenue: 0, profit: 0, qty: 0 }, prev: { revenue: 0, profit: 0, qty: 0 },
    }
    const bucket = new Date(t.timestamp).getTime() >= splitAt ? cur.recent : cur.prev
    bucket.qty += t.quantity * sign
    bucket.revenue += t.selling_price * t.quantity * sign
    if (t.unit_price != null) bucket.profit += (t.selling_price - t.unit_price) * t.quantity * sign
    byP.set(t.product_id, cur)
  }

  const compared = [], notComparable = []
  for (const p of byP.values()) {
    const rate = (b) => (b.revenue > 0 ? b.profit / b.revenue : null)
    const recentRate = rate(p.recent), prevRate = rate(p.prev)
    const item = {
      ...p,
      recentRate: recentRate == null ? null : Math.round(recentRate * 1000) / 10,
      prevRate: prevRate == null ? null : Math.round(prevRate * 1000) / 10,
      dropPoints: recentRate != null && prevRate != null ? Math.round((prevRate - recentRate) * 1000) / 10 : null,
    }
    if (p.recent.qty >= minQty && p.prev.qty >= minQty && p.recent.revenue > 0 && p.prev.revenue > 0) compared.push(item)
    else notComparable.push(item)
  }
  const anomalies = compared.filter((p) => p.dropPoints != null && p.dropPoints >= dropPts).sort((a, b) => b.dropPoints - a.dropPoints)
  return { anomalies, comparedCount: compared.length, notComparableCount: notComparable.length, retailTxConsidered: rows.length, windowDays: win }
}

/**
 * ③ 该补货：**低库存 ∩ 有真实零售动销** 才叫该补货。
 *   · 低库存但没零售动销 → 另列（补了就是压货，不是"该补货"）
 *   · 只有渠道发货、没有零售 → 也让位给人判断（本机看不到优选仓那边卖了多少）
 */
export function findRestockNeeds(db, opts = {}) {
  const { restockWindowDays: win, restockMinSold: minSold, restockCoverDays: cover } = { ...BRIEFING_THRESHOLDS, ...opts }
  const sinceIso = new Date(Date.now() - win * DAY_MS).toISOString()
  const { retail, channel } = outflowByProduct(db, sinceIso)
  const low = lowStockProducts(db)

  const needs = [], lowButSlow = [], channelOnly = []
  for (const p of low) {
    const sold = retail.get(p.id) ?? 0
    const shipped = channel.get(p.id) ?? 0
    const base = { id: p.id, sku: p.sku_code, name: label(p), location: p.location, stock: p.stock, threshold: p.threshold, soldInWindow: sold, shippedInWindow: shipped }
    if (sold >= minSold) {
      const daily = sold / win
      const target = Math.ceil(daily * cover)
      const suggest = target - p.stock
      if (suggest > 0) needs.push({ ...base, dailyAvg: Math.round(daily * 100) / 100, coverDays: cover, suggestQty: suggest, targetQty: target })
    } else if (shipped > 0) {
      channelOnly.push(base)   // 有渠道发货、没零售 → 不能替他决定
    } else {
      lowButSlow.push(base)
    }
  }
  needs.sort((a, b) => b.soldInWindow - a.soldInWindow)
  channelOnly.sort((a, b) => b.shippedInWindow - a.shippedInWindow)
  return { needs, lowButSlow, channelOnly, windowDays: win, coverDays: cover }
}

/** 汇总：纯数据，给人看的排版交给调用方 */
export function buildBriefing(db, opts = {}) {
  const thresholds = { ...BRIEFING_THRESHOLDS, ...opts }
  const data = assessDataSufficiency(db, thresholds)
  const stock = findStockAnomalies(db)
  const margin = findMarginAnomalies(db, thresholds)
  const restock = findRestockNeeds(db, thresholds)

  const ledgerIssues = stock.negative.length + stock.outNoBatch.length + (stock.take?.diffCount ?? 0)
  const counts = {
    negativeStock: stock.negative.length,
    soldWithoutBatch: stock.outNoBatch.length,
    stockTakeDiff: stock.take?.diffCount ?? 0,
    channelZeroStock: stock.channelZero.length,
    marginAnomalies: margin.anomalies.length,
    restockNeeds: restock.needs.length,
    lowButSlow: restock.lowButSlow.length,
    channelOnly: restock.channelOnly.length,
    retailSalesTotal: data.retailSalesTotal,
  }

  // 头条优先级：**账对不上 > 数据不足 > 有该补货 > 没事**
  //   ⚠️ 第一版把"数据不足"放在最前面，结果把"账对不上"整段吞掉了 ——
  //   而账实体检（负库存/盘点/渠道商品零值）**恰恰不需要零售数据**，是今天就能修的事。
  //   数据不足只该压住 ②动销补货 与 ③毛利，不该压住 ①。
  let headline, stance
  if (ledgerIssues > 0 || counts.channelZeroStock > 0) {
    stance = 'fix-ledger-first'
    const bits = []
    if (ledgerIssues > 0) bits.push(ledgerIssues + ' 处账对不上')
    if (counts.channelZeroStock > 0) bits.push(counts.channelZeroStock + ' 个渠道商品账上没库存也没价值')
    headline = `先修账：${bits.join('、')}`
  } else if (!data.enough) {
    stance = 'insufficient-data'
    headline = `账是平的，但这份账里没有足够"生意"，所以不给补货/毛利建议：${data.reasons[0]}`
  } else if (counts.restockNeeds > 0) {
    stance = 'actionable'
    headline = `本周有 ${counts.restockNeeds} 个该补货`
  } else {
    stance = 'quiet'
    headline = '这周没有必须动手的事'
  }
  return { generatedAt: new Date().toISOString(), thresholds, data, counts, stock, margin, restock, stance, headline }
}
