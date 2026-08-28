// 价格/品名格式化单测：人民币主用，越南盾备用功能也要保证正确（清单第 22 项）
import { describe, expect, it } from 'vitest'
import { formatPrice, formatRelativeTime, productName } from './formatters'

describe('formatPrice', () => {
  it('人民币：分转元保留两位', () => {
    expect(formatPrice(4200)).toBe('¥42.00')
    expect(formatPrice(5)).toBe('¥0.05')
    expect(formatPrice(0)).toBe('¥0.00')
  })

  it('空值显示 - 而不是 null/undefined', () => {
    expect(formatPrice(null)).toBe('-')
    expect(formatPrice(undefined)).toBe('-')
  })

  it('越南盾：最小单位换算后取整，千分位按 vi-VN 习惯', () => {
    // 存 125000（最小单位）→ 显示 1.250 ₫（vi-VN 用点做千分位）
    expect(formatPrice(125000, 'VND')).toBe('₫1.250')
    expect(formatPrice(99, 'VND')).toBe('₫1') // 不足 1 盾的部分取整
    expect(formatPrice(0, 'VND')).toBe('₫0')
    expect(formatPrice(null, 'VND')).toBe('-')
  })
})

describe('productName（null 兜底）', () => {
  it('品牌+型号拼接', () => {
    expect(productName({ brand: '光威', model: '赤刃 3.6m', sku_code: 'JC-1' })).toBe('光威 赤刃 3.6m')
  })
  it('只剩品牌或只剩型号时不带多余空格', () => {
    expect(productName({ brand: '光威', model: null, sku_code: 'JC-1' })).toBe('光威')
    expect(productName({ brand: null, model: '赤刃', sku_code: 'JC-1' })).toBe('赤刃')
  })
  it('都为空回退 SKU，绝不出现 "null"', () => {
    expect(productName({ brand: null, model: null, sku_code: 'JC-QT-XX-XX-001' })).toBe('JC-QT-XX-XX-001')
  })
})

describe('formatRelativeTime（备份状态大白话）', () => {
  const at = (dayOffset: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() - dayOffset)
    d.setHours(hour, 30, 0, 0)
    return d.toISOString()
  }

  it('今天显示"今天 HH:MM"，昨天显示"昨天 HH:MM"', () => {
    expect(formatRelativeTime(at(0, 3))).toBe('今天 03:30')
    expect(formatRelativeTime(at(1, 3))).toBe('昨天 03:30')
  })

  it('更早显示"X 天前"，空值显示"还没有过"', () => {
    expect(formatRelativeTime(at(4, 3))).toBe('4 天前')
    expect(formatRelativeTime(null)).toBe('还没有过')
  })
})
