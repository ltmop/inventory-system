// 资金账户（最小形态）单测：账户 = 收款方式，余额 = 期初 + Σ收 − Σ付
import { describe, expect, it } from 'vitest'
import { deriveMoneyAccounts, normalizeAccount, parseOpening, MONEY_ACCOUNTS } from './moneyAccounts'

const sale = (o: Record<string, unknown> = {}) => ({
  type: 'out', quantity: 2, selling_price: 1000, paid_amount: null, pay_method: '现金',
  timestamp: '2026-09-22T10:00:00.000Z', ...o,
})

describe('normalizeAccount', () => {
  it('四个账户原样返回；空值 = 未登记（null）；没见过的值归「其他」', () => {
    expect(normalizeAccount('现金')).toBe('现金')
    expect(normalizeAccount(' 微信 ')).toBe('微信')
    expect(normalizeAccount('')).toBeNull()
    expect(normalizeAccount(null)).toBeNull()
    expect(normalizeAccount('银行转账')).toBe('其他')
  })
})

describe('deriveMoneyAccounts', () => {
  it('出库实收进「收」：没记实收就按 售价×数量 算全额', () => {
    const r = deriveMoneyAccounts({ transactions: [sale()] })
    const cash = r.accounts.find((a) => a.account === '现金')!
    expect(cash.inFen).toBe(2000)
    expect(cash.outFen).toBe(0)
    expect(cash.closingFen).toBe(2000)
    expect(r.totals.inFen).toBe(2000)
  })

  it('记了实收（部分付款）就按实收算，不按售价', () => {
    const r = deriveMoneyAccounts({ transactions: [sale({ paid_amount: 500 })] })
    expect(r.totals.inFen).toBe(500)
  })

  it('退货进「付」', () => {
    const r = deriveMoneyAccounts({ transactions: [sale({ type: 'return' })] })
    expect(r.totals.outFen).toBe(2000)
    expect(r.totals.inFen).toBe(0)
    expect(r.sources.returnsFen).toBe(2000)
  })

  it('没有售价的 out/return 不算现金移动（渠道发货不碰钱）', () => {
    const r = deriveMoneyAccounts({ transactions: [sale({ selling_price: null }), sale({ type: 'return', selling_price: null })] })
    expect(r.totals.n).toBe(0)
    expect(r.totals.inFen).toBe(0)
  })

  it('入库/报损等非 out/return 的流水一概不算', () => {
    const r = deriveMoneyAccounts({ transactions: [sale({ type: 'in' }), sale({ type: 'waste' })] })
    expect(r.totals.n).toBe(0)
  })

  it('客户还款进「收」，支出与付供应商进「付」，并按方式分账户', () => {
    const r = deriveMoneyAccounts({
      payments: [{ amount: 300, method: '微信', created_at: '2026-09-22' }],
      expenses: [{ amount: 120, method: '现金', expense_date: '2026-09-22' }],
      supplierPayments: [{ amount: 800, method: '支付宝', pay_date: '2026-09-22' }],
    })
    expect(r.accounts.find((a) => a.account === '微信')!.inFen).toBe(300)
    expect(r.accounts.find((a) => a.account === '现金')!.outFen).toBe(120)
    expect(r.accounts.find((a) => a.account === '支付宝')!.outFen).toBe(800)
    expect(r.sources.customerRepayFen).toBe(300)
    expect(r.sources.expensesFen).toBe(120)
    expect(r.sources.supplierPayFen).toBe(800)
  })

  it('没记方式的钱进「未登记方式」桶，绝不摊到任何账户头上', () => {
    const r = deriveMoneyAccounts({ transactions: [sale({ pay_method: null })] })
    expect(r.unrecorded.inFen).toBe(2000)
    expect(r.unrecorded.n).toBe(1)
    expect(r.totals.inFen).toBe(0) // 合计里也不含它
    for (const a of r.accounts) expect(a.inFen).toBe(0)
  })

  it('期初只影响余额，不影响收付', () => {
    const r = deriveMoneyAccounts(
      { transactions: [sale()], opening: { 现金: 10000 } },
      {},
    )
    const cash = r.accounts.find((a) => a.account === '现金')!
    expect(cash.openingFen).toBe(10000)
    expect(cash.inFen).toBe(2000)
    expect(cash.closingFen).toBe(12000)
    expect(r.totals.openingFen).toBe(10000)
    expect(r.totals.closingFen).toBe(12000)
  })

  it('日期区间含两端，区间外的钱不算', () => {
    const rows = [sale({ timestamp: '2026-09-01T00:00:00.000Z' }), sale({ timestamp: '2026-09-22T00:00:00.000Z' })]
    expect(deriveMoneyAccounts({ transactions: rows }, { from: '2026-09-22', to: '2026-09-22' }).totals.inFen).toBe(2000)
    expect(deriveMoneyAccounts({ transactions: rows }, { from: '2026-09-23' }).totals.inFen).toBe(0)
    expect(deriveMoneyAccounts({ transactions: rows }, { to: '2026-09-01' }).totals.inFen).toBe(2000)
  })

  it('四个账户永远都在（哪怕一笔没有），界面上不会缺行', () => {
    const r = deriveMoneyAccounts({})
    expect(r.accounts.map((a) => a.account)).toEqual([...MONEY_ACCOUNTS])
    expect(r.totals.closingFen).toBe(0)
  })

  it('空输入不炸（老库/刚开店时就是全空）', () => {
    expect(() => deriveMoneyAccounts({ transactions: [], payments: [], expenses: [], supplierPayments: [] })).not.toThrow()
  })
})

describe('parseOpening', () => {
  it('解析合法 JSON；只保留四个账户里的非零值', () => {
    expect(parseOpening('{"现金":10000,"微信":0,"其他":500}')).toEqual({ 现金: 10000, 其他: 500 })
  })
  it('坏值一律当没有（不能让期初把整页打挂）', () => {
    expect(parseOpening('{不是 json')).toEqual({})
    expect(parseOpening(null)).toEqual({})
    expect(parseOpening('"字符串"')).toEqual({})
  })
})

// 双胞胎防漂移（这是本文件最重要的一段）：
// 界面那份（本文件所在模块）与服务端/主进程那份（electron/lib/moneyAccounts.js）是**两份物理实现**，
// 必须逐例同输出。改了一边忘了另一边 → 桌面上看到的余额和手机/Agent 看到的对不上，这里直接红。
describe('双胞胎：src 那份 与 electron/lib 那份 逐例同输出', () => {
  it('同一组输入 → 完全一样的结构', async () => {
    // @ts-expect-error electron 那份是纯 JS（没有 .d.ts）：这里**就是要**拿它做逐例比对。
    // 哪天真给它配了类型声明，这行会变成"多余的忽略"并报错 —— 正好当提示。
    const lib = (await import('../../electron/lib/moneyAccounts.js')) as unknown as typeof import('./moneyAccounts')
    const input = {
      transactions: [
        { type: 'out', quantity: 2, selling_price: 1000, paid_amount: null, pay_method: '现金', timestamp: '2026-09-22T10:00:00.000Z' },
        { type: 'out', quantity: 1, selling_price: 5000, paid_amount: 3000, pay_method: '微信', timestamp: '2026-09-22T11:00:00.000Z' },
        { type: 'return', quantity: 1, selling_price: 1000, paid_amount: null, pay_method: '现金', timestamp: '2026-09-22T12:00:00.000Z' },
        { type: 'out', quantity: 3, selling_price: null, paid_amount: null, pay_method: '现金', timestamp: '2026-09-22T13:00:00.000Z' },
        { type: 'out', quantity: 1, selling_price: 999, paid_amount: null, pay_method: null, timestamp: '2026-09-22T14:00:00.000Z' },
        { type: 'out', quantity: 1, selling_price: 777, paid_amount: null, pay_method: '银行', timestamp: '2026-09-23T09:00:00.000Z' },
      ],
      payments: [{ amount: 300, method: '微信', created_at: '2026-09-22' }],
      expenses: [{ amount: 120, method: '现金', expense_date: '2026-09-22' }],
      supplierPayments: [{ amount: 800, method: '支付宝', pay_date: '2026-09-22' }],
      opening: { 现金: 10000, 微信: -200 },
    }
    const cases: Array<{ from?: string; to?: string }> = [{}, { from: '2026-09-22', to: '2026-09-22' }, { from: '2026-09-23' }]
    for (const range of cases) {
      expect(deriveMoneyAccounts(input, range)).toEqual(lib.deriveMoneyAccounts(input, range))
    }
    // 顺带把两个常量也钉住（账户取值域漂移了同样会让两边对不上）
    expect([...MONEY_ACCOUNTS]).toEqual([...lib.MONEY_ACCOUNTS])
    expect(parseOpening('{"现金":10000}')).toEqual(lib.parseOpening('{"现金":10000}'))
    expect(normalizeAccount('银行')).toBe(lib.normalizeAccount('银行'))
  })
})
