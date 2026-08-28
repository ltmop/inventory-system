// Ctrl+K 命令面板的匹配逻辑（纯函数，方便单测）。
// 面向不懂电脑的店主：只做简单的包含匹配，按字段精度排序，不搞模糊算法。

import type { Product } from '@/types'

export interface ProductMatch {
  product: Product
  /** 命中的字段，面板里用作小字提示 */
  matchedField: 'sku' | 'barcode' | 'brand' | 'model' | 'category'
}

// 字段优先级：SKU/条码最精确（扫码场景），其次品牌、型号、品类
const FIELD_GETTERS: Array<[ProductMatch['matchedField'], (p: Product) => string | null]> = [
  ['sku', (p) => p.sku_code],
  ['barcode', (p) => p.barcode],
  ['brand', (p) => p.brand],
  ['model', (p) => p.model],
  ['category', (p) => p.category],
]

/**
 * 在商品列表里按关键词匹配 SKU/条码/品牌/型号/品类（大小写不敏感的包含匹配）。
 * 排序规则：字段优先级高的在前；同字段内，前缀命中的排在中间包含命中的前面。
 */
export function searchProducts(products: Product[], query: string, limit = 8): ProductMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const scored: Array<{ match: ProductMatch; rank: number }> = []
  for (const p of products) {
    for (let fi = 0; fi < FIELD_GETTERS.length; fi++) {
      const [field, get] = FIELD_GETTERS[fi]
      const value = get(p)
      if (value && value.toLowerCase().includes(q)) {
        const prefixBonus = value.toLowerCase().startsWith(q) ? 0 : 1
        scored.push({ match: { product: p, matchedField: field }, rank: fi * 2 + prefixBonus })
        break // 一个商品只取最高优先级的命中字段
      }
    }
  }
  scored.sort((a, b) => a.rank - b.rank || a.match.product.id - b.match.product.id)
  return scored.slice(0, limit).map((s) => s.match)
}

export interface CommandItem {
  id: string
  label: string
  path: string
  /** 额外可匹配的关键词（含别名，方便记不清菜单名的用户） */
  keywords: string[]
}

// 与侧边栏菜单一一对应的静态命令（通用版：覆盖 5 大导航 + 全部功能页）
export const STATIC_COMMANDS: CommandItem[] = [
  { id: 'go-dashboard', label: '回首页', path: '/', keywords: ['首页', '仪表盘', '主界面'] },
  { id: 'go-inbound-hub', label: '入库中心', path: '/inbound-hub', keywords: ['入库', '进货', '收货', '采购'] },
  { id: 'go-inbound', label: '扫码入库', path: '/inbound', keywords: ['扫码入库', '入库', '扫码', '进货'] },
  { id: 'go-purchase', label: '采购订货', path: '/purchase', keywords: ['采购', '订货', '进货单'] },
  { id: 'go-suppliers', label: '供应商管理', path: '/suppliers', keywords: ['供应商', '供货商', '渠道'] },
  { id: 'go-sales-hub', label: '销售中心', path: '/sales-hub', keywords: ['销售', '出库', '卖货', '开单'] },
  { id: 'go-outbound', label: '销售开单', path: '/outbound', keywords: ['开单', '销售', '出库', '卖货'] },
  { id: 'go-customers', label: '客户管理', path: '/customers', keywords: ['客户', '顾客', '赊账', '欠款'] },
  { id: 'go-stock-hub', label: '库存中心', path: '/stock-hub', keywords: ['库存', '查询', '盘点'] },
  { id: 'go-inventory', label: '商品库存', path: '/inventory', keywords: ['库存', '商品', '查询'] },
  { id: 'go-stock-take', label: '库存盘点', path: '/stock-take', keywords: ['盘点', '盘库'] },
  { id: 'go-waste', label: '报损处理', path: '/waste', keywords: ['报损', '损耗', '破损'] },
  { id: 'go-kits', label: '组合商品', path: '/kits', keywords: ['组合', '套装', '捆绑'] },
  { id: 'go-categories', label: '分类管理', path: '/categories', keywords: ['分类', '品类'] },
  { id: 'go-units', label: '单位管理', path: '/units', keywords: ['单位', '计量', '斤', '个'] },
  { id: 'go-mine-hub', label: '我的中心', path: '/mine-hub', keywords: ['我的', '报表', '备份', '云同步'] },
  { id: 'go-reports', label: '经营报表', path: '/reports', keywords: ['报表', '统计', '利润', '营业额'] },
  { id: 'go-receipt', label: '收支对账', path: '/receipt-reconcile', keywords: ['对账', '收支', '收款'] },
  { id: 'go-expenses', label: '费用支出', path: '/expenses', keywords: ['支出', '费用', '花销'] },
  { id: 'go-audit', label: '操作日志', path: '/audit', keywords: ['日志', '审计', '记录'] },
  { id: 'go-account', label: '账号与云同步', path: '/account', keywords: ['账号', '账户', '登录', '云同步', '备份'] },
  { id: 'go-ai-hub', label: 'AI智能', path: '/ai-hub', keywords: ['AI', '智能', '助手', '语音', '模型'] },
  { id: 'go-import', label: '数据导入', path: '/import', keywords: ['导入', '搬家', 'Excel'] },
  { id: 'go-knowledge', label: '使用帮助', path: '/knowledge', keywords: ['帮助', '教程', '说明'] },
  { id: 'go-settings', label: '系统设置', path: '/settings', keywords: ['设置', '备份', '云同步', '主题'] },
]

/** 空关键词返回全部命令；否则按命令名/关键词包含匹配 */
export function searchCommands(query: string): CommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return STATIC_COMMANDS
  return STATIC_COMMANDS.filter(
    (c) =>
      c.label.toLowerCase().includes(q) || c.keywords.some((k) => k.toLowerCase().includes(q)),
  )
}
