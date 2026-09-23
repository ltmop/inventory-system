// 资金账户（最小形态）：**不新建账户表**，只把已有的钱进出按「收款方式」汇总成一本流水账。
//
// 为什么这么做（2026-09-22 owner 拍板「资金账户按最小形态补上」）：
//   我们的库里已经有三处记了钱的进出，而且**每一条都带方式**：
//     · transactions  出库实收 / 退货退款（pay_method）           —— 卖货收钱、退钱给客人
//     · payments      客户还款（method）                          —— 赊账收回
//     · expenses      支出（method）                              —— 房租水电运费人工杂项
//     · supplier_payments 付供应商（method）                      —— 进货付款
//   再建一张「账户表」就会变成**第二份真相**（余额和流水迟早对不上）。所以这里只做**派生**：
//     账户 = 收款方式（现金 / 微信 / 支付宝 / 其他），余额 = 期初 + Σ收 − Σ付。
//   期初放**已有的 settings 表**（键 account_opening），也不新建表。
//
// 与 src/lib/moneyAccounts.ts 是**同口径双胞胎**（跟 lib/restockAdvice.js ↔ restockAdvice.ts、
//   lib/productName.js ↔ formatters.ts 一样：打包只含 electron/**，界面不得引用 electron/**）。
//   test-backend.mjs 有一条断言逐例比对两边输出，改一边不改另一边会红。
//
// 口径细节（与 electron/commands/reports.js 的 todayPaymentSplit 对齐，不另发明）：
//   · 只有 `selling_price` 非空的 out/return 才算**现金移动**（无售价的是渠道发货，不碰钱）。
//   · 出库实收 = paid_amount ?? 售价×数量（paid_amount 为 NULL 在老库里语义是"全额付清"）。
//   · 退货按售价×数量记**付出**（与今日收款拆分把退货记负是同一件事，只是这里分列收/付）。
//   · 方式为空的进「未登记方式」桶，**不算进任何账户**（不猜），但仍报出来提醒补记。

/** 账户取值域 = 现有 pay_method / method 的取值域，一个不多 */
export const MONEY_ACCOUNTS = ['现金', '微信', '支付宝', '其他']
/** 方式没记的那部分：单独一桶，绝不摊到某个账户头上 */
export const UNRECORDED_ACCOUNT = '未登记方式'

/** 把任意来源的方式归一到四个账户；空值返回 null（=未登记），未知值归「其他」 */
export function normalizeAccount(method) {
  const s = String(method ?? '').trim()
  if (!s) return null
  return MONEY_ACCOUNTS.includes(s) ? s : '其他'
}

const blankBucket = () => ({ inFen: 0, outFen: 0, n: 0 })

/** 取一行钱的日期（不同表字段名不同，这里统一兜住） */
const dayOf = (row) =>
  String(row.expense_date ?? row.pay_date ?? row.timestamp ?? row.created_at ?? '').slice(0, 10)

/**
 * 派生资金账户总览。
 * @param {{transactions?: any[], payments?: any[], supplierPayments?: any[], expenses?: any[], opening?: Record<string, number>}} input
 * @param {{from?: string, to?: string}} range 可选日期区间（YYYY-MM-DD，含两端；留空=全部）
 */
export function deriveMoneyAccounts(input, range = {}) {
  const transactions = input?.transactions ?? []
  const payments = input?.payments ?? []
  const supplierPayments = input?.supplierPayments ?? []
  const expenses = input?.expenses ?? []
  const opening = input?.opening ?? {}
  const from = String(range.from ?? '')
  const to = String(range.to ?? '')
  const inRange = (d) => (!from || d >= from) && (!to || d <= to)

  const buckets = new Map(MONEY_ACCOUNTS.map((a) => [a, blankBucket()]))
  const unrec = blankBucket()
  const sources = { salesFen: 0, returnsFen: 0, customerRepayFen: 0, expensesFen: 0, supplierPayFen: 0 }

  // ① 出库实收 / ② 退货退款（同一张表，按 type 分收支）
  for (const t of transactions) {
    if (t?.selling_price == null) continue // 无售价 = 非现金移动（渠道发货/冲减欠款的退货）
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
    const b = acct ? buckets.get(acct) : unrec
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

  // ③ 客户还款（收）
  for (const r of payments) {
    const fen = Number(r?.amount) || 0
    if (!(fen > 0) || !inRange(dayOf(r))) continue
    const acct = normalizeAccount(r.method)
    const b = acct ? buckets.get(acct) : unrec
    b.inFen += fen
    b.n += 1
    if (acct) sources.customerRepayFen += fen
  }

  // ④ 支出（付）
  for (const e of expenses) {
    const fen = Number(e?.amount) || 0
    if (!(fen > 0) || !inRange(dayOf(e))) continue
    const acct = normalizeAccount(e.method)
    const b = acct ? buckets.get(acct) : unrec
    b.outFen += fen
    b.n += 1
    if (acct) sources.expensesFen += fen
  }

  // ⑤ 付供应商（付）
  for (const s of supplierPayments) {
    const fen = Number(s?.amount) || 0
    if (!(fen > 0) || !inRange(dayOf(s))) continue
    const acct = normalizeAccount(s.method)
    const b = acct ? buckets.get(acct) : unrec
    b.outFen += fen
    b.n += 1
    if (acct) sources.supplierPayFen += fen
  }

  const accounts = MONEY_ACCOUNTS.map((account) => {
    const b = buckets.get(account)
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

  const sum = (f) => accounts.reduce((n, a) => n + f(a), 0)
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

/** 把 settings 里存的那段 JSON 解析成 { 现金: 分, ... }；坏值一律当没有 */
export function parseOpening(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!o || typeof o !== 'object') return {}
    const out = {}
    for (const a of MONEY_ACCOUNTS) {
      const v = Number(o[a])
      if (Number.isFinite(v) && v !== 0) out[a] = Math.round(v)
    }
    return out
  } catch {
    return {}
  }
}
