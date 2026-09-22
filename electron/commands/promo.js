// 店铺活动策划（老板 2026-09-22：「如果要做店铺活动要根据客户现有的商品来制定活动，并给出预计活动收益！！！」）
//
// 设计取舍（和这个项目一路的规矩一致）：
//   · **规则算数，AI 只写话**。预计收益必须是能用计算器复核的，不能是模型编的。
//   · 候选商品来自已有的清仓引擎 buildClearance（滞销/临期/无动销），不另起一套口径。
//   · 提升系数是**假设**，必须写在界面上让老板看见、能调（保守/正常/激进），不许藏着当结论。

import { buildClearance } from './clearance.js'

/** 折扣 → 指望多卖多少倍（有动销的货）。这是经验值，不是精确模型 —— 界面上要写成"按经验估" */
const UPLIFT = {
  0.95: 1.15,
  0.9: 1.3,
  0.85: 1.45,
  0.8: 1.7,
  0.75: 1.9,
  0.7: 2.2,
  0.6: 2.8,
}

/** 折扣 → 活动期内能清掉**存货的百分之几**（没动销的货只能这么估） */
const CLEAR_PCT = {
  0.95: 0.05,
  0.9: 0.10,
  0.85: 0.15,
  0.8: 0.20,
  0.75: 0.28,
  0.7: 0.35,
  0.6: 0.5,
}

/** 档位系数：保守 / 正常 / 激进 —— 让老板自己选，别我们替他定 */
const MODE_K = { low: 0.7, normal: 1, high: 1.35 }

const round = (x) => Math.round(x)
const nearestKey = (tbl, d) => {
  const keys = Object.keys(tbl).map(Number)
  let best = keys[0]
  let bestD = Math.abs(keys[0] - d)
  for (const k of keys) { const dd = Math.abs(k - d); if (dd < bestD) { bestD = dd; best = k } }
  return best
}

/**
 * 算一份活动方案。
 * @param {object} db
 * @param {{discount?:number, days?:number, mode?:'low'|'normal'|'high', scope?:'slow'|'all', limit?:number}} opts
 */
export function buildPromoPlan(db, opts = {}) {
  const discount = Math.min(1, Math.max(0.5, Number(opts.discount) || 0.8))
  const days = Math.min(60, Math.max(1, parseInt(opts.days, 10) || 7))
  const mode = MODE_K[opts.mode] ? opts.mode : 'normal'
  const k = MODE_K[mode]
  const scope = opts.scope === 'all' ? 'all' : 'slow'
  const limit = Math.min(60, Math.max(5, parseInt(opts.limit, 10) || 30))

  const dk = nearestKey(UPLIFT, discount)
  const uplift = UPLIFT[dk]
  const clearPct = CLEAR_PCT[dk]

  // 近 90 天真实动销（只有"有售价的出库"才算卖出去，与报表口径一致）
  const since = new Date(Date.now() - 90 * 86400000).toISOString()
  let sold = []
  try {
    sold = db.prepare("SELECT product_id, COALESCE(SUM(quantity),0) AS q FROM transactions WHERE type='out' AND selling_price IS NOT NULL AND timestamp >= ? GROUP BY product_id").all(since)
  } catch (e) { sold = [] }
  const soldMap = new Map(sold.map((r) => [Number(r.product_id), Number(r.q) || 0]))

  // 候选池
  let candidates = []
  if (scope === 'slow') {
    // 滞销/临期优先 —— 活动先救压着钱的货
    try {
      const cl = buildClearance(db)
      candidates = (cl.items || []).map((it) => ({ id: it.id, why: (it.reason || []).join('、') || '滞销', priority: it.priority }))
    } catch (e) { candidates = [] }
  }
  // all：再补上"有动销但库存压得多"的货（卖得动的打折才真的多卖）
  if (scope === 'all') {
    try {
      const rows = db.prepare(`SELECT p.id AS id, COALESCE(SUM(b.quantity),0) AS stock
        FROM products p LEFT JOIN inventory_batches b ON b.product_id = p.id
        GROUP BY p.id HAVING stock > 0 ORDER BY stock DESC LIMIT 200`).all()
      const seen = new Set(candidates.map((c) => c.id))
      for (const r of rows) if (!seen.has(r.id)) candidates.push({ id: Number(r.id), why: '库存压得多', priority: 'P2' })
    } catch (e) { /* 忽略 */ }
  }

  const info = new Map()
  try {
    for (const r of db.prepare('SELECT id, sku_code, brand, model, category, cost_price, suggest_price FROM products').all()) info.set(Number(r.id), r)
  } catch (e) { /* 忽略 */ }
  const stockMap = new Map()
  try {
    for (const r of db.prepare('SELECT product_id, COALESCE(SUM(quantity),0) AS q FROM inventory_batches GROUP BY product_id').all()) stockMap.set(Number(r.product_id), Number(r.q) || 0)
  } catch (e) { /* 忽略 */ }

  const items = []
  for (const c of candidates) {
    const p = info.get(c.id)
    if (!p) continue
    const stock = stockMap.get(c.id) || 0
    if (stock <= 0) continue
    const price = Number(p.suggest_price) || 0
    if (price <= 0) continue
    const cost = Number(p.cost_price) || 0
    const promoPrice = Math.max(1, round(price * discount / 10) * 10)   // 取整到「角」
    const daily = (soldMap.get(c.id) || 0) / 90
    // 有动销：按"日均 × 提升倍数"；没动销：按"能清掉存货的百分之几"（两者取大，别互相抵消）
    const byVel = daily > 0 ? daily * uplift * k * days : 0
    const byClear = stock * clearPct * k
    const estQty = Math.max(1, Math.min(stock, Math.round(Math.max(byVel, byClear))))
    const revenue = promoPrice * estQty
    const margin = (promoPrice - cost) * estQty
    const baselineQty = Math.min(stock, Math.round(daily * days))          // 不搞活动大概能卖多少
    const baselineRevenue = price * baselineQty
    items.push({
      id: c.id,
      name: (((p.brand || '') + ' ' + (p.model || '')).trim()) || p.sku_code || ('商品' + c.id),
      category: p.category || '',
      stock,
      cost,
      price,
      promoPrice,
      discountLabel: (discount * 10).toFixed(1).replace(/\.0$/, '') + '折',
      estQty,
      revenue,
      margin,
      baselineQty,
      baselineRevenue,
      deltaRevenue: revenue - baselineRevenue,
      belowCost: cost > 0 && promoPrice < cost,
      why: c.why,
      priority: c.priority,
      tiedCost: cost * stock,
    })
  }
  // 压钱最多的排前面
  items.sort((a, b) => (b.tiedCost - a.tiedCost) || (b.deltaRevenue - a.deltaRevenue))
  const picked = items.slice(0, limit)

  const sum = (f) => picked.reduce((s, x) => s + f(x), 0)
  const plan = {
    generatedAt: new Date().toISOString(),
    discount,
    discountLabel: (discount * 10).toFixed(1).replace(/\.0$/, '') + '折',
    days,
    mode,
    scope,
    // 假设写在结果里 —— 界面必须把它显示出来，不能让老板以为这是精确预测
    assumption: {
      uplift: uplift,
      clearPct,
      modeK: k,
      text: '有动销的货按"平时日均卖 × ' + uplift + ' 倍"估；没动销的货按"活动期内清掉存货的 ' + Math.round(clearPct * 100) + '%"估；再乘档位系数 ' + k + '（' + (mode === 'low' ? '保守' : mode === 'high' ? '激进' : '正常') + '）。',
    },
    itemCount: picked.length,
    totalStock: sum((x) => x.stock),
    tiedCost: sum((x) => x.tiedCost),
    estQty: sum((x) => x.estQty),
    estRevenue: sum((x) => x.revenue),
    estMargin: sum((x) => x.margin),
    baselineRevenue: sum((x) => x.baselineRevenue),
    deltaRevenue: sum((x) => x.deltaRevenue),
    recoverCost: sum((x) => x.cost * x.estQty),          // 这一波能把多少压着的本钱收回来
    belowCount: picked.filter((x) => x.belowCost).length,
    items: picked.map((x) => ({ ...x, estRevenue: x.revenue, priceYuan: round(x.price / 100), promoYuan: round(x.promoPrice / 100) })),
  }
  // 一句话结论（数字算出来的，不是编的）
  if (!picked.length) plan.headline = '现在没有适合做活动的货（滞销/压库存的都被清完了）'
  else {
    plan.headline = plan.discountLabel + ' / ' + days + ' 天：挑 ' + plan.itemCount + ' 样货，预计卖 ¥' + round(plan.estRevenue / 100) +
      '、毛利 ¥' + round(plan.estMargin / 100) + '，比不做活动多卖 ¥' + round(plan.deltaRevenue / 100) +
      '，还能收回 ¥' + round(plan.recoverCost / 100) + ' 压着的本钱'
  }
  return plan
}
