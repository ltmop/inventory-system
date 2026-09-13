// 两个同源 SQLite 库的逐表比对：给「搬运脚本」和「冲突对照报告」共用。
//
// 为什么抽出来：分类口径（哪些表要管、怎么算"新增/冲突/已一致"、忽略哪些列）
// 一旦在两个工具里各写一份，迟早会走偏 —— 而这两个工具都直接决定往生产库里写什么。
// 本项目已经吃过一次"同一套取值写在三处然后漂移"的亏（销售渠道），不再重复。
//
// 核心约定：
//   · 只比两边都有的列（交集）—— 中央库没有 guid 而门店库有，这类不对称自动跳过
//   · 按主键 id 匹配；同 id 且业务字段有差异 = 冲突（**绝不覆盖**，交给人判）
//   · guid / updated_at 不算业务差异（各库各机自己生成的）
//   · settings/users/idem/ai_*/audit_log/sync_* 是机器本地状态，不是业务数据，跳过
//   · 另给"自然键疑似重复"预警：两库分叉后同一笔业务可能各拿一个 id，
//     按 id 去重会把它当新行插进去变成重复单 —— 这是最贵的错误，必须预警

/** 父子顺序：父表在前，子表的外键才有指向 */
export const COPY_ORDER = [
  'categories', 'units', 'suppliers', 'customers', 'products', 'price_tiers', 'kits',
  'inventory_batches', 'kit_items', 'purchase_orders', 'stock_takes',
  'transactions', 'payments', 'expenses', 'purchase_order_items', 'stock_take_items',
  'supplier_payments', 'waste_logs', 'payment_registers',
]

/** 机器本地状态 / 非业务数据：不搬、也不比 */
export const SKIP = new Set([
  'settings', 'users', 'idem', 'ai_insights', 'ai_messages', 'ai_usage',
  'audit_log', 'sync_changelog', 'sync_outbox',
])

/** 比对时忽略：各库/各机自己生成的，不构成"业务内容不同" */
export const IGNORE_IN_COMPARE = new Set(['guid', 'updated_at'])

/** 业务自然键：用于"疑似重复单"预警（只报不拦） */
export const NATURAL_KEY = {
  customers: ['name'],
  transactions: ['product_id', 'timestamp', 'quantity'],
  payments: ['customer_id', 'amount', 'created_at'],
}

export const tableExists = (db, t) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)

export const colsOf = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)

/**
 * 单表比对。
 * @returns {{t:string, shared:string[], srcCount:number, dstCount:number,
 *            fresh:object[], conflict:{id:number, fields:string[]}[],
 *            same:number, dupRisk:object[], nk:string[]|null}}
 */
export function classifyTable(src, dst, t) {
  const shared = colsOf(src, t).filter((c) => colsOf(dst, t).includes(c))
  const empty = { t, shared, srcCount: 0, dstCount: 0, fresh: [], conflict: [], same: 0, dupRisk: [], nk: null }
  if (!shared.includes('id')) return empty // 没有 id 就无法按主键比对
  const sel = `SELECT ${shared.map((c) => `"${c}"`).join(',')} FROM "${t}"`
  const srcRows = src.prepare(sel).all()
  const dstRows = dst.prepare(sel).all()
  const dstById = new Map(dstRows.map((r) => [r.id, r]))
  const cmpCols = shared.filter((c) => c !== 'id' && !IGNORE_IN_COMPARE.has(c))

  const fresh = [], conflict = []
  for (const r of srcRows) {
    const d = dstById.get(r.id)
    if (d === undefined) { fresh.push(r); continue }
    const fields = cmpCols.filter((c) => (r[c] ?? null) !== (d[c] ?? null))
    if (fields.length) conflict.push({ id: r.id, fields })
  }

  const nk = NATURAL_KEY[t]
  let dupRisk = []
  if (nk && nk.every((c) => shared.includes(c)) && fresh.length) {
    const keyOf = (r) => nk.map((c) => String(r[c] ?? '\u0000')).join('|')
    const dstKeys = new Set(dstRows.map(keyOf))
    dupRisk = fresh.filter((r) => dstKeys.has(keyOf(r)))
  }

  return {
    t, shared, srcCount: srcRows.length, dstCount: dstRows.length,
    fresh, conflict, same: srcRows.length - fresh.length - conflict.length, dupRisk, nk: nk ?? null,
    srcRows, dstRows,
  }
}

/** 全表比对。only 为空则按 COPY_ORDER 全走 */
export function classify(src, dst, only = null) {
  const out = []
  for (const t of COPY_ORDER) {
    if (only && !only.includes(t)) continue
    if (SKIP.has(t)) continue
    if (!tableExists(src, t) || !tableExists(dst, t)) {
      out.push({ t, missing: !tableExists(src, t) ? 'src' : 'dst' })
      continue
    }
    out.push(classifyTable(src, dst, t))
  }
  return out
}

/** 汇总计数 */
export function totals(results) {
  let fresh = 0, conflict = 0, same = 0
  for (const r of results) { fresh += r.fresh?.length ?? 0; conflict += r.conflict?.length ?? 0; same += r.same ?? 0 }
  return { fresh, conflict, same }
}
