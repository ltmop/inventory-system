// 支出记账（v1.10）
// 口径：净利 = 毛利 − 支出。支出按 expense_date（本地日期）归属到当天，
// 与经营报表"赚了多少"同区间相减；只记钱出去，不影响库存和批次。
import {
  assertPositiveInt,
  PAYMENT_METHODS,
  today,
  EXPENSE_DATE_RE,
  inTransaction,
  now,
  logAudit,
} from './helpers.js'
import { assertOwnerAction } from './users.js'

// 支出分类白名单（个体户常见科目，杂项兜底）
export const EXPENSE_CATEGORIES = ['进货付款', '房租', '水电', '运费', '人工', '杂项']

/** 支出字段公共校验：分类/金额/方式/日期/供应商，返回归一后的字段 */
function normalizeExpense(db, { category, amount, method, supplierId, expenseDate, note }) {
  if (!EXPENSE_CATEGORIES.includes(category)) {
    throw new Error(`支出分类必须是：${EXPENSE_CATEGORIES.join(' / ')}，收到：${category}`)
  }
  assertPositiveInt(amount, '支出金额')
  const m = method ?? '现金'
  if (!PAYMENT_METHODS.includes(m)) {
    throw new Error(`付款方式必须是：${PAYMENT_METHODS.join(' / ')}，收到：${method}`)
  }
  const date = expenseDate ?? today()
  if (!EXPENSE_DATE_RE.test(date)) {
    throw new Error(`支出日期必须是 YYYY-MM-DD 格式，收到：${expenseDate}`)
  }
  let sid = null
  if (supplierId != null) {
    const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)
    if (!sup) throw new Error('供应商不存在')
    sid = supplierId
  }
  return { category, amount, method: m, supplierId: sid, expenseDate: date, note: note?.trim() || null }
}

/** 记一笔支出：金额单位分；返回完整行（含关联供应商名） */
export function createExpense(db, input) {
  const v = normalizeExpense(db, input)
  return inTransaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO expenses (category, amount, method, supplier_id, note, expense_date, operator, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.category, v.amount, v.method, v.supplierId, v.note, v.expenseDate, input.operator ?? null, now())
    const row = getExpense(db, info.lastInsertRowid)
    logAudit(db, '记支出', `${v.category} ${(v.amount / 100).toFixed(2)} 元`,
      { id: row.id, ...v }, input.operator)
    return row
  })
}

/** 改支出：整单字段全量替换（简单账目不做部分更新） */
export function updateExpense(db, input) {
  const { id } = input
  const old = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)
  if (!old) throw new Error('支出记录不存在或已被删除')
  const v = normalizeExpense(db, input)
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE expenses SET category = ?, amount = ?, method = ?, supplier_id = ?, note = ?, expense_date = ?
       WHERE id = ?`,
    ).run(v.category, v.amount, v.method, v.supplierId, v.note, v.expenseDate, id)
    const row = getExpense(db, id)
    logAudit(db, '改支出', `${v.category} ${(v.amount / 100).toFixed(2)} 元`,
      { id, before: { category: old.category, amount: old.amount }, after: v }, input.operator)
    return row
  })
}

/** 删支出：账目可删（不像客户有引用完整性问题），留审计日志 */
export function deleteExpense(db, { id, operator }) {
  assertOwnerAction(db, '删除支出')
  const old = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)
  if (!old) throw new Error('支出记录不存在或已被删除')
  return inTransaction(db, () => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id)
    logAudit(db, '删支出', `${old.category} ${(old.amount / 100).toFixed(2)} 元`,
      { id, category: old.category, amount: old.amount, expense_date: old.expense_date }, operator)
    return { ok: true }
  })
}

/** 单条支出（含供应商名） */
function getExpense(db, id) {
  return db
    .prepare(
      `SELECT e.*, s.name AS supplier_name
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id
       WHERE e.id = ?`,
    )
    .get(id)
}

/**
 * 支出列表：可按日期区间 [from, to]（YYYY-MM-DD，含两端）和分类筛选，
 * 按日期倒序返回（含供应商名，直接给页面渲染）
 */
export function listExpenses(db, { from, to, category, limit = 500 } = {}) {
  const conds = []
  const args = []
  if (from) { conds.push('e.expense_date >= ?'); args.push(from) }
  if (to) { conds.push('e.expense_date <= ?'); args.push(to) }
  if (category) {
    if (!EXPENSE_CATEGORIES.includes(category)) {
      throw new Error(`支出分类必须是：${EXPENSE_CATEGORIES.join(' / ')}，收到：${category}`)
    }
    conds.push('e.category = ?')
    args.push(category)
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
  return db
    .prepare(
      `SELECT e.*, s.name AS supplier_name
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id
       ${where}
       ORDER BY e.expense_date DESC, e.id DESC
       LIMIT ?`,
    )
    .all(...args, Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000))
}
