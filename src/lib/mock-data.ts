import type {
  AuditLogEntry,
  Customer,
  Expense,
  InventoryBatch,
  Payment,
  PriceTier,
  Product,
  PurchaseOrderItemDetail,
  PurchaseOrderListItem,
  StockTake,
  StockTakeItem,
  Supplier,
  Transaction,
} from '@/types'

// 近 7 天流水用运行当天为基准动态生成，保证仪表盘"今日入/出库"和 7 日趋势始终有数据
function daysAgo(n: number, hour = 10, minute = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
function dateDaysAgo(n: number): string {
  return daysAgo(n).slice(0, 10)
}
// 相对今天 n 天后的日期串 YYYY-MM-DD（n 为负=已过期），给临期/过期 mock 商品用
function dateInDays(n: number): string {
  return dateDaysAgo(-n)
}

// ========== 供应商（4 家）==========
export const mockSuppliers: Supplier[] = [
  { id: 1, name: '味美食品批发', contact: '周经理', phone: '010-55667788', address: '北京市朝阳区食品批发市场', notes: '月结30天，零食走量大' },
  { id: 2, name: '洁宁日用品商行', contact: '李老板', phone: '021-66778899', address: '上海市嘉定区日用品园区', notes: '清洁/纸品二级代理' },
  { id: 3, name: '力邦五金供应', contact: '王工', phone: '0755-77889900', address: '深圳市宝安区五金城', notes: '工具五金一级代理' },
  { id: 4, name: '优创电子代理', contact: '陈总', phone: '020-88990011', address: '广州市天河区电子市场', notes: '线材/配件批发' },
]

// ========== 商品：8 个通用商品示例（覆盖 6 个通用分类 + 4 种状态） ==========
export const mockProducts: Product[] = [
  { id: 1, sku_code: "SP-001", barcode: null, category: "食品饮料", sub_category: "零食", brand: "怡客", model: "原味苏打饼干 400g", cost_price: 800, suggest_price: 1500, location: "A货架-1", photo_path: null, name_vi: null, color: null, material: null, expiry_date: dateInDays(240), min_stock: null, unit: "件", status: "在售", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 2, sku_code: "BH-001", barcode: null, category: "日用百货", sub_category: "清洁", brand: "洁宁", model: "抽纸 3层100抽", cost_price: 500, suggest_price: 990, location: "B货架-2", photo_path: null, name_vi: null, color: null, material: "原生木浆", expiry_date: null, min_stock: null, unit: "件", status: "在售", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 3, sku_code: "WJ-001", barcode: null, category: "五金工具", sub_category: "工具", brand: "力邦", model: "羊角锤 0.5kg", cost_price: 1800, suggest_price: 3200, location: "C柜-1", photo_path: null, name_vi: null, color: null, material: "碳钢", expiry_date: null, min_stock: null, unit: "件", status: "在售", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 4, sku_code: "DQ-001", barcode: null, category: "电子电器", sub_category: "线材", brand: "优创", model: "USB数据线 1米", cost_price: 200, suggest_price: 600, location: "D柜-2", photo_path: null, name_vi: null, color: "黑", material: "TPE", expiry_date: null, min_stock: null, unit: "米", status: "在售", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 5, sku_code: "FS-001", barcode: null, category: "服饰鞋帽", sub_category: "袜子", brand: "舒适", model: "纯棉运动袜 黑白", cost_price: 600, suggest_price: 1200, location: "E区-1", photo_path: null, name_vi: null, color: "白", material: "纯棉", expiry_date: null, min_stock: null, unit: "件", status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 6, sku_code: "BG-001", barcode: null, category: "文具办公", sub_category: "书写", brand: "得力", model: "中性笔 0.5mm 黑", cost_price: 150, suggest_price: 400, location: "F架-1", photo_path: null, name_vi: null, color: "黑", material: null, expiry_date: null, min_stock: null, unit: "件", status: "在售", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 7, sku_code: "SP-002", barcode: null, category: "食品饮料", sub_category: "零食", brand: "怡客", model: "每日坚果礼盒 30袋", cost_price: 2500, suggest_price: 4500, location: "A货架-2", photo_path: null, name_vi: null, color: null, material: null, expiry_date: dateInDays(180), min_stock: null, unit: "件", status: "停售", created_at: daysAgo(40), updated_at: daysAgo(1) },
  { id: 8, sku_code: "RH-001", barcode: null, category: "清洁日化", sub_category: "清洁", brand: "洁宁", model: "洗衣液 2kg", cost_price: 1200, suggest_price: 2200, location: "G区-1", photo_path: null, name_vi: null, color: null, material: null, expiry_date: null, min_stock: null, unit: "件", status: "清仓", created_at: daysAgo(60), updated_at: daysAgo(1) },
]

// ========== 批次（每商品一个） ==========
export const mockBatches: InventoryBatch[] = [
  { id: 1, product_id: 1, batch_no: "PO20260730-001", quantity: 10, cost_price: 800, location: "A货架-1", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 2, product_id: 2, batch_no: "PO20260730-002", quantity: 20, cost_price: 500, location: "B货架-2", inbound_date: dateDaysAgo(5), supplier_id: 2 },
  { id: 3, product_id: 3, batch_no: "PO20260730-003", quantity: 8, cost_price: 1800, location: "C柜-1", inbound_date: dateDaysAgo(5), supplier_id: 3 },
  { id: 4, product_id: 4, batch_no: "PO20260730-004", quantity: 30, cost_price: 200, location: "D柜-2", inbound_date: dateDaysAgo(5), supplier_id: 4 },
  { id: 5, product_id: 5, batch_no: "PO20260730-005", quantity: 12, cost_price: 600, location: "E区-1", inbound_date: dateDaysAgo(5), supplier_id: 2 },
  { id: 6, product_id: 6, batch_no: "PO20260730-006", quantity: 50, cost_price: 150, location: "F架-1", inbound_date: dateDaysAgo(5), supplier_id: 2 },
  { id: 7, product_id: 7, batch_no: "PO20260720-001", quantity: 5, cost_price: 2500, location: "A货架-2", inbound_date: dateDaysAgo(12), supplier_id: 1 },
  { id: 8, product_id: 8, batch_no: "PO20260630-001", quantity: 3, cost_price: 1200, location: "G区-1", inbound_date: dateDaysAgo(30), supplier_id: 2 },
]

// ========== 出入库流水：近 7 天 + 90 天前历史 ==========
// 口径：out/return 的 unit_price=批次成本，selling_price=售价/退款
let tid = 1
const tx = (
  product_id: number,
  batch_id: number | null,
  type: Transaction['type'],
  quantity: number,
  unit_price: number | null,
  selling_price: number | null,
  daysBack: number,
  hour: number,
  operator: string,
  notes: string | null = null,
  credit: { customerId: number; paidAmount: number | null } | null = null,
): Transaction => ({
  id: tid++,
  product_id,
  batch_id,
  type,
  quantity,
  unit_price,
  selling_price,
  timestamp: daysAgo(daysBack, hour),
  operator,
  notes,
  customer_id: credit?.customerId ?? null,
  paid_amount: credit ? credit.paidAmount : null,
})

export const mockTransactions: Transaction[] = [
  tx(1, 1, 'out', 3, 800, 1500, 6, 11, '阿杜', null, { customerId: 1, paidAmount: 3000 }),
  tx(2, 2, 'out', 5, 500, 990, 6, 15, '店员小张'),
  tx(4, 4, 'out', 10, 200, 600, 5, 10, '店员小张'),
  tx(1, 1, 'in', 10, 800, null, 5, 14, '阿杜', '饼干补货'),
  tx(3, 3, 'out', 2, 1800, 3200, 4, 16, '阿杜'),
  tx(1, 1, 'out', 2, 800, 1500, 3, 9, '店员小张'),
  tx(4, 4, 'in', 30, 200, null, 2, 10, '阿杜', '数据线到货'),
  tx(6, 6, 'out', 10, 150, 400, 1, 11, '店员小张'),
  tx(5, 5, 'out', 1, 600, 1200, 1, 16, '阿杜'),
  tx(2, 2, 'out', 3, 500, 990, 0, 9, '店员小张'),
  tx(2, 2, 'in', 20, 500, null, 0, 11, '阿杜', '抽纸补货'),
  tx(1, 1, 'out', 1, 800, 1500, 0, 10, '阿杜'),
  // 90 天前历史流水：用于滞销统计和退货/换货类型覆盖
  tx(1, 1, 'out', 2, 800, 1500, 92, 15, '阿杜'),
  tx(3, 3, 'out', 1, 1800, 3200, 91, 11, '店员小张'),
  tx(6, 6, 'out', 15, 150, 400, 90, 16, '阿杜'),
  tx(4, 4, 'return', 2, 200, 600, 90, 14, '阿杜', '退货回补'),
  tx(2, 2, 'return', 1, 500, null, 89, 10, '阿杜', '换货退旧'),
  tx(1, 1, 'out', 1, 800, 1500, 89, 10, '阿杜', '换货出新'),
]

// ========== 盘点 ==========
export const mockStockTakes: StockTake[] = [
  {
    id: 1,
    take_no: 'ST20260720-001',
    status: '已完成',
    location_filter: null,
    started_at: daysAgo(8, 10),
    completed_at: daysAgo(8, 17),
    operator: '阿杜',
  },
  {
    id: 2,
    take_no: 'ST20260728-001',
    status: '进行中',
    location_filter: 'A区',
    started_at: daysAgo(0, 10),
    completed_at: null,
    operator: '店员小张',
  },
]

export const mockStockTakeItems: StockTakeItem[] = [
  { id: 1, stock_take_id: 1, product_id: 1, batch_id: 1, system_qty: 10, actual_qty: 10, difference: 0, reason: '' },
  { id: 2, stock_take_id: 1, product_id: 3, batch_id: 3, system_qty: 8, actual_qty: 7, difference: -1, reason: '盘点差异' },
  { id: 3, stock_take_id: 1, product_id: 4, batch_id: 4, system_qty: 30, actual_qty: 28, difference: -2, reason: '漏记出库' },
  { id: 4, stock_take_id: 2, product_id: 1, batch_id: 1, system_qty: 10, actual_qty: null, difference: null, reason: '' },
  { id: 5, stock_take_id: 2, product_id: 2, batch_id: 2, system_qty: 20, actual_qty: null, difference: null, reason: '' },
  { id: 6, stock_take_id: 2, product_id: 3, batch_id: 3, system_qty: 7, actual_qty: null, difference: null, reason: '' },
]

// ========== 赊账包 ==========
export const mockCustomers: Customer[] = [
  { id: 1, name: '老王', phone: '13812345678', notes: '老客户，常赊账，月底结', price_level: 'regular', created_at: daysAgo(20) },
  { id: 2, name: '小刘', phone: '13987654321', notes: null, price_level: null, created_at: daysAgo(12) },
  { id: 3, name: '张老板', phone: null, notes: '批发客户，拿货量大', price_level: 'wholesale', created_at: daysAgo(9) },
]

export const mockPayments: Payment[] = [
  { id: 1, customer_id: 1, amount: 3000, method: '微信', notes: null, created_at: daysAgo(2, 15) },
]

// ========== 采购订单 ==========
export const mockPurchaseOrders: PurchaseOrderListItem[] = [
  {
    id: 1,
    po_no: 'PO20260730-001',
    supplier_id: 2,
    status: 'sent',
    expected_arrival: null,
    total_cost: 50 * 500 + 100 * 150,
    created_at: daysAgo(1, 9),
    updated_at: daysAgo(1, 9),
    operator: '阿杜',
    notes: '纸品和文具补货',
    supplier_name: '洁宁日用品商行',
    item_count: 2,
    total_qty: 150,
    received_qty: 0,
  },
  {
    id: 2,
    po_no: 'PO20260726-001',
    supplier_id: 1,
    status: 'partial',
    expected_arrival: null,
    total_cost: 20 * 800 + 5 * 2500,
    created_at: daysAgo(4, 10),
    updated_at: daysAgo(2, 15),
    operator: '阿杜',
    notes: null,
    supplier_name: '味美食品批发',
    item_count: 2,
    total_qty: 25,
    received_qty: 10,
  },
]

export const mockPurchaseOrderItems: PurchaseOrderItemDetail[] = [
  { id: 1, po_id: 1, product_id: 2, product_desc: null, category: '日用百货', quantity: 50, received_qty: 0, unit_cost: 500, created_at: daysAgo(1, 9), sku_code: 'BH-001', brand: '洁宁', model: '抽纸 3层100抽', product_name: '洁宁 抽纸 3层100抽' },
  { id: 2, po_id: 1, product_id: 6, product_desc: null, category: '文具办公', quantity: 100, received_qty: 0, unit_cost: 150, created_at: daysAgo(1, 9), sku_code: 'BG-001', brand: '得力', model: '中性笔 0.5mm 黑', product_name: '得力 中性笔 0.5mm 黑' },
  { id: 3, po_id: 2, product_id: 1, product_desc: null, category: '食品饮料', quantity: 20, received_qty: 10, unit_cost: 800, created_at: daysAgo(4, 10), sku_code: 'SP-001', brand: '怡客', model: '原味苏打饼干 400g', product_name: '怡客 原味苏打饼干 400g' },
  { id: 4, po_id: 2, product_id: 7, product_desc: null, category: '食品饮料', quantity: 5, received_qty: 0, unit_cost: 2500, created_at: daysAgo(4, 10), sku_code: 'SP-002', brand: '怡客', model: '每日坚果礼盒 30袋', product_name: '怡客 每日坚果礼盒 30袋' },
]

// ========== 多级定价 ==========
export const mockPriceTiers: PriceTier[] = [
  { id: 1, product_id: 1, tier: 'retail', price: 1500 },
  { id: 2, product_id: 1, tier: 'regular', price: 1300 },
  { id: 3, product_id: 1, tier: 'wholesale', price: 1000 },
  { id: 4, product_id: 2, tier: 'retail', price: 990 },
  { id: 5, product_id: 2, tier: 'promo', price: 800 },
]

// ========== 操作日志 ==========
export const mockAuditLogs: AuditLogEntry[] = [
  { id: 8, action: '出库', entity: '怡客 原味苏打饼干 400g x1', detail: JSON.stringify({ quantity: 1, sellingPrice: 1500 }), operator: '阿杜', created_at: daysAgo(0, 15) },
  { id: 7, action: '还账', entity: '老王 还 30.00 元', detail: JSON.stringify({ amount: 3000, method: '微信' }), operator: '阿杜', created_at: daysAgo(2, 15) },
  { id: 6, action: '入库', entity: '洁宁 抽纸 3层100抽 x20', detail: JSON.stringify({ quantity: 20, costPrice: 500 }), operator: '阿杜', created_at: daysAgo(0, 11) },
  { id: 5, action: '改价', entity: '怡客 原味苏打饼干 400g', detail: JSON.stringify({ tier: 'wholesale', price: 1000 }), operator: '阿杜', created_at: daysAgo(2, 16) },
  { id: 4, action: '退货', entity: '优创 USB数据线 1米 x2', detail: JSON.stringify({ quantity: 2, refundPrice: 600 }), operator: '阿杜', created_at: daysAgo(90, 14) },
  { id: 3, action: '入库', entity: '怡客 原味苏打饼干 400g x1', detail: JSON.stringify({ quantity: 1, costPrice: 800 }), operator: '阿杜', created_at: daysAgo(95, 10) },
  { id: 2, action: '盘点', entity: 'ST20260720-001', detail: JSON.stringify({ counted: 3 }), operator: '阿杜', created_at: daysAgo(8, 17) },
  { id: 1, action: '新建客户', entity: '老王', detail: JSON.stringify({ phone: '13812345678', price_level: 'regular' }), operator: null, created_at: daysAgo(20, 10) },
]


// ========== 支出记账（演示：本月房租 + 进货付款 + 运费 + 水电） ==========
export const mockExpenses: Expense[] = [
  { id: 5, category: '运费', amount: 3500, method: '微信', supplier_id: null, supplier_name: null, note: '补货快递费', expense_date: dateDaysAgo(0), operator: '阿杜', created_at: daysAgo(0, 16) },
  { id: 4, category: '进货付款', amount: 500000, method: '支付宝', supplier_id: 1, supplier_name: '味美食品批发', note: '7 月货款尾款', expense_date: dateDaysAgo(1), operator: '阿杜', created_at: daysAgo(1, 11) },
  { id: 3, category: '水电', amount: 18600, method: '微信', supplier_id: null, supplier_name: null, note: null, expense_date: dateDaysAgo(3), operator: null, created_at: daysAgo(3, 9) },
  { id: 2, category: '房租', amount: 280000, method: '其他', supplier_id: null, supplier_name: null, note: '店面月租（转账给房东）', expense_date: dateDaysAgo(5), operator: '阿杜', created_at: daysAgo(5, 10) },
  { id: 1, category: '杂项', amount: 4500, method: '现金', supplier_id: null, supplier_name: null, note: '门店招牌灯管更换', expense_date: dateDaysAgo(8), operator: null, created_at: daysAgo(8, 14) },
]
