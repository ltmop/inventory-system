// 把 seedData.js 里的真实库存（53 条鱼竿 + 3 条演示商品）导入【已有】数据库。
// 背景：seedDatabase 只在空库首次启动时写入，老库（如阿杜正在用的 data.db）吃不到新种子。
// 用法：
//   node scripts/import-real-inventory.mjs            # 干跑（默认指向 %APPDATA%/fishing-inventory/data.db）
//   node scripts/import-real-inventory.mjs --apply    # 真正写入（写入前自动备份 .bak-import-时间戳）
//   node scripts/import-real-inventory.mjs --db <路径> [--apply]
// 幂等：按 sku_code / 供应商名 / 批次号去重，重复执行不会重复导入。
// 只导入 供应商/商品/批次；不导入种子流水和盘点单（那是演示数据，老库有自己的真实流水）。
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../electron/db.js'
import { SEED_SUPPLIERS, SEED_PRODUCTS, SEED_BATCHES } from '../electron/seedData.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const dbIdx = args.indexOf('--db')
const dbPath =
  dbIdx >= 0
    ? path.resolve(args[dbIdx + 1])
    : path.join(process.env.APPDATA, 'fishing-inventory', 'data.db')

if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`)
  process.exit(1)
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString()
const dateDaysAgo = (n) => daysAgo(n).slice(0, 10)

const db = openDatabase(dbPath)

// ---------- 干跑统计 ----------
const existSkus = new Set(db.prepare('SELECT sku_code FROM products').all().map((r) => r.sku_code))
const existBatchNos = new Set(db.prepare('SELECT batch_no FROM inventory_batches').all().map((r) => r.batch_no))
const supplierIdByName = new Map(db.prepare('SELECT id, name FROM suppliers').all().map((r) => [r.name, r.id]))

const newProducts = SEED_PRODUCTS.filter((p) => !existSkus.has(p[0]))
const newSuppliers = SEED_SUPPLIERS.filter((s) => !supplierIdByName.has(s[0]))
console.log(`目标库：${dbPath}`)
console.log(`模式：${apply ? '正式写入' : '干跑（加 --apply 才会写入）'}`)
console.log(`待导入：供应商 ${newSuppliers.length} 个 / 商品 ${newProducts.length} 个（跳过已存在 ${SEED_PRODUCTS.length - newProducts.length} 个）`)
if (!apply) {
  const newSkuSet = new Set(newProducts.map((p) => p[0]))
  const newBatches = SEED_BATCHES.filter(
    (b) => newSkuSet.has(SEED_PRODUCTS[b[0] - 1][0]) && !existBatchNos.has(b[1]),
  )
  console.log(`待导入：批次 ${newBatches.length} 个`)
  db.close()
  process.exit(0)
}

// ---------- 正式写入：先备份 ----------
const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString()
  .replace(/[:T]/g, '-')
  .slice(0, 19)
const bakPath = `${dbPath}.bak-import-${stamp}`
fs.copyFileSync(dbPath, bakPath)
console.log(`已备份：${bakPath}`)

db.exec('BEGIN')
try {
  // 1. 供应商：按名字去重，建立 种子序号(1起) → 实际 id 映射
  const insSupplier = db.prepare(
    'INSERT INTO suppliers (name, contact, phone, address, notes) VALUES (?, ?, ?, ?, ?)',
  )
  const supplierIdBySeedIdx = new Map()
  SEED_SUPPLIERS.forEach((s, i) => {
    if (supplierIdByName.has(s[0])) {
      supplierIdBySeedIdx.set(i + 1, supplierIdByName.get(s[0]))
    } else {
      const info = insSupplier.run(...s)
      supplierIdBySeedIdx.set(i + 1, Number(info.lastInsertRowid))
    }
  })

  // 2. 商品：按 sku_code 去重，建立 种子序号(1起) → 实际 id 映射（已存在的也映射，供批次引用）
  const skuToId = new Map(db.prepare('SELECT id, sku_code FROM products').all().map((r) => [r.sku_code, r.id]))
  const insProduct = db.prepare(
    `INSERT INTO products (sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const productIdBySeedIdx = new Map()
  let importedProducts = 0
  SEED_PRODUCTS.forEach((p, i) => {
    if (skuToId.has(p[0])) {
      productIdBySeedIdx.set(i + 1, skuToId.get(p[0]))
      return
    }
    const info = insProduct.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], daysAgo(p[10]), daysAgo(p[11]))
    productIdBySeedIdx.set(i + 1, Number(info.lastInsertRowid))
    importedProducts++
  })

  // 3. 批次：重映射 product_id / supplier_id，批次号冲突则跳过
  const insBatch = db.prepare(
    `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  let importedBatches = 0
  let skippedBatches = 0
  for (const b of SEED_BATCHES) {
    if (existBatchNos.has(b[1])) {
      skippedBatches++
      continue
    }
    insBatch.run(productIdBySeedIdx.get(b[0]), b[1], b[2], b[3], b[4], dateDaysAgo(b[5]), supplierIdBySeedIdx.get(b[6]) ?? null)
    importedBatches++
  }

  db.exec('COMMIT')
  console.log(`导入完成：供应商 ${newSuppliers.length} 个 / 商品 ${importedProducts} 个 / 批次 ${importedBatches} 个（批次号冲突跳过 ${skippedBatches} 个）`)
  const totals = {
    products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
    batches: db.prepare('SELECT COUNT(*) AS n FROM inventory_batches').get().n,
    stock: db.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_batches').get().q,
    value: db.prepare('SELECT COALESCE(SUM(quantity * cost_price),0) AS v FROM inventory_batches').get().v,
  }
  console.log(`导入后全库：商品 ${totals.products} / 批次 ${totals.batches} / 库存 ${totals.stock} 件 / 库存价值 ${(totals.value / 100).toFixed(2)} 元`)
} catch (e) {
  db.exec('ROLLBACK')
  console.error('导入失败已回滚：', e.message)
  process.exit(1)
} finally {
  db.close()
}
