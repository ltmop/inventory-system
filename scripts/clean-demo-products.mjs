// 清掉最早一批 JD- 开头的假演示数据（2026-07-31 之前的旧种子，共 12 个商品）。
// 真实库存（YL-/CH-/QT- 等 56 条）已于今日正式导入，假数据继续留着会混进库存总值和报表。
// 用法：
//   node scripts/clean-demo-products.mjs            # 干跑（默认 %APPDATA%/fishing-inventory/data.db）
//   node scripts/clean-demo-products.mjs --apply    # 真正删除（删前自动备份 .bak-clean-时间戳）
//   node scripts/clean-demo-products.mjs --db <路径> [--apply]
// 删除范围：products(sku LIKE 'JD-%') 及其 批次/流水/盘点明细/价格档/采购明细（同一事务，全删或全不删）。
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../electron/db.js'

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

const db = openDatabase(dbPath)
const demos = db.prepare("SELECT id, sku_code, brand, model FROM products WHERE sku_code LIKE 'JD-%'").all()
if (demos.length === 0) {
  console.log('没有 JD- 开头的演示数据，无需清理')
  db.close()
  process.exit(0)
}
const ids = demos.map((d) => d.id)
const ph = ids.map(() => '?').join(',')
const counts = {
  批次: db.prepare(`SELECT COUNT(*) AS n FROM inventory_batches WHERE product_id IN (${ph})`).get(...ids).n,
  流水: db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE product_id IN (${ph})`).get(...ids).n,
  盘点明细: db.prepare(`SELECT COUNT(*) AS n FROM stock_take_items WHERE product_id IN (${ph})`).get(...ids).n,
  价格档: db.prepare(`SELECT COUNT(*) AS n FROM price_tiers WHERE product_id IN (${ph})`).get(...ids).n,
  采购明细: db.prepare(`SELECT COUNT(*) AS n FROM purchase_order_items WHERE product_id IN (${ph})`).get(...ids).n,
}
console.log(`目标库：${dbPath}`)
console.log(`模式：${apply ? '正式删除' : '干跑（加 --apply 才会删除）'}`)
console.log(`待删除演示商品 ${demos.length} 个：${demos.map((d) => d.sku_code).join(', ')}`)
console.log(`连带删除：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
if (!apply) {
  db.close()
  process.exit(0)
}

const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString()
  .replace(/[:T]/g, '-')
  .slice(0, 19)
const bakPath = `${dbPath}.bak-clean-${stamp}`
fs.copyFileSync(dbPath, bakPath)
console.log(`已备份：${bakPath}`)

db.exec('BEGIN')
try {
  db.prepare(`DELETE FROM stock_take_items WHERE product_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM price_tiers WHERE product_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM purchase_order_items WHERE product_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM transactions WHERE product_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM inventory_batches WHERE product_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM products WHERE id IN (${ph})`).run(...ids)
  db.exec('COMMIT')
  const left = {
    products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
    batches: db.prepare('SELECT COUNT(*) AS n FROM inventory_batches').get().n,
    stock: db.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_batches').get().q,
    value: db.prepare('SELECT COALESCE(SUM(quantity * cost_price),0) AS v FROM inventory_batches').get().v,
  }
  console.log(`清理完成。剩余：商品 ${left.products} / 批次 ${left.batches} / 库存 ${left.stock} 件 / 库存价值 ${(left.value / 100).toFixed(2)} 元`)
} catch (e) {
  db.exec('ROLLBACK')
  console.error('清理失败已回滚：', e.message)
  process.exit(1)
} finally {
  db.close()
}
