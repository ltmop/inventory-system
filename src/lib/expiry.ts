// 临期/过期商品计算：与后端 electron/commands.js 的 parseExpiryDate / expiringProducts 同口径。
// 生产环境商品数据本就来自后端，前端本地再算一遍是为了：
// 1) 库存页徽章/筛选能随 store 实时刷新；2) 浏览器 mock 回退路径没有 IPC 可用。
import type { ExpiringProduct, Product } from '@/types'
import { productName } from '@/lib/formatters'

/** 解析保质期写法：'YYYY-MM' → 当月最后一天（保质"到几月"的常识口径）；
 * 'YYYY-MM-DD' → 当天；无法识别返回 null（不参与预警） */
export function parseExpiryDate(text: string | null | undefined): Date | null {
  const s = String(text ?? '').trim()
  let m = /^(\d{4})-(\d{2})$/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]), 0) // 当月最后一天
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return null
}

/** 临期/过期商品：有库存、expiry_date 在未来 days 天内（含已过期），按过期日升序（最紧的排最前） */
export function computeExpiring(
  products: Pick<Product, 'id' | 'sku_code' | 'brand' | 'model' | 'expiry_date'>[],
  totalStockOf: (productId: number) => number,
  days = 30,
): ExpiringProduct[] {
  const todayMid = new Date()
  todayMid.setHours(0, 0, 0, 0)
  const out: ExpiringProduct[] = []
  for (const p of products) {
    if (!p.expiry_date) continue
    const stock = totalStockOf(p.id)
    if (stock <= 0) continue
    const exp = parseExpiryDate(p.expiry_date)
    if (!exp) continue
    const daysLeft = Math.round((exp.getTime() - todayMid.getTime()) / 86400000)
    if (daysLeft > days) continue
    out.push({
      id: p.id,
      name: productName(p),
      sku: p.sku_code,
      expiry_date: p.expiry_date,
      daysLeft,
      expired: daysLeft < 0,
      stock,
    })
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft)
}
