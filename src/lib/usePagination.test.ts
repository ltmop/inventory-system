// 分页纯函数单测：切片、页码夹紧、页码窗口
import { describe, expect, it } from 'vitest'
import { paginate, pageNumbers } from './usePagination'

const list = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('paginate', () => {
  it('按页切片：第 1 页取前 pageSize 条', () => {
    const r = paginate(list(137), 1, 20)
    expect(r.pageItems).toEqual(list(20))
    expect(r.total).toBe(137)
    expect(r.pageCount).toBe(7)
    expect(r.start).toBe(0)
  })

  it('最后一页只装剩下的', () => {
    const r = paginate(list(137), 7, 20)
    expect(r.pageItems).toEqual(list(137).slice(120))
    expect(r.pageItems).toHaveLength(17)
    expect(r.start).toBe(120)
  })

  it('页码越界时夹紧：筛选后总数变少不会停在空白页', () => {
    const r = paginate(list(10), 5, 20)
    expect(r.page).toBe(1)
    expect(r.pageItems).toEqual(list(10))
    const r2 = paginate(list(137), 99, 20)
    expect(r2.page).toBe(7)
  })

  it('空列表：1 页 0 条，不崩', () => {
    const r = paginate([], 1, 50)
    expect(r.pageCount).toBe(1)
    expect(r.pageItems).toEqual([])
    expect(r.total).toBe(0)
  })

  it('不足一页时只有 1 页', () => {
    const r = paginate(list(50), 1, 50)
    expect(r.pageCount).toBe(1)
    expect(r.pageItems).toHaveLength(50)
  })
})

describe('pageNumbers', () => {
  it('7 页以内全摆出来', () => {
    expect(pageNumbers(1, 1)).toEqual([1])
    expect(pageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('页数多时折叠中间：开头', () => {
    expect(pageNumbers(1, 12)).toEqual([1, 2, '…', 12])
  })

  it('页数多时折叠中间：中间页前后各留 1 页', () => {
    expect(pageNumbers(5, 12)).toEqual([1, '…', 4, 5, 6, '…', 12])
  })

  it('页数多时折叠中间：结尾', () => {
    expect(pageNumbers(12, 12)).toEqual([1, '…', 11, 12])
  })

  it('连续段不重复加省略号', () => {
    expect(pageNumbers(2, 12)).toEqual([1, 2, 3, '…', 12])
    expect(pageNumbers(11, 12)).toEqual([1, '…', 10, 11, 12])
  })
})
