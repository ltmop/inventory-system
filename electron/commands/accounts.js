// 资金账户（最小形态）· 命令层读取口
//
// 一份口径：真正的推导在 electron/lib/moneyAccounts.js（界面那份是 src/lib/moneyAccounts.ts，
// 与它逐例同输出，由 test-backend.mjs 的断言盯着）。本文件只负责**从库里取行**，
// 不在这里写任何金额规则 —— 口径只有一个地方，才不会被改歪。
//
// 为什么不新建账户表：库里的钱已经有三处记着、而且每条都带方式（transactions.pay_method /
// payments.method / expenses.method / supplier_payments.method）。再建一张账户表就是第二份真相，
// 余额和流水迟早对不上。所以账户 = 收款方式，余额 = 期初 + Σ收 − Σ付；期初存 settings 表。
import { deriveMoneyAccounts, parseOpening, ACCOUNT_OPENING_KEY, MONEY_ACCOUNTS } from '../lib/moneyAccounts.js'
import { inTransaction, logAudit, now } from './helpers.js'

function readOpening(db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ACCOUNT_OPENING_KEY)
    return parseOpening(row?.value)
  } catch {
    return {}
  }
}

function rows(db, sql, ...args) {
  try {
    return db.prepare(sql).all(...args)
  } catch {
    return [] // 老库还没补列时不让整条查询挂掉（与项目其它只读口同样的保守做法）
  }
}

/**
 * 资金账户总览（只读）：按收款方式汇总钱的进出与余额。
 * 账户 = 现金/微信/支付宝/其他（就是现有 pay_method 的取值域，不新增概念）；余额 = 期初 + Σ收 − Σ付。
 * 钱来自四处已有记录：出库实收与退货退款（transactions）、客户还款（payments）、支出（expenses）、付供应商（supplier_payments）。
 * 方式没记的进「未登记方式」桶，不摊到任何账户头上 —— 只报出来提醒补记。
 */
export function moneyAccounts(db, { from = '', to = '' } = {}) {
  const transactions = rows(
    db,
    `SELECT type, quantity, selling_price, paid_amount, pay_method, timestamp
     FROM transactions
     WHERE selling_price IS NOT NULL AND type IN ('out','return')`,
  )
  const payments = rows(db, 'SELECT amount, method, created_at FROM payments')
  const expenses = rows(db, 'SELECT amount, method, expense_date, created_at FROM expenses')
  const supplierPayments = rows(db, 'SELECT amount, method, pay_date, created_at FROM supplier_payments')
  return deriveMoneyAccounts(
    { transactions, payments, expenses, supplierPayments, opening: readOpening(db) },
    { from, to },
  )
}

/**
 * 设置某个资金账户的期初余额（单位：分）。
 * 期初存在 settings 表（键 account_opening）里的一段 JSON，因此**不新增表、也不新增迁移**。
 */
export function setAccountOpening(db, { account, amountFen, operator } = {}) {
  const name = String(account ?? '').trim()
  if (!MONEY_ACCOUNTS.includes(name)) {
    throw new Error(`账户只能是 ${MONEY_ACCOUNTS.join(' / ')}，收到：${account}`)
  }
  const fen = Math.round(Number(amountFen))
  if (!Number.isFinite(fen)) throw new Error(`期初金额要是一个数字（单位分），收到：${amountFen}`)
  const cur = readOpening(db)
  const next = { ...cur }
  if (fen === 0) delete next[name]
  else next[name] = fen
  return inTransaction(db, () => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      ACCOUNT_OPENING_KEY,
      JSON.stringify(next),
    )
    logAudit(db, '资金账户期初', name, { from: cur[name] ?? 0, to: fen }, operator ?? null)
    return { ok: true, account: name, openingFen: fen, opening: next, at: now() }
  })
}
