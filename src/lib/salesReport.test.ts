import { describe, expect, it } from 'vitest'
import { buildRangeReport, localDayKey, rangePreset } from './salesReport'
import type { Transaction } from '@/types'

let seq = 0
function mk(over: Partial<Transaction>): Transaction {
  return {
    id: ++seq,
    product_id: 1,
    batch_id: 1,
    type: 'out',
    quantity: 1,
    unit_price: 500,
    selling_price: 1000,
    timestamp: '2026-07-15T03:00:00.000Z', // 北京 7-15 11:00
    operator: '测试',
    notes: null,
    customer_id: null,
    paid_amount: null,
    pay_method: null,
    ...over,
  }
}

describe('localDayKey（本地日归类）', () => {
  it('UTC 下午 4 点半 = 北京次日凌晨，归入第二天', () => {
    expect(localDayKey('2026-07-15T16:30:00.000Z')).toBe('2026-07-16')
  })
  it('UTC 上午 = 北京同一天', () => {
    expect(localDayKey('2026-07-15T03:00:00.000Z')).toBe('2026-07-15')
  })
})

describe('buildRangeReport', () => {
  it('全额收款：paid_amount null 视为全额付清，未记方式进 unrecorded', () => {
    const r = buildRangeReport([mk({})], '2026-07-15', '2026-07-15')
    expect(r.days).toHaveLength(1)
    const d = r.days[0]
    expect(d.revenue).toBe(1000)
    expect(d.profit).toBe(500)
    expect(d.qty).toBe(1)
    expect(d.unrecorded).toBe(1000)
    expect(d.credit).toBe(0)
    expect(r.totals.margin).toBeCloseTo(0.5)
  })

  it('部分付款：实收按方式入账，差额记新增赊账', () => {
    const r = buildRangeReport(
      [mk({ paid_amount: 400, pay_method: '微信' })],
      '2026-07-15',
      '2026-07-15',
    )
    const d = r.days[0]
    expect(d.byMethod['微信']).toBe(400)
    expect(d.credit).toBe(600)
    expect(d.unrecorded).toBe(0)
  })

  it('纯赊账：没有现金移动，不计任何方式', () => {
    const r = buildRangeReport(
      [mk({ paid_amount: 0, pay_method: null, customer_id: 1 })],
      '2026-07-15',
      '2026-07-15',
    )
    const d = r.days[0]
    expect(d.credit).toBe(1000)
    expect(d.unrecorded).toBe(0)
    expect(Object.keys(d.byMethod)).toHaveLength(0)
  })

  it('真退钱的退货：营业额冲减、退款额统计、方式记负', () => {
    const r = buildRangeReport(
      [
        mk({}),
        mk({ type: 'return', selling_price: 1000, unit_price: 500, pay_method: '现金' }),
      ],
      '2026-07-15',
      '2026-07-15',
    )
    const d = r.days[0]
    expect(d.revenue).toBe(0)
    expect(d.profit).toBe(0)
    expect(d.qty).toBe(0)
    expect(d.refundAmount).toBe(1000)
    expect(d.byMethod['现金']).toBe(-1000)
  })

  it('换货退旧腿不算销售', () => {
    const r = buildRangeReport(
      [mk({ type: 'return', notes: '换货退旧', pay_method: null })],
      '2026-07-15',
      '2026-07-15',
    )
    expect(r.days).toHaveLength(0)
  })

  it('冲减欠款的退货（无方式）：营业额照冲，但不动到账方式', () => {
    const r = buildRangeReport(
      [mk({}), mk({ type: 'return', pay_method: null, customer_id: 1 })],
      '2026-07-15',
      '2026-07-15',
    )
    const d = r.days[0]
    expect(d.revenue).toBe(0)
    expect(d.unrecorded).toBe(1000) // 只有出库那笔
    expect(Object.keys(d.byMethod)).toHaveLength(0)
  })

  it('没填售价的流水：件数照算，不动金额', () => {
    const r = buildRangeReport([mk({ selling_price: null })], '2026-07-15', '2026-07-15')
    const d = r.days[0]
    expect(d.qty).toBe(1)
    expect(d.revenue).toBe(0)
    expect(d.profit).toBe(0)
  })

  it('区间含两端，区间外的流水不进来；跨本地日正确分桶', () => {
    const r = buildRangeReport(
      [
        mk({ timestamp: '2026-07-14T16:30:00.000Z' }), // 北京 7-15 00:30 → 7-15
        mk({ timestamp: '2026-07-15T16:30:00.000Z' }), // 北京 7-16 00:30 → 7-16
        mk({ timestamp: '2026-07-13T03:00:00.000Z' }), // 7-13，区间外
      ],
      '2026-07-15',
      '2026-07-16',
    )
    expect(r.days).toHaveLength(2)
    expect(r.days[0].date).toBe('2026-07-15')
    expect(r.days[1].date).toBe('2026-07-16')
    expect(r.totals.revenue).toBe(2000)
  })

  it('多种方式合计 + 毛利率', () => {
    const r = buildRangeReport(
      [
        mk({ pay_method: '现金' }),
        mk({ pay_method: '支付宝' }),
        mk({ quantity: 2, paid_amount: 1500, pay_method: '微信' }), // 应付 2000 赊 500
      ],
      '2026-07-01',
      '2026-07-31',
    )
    const t = r.totals
    expect(t.revenue).toBe(4000)
    expect(t.byMethod['现金']).toBe(1000)
    expect(t.byMethod['支付宝']).toBe(1000)
    expect(t.byMethod['微信']).toBe(1500)
    expect(t.credit).toBe(500)
    expect(t.margin).toBeCloseTo((4000 - 500 * 4) / 4000)
  })

  it('空区间：没有日子，合计为零、毛利率 null', () => {
    const r = buildRangeReport([], '2026-07-15', '2026-07-16')
    expect(r.days).toHaveLength(0)
    expect(r.totals.revenue).toBe(0)
    expect(r.totals.margin).toBeNull()
  })
})

describe('rangePreset', () => {
  it('上月：从上月 1 号到月末', () => {
    const [from, to] = rangePreset('lastMonth')
    expect(from.slice(0, 7)).toBe(to.slice(0, 7))
    expect(from.endsWith('-01')).toBe(true)
    expect(Number(from.slice(5, 7))).toBe(((new Date().getMonth() + 11) % 12) + 1)
  })
})
