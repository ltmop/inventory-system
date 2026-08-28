// client-side 分页：数据本就在内存（loadAll 全量），分页只解决渲染卡顿
// 用法：const pg = usePagination(sortedRows, [sortedRows]) → pg.pageItems 喂给表格，<Pagination {...pg} /> 放表格下
import { useEffect, useMemo, useState } from 'react'

export interface PageSlice<T> {
  pageItems: T[] // 当前页的数据切片
  page: number // 当前页（已夹紧到合法范围）
  pageCount: number // 总页数（至少 1）
  total: number // 总条数
  start: number // 当前页第一条在总列表里的下标（0 起），用于「第 X-Y 条」
}

/** 纯函数：数组切片 + 页码夹紧（筛选后总数变少时不会停在空白页） */
export function paginate<T>(items: T[], page: number, pageSize: number): PageSlice<T> {
  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const start = (safePage - 1) * pageSize
  return { pageItems: items.slice(start, start + pageSize), page: safePage, pageCount, total, start }
}

/**
 * 页码窗口：页数多时不全摆出来，当前页前后各留 1 页，首尾各留 1 页，中间用 '…' 折叠。
 * 例：page=5, pageCount=12 → [1, '…', 4, 5, 6, '…', 12]
 */
export function pageNumbers(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)
  const pages = new Set<number>([1, pageCount, page - 1, page, page + 1])
  const sorted = [...pages].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)
  const out: (number | '…')[] = []
  let prev = 0
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
}

export interface UsePaginationResult<T> extends PageSlice<T> {
  pageSize: number
  setPage: (page: number) => void
  setPageSize: (size: number) => void // 换每页条数时回第 1 页
}

/**
 * client-side 分页 hook。
 * @param items 已经「先筛选后排序」好的完整列表，分页切在最后
 * @param resetDeps 这些值变化时回第 1 页（一般传筛选结果数组本身）
 * @param defaultPageSize 默认每页 50 条
 */
export function usePagination<T>(
  items: T[],
  resetDeps: readonly unknown[] = [items],
  defaultPageSize = 50,
): UsePaginationResult<T> {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeRaw] = useState(defaultPageSize)

  // 筛选变化回第 1 页（deps 由调用方显式给，通常是 items 本身）
  useEffect(() => {
    setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps)

  const slice = useMemo(() => paginate(items, page, pageSize), [items, page, pageSize])

  const setPageSize = (size: number) => {
    setPageSizeRaw(size)
    setPage(1)
  }

  return { ...slice, pageSize, setPage, setPageSize }
}
