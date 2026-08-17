// 通用规格映射单测：品类→字段列表、一行格式化、表单状态互转
import { describe, expect, it } from 'vitest'
import { CATEGORIES } from '@/types'
import {
  SPEC_FIELDS, collectSpecs, formatSpecs, specFieldsFor, specsToForm,
} from './productSpecs'

describe('specFieldsFor', () => {
  it('任何品类统一给颜色/材质/保质期', () => {
    for (const c of CATEGORIES) {
      expect(specFieldsFor(c)).toEqual(['color', 'material', 'expiry_date'])
    }
  })
})

describe('requiresExpiry', () => {
  it('通用版不按品类强制到期日（全部可选）', async () => {
    const { requiresExpiry } = await import('./productSpecs')
    expect(requiresExpiry('食品饮料')).toBe(false)
    expect(requiresExpiry(null)).toBe(false)
  })
})

describe('formatSpecs', () => {
  it('非空规格拼成一行', () => {
    expect(
      formatSpecs({ color: '红', material: '不锈钢' }),
    ).toBe('红 · 不锈钢')
  })

  it('空值和空白串被跳过', () => {
    expect(formatSpecs({ color: null, material: 'PE' })).toBe('PE')
  })

  it('全空返回空串', () => {
    expect(formatSpecs({})).toBe('')
    expect(
      formatSpecs(Object.fromEntries(SPEC_FIELDS.map((f) => [f, null]))),
    ).toBe('')
  })
})

describe('collectSpecs / specsToForm', () => {
  it('表单空串归 null，非空去空白', () => {
    const form = Object.fromEntries(SPEC_FIELDS.map((f) => [f, ''])) as Record<
      (typeof SPEC_FIELDS)[number],
      string
    >
    form.material = ' 不锈钢 '
    const out = collectSpecs(form)
    expect(out.material).toBe('不锈钢')
    expect(out.color).toBeNull()
    expect(out.expiry_date).toBeNull()
  })

  it('specsToForm 与 collectSpecs 互逆', () => {
    const p = {
      color: '红', material: null, expiry_date: '2027-06',
    }
    const form = specsToForm(p)
    expect(form.color).toBe('红')
    expect(form.material).toBe('')
    expect(collectSpecs(form).expiry_date).toBe('2027-06')
  })
})
