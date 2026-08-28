// 与后端数据库 Schema 一一对应的类型契约，字段名不可改

// 通用版：分类由 categories 表驱动（用户可增删改/行业模板套用），前端动态读取
export type Category = string

export const CATEGORIES: Category[] = [] // 运行时由 loadAll 的 categories 填充

// 品类代码速查（用于SKU自动生成；未匹配的统一用 QT）
export const CATEGORY_CODES: Record<string, string> = {
  '饮料': 'YL', '零食': 'LS', '粮油': 'LY', '日化': 'RH', '生鲜': 'SX',
  '乳品': 'RP', '酒水': 'JS', '调味品': 'TW', '冷冻': 'LD', '方便食品': 'FB',
  '文具': 'WJ', '笔': 'B', '本册': 'BC', '纸品': 'ZP', '办公用品': 'BG',
  '美术用品': 'MS', '螺丝': 'LS', '工具': 'GJ', '电线电缆': 'DX', '管材': 'GC',
  '油漆涂料': 'YQ', '五金件': 'WJ', '灯具': 'DJ', '开关插座': 'KG', '锁具': 'SJ',
  '卫浴': 'WY', '劳保': 'LB', '清洁用品': 'QJ', '厨具': 'CJ', '塑料制品': 'SL',
  '纺织': 'FZ', '洗护': 'XH', '收纳': 'SN', '小家电': 'XD', '餐具': 'CJ',
  '食品': 'SP', '其他': 'QT',
}

export type ProductStatus = '待盘点' | '已盘点' | '在售' | '已售罄' | '停产'

export const PRODUCT_STATUSES: ProductStatus[] = [
  '待盘点',
  '已盘点',
  '在售',
  '已售罄',
  '停产',
]

// 计量单位（通用版）：由 units 表驱动（件/斤/米/公斤等），allow_decimal=1 支持小数数量
export type Unit = string
export const UNITS: Unit[] = ['件', '斤', '公斤', '米']

export interface Product {
  id: number
  sku_code: string
  barcode: string | null
  category: Category
  sub_category: string | null  // 子类，如"手竿""PE线""伊势尼""抄网"
  brand: string | null
  model: string | null
  cost_price: number // 单位：分
  suggest_price: number | null // 单位：分
  location: string | null
  photo_path: string | null
  name_vi: string | null
  rod_length: string | null
  line_number: string | null
  hook_size: string | null
  color: string | null
  material: string | null
  rod_action: string | null
  power_rating: string | null
  expiry_date: string | null
  /** 最低库存预警线：NULL=用默认阈值 5；设了按各自阈值预警（COALESCE(min_stock, 5)） */
  min_stock: number | null
  /** 计量单位（通用版）：件/斤/米/公斤等，由 units 表驱动 */
  unit?: Unit | null
  /** 单位是否允许小数（units.allow_decimal 映射）：1=斤/米等可开 0.5、1.5 */
  unit_decimal?: number | null
  /** 手动标记（v2.9）：1=热销（老板标的"卖得好/推荐"）；0=未标 */
  is_hot?: number
  /** 手动标记（v2.9）：1=处理货（清仓甩卖）；0=未标 */
  is_clearance?: number
  status: ProductStatus
  created_at: string
  updated_at: string
}

export interface InventoryBatch {
  id: number
  product_id: number
  batch_no: string
  quantity: number
  cost_price: number // 单位：分
  location: string | null
  inbound_date: string // YYYY-MM-DD
  supplier_id: number | null
  /** 批次到期日（保质期商品）：饵料/小药/活饵入库时记录，FEFO 先到期先出 + 临期按批次预警 */
  expiry_date?: string | null
  notes?: string | null
  created_at?: string
}

export type TransactionType = 'in' | 'out' | 'return' | 'exchange' | 'waste'

export interface Transaction {
  id: number
  product_id: number
  batch_id: number | null
  type: TransactionType
  quantity: number
  unit_price: number | null // 单位：分；入库=进价，出库=批次成本价
  selling_price?: number | null // 单位：分；出库时的实际售价，入库/退货为 null
  timestamp: string
  operator: string | null
  notes: string | null
  customer_id?: number | null // 赊账包：赊账/记账客户；散客为 null
  paid_amount?: number | null // 单位：分；实收金额，null=已全额付清（含赊账前的老数据）
  pay_method?: PaymentMethod | null // 收款/退款方式；null=未记录或没有现金移动（纯赊/冲减欠款）
}

// ---------- 赊账包：客户与还款（客户余额模型） ----------

export interface Customer {
  id: number
  name: string
  phone: string | null
  notes: string | null
  /** 默认价格档：NULL=零售默认；设了之后出库选他会自动按这档出价 */
  price_level: PriceLevel | null
  /** 客户偏好（v2.2）：自由文本 */
  preferences?: string | null
  /** 会员号（通用版）：会员建档自动生成 M+日期+序号；普通客户为 null */
  member_no?: string | null
  /** 会员等级（通用版）：普通会员/银卡/金卡等；仅会员价，无积分 */
  level?: string | null
  /** 入会日期 YYYY-MM-DD */
  join_date?: string | null
  created_at: string
}

/** 客户 + 赊账汇总（customer:list 返回）：outstanding 为负=预收 */
export interface CustomerWithStats extends Customer {
  outstanding: number // 当前欠款，单位：分
  total_credit: number // 赊销净额（赊销 - 赊账退货冲减），单位：分
  total_paid_back: number // 累计还款，单位：分
  last_deal_at: string | null // 最近交易/还款时间
}

export type PaymentMethod = '现金' | '微信' | '支付宝' | '其他'

export const PAYMENT_METHODS: PaymentMethod[] = ['现金', '微信', '支付宝', '其他']

// ---------- 一单多商品收银台 ----------

/** 收银台一行商品：售价必填（分），营业额/毛利全靠它 */
export interface CheckoutLine {
  productId: number
  quantity: number
  sellingPrice: number // 单位：分
}

/** 库存不足时收银台返回的缺货明细（哪样不够、差多少） */
export interface CheckoutShortage {
  productId: number
  name: string
  shortage: number
}

export interface ExpiredProductInfo {
  productId: number
  name: string
  expiredBatches: { batch_no: string; expiry_date: string; quantity: number }[]
}

export type CheckoutResult =
  | { ok: true; lines: unknown[]; totalDue: number; paidAmount: number | null; creditAmount: number }
  | { ok: false; shortages: CheckoutShortage[] }
  | { ok: false; expired: true; expiredProducts: ExpiredProductInfo[] }


export interface Payment {
  id: number
  customer_id: number
  amount: number // 单位：分
  method: PaymentMethod
  notes: string | null
  created_at: string
}

// ---------- 支出记账（v1.10） ----------

export type ExpenseCategory = '进货付款' | '房租' | '水电' | '运费' | '人工' | '杂项'
export const EXPENSE_CATEGORIES: ExpenseCategory[] = ['进货付款', '房租', '水电', '运费', '人工', '杂项']

export interface Expense {
  id: number
  category: ExpenseCategory
  amount: number // 单位：分
  method: PaymentMethod
  supplier_id: number | null
  supplier_name?: string | null // 列表/单条查询时 JOIN 带出
  note: string | null
  expense_date: string // 本地日期 YYYY-MM-DD
  operator: string | null
  created_at: string
}

/** 支出表单输入（新增/编辑共用；amount 单位分，页面从元换算） */
export interface ExpenseInput {
  category: ExpenseCategory
  amount: number
  method: PaymentMethod
  supplierId?: number | null
  note?: string | null
  expenseDate?: string
}

/** 对账单赊销明细行（customer:statement 的 sales 元素）；退货行 owed 为负（退货后少欠） */
export interface StatementSale {
  id: number
  timestamp: string
  type: 'out' | 'return'
  product_id: number
  product_name: string
  quantity: number
  due: number // 应付，单位：分
  paid: number // 已付，单位：分
  owed: number // 欠，单位：分
}

/** 客户对账单（customer:statement 返回） */
export interface CustomerStatement {
  customer: Customer
  sales: StatementSale[]
  payments: Payment[]
  total_credit: number
  total_paid_back: number
  outstanding: number
}

// ---------- 采购订单（v2.0） ----------

export type POStatus = 'draft' | 'sent' | 'partial' | 'complete' | 'cancelled'
export const PO_STATUSES: POStatus[] = ['draft', 'sent', 'partial', 'complete', 'cancelled']

/** 采购单状态中文名（数据库存英文枚举，界面只显示中文） */
export const PO_STATUS_LABELS: Record<POStatus, string> = {
  draft: '草稿',
  sent: '待收货',
  partial: '部分收货',
  complete: '已完成',
  cancelled: '已取消',
}

export interface PurchaseOrder {
  id: number
  po_no: string
  supplier_id: number | null
  status: POStatus
  expected_arrival: string | null
  total_cost: number | null
  created_at: string
  updated_at: string
  operator: string | null
  notes: string | null
}

export interface PurchaseOrderItem {
  id: number
  po_id: number
  product_id: number | null
  product_desc: string | null
  category: string | null
  quantity: number
  received_qty: number
  unit_cost: number
  created_at: string
}

/** 采购单列表行（po:list 返回）：在订单头基础上带供应商名与收货进度 */
export interface PurchaseOrderListItem extends PurchaseOrder {
  supplier_name: string | null
  item_count: number // 明细条数
  total_qty: number // 应收总数量
  received_qty: number // 已收总数量
}

/** 采购单明细行（po:detail 返回）：带商品名与 SKU，方便前端展示 */
export interface PurchaseOrderItemDetail extends PurchaseOrderItem {
  sku_code: string | null
  brand: string | null
  model: string | null
  product_name: string
}

/** 采购单详情（po:detail 返回） */
export interface PurchaseOrderDetail {
  order: PurchaseOrder & { supplier_name: string | null }
  items: PurchaseOrderItemDetail[]
}

// ---------- 多级定价（v2.0） ----------

export type PriceLevel = 'retail' | 'regular' | 'VIP' | 'wholesale' | 'promo'
export const PRICE_LEVELS: PriceLevel[] = ['retail', 'regular', 'VIP', 'wholesale', 'promo']

/** 价格档位中文名（数据库存英文枚举，界面只显示中文） */
export const PRICE_LEVEL_LABELS: Record<PriceLevel, string> = {
  retail: '零售',
  regular: '常客',
  VIP: '会员',
  wholesale: '批发',
  promo: '促销',
}

export interface PriceTier {
  id: number
  product_id: number
  tier: PriceLevel
  price: number
}

export interface Supplier {
  id: number
  name: string
  contact: string
  phone: string
  address: string
  notes: string
  created_at?: string
}

export type StockTakeStatus = '进行中' | '已完成' | '已审核'

export interface StockTake {
  id: number
  take_no: string
  status: StockTakeStatus
  location_filter: string | null
  category_filter?: Category | null // 赊账包新增：按品类盘点（与货位/供应商取交集）
  supplier_filter?: number | null // 赊账包新增：按供应商盘点
  /** 盘点方式：batch=按批次逐行 / sku=按商品盘总数（v2.1 新增） */
  mode?: 'batch' | 'sku'
  started_at: string
  completed_at: string | null
  operator: string
}

export interface StockTakeItem {
  id: number
  stock_take_id: number
  product_id: number
  batch_id: number | null
  system_qty: number
  actual_qty: number | null
  difference: number | null
  reason: string
}

// ---------- 员工账号（v0.1） ----------

export type UserRole = 'owner' | 'manager' | 'staff'

export interface User {
  id: number
  name: string
  username: string
  role: UserRole
  active: number
  created_at?: string
}

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  owner: '老板',
  manager: '高管',
  staff: '店员',
}

// ---------- 过期预警 / 操作日志 / 供应商对账 / 备份状态 ----------

/** 临期/过期商品（product:expiring 返回）：daysLeft 为负即已过期 */
export interface ExpiringProduct {
  id: number
  name: string
  sku: string
  expiry_date: string
  daysLeft: number
  expired: boolean
  stock: number
}

/** 操作日志行（audit:list 返回） */
export interface AuditLogEntry {
  id: number
  action: string // 入库/出库/退货/换货/盘点/改价/删商品/新建商品/改商品/新建客户/还账/采购收货
  entity: string | null // 对象描述，如"光威 赤刃 3.6m x2"
  detail: string | null // 关键数据 JSON 或一句话
  operator: string | null
  created_at: string
}

/** 供应商对账明细行（supplier:statement 的 lines 元素） */
export interface SupplierStatementLine {
  batch_id: number
  batch_no: string
  date: string // 入库日期 YYYY-MM-DD
  product_id: number
  product_name: string
  sku: string
  quantity: number // 进货数量（入库流水口径）
  remaining: number // 批次当前剩余
  cost_price: number // 单位：分
  amount: number // 进货金额 = quantity × cost_price，单位：分
  po_no: string | null // 关联采购单号（采购收货入库的才有）
}

/** 供应商付款记录（supplier:pay / supplier:payments 返回，v0.1） */
export interface SupplierPayment {
  id: number
  supplier_id: number
  amount: number // 单位：分
  method: string
  note: string | null
  pay_date: string // YYYY-MM-DD
  operator: string | null
  created_at?: string
}

/** 供应商对账单（supplier:statement 返回） */
export interface SupplierStatement {
  supplier: Supplier
  lines: SupplierStatementLine[]
  totalAmount: number // 总进货金额，单位：分
  totalQty: number // 总进货件数
  lastInboundAt: string | null // 最近一次进货日期
  pendingPoAmount: number // 待收采购单金额（sent/partial 的未收部分），单位：分
  totalPaid: number // 累计已付款（v0.1），单位：分
  outstanding: number // 还欠 = 总进货 - 已付（负=多付/预付），单位：分
  payments: SupplierPayment[] // 付款记录（新→旧）
}

/** 备份状态（backup:status 返回）：stale=true 表示超过 3 天没备份，前端提醒 */
export interface BackupStatus {
  lastBackupAt: string | null
  backupCount: number
  extraDir: string | null // 第二备份位置（未配置为 null）
  extraDirOk: boolean | null // 第二位置可写性（未配置为 null）
  extraError: string | null // 最近一次向第二位置复制的失败信息
  dbPath: string
  stale: boolean
}

// ---------- 套装（v2.2）：一套多个商品，卖一套一键加清单 ----------

export interface Kit {
  id: number
  name: string
  /** 打包一口价（分）：NULL=没设，按组成件现价加清单 */
  price?: number | null
  /** 总折扣（如 90 = 9 折）：NULL=不设；设了一口价则一口价优先 */
  discount_percent?: number | null
  created_at: string
  updated_at: string
}

export interface KitItem {
  id: number
  kit_id: number
  product_id: number
  quantity: number
}

/** 套装表单输入（kit:save 接收） */
export interface KitInput {
  id?: number
  name: string
  /** 打包一口价（分，可选）；设了优先于折扣 */
  price?: number | null
  /** 总折扣（如 90 = 9 折，可选） */
  discount_percent?: number | null
  items: { productId: number; quantity: number }[]
}

/** 套装列表行（kit:list 返回）：带商品明细条数 */
export interface KitListItem extends Kit {
  item_count: number
}

/** 套装详情（kit:get 返回）：带每个商品的名称/SKU/售价，方便开单时加清单 */
export interface KitDetailItem {
  product_id: number
  quantity: number
  sku_code: string
  brand: string | null
  model: string | null
  product_name: string
  suggest_price: number | null
}


// ---------- 通用版：分类 / 单位 / 行业模板 ----------

export interface CategoryRow {
  id: number
  name: string
  sort_order: number
  icon: string | null
  template_type: string
  created_at?: string
  /** 该分类下商品数（listCategoriesWithCount 返回） */
  product_count?: number
}

export interface CategoryRowWithCount extends CategoryRow {
  product_count: number
}

export interface UnitRow {
  id: number
  name: string
  allow_decimal: number
  sort_order: number
  created_at?: string
}

export interface IndustryTemplate {
  id: string
  name: string
  desc: string
  categories: string[]
  units: { name: string; allow_decimal: number }[]
}

