// 临期/过期计算单测：口径必须与后端 commands.js 的 expiringProducts 一致
import { describe, expect, it } from 'vitest'
import { computeExpiring, parseExpiryDate } from './expiry'

/** 生成相对今天 n 天后的本地日期串 YYYY-MM-DD（n 为负=已过期） */
function dateInDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const prod = (
  id: number,
  expiry_date: string | null,
): { id: number; sku_code: string; brand: string; model: string; expiry_date: string | null } => ({
  id,
  sku_code: `SKU-${id}`,
  brand: '测试',
  model: `商品${id}`,
  expiry_date,
})

describe('parseExpiryDate', () => {
  it('YYYY-MM 解析为当月最后一天', () => {
    const d = parseExpiryDate('2026-07')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)
    expect(d.getDate()).toBe(31)
  })

  it('YYYY-MM-DD 解析为当天', () => {
    const d = parseExpiryDate('2026-02-14')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(1)
    expect(d.getDate()).toBe(14)
  })

  it('无法识别的写法返回 null', () => {
    expect(parseExpiryDate('2026/07/01')).toBeNull()
    expect(parseExpiryDate('长期')).toBeNull()
    expect(parseExpiryDate('')).toBeNull()
    expect(parseExpiryDate(null)).toBeNull()
  })
})

describe('computeExpiring', () => {
  const stockOf = (stock: Record<number, number>) => (id: number) => stock[id] ?? 0

  it('30 天内到期纳入，超过 30 天不纳入', () => {
    const list = computeExpiring(
      [prod(1, dateInDays(10)), prod(2, dateInDays(31))],
      stockOf({ 1: 5, 2: 5 }),
    )
    expect(list.map((x) => x.id)).toEqual([1])
    expect(list[0].daysLeft).toBe(10)
    expect(list[0].expired).toBe(false)
  })

  it('已过期的 daysLeft 为负且 expired=true', () => {
    const list = computeExpiring([prod(1, dateInDays(-3))], stockOf({ 1: 2 }))
    expect(list).toHaveLength(1)
    expect(list[0].daysLeft).toBe(-3)
    expect(list[0].expired).toBe(true)
  })

  it('没库存 / 没保质期 / 保质期无法识别的不参与预警', () => {
    const list = computeExpiring(
      [prod(1, dateInDays(5)), prod(2, null), prod(3, '长期')],
      stockOf({ 2: 9, 3: 9 }), // 1 号库存 0
    )
    expect(list).toHaveLength(0)
  })

  it('按过期日升序：最紧的排最前（过期的在最前）', () => {
    const list = computeExpiring(
      [prod(1, dateInDays(20)), prod(2, dateInDays(-1)), prod(3, dateInDays(5))],
      stockOf({ 1: 1, 2: 1, 3: 1 }),
    )
    expect(list.map((x) => x.id)).toEqual([2, 3, 1])
  })

  it('YYYY-MM 当月保质：本月最后一天前都算临期', () => {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const list = computeExpiring([prod(1, ym)], stockOf({ 1: 1 }))
    expect(list).toHaveLength(1)
    expect(list[0].expired).toBe(false)
  })
})
