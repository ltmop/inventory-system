import { describe, expect, it } from 'vitest'

import { subCategoryOptions } from './subCategories'

const P = (category: string, sub: string | null) => ({ category, sub_category: sub })

describe('subCategoryOptions', () => {
  it('去重后"用得多的排前面"（复用越多的越容易被选中）', () => {
    const out = subCategoryOptions([
      P('鱼钩', '伊势尼'),
      P('鱼钩', '新关东'),
      P('鱼钩', '伊势尼'),
      P('鱼钩', '伊势尼'),
      P('鱼钩', '新关东'),
    ])
    expect(out).toEqual(['伊势尼', '新关东'])
  })

  it('传了品类就只给该品类用过的子类（鱼钩下面不该建议纺车轮）', () => {
    const all = [P('鱼钩', '伊势尼'), P('渔轮', '纺车轮')]
    expect(subCategoryOptions(all, '鱼钩')).toEqual(['伊势尼'])
    expect(subCategoryOptions(all, '渔轮')).toEqual(['纺车轮'])
    // 不传品类 = 不限，两个都在
    const noScope = subCategoryOptions(all)
    expect(noScope).toHaveLength(2)
    expect(noScope).toContain('伊势尼')
    expect(noScope).toContain('纺车轮')
  })

  it('null / 空串 / 纯空格一律不算候选', () => {
    expect(subCategoryOptions([P('鱼钩', null), P('鱼钩', ''), P('鱼钩', '   ')])).toEqual([])
  })

  it('首尾空格归一后再去重（" 伊势尼 " 与 "伊势尼" 是同一个值）', () => {
    expect(subCategoryOptions([P('鱼钩', '伊势尼'), P('鱼钩', ' 伊势尼 ')])).toEqual(['伊势尼'])
  })

  it('空列表 → 空候选，不抛错', () => {
    expect(subCategoryOptions([])).toEqual([])
    expect(subCategoryOptions([], '鱼钩')).toEqual([])
  })

  it('带注解的真值一个字都不改（这是老板真实输入的渔具子类，不是脏数据）', () => {
    // 生产库实测里这类值很多：'伊势尼(粗弯倒刺深)' '筏竿(极短1.2-1.8m)'
    // 曾经被判成"自由文本污染"、要收成受控下拉 —— 那会把这些真值全丢掉。
    const v = '伊势尼(粗弯倒刺深)'
    expect(subCategoryOptions([P('鱼钩', v)])).toEqual([v])
  })

  it('不修改入参（纯函数）', () => {
    const input = [P('鱼钩', '伊势尼')]
    const snapshot = JSON.stringify(input)
    subCategoryOptions(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
