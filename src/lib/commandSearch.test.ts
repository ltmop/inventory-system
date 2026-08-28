// 命令面板搜索匹配逻辑单测：字段优先级、前缀加权、limit、命令别名
import { describe, expect, it } from 'vitest'
import { searchCommands, searchProducts, STATIC_COMMANDS } from './commandSearch'
import type { Product } from '@/types'

function makeProduct(overrides: Partial<Product>): Product {
  return {
    id: 1,
    sku_code: 'FG-0001',
    barcode: null,
    category: '鱼竿',
    sub_category: null,
    brand: null,
    model: null,
    cost_price: 10000,
    suggest_price: null,
    location: null,
    photo_path: null,
    name_vi: null,
    rod_length: null,
    line_number: null,
    hook_size: null,
    color: null,
    material: null,
    rod_action: null,
    power_rating: null,
    expiry_date: null,
    min_stock: null,
    status: '已盘点',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  }
}

describe('searchProducts', () => {
  const products = [
    makeProduct({ id: 1, sku_code: 'FG-0001', brand: '光威', model: '赤刃4.5米' }),
    makeProduct({ id: 2, sku_code: 'YL-0002', brand: '达瓦', model: '纺车轮2500' }),
    makeProduct({ id: 3, sku_code: 'YG-0003', barcode: '6901234567890', brand: ' Owner', model: '伊势尼8号' }),
    makeProduct({ id: 4, sku_code: 'XL-0004', brand: '大力马', model: 'PE线2号' }),
  ]

  it('空关键词不返回任何结果', () => {
    expect(searchProducts(products, '')).toEqual([])
    expect(searchProducts(products, '   ')).toEqual([])
  })

  it('按品牌/型号/SKU/条码都能命中', () => {
    expect(searchProducts(products, '光威')[0].product.id).toBe(1)
    expect(searchProducts(products, '纺车轮')[0].product.id).toBe(2)
    expect(searchProducts(products, 'fg-0001')[0].product.id).toBe(1) // 大小写不敏感
    expect(searchProducts(products, '690123')[0].product.id).toBe(3) // 条码前缀
  })

  it('SKU 命中排在品牌命中前面（字段优先级）', () => {
    const list = [
      makeProduct({ id: 10, sku_code: 'ZZ-0001', brand: 'AA渔具' }),
      makeProduct({ id: 11, sku_code: 'AA-0002', brand: '别的' }),
    ]
    const result = searchProducts(list, 'aa')
    expect(result[0].product.id).toBe(11)
    expect(result[0].matchedField).toBe('sku')
    expect(result[1].matchedField).toBe('brand')
  })

  it('同字段内前缀命中排在中间包含命中前面', () => {
    const list = [
      makeProduct({ id: 20, brand: '老光威' }),
      makeProduct({ id: 21, brand: '光威' }),
    ]
    const result = searchProducts(list, '光威')
    expect(result.map((r) => r.product.id)).toEqual([21, 20])
  })

  it('一个商品只出现一次，且取最高优先级字段', () => {
    const list = [makeProduct({ id: 30, sku_code: 'FG-0001', brand: 'FG牌' })]
    const result = searchProducts(list, 'fg')
    expect(result).toHaveLength(1)
    expect(result[0].matchedField).toBe('sku')
  })

  it('结果数量受 limit 限制', () => {
    const list = Array.from({ length: 20 }, (_, i) =>
      makeProduct({ id: i + 1, brand: `光威${i}` }),
    )
    expect(searchProducts(list, '光威', 8)).toHaveLength(8)
    expect(searchProducts(list, '光威', 3)).toHaveLength(3)
  })

  it('匹配不到时返回空数组', () => {
    expect(searchProducts(products, '不存在的牌子')).toEqual([])
  })
})

describe('searchCommands', () => {
  it('空关键词返回全部静态命令', () => {
    expect(searchCommands('')).toEqual(STATIC_COMMANDS)
    expect(searchCommands('  ')).toEqual(STATIC_COMMANDS)
  })

  it('按命令名匹配：入库中心排前面，具体入库页次之', () => {
    const result = searchCommands('入库')
    expect(result[0].id).toBe('go-inbound-hub')
    expect(result.map((c) => c.id)).toContain('go-inbound')
  })

  it('按别名关键词匹配', () => {
    expect(searchCommands('卖货').map((c) => c.id)).toEqual(['go-sales-hub', 'go-outbound'])
    expect(searchCommands('首页').map((c) => c.id)).toEqual(['go-dashboard'])
  })

  it('按功能名匹配设置', () => {
    expect(searchCommands('设置').map((c) => c.id)).toEqual(['go-settings'])
  })

  it('匹配不到时返回空数组', () => {
    expect(searchCommands('不存在的功能xyz')).toEqual([])
  })
})
