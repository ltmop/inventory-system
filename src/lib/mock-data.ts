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
  { id: 1, name: '威海光威渔具集团', contact: '王经理', phone: '0631-5628888', address: '山东省威海市环翠区渔具产业园', notes: '月结30天，主打台钓竿' },
  { id: 2, name: '广州钓之屋商贸', contact: '陈小姐', phone: '020-83456789', address: '广州市荔湾区芳村渔具批发市场A12', notes: '路亚饵/鱼钩走量大' },
  { id: 3, name: '宁波海伯渔具', contact: '李工', phone: '0574-87654321', address: '宁波市北仑区小港街道工业园区', notes: '渔轮一级代理' },
  { id: 4, name: '肃宁浮漂世家', contact: '赵老板', phone: '0317-5012345', address: '河北省沧州市肃宁县浮漂产业园', notes: '手工浮漂，起订量50支' },
]

// ========== 商品：53 条真实鱼竿库存 + 3 条其他品类演示 ==========
// 数据来源：渔具店库存清单_2026-07-30.csv（53 条真实盘点数据）
// 进价按品牌分档，售价按进价 1.8 倍估算（品牌竿另算）
// 状态：CSV 中"待处理"→ 系统"待盘点"
export const mockProducts: Product[] = [
  // --- 保留区：御鳞竿（9 条，id 1-9）---
  { id: 1, sku_code: "YL-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "3H", cost_price: 4500, suggest_price: 8800, location: "A墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: "3H", expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 2, sku_code: "YL-002", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "4H", cost_price: 4500, suggest_price: 8800, location: "A墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: "4H", expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 3, sku_code: "YL-003", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "5H", cost_price: 4500, suggest_price: 8800, location: "A墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: "5H", expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 4, sku_code: "YL-004", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "6H", cost_price: 4500, suggest_price: 8800, location: "A墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: "6H", expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 5, sku_code: "YL-005", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "7H", cost_price: 4500, suggest_price: 8800, location: "A墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: "7H", expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 6, sku_code: "YL-006", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "8H", cost_price: 4500, suggest_price: 8800, location: "A墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: "8H", expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 7, sku_code: "YL-007", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "9H+", cost_price: 4500, suggest_price: 8800, location: "A墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: "9H+", expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 8, sku_code: "YL-008", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "标准款", cost_price: 4500, suggest_price: 8800, location: "B墙-下", photo_path: null, name_vi: null, rod_length: "多长度", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 9, sku_code: "YL-009", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "御鳞竿", model: "标准款", cost_price: 4500, suggest_price: 8800, location: "C墙", photo_path: null, name_vi: null, rod_length: "多长度", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 品牌溢价区（3 条，id 10-12）---
  { id: 10, sku_code: "DW-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "达亿瓦", model: "DAIWA", cost_price: 28000, suggest_price: 49800, location: "D墙-左", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 11, sku_code: "GY-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "孤悦", model: "垂钓专家", cost_price: 15000, suggest_price: 28800, location: "D墙-中", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 12, sku_code: "CJ-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "仓吉", model: "标准款", cost_price: 12000, suggest_price: 22800, location: "D墙-右", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 处理区：慈海系列（10 条，id 13-22）---
  { id: 13, sku_code: "CH-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海", model: "干将S级", cost_price: 3000, suggest_price: 5400, location: "E墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 14, sku_code: "CH-002", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海", model: "干将S级", cost_price: 3000, suggest_price: 5400, location: "E墙-上", photo_path: null, name_vi: null, rod_length: "3.9m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 15, sku_code: "CH-003", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海", model: "干将S级", cost_price: 3000, suggest_price: 5400, location: "E墙-上", photo_path: null, name_vi: null, rod_length: "4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 16, sku_code: "CH-004", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海", model: "干将S级 CARBON", cost_price: 3000, suggest_price: 5400, location: "E墙-上", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 17, sku_code: "CH-005", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海", model: "干将S级 CARBON", cost_price: 3000, suggest_price: 5400, location: "E墙-上", photo_path: null, name_vi: null, rod_length: "5.4m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 18, sku_code: "CH-006", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海", model: "红影", cost_price: 3000, suggest_price: 5400, location: "F墙", photo_path: null, name_vi: null, rod_length: "3.6m/4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 19, sku_code: "CH-007", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海", model: "精英", cost_price: 3000, suggest_price: 5400, location: "F墙", photo_path: null, name_vi: null, rod_length: "3.6m/4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 20, sku_code: "CH-008", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海/慈瀚", model: "迷彩款", cost_price: 2800, suggest_price: 5040, location: "G墙", photo_path: null, name_vi: null, rod_length: "多长度", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 21, sku_code: "CH-009", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海/慈瀚", model: "蓝白款", cost_price: 2800, suggest_price: 5040, location: "G墙", photo_path: null, name_vi: null, rod_length: "3.6m/4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 22, sku_code: "CH-010", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈海/慈瀚", model: "杂色款", cost_price: 2800, suggest_price: 5040, location: "G墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 处理区：决战系列（3 条，id 23-25）---
  { id: 23, sku_code: "JZ-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "决战", model: "决战28K", cost_price: 2500, suggest_price: 4500, location: "H墙-左", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 24, sku_code: "JZ-002", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "决战", model: "决战28K", cost_price: 2500, suggest_price: 4500, location: "H墙-左", photo_path: null, name_vi: null, rod_length: "5.4m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 25, sku_code: "JZ-003", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "决战", model: "决战K", cost_price: 2500, suggest_price: 4500, location: "H墙-左", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 处理区：羽战系列（6 条，id 26-31）---
  { id: 26, sku_code: "YZ-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "羽战", model: "羽战尊", cost_price: 2200, suggest_price: 3960, location: "I墙", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 27, sku_code: "YZ-002", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "羽战", model: "羽战悍-金色", cost_price: 2200, suggest_price: 3960, location: "I墙", photo_path: null, name_vi: null, rod_length: "3.6m/4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 28, sku_code: "YZ-003", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "羽战", model: "羽战悍-银色", cost_price: 2200, suggest_price: 3960, location: "I墙", photo_path: null, name_vi: null, rod_length: "4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 29, sku_code: "YZ-004", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "羽战", model: "羽战悍-红色", cost_price: 2200, suggest_price: 3960, location: "I墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 30, sku_code: "YZ-005", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "羽战", model: "羽战悍-蓝色", cost_price: 2200, suggest_price: 3960, location: "I墙", photo_path: null, name_vi: null, rod_length: "4.5m/6.0m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 31, sku_code: "YZ-006", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "羽战", model: "羽战悍-黑色", cost_price: 2200, suggest_price: 3960, location: "I墙", photo_path: null, name_vi: null, rod_length: "4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 处理区：皇水系列（8 条，id 32-39）---
  { id: 32, sku_code: "HS-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "钓无忧", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "多长度", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 33, sku_code: "HS-002", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "英雄", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 34, sku_code: "HS-003", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "皇采钓黑", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 35, sku_code: "HS-004", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "力持5.5H", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 36, sku_code: "HS-005", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "力持6.5H", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 37, sku_code: "HS-006", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "隆武", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 38, sku_code: "HS-007", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "斩锋芒", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 39, sku_code: "HS-008", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "皇水", model: "竹凡竞技", cost_price: 2000, suggest_price: 3600, location: "J墙", photo_path: null, name_vi: null, rod_length: "3.6m/5.4m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 处理区：天道/仙风/慈游红（4 条，id 40-43）---
  { id: 40, sku_code: "TD-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "天道", model: "标准款", cost_price: 1800, suggest_price: 3240, location: "K墙", photo_path: null, name_vi: null, rod_length: "多长度", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 41, sku_code: "XF-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "仙风", model: "标准款", cost_price: 1500, suggest_price: 2700, location: "L墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 42, sku_code: "XF-002", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "仙风", model: "轻量强韧", cost_price: 1500, suggest_price: 2700, location: "L墙", photo_path: null, name_vi: null, rod_length: "十五", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 43, sku_code: "CY-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "慈游红", model: "标准款", cost_price: 1400, suggest_price: 2520, location: "L墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 处理区：其他杂牌（10 条，id 44-53）---
  { id: 44, sku_code: "QT-001", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "未知", model: "12H超硬竞技竿", cost_price: 800, suggest_price: 1440, location: "M墙", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 45, sku_code: "QT-002", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "K-POWER", model: "黑虎3H", cost_price: 3500, suggest_price: 6300, location: "M墙", photo_path: null, name_vi: null, rod_length: "3.9m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 46, sku_code: "QT-003", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "非中皇", model: "标准款", cost_price: 1500, suggest_price: 2700, location: "M墙", photo_path: null, name_vi: null, rod_length: "3.6m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 47, sku_code: "QT-004", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "未知", model: "鲤系列", cost_price: 800, suggest_price: 1440, location: "M墙", photo_path: null, name_vi: null, rod_length: "3.6m/4.5m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 48, sku_code: "QT-005", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "天韵", model: "标准款", cost_price: 1200, suggest_price: 2160, location: "M墙", photo_path: null, name_vi: null, rod_length: "5.1m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 49, sku_code: "QT-006", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "普者黑", model: "标准款", cost_price: 1000, suggest_price: 1800, location: "M墙", photo_path: null, name_vi: null, rod_length: "5.1m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 50, sku_code: "QT-007", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "普者黑", model: "标准款", cost_price: 1000, suggest_price: 1800, location: "M墙", photo_path: null, name_vi: null, rod_length: "6.1m", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 51, sku_code: "QT-008", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "未知", model: "高碳竿", cost_price: 800, suggest_price: 1440, location: "M墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 52, sku_code: "QT-009", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "未知", model: "绿色包装竿", cost_price: 800, suggest_price: 1440, location: "M墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 53, sku_code: "QT-010", barcode: null, category: "鱼竿", sub_category: "手竿", brand: "未知", model: "杂牌竿", cost_price: 800, suggest_price: 1440, location: "M墙", photo_path: null, name_vi: null, rod_length: "未知", line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "待盘点", created_at: daysAgo(30), updated_at: daysAgo(2) },
  // --- 其他品类演示（3 条，id 54-56）---
  { id: 54, sku_code: "JC-YL-FC-XMN-2500", barcode: null, category: "渔轮", sub_category: "纺车轮", brand: "禧玛诺", model: "纳西 2500HG", cost_price: 32000, suggest_price: 49800, location: "B区-3号柜", photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "在售", created_at: daysAgo(20), updated_at: daysAgo(1) },
  { id: 55, sku_code: "JC-YG-YS-TFF-05", barcode: null, category: "鱼钩", sub_category: "伊势尼", brand: "土肥富", model: "伊势尼 5号 10枚装", cost_price: 300, suggest_price: 800, location: "C区-钩架-第2层", photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: "5号", color: null, material: "高碳钢", rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: "已盘点", created_at: daysAgo(20), updated_at: daysAgo(1) },
  { id: 56, sku_code: "JC-ER-SP-LG-918", barcode: null, category: "饵料", sub_category: "商品饵", brand: "老鬼", model: "九一八 腥香 300g", cost_price: 900, suggest_price: 1800, location: "C区-饵料架-第1层", photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: dateInDays(12), min_stock: null, status: "已盘点", created_at: daysAgo(20), updated_at: daysAgo(1) },
]

// ========== 批次：每商品一个入库批次，数量 = CSV 总库存 ==========
export const mockBatches: InventoryBatch[] = [
  { id: 1, product_id: 1, batch_no: "PO20260730-001", quantity: 2, cost_price: 4500, location: "A墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 2, product_id: 2, batch_no: "PO20260730-002", quantity: 2, cost_price: 4500, location: "A墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 3, product_id: 3, batch_no: "PO20260730-003", quantity: 2, cost_price: 4500, location: "A墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 4, product_id: 4, batch_no: "PO20260730-004", quantity: 2, cost_price: 4500, location: "A墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 5, product_id: 5, batch_no: "PO20260730-005", quantity: 2, cost_price: 4500, location: "A墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 6, product_id: 6, batch_no: "PO20260730-006", quantity: 2, cost_price: 4500, location: "A墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 7, product_id: 7, batch_no: "PO20260730-007", quantity: 2, cost_price: 4500, location: "A墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 8, product_id: 8, batch_no: "PO20260730-008", quantity: 10, cost_price: 4500, location: "B墙-下", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 9, product_id: 9, batch_no: "PO20260730-009", quantity: 8, cost_price: 4500, location: "C墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 10, product_id: 10, batch_no: "PO20260730-010", quantity: 1, cost_price: 28000, location: "D墙-左", inbound_date: dateDaysAgo(5), supplier_id: 3 },
  { id: 11, product_id: 11, batch_no: "PO20260730-011", quantity: 1, cost_price: 15000, location: "D墙-中", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 12, product_id: 12, batch_no: "PO20260730-012", quantity: 1, cost_price: 12000, location: "D墙-右", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 13, product_id: 13, batch_no: "PO20260730-013", quantity: 2, cost_price: 3000, location: "E墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 14, product_id: 14, batch_no: "PO20260730-014", quantity: 2, cost_price: 3000, location: "E墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 15, product_id: 15, batch_no: "PO20260730-015", quantity: 2, cost_price: 3000, location: "E墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 16, product_id: 16, batch_no: "PO20260730-016", quantity: 1, cost_price: 3000, location: "E墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 17, product_id: 17, batch_no: "PO20260730-017", quantity: 1, cost_price: 3000, location: "E墙-上", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 18, product_id: 18, batch_no: "PO20260730-018", quantity: 2, cost_price: 3000, location: "F墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 19, product_id: 19, batch_no: "PO20260730-019", quantity: 3, cost_price: 3000, location: "F墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 20, product_id: 20, batch_no: "PO20260730-020", quantity: 6, cost_price: 2800, location: "G墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 21, product_id: 21, batch_no: "PO20260730-021", quantity: 4, cost_price: 2800, location: "G墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 22, product_id: 22, batch_no: "PO20260730-022", quantity: 4, cost_price: 2800, location: "G墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 23, product_id: 23, batch_no: "PO20260730-023", quantity: 3, cost_price: 2500, location: "H墙-左", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 24, product_id: 24, batch_no: "PO20260730-024", quantity: 3, cost_price: 2500, location: "H墙-左", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 25, product_id: 25, batch_no: "PO20260730-025", quantity: 2, cost_price: 2500, location: "H墙-左", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 26, product_id: 26, batch_no: "PO20260730-026", quantity: 1, cost_price: 2200, location: "I墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 27, product_id: 27, batch_no: "PO20260730-027", quantity: 3, cost_price: 2200, location: "I墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 28, product_id: 28, batch_no: "PO20260730-028", quantity: 1, cost_price: 2200, location: "I墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 29, product_id: 29, batch_no: "PO20260730-029", quantity: 1, cost_price: 2200, location: "I墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 30, product_id: 30, batch_no: "PO20260730-030", quantity: 3, cost_price: 2200, location: "I墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 31, product_id: 31, batch_no: "PO20260730-031", quantity: 2, cost_price: 2200, location: "I墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 32, product_id: 32, batch_no: "PO20260730-032", quantity: 4, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 33, product_id: 33, batch_no: "PO20260730-033", quantity: 1, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 34, product_id: 34, batch_no: "PO20260730-034", quantity: 1, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 35, product_id: 35, batch_no: "PO20260730-035", quantity: 2, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 36, product_id: 36, batch_no: "PO20260730-036", quantity: 1, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 37, product_id: 37, batch_no: "PO20260730-037", quantity: 5, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 38, product_id: 38, batch_no: "PO20260730-038", quantity: 1, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 39, product_id: 39, batch_no: "PO20260730-039", quantity: 2, cost_price: 2000, location: "J墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 40, product_id: 40, batch_no: "PO20260730-040", quantity: 10, cost_price: 1800, location: "K墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 41, product_id: 41, batch_no: "PO20260730-041", quantity: 1, cost_price: 1500, location: "L墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 42, product_id: 42, batch_no: "PO20260730-042", quantity: 2, cost_price: 1500, location: "L墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 43, product_id: 43, batch_no: "PO20260730-043", quantity: 1, cost_price: 1400, location: "L墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 44, product_id: 44, batch_no: "PO20260730-044", quantity: 1, cost_price: 800, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 45, product_id: 45, batch_no: "PO20260730-045", quantity: 1, cost_price: 3500, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 46, product_id: 46, batch_no: "PO20260730-046", quantity: 2, cost_price: 1500, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 47, product_id: 47, batch_no: "PO20260730-047", quantity: 2, cost_price: 800, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 48, product_id: 48, batch_no: "PO20260730-048", quantity: 2, cost_price: 1200, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 49, product_id: 49, batch_no: "PO20260730-049", quantity: 1, cost_price: 1000, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 50, product_id: 50, batch_no: "PO20260730-050", quantity: 4, cost_price: 1000, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 51, product_id: 51, batch_no: "PO20260730-051", quantity: 2, cost_price: 800, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 52, product_id: 52, batch_no: "PO20260730-052", quantity: 2, cost_price: 800, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 53, product_id: 53, batch_no: "PO20260730-053", quantity: 6, cost_price: 800, location: "M墙", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 54, product_id: 54, batch_no: "PO20260730-054", quantity: 2, cost_price: 32000, location: "B区-3号柜", inbound_date: dateDaysAgo(5), supplier_id: 1 },
  { id: 55, product_id: 55, batch_no: "PO20260730-055", quantity: 30, cost_price: 300, location: "C区-钩架-第2层", inbound_date: dateDaysAgo(5), supplier_id: 2 },
  { id: 56, product_id: 56, batch_no: "PO20260730-056", quantity: 20, cost_price: 900, location: "C区-饵料架-第1层", inbound_date: dateDaysAgo(5), supplier_id: 2 },
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
  // 卖了几根竿（真实品类，id 1-56 现在全是真实库存）
  tx(1, 1, 'out', 1, 4500, 8800, 6, 11, '阿杜', null, { customerId: 1, paidAmount: 5000 }),
  tx(55, 55, 'out', 5, 300, 800, 6, 15, '店员小李'),
  tx(55, 55, 'out', 10, 300, 800, 5, 10, '店员小李'),
  tx(8, 8, 'in', 10, 4500, null, 5, 14, '阿杜', '御鳞竿标准款补货'),
  tx(54, 54, 'out', 1, 32000, 49800, 4, 16, '阿杜'),
  tx(1, 1, 'out', 1, 4500, 8800, 3, 9, '店员小李'),
  tx(10, 10, 'out', 1, 28000, 49800, 3, 14, '阿杜'),
  tx(56, 56, 'in', 20, 900, null, 2, 10, '阿杜', '老鬼饵料到货'),
  tx(55, 55, 'out', 6, 300, 800, 1, 11, '店员小李'),
  tx(8, 8, 'out', 1, 4500, 8800, 1, 16, '阿杜'),
  tx(55, 55, 'out', 3, 300, 800, 0, 9, '店员小李'),
  tx(1, 1, 'out', 1, 4500, 8800, 0, 10, '阿杜'),
  tx(56, 56, 'in', 15, 900, null, 0, 11, '阿杜', '饵料到货'),
  // 90 天前历史流水：用于滞销统计和退货/换货类型覆盖
  tx(3, 3, 'in', 2, 4500, null, 95, 10, '阿杜', '早期进货'),
  tx(1, 1, 'out', 1, 4500, 8800, 92, 15, '阿杜'),
  tx(55, 55, 'out', 10, 300, 800, 91, 11, '店员小李'),
  tx(55, 55, 'out', 20, 300, 800, 90, 16, '阿杜'),
  tx(54, 54, 'return', 1, 32000, 49800, 90, 14, '阿杜', '退货回补'),
  tx(55, 55, 'return', 2, 300, null, 89, 10, '阿杜', '换货退旧'),
  tx(1, 1, 'out', 1, 4500, 8800, 89, 10, '阿杜', '换货出新'),
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
    operator: '店员小李',
  },
]

export const mockStockTakeItems: StockTakeItem[] = [
  { id: 1, stock_take_id: 1, product_id: 1, batch_id: 1, system_qty: 2, actual_qty: 2, difference: 0, reason: '' },
  { id: 2, stock_take_id: 1, product_id: 54, batch_id: 54, system_qty: 2, actual_qty: 1, difference: -1, reason: '样机损耗' },
  { id: 3, stock_take_id: 1, product_id: 55, batch_id: 55, system_qty: 30, actual_qty: 28, difference: -2, reason: '漏记入库' },
  { id: 4, stock_take_id: 2, product_id: 1, batch_id: 1, system_qty: 2, actual_qty: null, difference: null, reason: '' },
  { id: 5, stock_take_id: 2, product_id: 2, batch_id: 2, system_qty: 2, actual_qty: null, difference: null, reason: '' },
  { id: 6, stock_take_id: 2, product_id: 3, batch_id: 3, system_qty: 2, actual_qty: null, difference: null, reason: '' },
  { id: 7, stock_take_id: 2, product_id: 4, batch_id: 4, system_qty: 2, actual_qty: null, difference: null, reason: '' },
]

// ========== 赊账包 ==========
export const mockCustomers: Customer[] = [
  { id: 1, name: '老王', phone: '13812345678', notes: '老钓友，常赊账，月底结', price_level: 'regular', created_at: daysAgo(20) },
  { id: 2, name: '小刘', phone: '13987654321', notes: null, price_level: null, created_at: daysAgo(12) },
  { id: 3, name: '码头张老板', phone: null, notes: '包船出海的，拿货量大', price_level: 'wholesale', created_at: daysAgo(9) },
]

export const mockPayments: Payment[] = [
  { id: 1, customer_id: 1, amount: 3800, method: '微信', notes: null, created_at: daysAgo(2, 15) },
]

// ========== 采购订单 ==========
export const mockPurchaseOrders: PurchaseOrderListItem[] = [
  {
    id: 1,
    po_no: 'PO20260730-001',
    supplier_id: 2,
    status: 'sent',
    expected_arrival: null,
    total_cost: 50 * 900 + 100 * 300,
    created_at: daysAgo(1, 9),
    updated_at: daysAgo(1, 9),
    operator: '阿杜',
    notes: '饵料和鱼钩补货',
    supplier_name: '广州钓之屋商贸',
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
    total_cost: 20 * 4500 + 5 * 15000,
    created_at: daysAgo(4, 10),
    updated_at: daysAgo(2, 15),
    operator: '阿杜',
    notes: null,
    supplier_name: '威海光威渔具集团',
    item_count: 2,
    total_qty: 25,
    received_qty: 10,
  },
]

export const mockPurchaseOrderItems: PurchaseOrderItemDetail[] = [
  { id: 1, po_id: 1, product_id: 56, product_desc: null, category: '饵料', quantity: 50, received_qty: 0, unit_cost: 900, created_at: daysAgo(1, 9), sku_code: 'JC-ER-SP-LG-918', brand: '老鬼', model: '九一八 腥香 300g', product_name: '老鬼 九一八 腥香 300g' },
  { id: 2, po_id: 1, product_id: 55, product_desc: null, category: '鱼钩', quantity: 100, received_qty: 0, unit_cost: 300, created_at: daysAgo(1, 9), sku_code: 'JC-YG-YS-TFF-05', brand: '土肥富', model: '伊势尼 5号 10枚装', product_name: '土肥富 伊势尼 5号 10枚装' },
  { id: 3, po_id: 2, product_id: 1, product_desc: null, category: '鱼竿', quantity: 20, received_qty: 10, unit_cost: 4500, created_at: daysAgo(4, 10), sku_code: 'YL-001', brand: '御鳞竿', model: '3H', product_name: '御鳞竿 3H' },
  { id: 4, po_id: 2, product_id: 11, product_desc: null, category: '鱼竿', quantity: 5, received_qty: 0, unit_cost: 15000, created_at: daysAgo(4, 10), sku_code: 'GY-001', brand: '孤悦', model: '垂钓专家', product_name: '孤悦 垂钓专家' },
]

// ========== 多级定价 ==========
export const mockPriceTiers: PriceTier[] = [
  { id: 1, product_id: 1, tier: 'retail', price: 8800 },
  { id: 2, product_id: 1, tier: 'regular', price: 8000 },
  { id: 3, product_id: 1, tier: 'wholesale', price: 6800 },
  { id: 4, product_id: 55, tier: 'retail', price: 800 },
  { id: 5, product_id: 55, tier: 'promo', price: 600 },
]

// ========== 操作日志 ==========
export const mockAuditLogs: AuditLogEntry[] = [
  { id: 8, action: '出库', entity: '御鳞竿 3H x1', detail: JSON.stringify({ quantity: 1, sellingPrice: 8800 }), operator: '阿杜', created_at: daysAgo(0, 15) },
  { id: 7, action: '还账', entity: '老王 还 38.00 元', detail: JSON.stringify({ amount: 3800, method: '微信' }), operator: '阿杜', created_at: daysAgo(2, 15) },
  { id: 6, action: '入库', entity: '老鬼 九一八 腥香 300g x15', detail: JSON.stringify({ quantity: 15, costPrice: 900 }), operator: '阿杜', created_at: daysAgo(0, 11) },
  { id: 5, action: '改价', entity: '御鳞竿 3H', detail: JSON.stringify({ tier: 'wholesale', price: 6800 }), operator: '阿杜', created_at: daysAgo(2, 16) },
  { id: 4, action: '退货', entity: '禧玛诺 纳西 2500HG x1', detail: JSON.stringify({ quantity: 1, refundPrice: 49800 }), operator: '阿杜', created_at: daysAgo(90, 14) },
  { id: 3, action: '入库', entity: '御鳞竿 3H x1', detail: JSON.stringify({ quantity: 1, costPrice: 4500 }), operator: '阿杜', created_at: daysAgo(95, 10) },
  { id: 2, action: '盘点', entity: 'ST20260720-001', detail: JSON.stringify({ counted: 3 }), operator: '阿杜', created_at: daysAgo(8, 17) },
  { id: 1, action: '新建客户', entity: '老王', detail: JSON.stringify({ phone: '13812345678', price_level: 'regular' }), operator: null, created_at: daysAgo(20, 10) },
]


// ========== 支出记账（演示：本月房租 + 进货付款 + 运费 + 水电） ==========
export const mockExpenses: Expense[] = [
  { id: 5, category: '运费', amount: 3500, method: '微信', supplier_id: null, supplier_name: null, note: '补货快递费', expense_date: dateDaysAgo(0), operator: '阿杜', created_at: daysAgo(0, 16) },
  { id: 4, category: '进货付款', amount: 500000, method: '支付宝', supplier_id: 1, supplier_name: '威海光威渔具集团', note: '7 月货款尾款', expense_date: dateDaysAgo(1), operator: '阿杜', created_at: daysAgo(1, 11) },
  { id: 3, category: '水电', amount: 18600, method: '微信', supplier_id: null, supplier_name: null, note: null, expense_date: dateDaysAgo(3), operator: null, created_at: daysAgo(3, 9) },
  { id: 2, category: '房租', amount: 280000, method: '其他', supplier_id: null, supplier_name: null, note: '店面月租（转账给房东）', expense_date: dateDaysAgo(5), operator: '阿杜', created_at: daysAgo(5, 10) },
  { id: 1, category: '杂项', amount: 4500, method: '现金', supplier_id: null, supplier_name: null, note: '门店招牌灯管更换', expense_date: dateDaysAgo(8), operator: null, created_at: daysAgo(8, 14) },
]
