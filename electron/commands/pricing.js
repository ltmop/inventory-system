// 定价建议引擎（决策层 MVP-2）· 单一来源：命令层 / CLI / IPC 共用 buildPricing(db)。
// 与清仓引擎（MVP-1, commands/clearance.js）同一模子：
//   纯规则、只读、零写入；只给「建议区间」绝不给单一价、绝不自动改价；
//   近 30 天有动销不做降价建议（降档护栏，保护在动商品的收入）；
//   无成本 / 无售价不硬出；已标记清仓的商品交给清仓引擎，不重复建议（防两引擎打架）。
//
// ⚠️ 口径（与 electron/commands/analytics.js 一致，勿混）：
//   transactions.unit_price     在 type='out' 上是【成本】口径（批次成本）
//   transactions.selling_price  在 type='out' 上是【实际成交价】，老流水可能为 NULL
//   毛利 = (selling_price - unit_price) × quantity
//   故本引擎的「实际成交价」一律取 selling_price；成本一律取 inventory_batches.cost_price。
//
// 常量：v1 固定阈值（与清仓引擎一致，本期不做设置 UI）。
const PRICING_MIN_MARGIN = 0.15     // 毛利率下限：低于此 → 毛利偏低，建议提价
const PRICING_MAX_MARGIN = 0.6      // 毛利率上限：高于此且近 30 天无动销 → 可降价促动销
const PRICING_WINDOW_DAYS = 90      // 实际成交价回看窗口（天）
const PRICING_GUARD_MOVE_DAYS = 30  // 降档护栏：近 N 天有动销 → 不给降价建议

// 建议区间 = 单位成本 × [lo, hi]
//   FLOOR 亏本在售：至少要回到成本之上（保本微利）
//   RAISE 毛利偏低：拉到 35%~60% 加成
//   CUT   毛利偏高且不动销：小幅让利促动销，仍守住底线
const PRICING_RANGE = { FLOOR: [1.05, 1.15], RAISE: [1.35, 1.6], CUT: [1.1, 1.25] }

const round2 = (x) => Math.round(x * 100) / 100
const localDay = (iso) => String(iso || '').slice(0, 10)
const dayDiff = (from, to) => {
  const a = new Date(String(from).slice(0, 10) + 'T00:00:00')
  const b = new Date(String(to).slice(0, 10) + 'T00:00:00')
  return Math.round((b - a) / 86400000)
}
function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y)
  if (a.length === 0) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

export function buildPricing(db) {
  const t = localDay(new Date().toISOString())
  const thresholds = {
    minMargin: PRICING_MIN_MARGIN,
    maxMargin: PRICING_MAX_MARGIN,
    windowDays: PRICING_WINDOW_DAYS,
    guardMoveDays: PRICING_GUARD_MOVE_DAYS,
    range: PRICING_RANGE,
  }

  // 数据窗口：优先用「带售价」的真实成交流水；没有则退到商品档案建议价（并把证据强度如实标注）。
  // 只有当两者都没有时才真正无据可评（不硬出）。
  const pricedSale = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='out' AND selling_price IS NOT NULL").get().n
  const anySuggest = db.prepare('SELECT COUNT(*) AS n FROM products WHERE suggest_price > 0').get().n
  const dataWindowOk = pricedSale > 0
  if (pricedSale === 0 && anySuggest === 0) {
    return {
      generatedAt: new Date().toISOString(),
      dataWindowOk: false,
      basis: 'none',
      totalCandidate: 0,
      byPriority: { P0: 0, P1: 0, P2: 0 },
      avgMarginPct: null,
      items: [],
      skipped: { noCost: 0, noPrice: 0, clearance: 0, guardMove: 0, normal: 0 },
      thresholds,
      note: '既无带售价的销售流水、也无商品档案建议价，无据可评：无法给出定价建议',
    }
  }

  // 近 WINDOW 天成交价（分），按商品聚合后取中位数（抗单笔异常价）
  const txRows = db.prepare(
    "SELECT product_id, selling_price FROM transactions " +
    "WHERE type='out' AND selling_price IS NOT NULL " +
    "AND timestamp >= date('now','localtime','-" + PRICING_WINDOW_DAYS + " days')",
  ).all()
  const pricesByProduct = new Map()
  for (const r of txRows) {
    if (!pricesByProduct.has(r.product_id)) pricesByProduct.set(r.product_id, [])
    pricesByProduct.get(r.product_id).push(r.selling_price)
  }

  // 价格档（批发/会员/零售等）：真实库当前可能为空，有则作参考并做「低于成本」提醒
  const tiersByProduct = new Map()
  try {
    for (const r of db.prepare('SELECT product_id, tier, price FROM price_tiers').all()) {
      if (!tiersByProduct.has(r.product_id)) tiersByProduct.set(r.product_id, [])
      tiersByProduct.get(r.product_id).push({ tier: r.tier, priceYuan: round2(r.price / 100) })
    }
  } catch { /* 老库无 price_tiers 表：忽略，不影响主流程 */ }

  const rows = db.prepare(
    "SELECT p.id, p.sku_code, p.brand, p.model, p.category, p.is_clearance, p.suggest_price, " +
    "SUM(CASE WHEN b.quantity > 0 THEN b.quantity ELSE 0 END) AS stock, " +
    "CAST(SUM(CASE WHEN b.quantity > 0 THEN b.quantity * b.cost_price ELSE 0 END) AS INTEGER) AS costTotal, " +
    "(SELECT MAX(t.timestamp) FROM transactions t WHERE t.product_id=p.id AND t.type='out') AS lastSold, " +
    "(SELECT COUNT(*) FROM transactions t WHERE t.product_id=p.id AND t.type='out' " +
    "  AND t.timestamp >= date('now','localtime','-" + PRICING_GUARD_MOVE_DAYS + " days')) AS recentOut30 " +
    "FROM products p JOIN inventory_batches b ON b.product_id=p.id " +
    "WHERE p.status != '停产' GROUP BY p.id HAVING stock > 0",
  ).all()

  const skipped = { noCost: 0, noPrice: 0, clearance: 0, guardMove: 0, normal: 0 }
  const items = []
  for (const r of rows) {
    const stock = r.stock
    const costTotalCents = r.costTotal || 0
    const unitCostYuan = stock > 0 ? round2(costTotalCents / stock / 100) : 0

    // 无成本 → 算不出毛利，不硬出（负库存强制出库会留「待补成本」）
    if (!(unitCostYuan > 0)) { skipped.noCost++; continue }
    // 清仓品交给清仓引擎（MVP-1），避免两个引擎给相反建议
    if (r.is_clearance) { skipped.clearance++; continue }

    const medCents = median(pricesByProduct.get(r.id) || [])
    const suggestYuan = r.suggest_price > 0 ? round2(r.suggest_price / 100) : null
    let refPriceYuan = null
    let refPriceSource = null
    if (medCents != null && medCents > 0) { refPriceYuan = round2(medCents / 100); refPriceSource = '近' + PRICING_WINDOW_DAYS + '天成交中位价' }
    else if (suggestYuan != null) { refPriceYuan = suggestYuan; refPriceSource = '商品档案建议价' }
    // 既无近期成交价也无档案价 → 无法评估现价
    if (refPriceYuan == null || !(refPriceYuan > 0)) { skipped.noPrice++; continue }

    const margin = (refPriceYuan - unitCostYuan) / refPriceYuan
    const marginPct = round2(margin * 100)
    const lastSoldDate = r.lastSold ? localDay(r.lastSold) : null
    const noOutDays = lastSoldDate ? dayDiff(lastSoldDate, t) : null
    const recentOut30 = r.recentOut30 || 0

    let priority = null
    let action = ''
    let rangeKey = null
    let guard = null
    if (margin < 0) { priority = 'P0'; action = '亏本在售：立即调价或停售'; rangeKey = 'FLOOR' }
    else if (margin < PRICING_MIN_MARGIN) { priority = 'P1'; action = '毛利偏低：建议提价'; rangeKey = 'RAISE' }
    else if (margin > PRICING_MAX_MARGIN) {
      if (recentOut30 > 0) {
        // 降档护栏：卖得动就别动价（保护收入），只在 skipped 里计数
        guard = { note: '近' + PRICING_GUARD_MOVE_DAYS + '天有动销，毛利虽高但不建议降价（护住收入）' }
        skipped.guardMove++
        continue
      }
      priority = 'P2'; action = '毛利偏高且近' + PRICING_GUARD_MOVE_DAYS + '天无动销：可降价促动销'; rangeKey = 'CUT'
    } else { skipped.normal++; continue }

    const [lo, hi] = PRICING_RANGE[rangeKey]
    const suggestRange = { low: round2(unitCostYuan * lo), high: round2(unitCostYuan * hi) }
    const reason = []
    if (margin < 0) reason.push('成交价低于成本 ' + round2(Math.abs(unitCostYuan - refPriceYuan)) + ' 元')
    else reason.push('毛利率 ' + marginPct + '%')
    reason.push('参考价来源：' + refPriceSource)
    if (noOutDays == null) reason.push('启用以来无出库记录')
    else if (noOutDays >= PRICING_WINDOW_DAYS) reason.push(noOutDays + '天无出库')
    const tiers = tiersByProduct.get(r.id) || []
    for (const tt of tiers) {
      if (tt.priceYuan < unitCostYuan) reason.push('价格档「' + tt.tier + '」' + tt.priceYuan + '元 低于成本，需核对')
    }
    const name = (((r.brand || '') + ' ' + (r.model || '')).trim()) || r.sku_code || ('商品' + r.id)

    items.push({
      id: r.id, name, category: r.category || '', stock,
      unitCostYuan, refPriceYuan, refPriceSource, suggestPriceYuan: suggestYuan,
      marginPct, tiedCostYuan: round2((stock * unitCostYuan)),
      lastSaleDaysAgo: noOutDays, recentOut30,
      priority, action, suggestRange, tiers, reason, guard,
    })
  }

  const rank = { P0: 0, P1: 1, P2: 2 }
  items.sort((a, b) => (rank[a.priority] - rank[b.priority]) || (b.tiedCostYuan - a.tiedCostYuan))
  const byPriority = {
    P0: items.filter((i) => i.priority === 'P0').length,
    P1: items.filter((i) => i.priority === 'P1').length,
    P2: items.filter((i) => i.priority === 'P2').length,
  }
  const avgMarginPct = items.length
    ? round2(items.reduce((s, i) => s + i.marginPct, 0) / items.length)
    : null

  return {
    generatedAt: new Date().toISOString(),
    dataWindowOk,
    basis: dataWindowOk ? 'sales' : 'catalog',
    totalCandidate: items.length,
    byPriority,
    avgMarginPct,
    items,
    skipped,
    thresholds,
    note: dataWindowOk
      ? '参考价取自近' + PRICING_WINDOW_DAYS + '天真实成交中位价（证据强）'
      : '当前无带售价的销售流水，参考价退用商品档案建议价（证据较弱：反映的是「挂牌价 vs 成本」，不是「实际卖价 vs 成本」）；门店跑出真实带价销售后自动升级为成交价口径',
  }
}
