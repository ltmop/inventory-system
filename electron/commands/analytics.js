// 数据分析命令层：HTTP /api/analytics/* 与桌面 invoke('analytics:*') 同源。
// 口径与 querySummary / inv-analytics 一致：
//   营业额 = Σ(type='out') selling_price×quantity − Σ(type='return' 非换货退旧) selling_price×quantity
//   毛利   = Σ(type='out') (selling_price−unit_price)×quantity − Σ(return 非换货退旧) (selling_price−unit_price)×quantity
//   库存金额 = Σ inventory_batches quantity×cost_price
// 只读：绝不写库。

function pad(n) { return String(n).padStart(2, '0') }
export function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }

/** 近 N 天（含今天）销售额/毛利/件数趋势 */
export function analyticsTrend(db, days = 7) {
  const n = Math.max(1, Math.min(Number(days) || 7, 90))
  const txs = db.prepare(
    "SELECT timestamp, type, notes, quantity, selling_price, unit_price FROM transactions WHERE type IN ('out','return')",
  ).all()
  const byDay = new Map()
  for (const t of txs) {
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const dk = dateKey(new Date(t.timestamp))
    const cur = byDay.get(dk) ?? { date: dk, revenue: 0, profit: 0, qty: 0 }
    const sign = t.type === 'return' ? -1 : 1
    cur.qty += t.quantity * sign
    if (t.selling_price != null) cur.revenue += t.selling_price * t.quantity * sign
    if (t.selling_price != null && t.unit_price != null) cur.profit += (t.selling_price - t.unit_price) * t.quantity * sign
    byDay.set(dk, cur)
  }
  const now = new Date()
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const dk = dateKey(d)
    const r = byDay.get(dk)
    out.push({ date: dk, revenue: Math.round(r?.revenue ?? 0), profit: Math.round(r?.profit ?? 0), qty: Math.round(r?.qty ?? 0) })
  }
  return out
}

/** 品类销售额/毛利/件数（全部销售） */
export function analyticsCategory(db) {
  const txs = db.prepare(
    "SELECT t.type, t.notes, t.quantity, t.selling_price, t.unit_price, p.category FROM transactions t JOIN products p ON p.id = t.product_id WHERE t.type IN ('out','return')",
  ).all()
  const byCat = new Map()
  for (const t of txs) {
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const cat = t.category || '未分类'
    const cur = byCat.get(cat) ?? { category: cat, revenue: 0, profit: 0, qty: 0 }
    const sign = t.type === 'return' ? -1 : 1
    cur.qty += t.quantity * sign
    if (t.selling_price != null) cur.revenue += t.selling_price * t.quantity * sign
    if (t.selling_price != null && t.unit_price != null) cur.profit += (t.selling_price - t.unit_price) * t.quantity * sign
    byCat.set(cat, cur)
  }
  return [...byCat.values()].sort((a, b) => b.revenue - a.revenue).map((r) => ({
    category: r.category, revenue: Math.round(r.revenue), profit: Math.round(r.profit), qty: Math.round(r.qty),
  }))
}

/** 畅销 Top N（按营业额，附毛利/件数） */
export function analyticsTop(db, n = 10) {
  const k = Math.max(1, Math.min(Number(n) || 10, 50))
  const txs = db.prepare(
    "SELECT t.type, t.notes, t.quantity, t.selling_price, t.unit_price, t.product_id, p.name, p.brand, p.model, p.sku_code FROM transactions t JOIN products p ON p.id = t.product_id WHERE t.type IN ('out','return')",
  ).all()
  const byP = new Map()
  let lookup
  try { lookup = db.prepare('SELECT id, name, brand, model, sku_code FROM products').all() } catch { lookup = [] }
  const meta = new Map(lookup.map((r) => [r.id, r]))
  for (const t of txs) {
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const cur = byP.get(t.product_id) ?? { productId: t.product_id, revenue: 0, profit: 0, qty: 0 }
    const sign = t.type === 'return' ? -1 : 1
    cur.qty += t.quantity * sign
    if (t.selling_price != null) cur.revenue += t.selling_price * t.quantity * sign
    if (t.selling_price != null && t.unit_price != null) cur.profit += (t.selling_price - t.unit_price) * t.quantity * sign
    byP.set(t.product_id, cur)
  }
  return [...byP.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, k)
    .map((r) => {
      const m = meta.get(r.productId)
      return {
        productId: r.productId,
        name: m?.name ?? '未知商品',
        brand: m?.brand ?? '',
        model: m?.model ?? '',
        sku: m?.sku_code ?? '',
        revenue: Math.round(r.revenue), profit: Math.round(r.profit), qty: Math.round(r.qty),
      }
    })
}

/** 库存金额按品类（当前批次货值） */
export function analyticsStockValue(db) {
  const rows = db.prepare(
    'SELECT p.category AS category, COALESCE(SUM(b.quantity),0) AS qty, COALESCE(SUM(b.quantity*b.cost_price),0) AS value FROM inventory_batches b JOIN products p ON p.id = b.product_id GROUP BY p.category ORDER BY value DESC',
  ).all()
  const total = rows.reduce((s, r) => s + r.value, 0)
  return {
    totalValue: Math.round(total),
    byCategory: rows.map((r) => ({ category: r.category || '未分类', qty: Math.round(r.qty), value: Math.round(r.value) })),
  }
}

/** 经营概览：今日 / 本月 营业额毛利 + 库存总额 + SKU 数 + 低库存数 */
export function analyticsOverview(db) {
  const txs = db.prepare(
    "SELECT timestamp, type, notes, quantity, selling_price, unit_price FROM transactions WHERE type IN ('out','return')",
  ).all()
  const now = new Date()
  const todayKey = dateKey(now)
  const monthPrefix = todayKey.slice(0, 7)
  let todayRevenue = 0, todayProfit = 0, monthRevenue = 0, monthProfit = 0
  for (const t of txs) {
    if (t.type === 'return' && t.notes === '换货退旧') continue
    const dk = dateKey(new Date(t.timestamp))
    const sign = t.type === 'return' ? -1 : 1
    if (t.selling_price != null) {
      const rev = t.selling_price * t.quantity * sign
      const prof = t.unit_price != null ? (t.selling_price - t.unit_price) * t.quantity * sign : 0
      if (dk === todayKey) { todayRevenue += rev; todayProfit += prof }
      if (dk.startsWith(monthPrefix)) { monthRevenue += rev; monthProfit += prof }
    }
  }
  const stock = db.prepare('SELECT COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(quantity*cost_price),0) AS v FROM inventory_batches').get()
  const totalSku = db.prepare('SELECT COUNT(*) AS n FROM products').get().n
  return {
    today: { revenue: Math.round(todayRevenue), profit: Math.round(todayProfit) },
    month: { revenue: Math.round(monthRevenue), profit: Math.round(monthProfit) },
    stockValue: Math.round(stock.v ?? 0), totalStock: Math.round(stock.q ?? 0), totalSku,
  }
}
