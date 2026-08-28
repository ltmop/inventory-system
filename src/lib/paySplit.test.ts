import { describe, expect, it } from 'vitest'

import { splitTodayPayments } from './paySplit'
import type { Transaction } from '@/types'

let seq = 1
function tx(partial: Partial<Transaction>): Transaction {
  return {
    id: seq++,
    product_id: 1,
    batch_id: 1,
    type: 'out',
    quantity: 1,
    unit_price: 100,
    selling_price: 200,
    timestamp: new Date().toISOString(),
    operator: null,
    notes: null,
    ...partial,
  }
}

describe('splitTodayPayments（日结收款方式拆分）', () => {
  it('全额收款（paid_amount=null）按方式入账', () => {
    const s = splitTodayPayments([tx({ quantity: 2, selling_price: 8000, pay_method: '微信' })])
    expect(s.byMethod['微信']).toBe(16000)
    expect(s.credit).toBe(0)
    expect(s.unrecorded).toBe(0)
  })

  it('部分付款：实收按方式入账，差额进新增赊账', () => {
    const s = splitTodayPayments([
      tx({ selling_price: 8000, paid_amount: 3000, pay_method: '支付宝', customer_id: 1 }),
    ])
    expect(s.byMethod['支付宝']).toBe(3000)
    expect(s.credit).toBe(5000)
  })

  it('纯赊账（paid=0）：无到账，全额进赊账', () => {
    const s = splitTodayPayments([
      tx({ selling_price: 8000, paid_amount: 0, pay_method: null, customer_id: 1 }),
    ])
    expect(Object.keys(s.byMethod)).toHaveLength(0)
    expect(s.credit).toBe(8000)
  })

  it('收到钱但没记方式进 unrecorded', () => {
    const s = splitTodayPayments([tx({ selling_price: 5000, pay_method: null })])
    expect(s.unrecorded).toBe(5000)
  })

  it('退货退款按方式记负；换货退旧腿与冲减欠款的退货不算现金移动', () => {
    const s = splitTodayPayments([
      tx({ type: 'return', selling_price: 8000, pay_method: '微信' }),
      tx({ type: 'return', selling_price: 8000, notes: '换货退旧', pay_method: '微信' }),
      tx({ type: 'return', selling_price: 8000, pay_method: null, customer_id: 1 }),
    ])
    expect(s.byMethod['微信']).toBe(-8000)
  })

  it('无售价流水（入库等）不参与', () => {
    const s = splitTodayPayments([tx({ type: 'in', selling_price: null })])
    expect(Object.keys(s.byMethod)).toHaveLength(0)
    expect(s.credit).toBe(0)
    expect(s.unrecorded).toBe(0)
  })
})
