// 通用规格映射单测：品类→字段列表、一行格式化、表单状态互转
import { describe, expect, it } from 'vitest'
import {
  SPEC_FIELDS, collectSpecs, formatSpecs, specFieldsFor, specsToForm,
} from './productSpecs'

describe('specFieldsFor', () => {
  it('任意品类都出通用的颜色/材质/保质期', () => {
    expect(specFieldsFor('饮料')).toEqual(['color', 'material', 'expiry_date'])
    expect(specFieldsFor('五金')).toEqual(['color', 'material', 'expiry_date'])
    expect(specFieldsFor('文具')).toEqual(['color', 'material', 'expiry_date'])
  })
})

describe('formatSpecs', () => {
  it('非空规格拼成一行', () => {
    expect(
      formatSpecs({ color: '红色', material: '不锈钢' }),
    ).toBe('红色 · 不锈钢')
  })

  it('空值和空白串被跳过', () => {
    expect(formatSpecs({ color: null, material: '  ' })).toBe('')
    expect(formatSpecs({ color: '  ', material: 'PE' })).toBe('PE')
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
    form.color = ' 红色 '
    const out = collectSpecs(form)
    expect(out.color).toBe('红色')
    expect(out.material).toBeNull()
    expect(out.expiry_date).toBeNull()
  })

  it('specsToForm 与 collectSpecs 互逆', () => {
    const p = {
      color: '蓝色', material: null, expiry_date: null,
    }
    const form = specsToForm(p)
    expect(form.color).toBe('蓝色')
    expect(form.material).toBe('')
    expect(collectSpecs(form).color).toBe('蓝色')
  })
})
