// 计量单位工具单测（v2.2）：件=整数，米=最多 1 位小数
import { describe, expect, it } from 'vitest'
import { roundQty, unitOf, unitLabel, validateQty } from './quantity'

describe('roundQty', () => {
  it('整数保持原样', () => {
    expect(roundQty(5)).toBe(5)
  })
  it('1 位小数保留', () => {
    expect(roundQty(3.5)).toBe(3.5)
  })
  it('多位小数归一为 1 位', () => {
    expect(roundQty(3.55)).toBe(3.6)
  })
})

describe('unitOf / unitLabel', () => {
  it('没传单位默认件', () => {
    expect(unitOf(null)).toBe('件')
    expect(unitOf(undefined)).toBe('件')
    expect(unitOf({})).toBe('件')
  })
  it('米商品返回米', () => {
    expect(unitOf({ unit: '米' })).toBe('米')
  })
  it('unitLabel 与 unitOf 同口径', () => {
    expect(unitLabel({ unit: '米' })).toBe('米')
    expect(unitLabel({ unit: '件' })).toBe('件')
  })
})

describe('validateQty', () => {
  it('件：正整数合法，0/负数/小数/非数字拒绝', () => {
    expect(validateQty(1, '件')).toBe(1)
    expect(validateQty(100, '件')).toBe(100)
    expect(validateQty(0, '件')).toBeNull()
    expect(validateQty(-3, '件')).toBeNull()
    expect(validateQty(3.5, '件')).toBeNull()
    expect(validateQty(NaN, '件')).toBeNull()
    expect(validateQty(Infinity, '件')).toBeNull()
  })

  it('米：正数且最多 1 位小数合法', () => {
    expect(validateQty(3, '米')).toBe(3)
    expect(validateQty(3.5, '米')).toBe(3.5)
    expect(validateQty(500, '米')).toBe(500)
  })

  it('米：0/负数/多位小数/非数字拒绝', () => {
    expect(validateQty(0, '米')).toBeNull()
    expect(validateQty(-1.5, '米')).toBeNull()
    expect(validateQty(3.55, '米')).toBeNull()
    expect(validateQty(NaN, '米')).toBeNull()
  })
})
