// 清仓建议引擎（决策层 MVP-1）· 单一来源：命令层/CLI/IPC/驱动舱共用 buildClearance(db)。
// 纯规则、只读、零写入；给区间不给自动价；30 天有动销降档护栏；无销售流水不硬出。
// 常量：v1 固定阈值，后续入设置（本期不做设置 UI）。
const CLEARANCE_MIN_TIED_YUAN = 500
const CLEARANCE_EXPIRY_URGENT_DAYS = 60
const CLEARANCE_DORMANT_DEAD_DAYS = 180
const CLEARANCE_DORMANT_SLOW_DAYS = 90
const CLEARANCE_GUARD_MOVE_DAYS = 30
const CLEARANCE_RANGE = { P0: [0.6, 0.85], P1: [0.8, 1.0], P2: [0.9, 1.0] }

const round2 = (x) => Math.round(x * 100) / 100
const localDay = (iso) => String(iso || '').slice(0, 10)
const dayDiff = (from, to) => { const a = new Date(String(from).slice(0, 10) + 'T00:00:00'); const b = new Date(String(to).slice(0, 10) + 'T00:00:00'); return Math.round((b - a) / 86400000) }

export function buildClearance(db) {
  const t = localDay(new Date().toISOString())
  const anySale = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='out'").get().n
  if (anySale === 0) {
    return { generatedAt: new Date().toISOString(), dataWindowOk: false, totalCandidate: 0, recoverableCost: 0, byPriority: { P0: 0, P1: 0, P2: 0 }, items: [], note: '系统启用以来无销售流水（暂无出库记录），数据窗口不足，无法判定滞销/清仓；启用销售后自动转为真实清仓分析' }
  }
  const rows = db.prepare(
    "SELECT p.id, p.sku_code, p.brand, p.model, p.category, p.is_clearance, " +
    "SUM(b.quantity) AS stock, " +
    "CAST(SUM(b.quantity * b.cost_price) AS INTEGER) AS tiedCapital, " +
    "MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS earliestExpiry, " +
    "(SELECT MAX(t.timestamp) FROM transactions t WHERE t.product_id=p.id AND t.type='out') AS lastSold, " +
    "(SELECT COUNT(*) FROM transactions t WHERE t.product_id=p.id AND t.type='out' AND t.timestamp >= date('now','localtime','-" + CLEARANCE_GUARD_MOVE_DAYS + " days')) AS recentOut30 " +
    "FROM products p JOIN inventory_batches b ON b.product_id=p.id " +
    "WHERE p.status != '停产' GROUP BY p.id HAVING stock > 0"
  ).all()
  const items = []
  for (const r of rows) {
    const tiedYuan = round2(r.tiedCapital / 100)
    if (tiedYuan < CLEARANCE_MIN_TIED_YUAN) continue
    const lastSoldDate = r.lastSold ? localDay(r.lastSold) : null
    const noOutDays = lastSoldDate ? dayDiff(lastSoldDate, t) : Infinity
    if (noOutDays < CLEARANCE_DORMANT_SLOW_DAYS) continue
    const expiryInDays = r.earliestExpiry ? dayDiff(t, r.earliestExpiry) : null
    const dead = noOutDays >= CLEARANCE_DORMANT_DEAD_DAYS
    const expiring = expiryInDays != null && expiryInDays <= CLEARANCE_EXPIRY_URGENT_DAYS
    const isClearance = !!r.is_clearance
    let priority
    if (dead && expiring) priority = 'P0'
    else if (dead) priority = 'P1'
    else if (expiring) priority = 'P1'
    else priority = 'P2'
    let guard = null
    if (r.recentOut30 > 0) {
      const down = priority === 'P0' ? 'P1' : priority === 'P1' ? 'P2' : null
      guard = { note: '近30天有动销，降为' + (down || '排除（在动，不建议清）') }
      if (down) priority = down
      else continue
    }
    let action = ''
    let suggestRange = null
    if (priority === 'P0') {
      if (expiryInDays != null && expiryInDays <= 0) action = '移出货架/报废核销'
      else { action = '降价出清'; suggestRange = { low: round2(tiedYuan * CLEARANCE_RANGE.P0[0]), high: round2(tiedYuan * CLEARANCE_RANGE.P0[1]) } }
    } else if (priority === 'P1') { action = '降价/捆绑搭售'; suggestRange = { low: round2(tiedYuan * CLEARANCE_RANGE.P1[0]), high: round2(tiedYuan * CLEARANCE_RANGE.P1[1]) } }
    else { action = '观察/挪动线'; suggestRange = { low: round2(tiedYuan * CLEARANCE_RANGE.P2[0]), high: round2(tiedYuan * CLEARANCE_RANGE.P2[1]) } }
    const reason = []
    if (noOutDays >= CLEARANCE_DORMANT_DEAD_DAYS) reason.push('180天无出库')
    else reason.push('90天无出库')
    if (expiryInDays != null && expiryInDays <= 0) reason.push('已过期')
    else if (expiryInDays != null && expiryInDays <= CLEARANCE_EXPIRY_URGENT_DAYS) reason.push('临期' + expiryInDays + '天')
    if (isClearance) reason.push('已标记清仓，核对是否清完')
    const name = (((r.brand || '') + ' ' + (r.model || '')).trim()) || r.sku_code || ('商品' + r.id)
    items.push({ id: r.id, name, category: r.category || '', stock: r.stock, tiedCostYuan: tiedYuan, lastSaleDaysAgo: lastSoldDate ? noOutDays : null, dormantTier: (noOutDays >= CLEARANCE_DORMANT_DEAD_DAYS ? '180天+' : '90天+'), expiryInDays, priority, action, suggestRange, reason, guard })
  }
  const rank = { P0: 0, P1: 1, P2: 2 }
  items.sort((a, b) => (rank[a.priority] - rank[b.priority]) || (b.tiedCostYuan - a.tiedCostYuan))
  const byPriority = { P0: items.filter((i) => i.priority === 'P0').length, P1: items.filter((i) => i.priority === 'P1').length, P2: items.filter((i) => i.priority === 'P2').length }
  return { generatedAt: new Date().toISOString(), dataWindowOk: true, totalCandidate: items.length, recoverableCost: round2(items.reduce((s, i) => s + i.tiedCostYuan, 0)), byPriority, items }
}
