// 散货按金额卖：口径单测（老板的现场数字就是这里的夹具）
import { describe, expect, it } from 'vitest'
import {
  BULK_AMOUNTS_FEN,
  actualFenForAmount,
  isBulkWeightProduct,
  isBulkWeightUnit,
  perGramFenFromPerJin,
  perJinYuanFromPerGram,
  qtyForAmount,
} from './bulkSell'

describe('散货单位判定', () => {
  it('重量类单位才算散货候选', () => {
    expect(isBulkWeightUnit('克')).toBe(true)
    expect(isBulkWeightUnit('斤')).toBe(true)
    expect(isBulkWeightUnit('件')).toBe(false)
    expect(isBulkWeightUnit(null)).toBe(false)
  })
  it('必须同时"重量类 + 允许小数"才算散货商品', () => {
    expect(isBulkWeightProduct({ unit: '克', unit_decimal: 1 })).toBe(true)
    expect(isBulkWeightProduct({ unit: '克', unit_decimal: 0 })).toBe(false)
    expect(isBulkWeightProduct({ unit: '包', unit_decimal: 1 })).toBe(false)
    expect(isBulkWeightProduct(null)).toBe(false)
  })
})

describe('按斤报价 → 每克价（老板报价习惯）', () => {
  it('¥70/斤 = 14 分/克（正好整除）', () => {
    expect(perGramFenFromPerJin(70)).toBe(14)
  })
  it('除不尽的按分四舍五入（¥68/斤 ≈ 14 分/克）', () => {
    expect(perGramFenFromPerJin(68)).toBe(14)
  })
  it('反向回显：14 分/克 = ¥70/斤', () => {
    expect(perJinYuanFromPerGram(14)).toBe(70)
  })
  it('坏值返回 null（不让它把录入界面算崩）', () => {
    expect(perGramFenFromPerJin(0)).toBeNull()
    expect(perGramFenFromPerJin(-1)).toBeNull()
    expect(perGramFenFromPerJin(Number.NaN)).toBeNull()
    expect(perJinYuanFromPerGram(0)).toBeNull()
  })
})

describe('按金额折算重量（客户说"来 5 块钱的"）', () => {
  it('¥5 ÷ ¥0.14/克 ≈ 35.7 克（老板说"5 块钱正常 35 克"，口径对得上）', () => {
    expect(qtyForAmount(500, 14)).toBe(35.7)
  })
  it('其余档位也是整数金额换重量', () => {
    expect(BULK_AMOUNTS_FEN).toEqual([500, 1000, 1500, 2000])
    expect(qtyForAmount(1000, 14)).toBe(71.4)
    expect(qtyForAmount(1500, 14)).toBe(107.1)
    expect(qtyForAmount(2000, 14)).toBe(142.9)
  })
  it('数量只保留 1 位小数（与全站数量口径一致）', () => {
    const q = qtyForAmount(500, 13)!
    expect(Math.round(q * 10) / 10).toBe(q)
  })
  it('折出来的钱与客户口报金额只差几厘（报表按实际重量算）', () => {
    expect(actualFenForAmount(500, 14)).toBe(500) // 35.7 × 14 = 499.8 → 500
    expect(actualFenForAmount(1000, 14)).toBe(1000)
    expect(actualFenForAmount(1500, 14)).toBe(1499) // 107.1 × 14 = 1499.4 → 1499
  })
  it('单价或金额非法时返回 null（不猜、不崩）', () => {
    expect(qtyForAmount(500, 0)).toBeNull()
    expect(qtyForAmount(0, 14)).toBeNull()
    expect(qtyForAmount(-500, 14)).toBeNull()
    expect(qtyForAmount(Number.NaN, 14)).toBeNull()
    expect(actualFenForAmount(500, 0)).toBeNull()
  })
  it('金额太小、折出来不足 0.1 时返回 null（宁可报错也不记 0）', () => {
    expect(qtyForAmount(1, 1000)).toBeNull()
  })
})
