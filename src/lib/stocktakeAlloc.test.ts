// 盘点 sku 模式批次分摊单测：算法与后端 electron/commands/stocktake.js submitStockTake 的兜底分摊一致
import { describe, expect, it } from 'vitest'
import { allocSkuToBatches } from './stocktakeAlloc'

const b = (id: number, quantity: number) => ({ id, quantity })

describe('allocSkuToBatches', () => {
  it('系统库存为 0 但盘出有货：全部记到第一个批次', () => {
    const r = allocSkuToBatches([b(1, 0), b(2, 0)], 8, 0)
    expect(r).toEqual([{ batchId: 1, quantity: 8 }])
  })

  it('按数量比例分摊，最后一个批次补平取整误差', () => {
    // 系统 100 = 批1(30) + 批2(70)，盘 50 → 30*50/100=15，70*50/100=35
    const r = allocSkuToBatches([b(1, 30), b(2, 70)], 50, 100)
    expect(r).toEqual([
      { batchId: 1, quantity: 15 },
      { batchId: 2, quantity: 35 },
    ])
    expect(r.reduce((s, x) => s + x.quantity, 0)).toBe(50)
  })

  it('比例分摊取整后总量正好等于目标（末批补差）', () => {
    // 系统 100 = 批1(30) + 批2(30) + 批3(40)，盘 55
    // 批1=16.5→17，批2=16.5→17，批3=55-34=21
    const r = allocSkuToBatches([b(1, 30), b(2, 30), b(3, 40)], 55, 100)
    expect(r.reduce((s, x) => s + x.quantity, 0)).toBe(55)
    expect(r[2]).toEqual({ batchId: 3, quantity: 21 })
  })

  it('单个批次直接等于目标', () => {
    const r = allocSkuToBatches([b(1, 42)], 10, 42)
    expect(r).toEqual([{ batchId: 1, quantity: 10 }])
  })

  it('空批次列表返回空', () => {
    expect(allocSkuToBatches([], 10, 10)).toEqual([])
  })

  it('米商品小数目标按 1 位小数摊（末批补差）', () => {
    // 目标带小数（米商品）→ 每批保留 1 位小数，与后端兜底分摊一致
    const r = allocSkuToBatches([b(1, 300), b(2, 200)], 250.5, 500)
    // 批1 = round(300*250.5/500 *10)/10 = 150.3，批2 = 250.5-150.3 = 100.2
    expect(r[0].quantity).toBe(150.3)
    expect(r[1].quantity).toBe(100.2)
    expect(r.reduce((s, x) => s + x.quantity, 0)).toBeCloseTo(250.5, 1)
  })
})
