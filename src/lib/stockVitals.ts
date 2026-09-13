/**
 * 库存体征的**唯一判据**（顶栏 / 首页 / 库存页 / 低库存提醒 / 表格 共用一份）。
 *
 * 为什么要收这一份（2026-09-14 真机取证）：
 *   同一个「低库存」在代码里有**两种写法并存**——
 *     `总库存 <  预警线`（TopBar.tsx / DashboardPage.tsx / InventoryTable.tsx / LowStockAlert.tsx）
 *     `总库存 <= 预警线`（VitalsBar.tsx / InventoryPage.tsx）
 *   于是一台收银机上同时出现「顶栏 28 缺货」和「首页 低库存 42」——
 *   **同一个画面两个数**，老板看到只会觉得系统坏了。
 *   owner 原话「布局太乱」，其中一条就是这个。
 *
 * 口径定案：**低于**预警线才算低库存（`<`）。刚好卡在预警线上说明还有的卖，不该报缺货。
 */
export const LOW_STOCK_THRESHOLD = 5

/** 某个商品是不是低库存。`minStock` 为空时按默认预警线算。 */
export function isLowStock(total: number, minStock: number | null | undefined): boolean {
  return total < (minStock ?? LOW_STOCK_THRESHOLD)
}

/** 低库存商品数（唯一算法）。调用方传 store 的 products 与 totalStockOf 即可。 */
export function countLowStock<P extends { id: number; min_stock: number | null }>(
  products: readonly P[],
  totalStockOf: (id: number) => number,
): number {
  let n = 0
  for (const p of products) if (isLowStock(totalStockOf(p.id), p.min_stock)) n++
  return n
}
