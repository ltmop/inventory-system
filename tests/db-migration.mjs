import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(__dirname)
const { openDatabase } = await import('file://' + path.join(root, 'electron', 'db.js').replace(/\\/g, '/'))

let pass = 0, fail = 0
const ok = (c, n, x='') => { if (c) { pass++; console.log('  ✓ ' + n + (x ? ' [' + x + ']' : '')) } else { fail++; console.log('  ✗ ' + n + (x ? ' [' + x + ']' : '')) } }

// ===== 测试1：新库初始化 =====
const db1Path = path.join(os.tmpdir(), 'inv-test-' + Date.now() + '.db')
const db1 = openDatabase(db1Path)
const cats = db1.prepare('SELECT * FROM categories').all()
const units = db1.prepare('SELECT * FROM units').all()
ok(cats.length > 0, '新库分类种子', '共 ' + cats.length + ' 个')
ok(units.length >= 12, '新库单位种子', '共 ' + units.length + ' 个')
db1.prepare("INSERT INTO products (sku_code, category, brand, model, cost_price, status, unit) VALUES ('T1','饮料','可口可乐','330ml',150,'在售','瓶')").run()
const t1 = db1.prepare("SELECT * FROM products WHERE sku_code='T1'").get()
ok(t1.category === '饮料', '任意分类可建档（CHECK 已去掉）')
ok(t1.store_code === '', 'store_code 默认空')
ok(t1.unit === '瓶', '单位=瓶（非硬编码件）')
db1.prepare("INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, inbound_date, production_date, expiry_date) VALUES (?, 'B1', 1.5, 150, '2026-01-01', '2026-01-01', '2026-12-31')").run(t1.id)
const b1 = db1.prepare("SELECT * FROM inventory_batches WHERE batch_no='B1'").get()
ok(b1.quantity === 1.5, '批次小数数量 1.5', 'qty=' + b1.quantity)
ok(!!b1.production_date, '批次生产日期已存')
db1.prepare("INSERT INTO customers (name, member_no, level, join_date, created_at) VALUES ('张会员','M001','银卡','2026-01-01','2026-01-01T00:00:00')").run()
const c1 = db1.prepare("SELECT * FROM customers WHERE name='张会员'").get()
ok(c1.member_no === 'M001' && c1.level === '银卡', '会员字段可用')
db1.close()

// ===== 测试2：老库升级 =====
const legacyPath = path.join(os.tmpdir(), 'inv-legacy-' + Date.now() + '.db')
const { DatabaseSync } = require('node:sqlite')
const legacy = new DatabaseSync(legacyPath)
legacy.exec("CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku_code TEXT UNIQUE NOT NULL, barcode TEXT, category TEXT NOT NULL CHECK (category IN ('鱼竿','鱼线')), sub_category TEXT, brand TEXT, model TEXT, cost_price INTEGER NOT NULL, suggest_price INTEGER, location TEXT, photo_path TEXT, name_vi TEXT, status TEXT, unit TEXT DEFAULT '件', min_stock INTEGER, parent_id INTEGER, part_type TEXT, created_at DATETIME, updated_at DATETIME)")
legacy.exec("CREATE TABLE inventory_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, supplier_id INTEGER, batch_no TEXT NOT NULL, quantity INTEGER NOT NULL, cost_price INTEGER NOT NULL, location TEXT, inbound_date DATE NOT NULL, notes TEXT, expiry_date TEXT, created_at DATETIME)")
legacy.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, notes TEXT, price_level TEXT, preferences TEXT, created_at TEXT NOT NULL DEFAULT '2026-01-01')")
legacy.exec("CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, batch_id INTEGER, type TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER, selling_price INTEGER, timestamp DATETIME, operator TEXT, notes TEXT, customer_id INTEGER, paid_amount INTEGER, pay_method TEXT)")
legacy.exec("CREATE TABLE settings (key TEXT UNIQUE NOT NULL, value TEXT NOT NULL)")
legacy.exec("CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT, phone TEXT, address TEXT, notes TEXT, created_at DATETIME)")
legacy.exec("INSERT INTO products (sku_code, category, brand, model, cost_price, suggest_price, status, unit) VALUES ('YL-001','鱼竿','御鳞','3H',4500,8800,'在售','件')")
legacy.exec("INSERT INTO products (sku_code, category, brand, model, cost_price, suggest_price, status, unit) VALUES ('XL-001','鱼线','YGK','PE',2000,3500,'在售','米')")
legacy.exec("INSERT INTO customers (name, created_at) VALUES ('老客户','2026-01-01')")
legacy.close()
const db2 = openDatabase(legacyPath)
const prods = db2.prepare('SELECT * FROM products').all()
ok(prods.length === 2, '老库商品保留', prods.map(p=>p.brand+' '+p.model).join('/'))
ok(prods[0].store_code === '', '老库补 store_code')
const cols = db2.prepare('PRAGMA table_info(products)').all().map(c=>c.name)
ok(cols.includes('store_code') && cols.includes('unit'), '老库 products 补列完整')
const cats2 = db2.prepare('SELECT * FROM categories').all()
ok(cats2.some(c=>c.name==='鱼竿') && cats2.some(c=>c.name==='鱼线'), '老分类从商品抽取迁移', cats2.map(c=>c.name).join('/'))
const custCols = db2.prepare('PRAGMA table_info(customers)').all().map(c=>c.name)
ok(custCols.includes('member_no') && custCols.includes('level'), '老库 customers 补会员字段')
const units2 = db2.prepare('SELECT * FROM units').all()
ok(units2.length >= 12, '老库单位种子化')
const batchCols = db2.prepare('PRAGMA table_info(inventory_batches)').all().map(c=>c.name)
ok(batchCols.includes('production_date') && batchCols.includes('store_code'), '老库批次补生产日期/store_code')
db2.close()
try { fs.unlinkSync(db1Path); fs.unlinkSync(legacyPath) } catch {}
console.log('\n==== db.js 迁移测试: ' + pass + ' 通过, ' + fail + ' 失败 ====')
process.exit(fail > 0 ? 1 : 0)
