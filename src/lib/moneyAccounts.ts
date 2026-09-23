// 资金账户（最小形态）· 界面那一份 —— 与 electron/lib/moneyAccounts.js 是同口径双胞胎。
//
// 为什么要两份：打包只含 electron/**，界面（src/**）不能引用 electron/**；而界面在本机模式下
// 没有服务端通道可调，必须能在本地从 store 里现算。这与 lib/restockAdvice.ts ↔ lib/restockAdvice.js、
// lib/formatters.ts ↔ lib/productName.js 是**同一个既有套路**。
// test-backend.mjs 有一条断言逐例比对两边输出，改一边不改另一边会红。
//
// 口径说明（完整推导见 electron/lib/moneyAccounts.js 顶部注释）：
//   账户 = 收款方式（现金/微信/支付宝/其他）；余额 = 期初 + Σ收 − Σ付；期初存 settings，不新建表。

export const MONEY_ACCOUNTS = ['现金', '微信', '支付宝', '其他'] as const
export type MoneyAccountName = (typeof MONEY_ACCOUNTS)[number]
export const UNRECORDED_ACCOUNT = '未登记方式'

export interface MoneyRow {
  type?: string | null
  quantity?: number | null
  selling_price?: number | null
  paid_amount?: number | null
  pay_method?: string | null
  method?: string | null
  amount?: number | null
  timestamp?: string | null
  created_at?: string | null
  expense_date?: string | null
  pay_date?: string | null
}

export interface MoneyAccountRow {
  account: MoneyAccountName
  openingFen: number
  inFen: number
  outFen: number
  netFen: number
  closingFen: number
  n: number
}

export interface MoneyAccountsResult {
  range: { from: string; to: string }
  accounts: MoneyAccountRow[]
  unrecorded: { inFen: number; outFen: number; netFen: number; n: number }
  totals: { openingFen: number; inFen: number; outFen: number; netFen: number; closingFen: number; n: number }
  sources: { salesFen: number; returnsFen: number; customerRepayFen: number; expensesFen: number; supplierPayFen: number }
}

/** 把任意来源的方式归一到四个账户；空值返回 null（=未登记），未知值归「其他」 */
export function normalizeAccount(method: string | null | undefined): MoneyAccountName | null {
  const s = String(method ?? '').trim()
  if (!s) return null
  return (MONEY_ACCOUNTS as readonly string[]).includes(s) ? (s as MoneyAccountName) : '其他'
}

const blankBucket = () => ({ inFen: 0, outFen: 0, n: 0 })
const dayOf = (row: MoneyRow) =>
  String(row.expense_date ?? row.pay_date ?? row.timestamp ?? row.created_at ?? '').slice(0, 10)

export interface MoneyAccountsInput {
  transactions?: MoneyRow[]
  payments?: MoneyRow[]
  supplierPayments?: MoneyRow[]
  expenses?: MoneyRow[]
  opening?: Partial<Record<MoneyAccountName, number>>
}

export function deriveMoneyAccounts(
  input: MoneyAccountsInput,
  range: { from?: string; to?: string } = {},
): MoneyAccountsResult {
  const transactions = input?.transactions ?? []
  const payments = input?.payments ?? []
  const supplierPayments = input?.supplierPayments ?? []
  const expenses = input?.expenses ?? []
  const opening = input?.opening ?? {}
  const from = String(range.from ?? '')
  const to = String(range.to ?? '')
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to)

  const buckets = new Map<MoneyAccountName, { inFen: number; outFen: number; n: number }>(
    MONEY_ACCOUNTS.map((a) => [a, blankBucket()]),
  )
  const unrec = blankBucket()
  const sources = { salesFen: 0, returnsFen: 0, customerRepayFen: 0, expensesFen: 0, supplierPayFen: 0 }

  // ① 出库实收 / ② 退货退款
  for (const t of transactions) {
    if (t?.selling_price == null) continue
    const type = String(t.type ?? '')
    if (type !== 'out' && type !== 'return') continue
    if (!inRange(dayOf(t))) continue
    const qty = Number(t.quantity) || 0
    const fen =
      type === 'out'
        ? t.paid_amount == null
          ? Math.round(Number(t.selling_price) * qty)
          : Number(t.paid_amount)
        : Math.round(Number(t.selling_price) * qty)
    // 金额为 0 的行不是"钱的进出"：纯赊账（paid_amount=0）没有现金移动，不该占一笔
    if (!(fen > 0)) continue
    const acct = normalizeAccount(t.pay_method)
    const b = acct ? buckets.get(acct)! : unrec
    if (type === 'out') {
      b.inFen += fen
      // sources 只统计**真的落进某个账户**的钱，与 totals 同口径；
      // 没记方式的钱只在 unrecorded 里报，不混进来源拆分（否则两处口径不一致）
      if (acct) sources.salesFen += fen
    } else {
      b.outFen += fen
      if (acct) sources.returnsFen += fen
    }
    b.n += 1
  }

  // ③ 客户还款
  for (const r of payments) {
    const fen = Number(r?.amount) || 0
    if (!(fen > 0) || !inRange(dayOf(r))) continue
    const acct = normalizeAccount(r.method)
    const b = acct ? buckets.get(acct)! : unrec
    b.inFen += fen
    b.n += 1
    if (acct) sources.customerRepayFen += fen
  }

  // ④ 支出
  for (const e of expenses) {
    const fen = Number(e?.amount) || 0
    if (!(fen > 0) || !inRange(dayOf(e))) continue
    const acct = normalizeAccount(e.method)
    const b = acct ? buckets.get(acct)! : unrec
    b.outFen += fen
    b.n += 1
    if (acct) sources.expensesFen += fen
  }

  // ⑤ 付供应商
  for (const s of supplierPayments) {
    const fen = Number(s?.amount) || 0
    if (!(fen > 0) || !inRange(dayOf(s))) continue
    const acct = normalizeAccount(s.method)
    const b = acct ? buckets.get(acct)! : unrec
    b.outFen += fen
    b.n += 1
    if (acct) sources.supplierPayFen += fen
  }

  const accounts: MoneyAccountRow[] = MONEY_ACCOUNTS.map((account) => {
    const b = buckets.get(account)!
    const openingFen = Number(opening[account]) || 0
    return {
      account,
      openingFen,
      inFen: b.inFen,
      outFen: b.outFen,
      netFen: b.inFen - b.outFen,
      closingFen: openingFen + b.inFen - b.outFen,
      n: b.n,
    }
  })

  const sum = (f: (a: MoneyAccountRow) => number) => accounts.reduce((n, a) => n + f(a), 0)
  return {
    range: { from, to },
    accounts,
    unrecorded: { inFen: unrec.inFen, outFen: unrec.outFen, netFen: unrec.inFen - unrec.outFen, n: unrec.n },
    totals: {
      openingFen: sum((a) => a.openingFen),
      inFen: sum((a) => a.inFen),
      outFen: sum((a) => a.outFen),
      netFen: sum((a) => a.netFen),
      closingFen: sum((a) => a.closingFen),
      n: sum((a) => a.n),
    },
    sources,
  }
}

/** 期初余额的存放约定：settings 表的一个键（值是一段 JSON），不新建表 */
export const ACCOUNT_OPENING_KEY = 'account_opening'

export function parseOpening(raw: unknown): Partial<Record<MoneyAccountName, number>> {
  try {
    const o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | null
    if (!o || typeof o !== 'object') return {}
    const out: Partial<Record<MoneyAccountName, number>> = {}
    for (const a of MONEY_ACCOUNTS) {
      const v = Number(o[a])
      if (Number.isFinite(v) && v !== 0) out[a] = Math.round(v)
    }
    return out
  } catch {
    return {}
  }
}
