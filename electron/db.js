// 数据层：SQLite 初始化（WAL 模式）+ 建表 + 首次启动种子数据
// 使用 Electron 内置 Node 的 node:sqlite，零原生依赖，免编译
// 说明：架构文档原定 better-sqlite3，因开发机无 VS Build Tools 且其无 Electron 预编译产物，
//       改用 node:sqlite（API 同为同步风格，SQL schema 一字未动）
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import {
  SEED_SUPPLIERS,
  SEED_PRODUCTS,
  SEED_BATCHES,
  SEED_TRANSACTIONS,
  SEED_STOCK_TAKES,
  SEED_STOCK_TAKE_ITEMS,
} from './seedData.js'

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_code TEXT UNIQUE NOT NULL,
    barcode TEXT,
    -- 分类（通用版）：不限死，前端给预设通用分类 + 允许自由填
    category TEXT NOT NULL DEFAULT '其他',
    sub_category TEXT,
    brand TEXT,
    model TEXT,
    cost_price INTEGER NOT NULL,
    suggest_price INTEGER,
    location TEXT,
    photo_path TEXT,
    name_vi TEXT,
    status TEXT DEFAULT '待盘点' CHECK (status IN ('待盘点','已盘点','在售','停售','清仓')),
    -- 计量单位（v2.2）：件=整数按个卖（默认）；米=按长度小数卖（如布料/线材）
    unit TEXT DEFAULT '件',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT,
    phone TEXT,
    address TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    supplier_id INTEGER REFERENCES suppliers(id),
    batch_no TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    cost_price INTEGER NOT NULL,
    location TEXT,
    inbound_date DATE NOT NULL,
    notes TEXT,
    -- 批次到期日（保质期商品：饵料/小药/活饵用；NULL=无保质期）。FEFO 先到期先出 + 临期按批次预警
    expiry_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 赊账包：客户档案（余额模型——"老王一共欠我多少钱"，不绑定单张订单）
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    -- 客户绑定价格档（可空，NULL=零售默认；老库由 migrateCustomerPriceLevel 补）
    price_level TEXT,
    -- 老钓友偏好（v2.2）：自由文本
    preferences TEXT,
    created_at TEXT NOT NULL
);

-- 赊账包：还款记录（登记到客户头上；amount 单位：分）
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT '现金' CHECK (method IN ('现金','微信','支付宝','其他')),
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    batch_id INTEGER REFERENCES inventory_batches(id),
    type TEXT NOT NULL CHECK (type IN ('in', 'out', 'return', 'exchange', 'waste')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER,
    selling_price INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    operator TEXT,
    notes TEXT,
    -- 赊账包两列（老库由 migrateCreditPack 补）：customer_id 可空（散客），
    -- paid_amount=实收金额（分），NULL 视为已全额付清（老数据不动即为此语义）
    customer_id INTEGER REFERENCES customers(id),
    paid_amount INTEGER,
    -- 收款方式（老库由 migratePayMethod 补）：现金/微信/支付宝/其他，
    -- NULL=未记录（老数据/纯赊账/冲减欠款等没有现金移动的流水）
    pay_method TEXT CHECK (pay_method IN ('现金','微信','支付宝','其他'))
);

CREATE TABLE IF NOT EXISTS stock_takes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    take_no TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT '进行中' CHECK (status IN ('进行中','已完成','已审核')),
    location_filter TEXT,
    -- 赊账包新增两列（老库由 migrateCreditPack 补）：按品类/供应商盘点
    category_filter TEXT,
    supplier_filter INTEGER,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    operator TEXT
);

CREATE TABLE IF NOT EXISTS stock_take_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    batch_id INTEGER REFERENCES inventory_batches(id),
    system_qty INTEGER NOT NULL,
    actual_qty INTEGER,
    difference INTEGER GENERATED ALWAYS AS (actual_qty - system_qty) STORED,
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_batches_product ON inventory_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_batch_no ON inventory_batches(batch_no);
CREATE INDEX IF NOT EXISTS idx_batches_supplier ON inventory_batches(supplier_id);
CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_transactions_batch ON transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_stock_take_items_take ON stock_take_items(stock_take_id);

-- 采购订单（v2.0）
CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_no TEXT UNIQUE NOT NULL,
    supplier_id INTEGER REFERENCES suppliers(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','complete','cancelled')),
    expected_arrival DATE,
    total_cost INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    operator TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    product_desc TEXT,
    category TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    received_qty INTEGER NOT NULL DEFAULT 0,
    unit_cost INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 多级定价（v2.0）：零售/普通/VIP/批发/促销
CREATE TABLE IF NOT EXISTS price_tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    tier TEXT NOT NULL CHECK (tier IN ('retail','regular','VIP','wholesale','promo')),
    price INTEGER NOT NULL,
    UNIQUE(product_id, tier)
);

CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_price_tiers_product ON price_tiers(product_id);

-- 操作日志：关键写操作留痕（谁/什么时候/对什么/做了什么），与业务写入同事务提交
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity TEXT,
    detail TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- AI 记忆：对话历史（只存 user/assistant）与自主沉淀的经营知识
CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 应用设置表（v1.13）：新手引导标记、授权偏好等；CREATE IF NOT EXISTS 兼容老库
CREATE TABLE IF NOT EXISTS settings (
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL
);

-- 支出记账（v1.10）：进货付款/房租/水电/运费/人工/杂项，金额单位分；
-- 净利 = 毛利 − 支出（经营报表口径）。老库靠 CREATE TABLE IF NOT EXISTS 直接建表，无需迁移
CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK (category IN ('进货付款','房租','水电','运费','人工','杂项')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT '现金' CHECK (method IN ('现金','微信','支付宝','其他')),
    supplier_id INTEGER REFERENCES suppliers(id),
    note TEXT,
    -- 支出发生的本地日期 YYYY-MM-DD（老板补记昨天的账也能记对日子）
    expense_date TEXT NOT NULL,
    operator TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

-- 报损登记（v2.1）：活饵死亡/饵料报废等损耗。报损 = 从批次扣库存 + 记损耗，供成本报表单独统计
CREATE TABLE IF NOT EXISTS waste_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    batch_id INTEGER REFERENCES inventory_batches(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    -- 报损该批次的进价（v2.2）：哪批报损按哪批的成本算，老数据 NULL 回退商品最近进价
    cost_price INTEGER,
    reason TEXT NOT NULL DEFAULT '',  -- 报损原因：活饵死亡/饵料临期报废/破损等
    operator TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waste_logs_created ON waste_logs(created_at);

-- 收款登记（v3.0 收款对账）：老板每天手动登记 微信/支付宝/现金 实际到账，系统对账
CREATE TABLE IF NOT EXISTS payment_registers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    register_date TEXT NOT NULL,        -- YYYY-MM-DD
    method TEXT NOT NULL CHECK (method IN ('现金','微信','支付宝','其他')),
    amount INTEGER NOT NULL CHECK (amount >= 0),  -- 单位：分
    operator TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(register_date, method)       -- 每天每方式一条，重复登记覆盖
);

-- AI 功能每日用量（v3.0）：视觉识别等按版本限每日额度（普通20/进阶100/大师不限）
CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_date TEXT NOT NULL,           -- YYYY-MM-DD
    feature TEXT NOT NULL,              -- 如 'vision'（拍照识别）
    count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(usage_date, feature)
);

-- 套装（v2.2）：一套多个商品（新手套装/绑钩套装等），开单时一键加清单
CREATE TABLE IF NOT EXISTS kits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- 打包价（v2.2）：一口价，单位分；NULL=没设，按组成件现价加清单
    price INTEGER,
    -- 总折扣（v2.2）：如 90 = 9 折（按组成件现价合计打这个折）；NULL=不设
    discount_percent INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS kit_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    UNIQUE(kit_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_kit_items_kit ON kit_items(kit_id);
`

/**
 * 打开（必要时创建）数据库，执行 schema，空库时写入种子数据
 * @param {string} dbPath 数据库文件绝对路径
 * @returns {DatabaseSync}
 */
/** 依次执行全部迁移（各自独立 try/catch：单个失败记录但不连锁崩坏） */
function runMigrations(db) {
  const steps = [
    ['旧商品表重建', migrateOldProductsTable],
    ['赊账包补列', migrateCreditPack],
    ['渔具属性补列', migrateFishingAttrs],
    ['客户价格档补列', migrateCustomerPriceLevel],
    ['安全库存补列', migrateMinStock],
    ['收款方式补列', migratePayMethod],
    ['批次到期日补列', migrateBatchExpiry],
    ['盘点模式补列', migrateStockTakeMode],
    ['流水表重建加报损类型', migrateTransactionsWasteType],
    ['报损成本补列', migrateWasteCostPrice],
    ['商品计量单位补列', migrateProductUnit],
    ['客户偏好补列', migrateCustomerPreferences],
    ['套装价格补列', migrateKitPrice],
  ]
  const failures = []
  for (const [name, fn] of steps) {
    try {
      fn(db)
    } catch (e) {
      failures.push(`${name}: ${e.message}`)
      console.error(`[db] 迁移「${name}」失败（已跳过，不阻断启动）:`, e.message)
    }
  }
  return failures
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  // 迁移安全网：老库做原地重建表前先把库文件拷贝留底（已存在不覆盖），
  // 迁移一旦失败可从 .pre-migration.bak 自动回退；拷贝失败只告警不阻断启动
  const bakPath = dbPath + '.pre-migration.bak'
  if (fs.existsSync(dbPath) && !fs.existsSync(bakPath)) {
    try {
      fs.copyFileSync(dbPath, bakPath)
    } catch (e) {
      console.error('[db] 迁移前留底备份失败:', e)
    }
  }

  const openAndMigrate = (path) => {
    const db = new DatabaseSync(path)
    db.exec(SCHEMA_SQL)
    const failures = runMigrations(db)
    const row = db.prepare('SELECT COUNT(*) AS n FROM products').get()
    if (row.n === 0) seedDatabase(db)
    return { db, failures }
  }

  // 第一次尝试
  let result
  try {
    result = openAndMigrate(dbPath)
  } catch (e) {
    // 迁移失败 → 若 .pre-migration.bak 存在，恢复后再试一次（自动兜底，不砖死）
    console.error('[db] 首次迁移失败，尝试从备份恢复:', e.message)
    try { db?.close() } catch { /* 忽略 */ }
    if (fs.existsSync(bakPath)) {
      try {
        // 当前（可能半迁移）的库留底，再用备份覆盖
        const brokenPath = dbPath + '.broken-' + Date.now()
        fs.copyFileSync(dbPath, brokenPath)
        fs.copyFileSync(bakPath, dbPath)
        console.error('[db] 已从备份恢复，broken 库留底于:', brokenPath)
        result = openAndMigrate(dbPath)
      } catch (e2) {
        // 恢复也失败：把备份路径明确抛出，让启动弹窗可读
        throw new Error(`数据库迁移失败且自动恢复也失败。数据在备份：${bakPath}\n原始错误：${e.message}\n恢复错误：${e2.message}`)
      }
    } else {
      throw new Error(`数据库迁移失败且无备份可恢复。错误：${e.message}`)
    }
  }

  // 记录迁移失败项（不阻断启动，但不静默）
  if (result.failures.length > 0) {
    console.warn('[db] 部分迁移未完成:', result.failures.join('; '))
  }
  return result.db
}

// ---------- 旧库迁移：10 大类 schema（无 sub_category）→ 20 大类 + sub_category ----------
// 老用户的 data.db 是旧 10 类结构，直接启动会被新 CHECK 约束卡死，这里做原地重建表迁移。
// 品类映射：台钓竿/路亚竿/海竿 → 鱼竿（原名降级为 sub_category）、路亚饵 → 路亚假饵、
//           配件 → 工具配件，其余（渔轮/鱼线/鱼钩/浮漂/其他）同名保留；老 SKU（JD-*）不动。
const OLD_CATEGORY_MAP = `
  CASE category
    WHEN '台钓竿' THEN '鱼竿'
    WHEN '路亚竿' THEN '鱼竿'
    WHEN '海竿'   THEN '鱼竿'
    WHEN '路亚饵' THEN '路亚假饵'
    WHEN '配件'   THEN '工具配件'
    ELSE category
  END`

function migrateOldProductsTable(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'")
    .get()
  // 新库（无表）或已是新 schema（含 sub_category）都无需迁移
  if (!row || row.sql.includes('sub_category')) return

  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE products_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sku_code TEXT UNIQUE NOT NULL,
          barcode TEXT,
          category TEXT NOT NULL DEFAULT '其他',
          sub_category TEXT,
          brand TEXT,
          model TEXT,
          cost_price INTEGER NOT NULL,
          suggest_price INTEGER,
          location TEXT,
          photo_path TEXT,
          name_vi TEXT,
          status TEXT DEFAULT '待盘点' CHECK (status IN ('待盘点','已盘点','在售','停售','清仓')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO products_new
        (id, sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, photo_path, name_vi, status, created_at, updated_at)
      SELECT
        id, sku_code, barcode,
        ${OLD_CATEGORY_MAP},
        CASE WHEN category IN ('台钓竿','路亚竿','海竿') THEN category ELSE NULL END,
        brand, model, cost_price, suggest_price, location, photo_path, name_vi,
        CASE status
          WHEN '已上架虾皮' THEN '在售'
          WHEN '已售罄' THEN '清仓'
          WHEN '停产' THEN '停售'
          ELSE status END,
        created_at, updated_at
      FROM products;
      DROP TABLE products;
      ALTER TABLE products_new RENAME TO products;
    `)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    db.exec('PRAGMA foreign_keys = ON')
    throw e
  }
  db.exec('PRAGMA foreign_keys = ON')
  // DROP TABLE 会连带删掉 products 上的索引（SCHEMA_SQL 里的 IF NOT EXISTS 已先于迁移执行），需重建
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
  `)
}

// ---------- 渔具专用属性迁移（v2.0）：只增不改，老数据新列为 NULL ----------
// 通用版：只补通用商品属性（颜色/材质/保质期），去掉渔具专属规格列（长度/调性/硬度/线号/钩号）
function migrateFishingAttrs(db) {
  const addCol = (col, ddl) => {
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
    if (!cols.includes(col)) db.exec(`ALTER TABLE products ADD COLUMN ${ddl}`)
  }
  addCol('color', 'color TEXT')
  addCol('material', 'material TEXT')
  addCol('expiry_date', 'expiry_date TEXT')
}

// ---------- 赊账包迁移：老库补列（只增不改；新库 SCHEMA_SQL 已含这些列，ALTER 自动跳过） ----------
// 注意：两张新表（customers/payments）由 SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 建好，无需迁移；
// 这里只负责给老库的 transactions / stock_takes 补新列。
function migrateCreditPack(db) {
  const addColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  addColumn('transactions', 'customer_id', 'customer_id INTEGER REFERENCES customers(id)')
  addColumn('transactions', 'paid_amount', 'paid_amount INTEGER')
  addColumn('stock_takes', 'category_filter', 'category_filter TEXT')
  addColumn('stock_takes', 'supplier_filter', 'supplier_filter INTEGER')
  // 索引放在迁移之后建：老库的 transactions 要等到 ALTER 之后才有 customer_id 列，
  // 若写进 SCHEMA_SQL 会在老库上报 "no such column" 导致启动失败
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
  `)
}

// ---------- 客户价格档迁移：老库 customers 补 price_level（只增不改；NULL=零售默认） ----------
function migrateCustomerPriceLevel(db) {
  const addCol = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  addCol('customers', 'price_level', 'price_level TEXT')
}

// ---------- 分级库存预警迁移：老库 products 补 min_stock（只增不改；NULL=用默认阈值 5） ----------
// 注意：migrateOldProductsTable 重建的 products_new 也不含 min_stock，靠这里统一补上
function migrateMinStock(db) {
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
  if (!cols.includes('min_stock')) db.exec('ALTER TABLE products ADD COLUMN min_stock INTEGER')
}

// ---------- 收款方式迁移：老库 transactions 补 pay_method（只增不改；NULL=未记录） ----------
function migratePayMethod(db) {
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name)
  if (!cols.includes('pay_method')) {
    db.exec("ALTER TABLE transactions ADD COLUMN pay_method TEXT CHECK (pay_method IN ('现金','微信','支付宝','其他'))")
  }
}

// ---------- 批次到期日迁移（v2.1）：老库 inventory_batches 补 expiry_date（NULL=无保质期） ----------
function migrateBatchExpiry(db) {
  const cols = db.prepare('PRAGMA table_info(inventory_batches)').all().map((c) => c.name)
  if (!cols.includes('expiry_date')) {
    db.exec('ALTER TABLE inventory_batches ADD COLUMN expiry_date TEXT')
  }
}

// ---------- 盘点模式迁移（v2.1）：老库 stock_takes 补 mode（'batch'=按批次 / 'sku'=按SKU合并） ----------
function migrateStockTakeMode(db) {
  const cols = db.prepare('PRAGMA table_info(stock_takes)').all().map((c) => c.name)
  if (!cols.includes('mode')) {
    db.exec("ALTER TABLE stock_takes ADD COLUMN mode TEXT DEFAULT 'batch'")
  }
}

// ---------- 流水表重建（v2.2）：transactions 的 type CHECK 加 'waste'，老库重建表 ----------
// SQLite 无法 ALTER CHECK 约束，只能"建新表→INSERT SELECT→DROP→RENAME"整表迁移。
// 照抄 migrateOldProductsTable 模式：保留全部列（含赊账 customer_id/paid_amount/pay_method）+ 重建索引。
function migrateTransactionsWasteType(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get()
  if (!row || row.sql.includes("'waste'")) return // 新库/已迁过都跳过
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id),
          batch_id INTEGER REFERENCES inventory_batches(id),
          type TEXT NOT NULL CHECK (type IN ('in', 'out', 'return', 'exchange', 'waste')),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price INTEGER,
          selling_price INTEGER,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          operator TEXT,
          notes TEXT,
          customer_id INTEGER REFERENCES customers(id),
          paid_amount INTEGER,
          pay_method TEXT CHECK (pay_method IN ('现金','微信','支付宝','其他'))
      );
      INSERT INTO transactions_new
        (id, product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
      SELECT
        id, product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method
      FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_new RENAME TO transactions;
    `)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    db.exec('PRAGMA foreign_keys = ON')
    throw e
  }
  db.exec('PRAGMA foreign_keys = ON')
  // DROP TABLE 连带删了索引，需重建
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_batch ON transactions(batch_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
  `)
}

// ---------- 报损成本补列（v2.2）：waste_logs 补 cost_price（该批次进价；老数据 NULL=回退商品最近进价） ----------
function migrateWasteCostPrice(db) {
  const cols = db.prepare('PRAGMA table_info(waste_logs)').all().map((c) => c.name)
  if (!cols.includes('cost_price')) db.exec('ALTER TABLE waste_logs ADD COLUMN cost_price INTEGER')
}

// ---------- 商品计量单位补列（v2.2）：products 补 unit（件/米，默认件） ----------
function migrateProductUnit(db) {
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
  if (!cols.includes('unit')) db.exec("ALTER TABLE products ADD COLUMN unit TEXT DEFAULT '件'")
}

// ---------- 客户偏好补列（v2.2）：customers 补 preferences（自由文本） ----------
function migrateCustomerPreferences(db) {
  const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name)
  if (!cols.includes('preferences')) db.exec('ALTER TABLE customers ADD COLUMN preferences TEXT')
}

// ---------- 套装价格补列（v2.2）：kits 补 price（一口价）+ discount_percent（总折扣） ----------
function migrateKitPrice(db) {
  const cols = db.prepare('PRAGMA table_info(kits)').all().map((c) => c.name)
  if (!cols.includes('price')) db.exec('ALTER TABLE kits ADD COLUMN price INTEGER')
  if (!cols.includes('discount_percent')) db.exec('ALTER TABLE kits ADD COLUMN discount_percent INTEGER')
}

/** 软件正常退出时调用一次：收尾 checkpoint，截断 WAL */
export function finalCheckpoint(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // 退出阶段失败不影响数据安全（WAL 下次启动自动恢复）
  }
}

// ---------- AI 记忆沉淀：对话历史 + 知识库（纯数据层，与 Electron 解耦，可单测） ----------

/** 落一条对话消息（只存 user/assistant，tool 中间步骤不存） */
export function saveAiMessage(db, role, content) {
  if (role !== 'user' && role !== 'assistant') return
  db.prepare('INSERT INTO ai_messages (role, content, created_at) VALUES (?, ?, ?)').run(
    role,
    String(content ?? ''),
    new Date().toISOString(),
  )
}

/** 最近 N 条对话，按时间正序返回（前端启动恢复用） */
export function listAiMessages(db, limit = 50) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const rows = db.prepare('SELECT role, content FROM ai_messages ORDER BY id DESC LIMIT ?').all(n)
  return rows.reverse()
}

const INSIGHT_KINDS = new Set(['fact', 'preference', 'suggestion'])

/** AI 自主沉淀一条知识；kind 不在白名单里按 fact 存 */
export function saveInsight(db, kind, content) {
  const text = String(content ?? '').trim()
  if (!text) return { saved: false, reason: '内容为空' }
  const k = INSIGHT_KINDS.has(kind) ? kind : 'fact'
  db.prepare('INSERT INTO ai_insights (kind, content, created_at) VALUES (?, ?, ?)').run(
    k,
    text,
    new Date().toISOString(),
  )
  return { saved: true, kind: k }
}

/** 知识列表查询（ai:insights 通道备用） */
export function listInsights(db, { limit = 50, activeOnly = false } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)
  const rows = activeOnly
    ? db.prepare('SELECT id, kind, content, created_at, active FROM ai_insights WHERE active = 1 ORDER BY id DESC LIMIT ?').all(n)
    : db.prepare('SELECT id, kind, content, created_at, active FROM ai_insights ORDER BY id DESC LIMIT ?').all(n)
  return rows
}

const KIND_LABEL = { fact: '事实', preference: '偏好', suggestion: '建议' }
// 注入系统提示的记忆片段总长上限（与 ai.js 单条消息 4000 字截断同思路）
const MAX_MEMORY_CHARS = 1500

/**
 * 组装注入系统提示词的记忆片段：active=1 的最近 N 条，超出长度上限的截掉。
 * 无记忆时返回空串，调用方拼提示词时跳过。
 */
export function buildInsightsContext(db, limit = 20) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  const rows = db
    .prepare('SELECT kind, content FROM ai_insights WHERE active = 1 ORDER BY id DESC LIMIT ?')
    .all(n)
  if (rows.length === 0) return ''
  let out = '你之前记住的店里的事（回答时可以参考）：'
  for (const r of rows.reverse()) {
    const line = `\n- [${KIND_LABEL[r.kind] ?? '事实'}] ${r.content}`
    if (out.length + line.length > MAX_MEMORY_CHARS) break
    out += line
  }
  return out
}

// ---------- 种子数据（与前端 mock-data.ts 同源，空库首次启动写入） ----------

function daysAgo(n, hour = 10, minute = 0) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
const dateDaysAgo = (n) => daysAgo(n).slice(0, 10)

function seedDatabase(db) {
  // 数据定义已抽取到 electron/seedData.js（索引即新库自增 id：空库从 1 开始连续插入）
  const suppliers = SEED_SUPPLIERS
  const products = SEED_PRODUCTS
  const batches = SEED_BATCHES
  const txs = SEED_TRANSACTIONS
  const stockTakes = SEED_STOCK_TAKES
  const stockTakeItems = SEED_STOCK_TAKE_ITEMS

  db.exec('BEGIN')
  try {
    const insSupplier = db.prepare(
      'INSERT INTO suppliers (name, contact, phone, address, notes) VALUES (?, ?, ?, ?, ?)',
    )
    for (const s of suppliers) insSupplier.run(...s)

    const insProduct = db.prepare(
      `INSERT INTO products (sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const p of products)
      insProduct.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], daysAgo(p[10]), daysAgo(p[11]))

    const insBatch = db.prepare(
      `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const b of batches) insBatch.run(b[0], b[1], b[2], b[3], b[4], dateDaysAgo(b[5]), b[6])

    const insTx = db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const t of txs)
      insTx.run(t[0], t[1], t[2], t[3], t[4], t[5], daysAgo(t[6], t[7]), t[8], t[9])

    const insTake = db.prepare(
      `INSERT INTO stock_takes (take_no, status, location_filter, started_at, completed_at, operator)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const st of stockTakes)
      insTake.run(
        st[0], st[1], st[2],
        daysAgo(st[3], st[4]),
        st[5] === null ? null : daysAgo(st[5], st[6]),
        st[7],
      )

    const insItem = db.prepare(
      `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const it of stockTakeItems) insItem.run(...it)

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
