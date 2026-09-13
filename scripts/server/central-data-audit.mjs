// 中央库数据体检（只读）：回答「中央库到底有哪些数据、缺哪些」
//
// 为什么需要它：台账 line 104 指定「中央库是首单判定唯一权威口」，而首单北极星判据是
//   `type=out 且 selling_price>0 且 channel='Shopee'`
// 如果中央库里根本没有门店的真实零售数据，这个判据**永远不可能翻转** ——
// 而且它看起来一切正常（判据为 0 会被当成「首单未出」，而不是「判据读不到数据」）。
// 所以必须先量出来缺什么，才能判断「首单未出」是真的没成交，还是判据根本没接上数据。
//
// 跑法（服务器上）：
//   /opt/node22/bin/node --experimental-sqlite /opt/inventory-app/central-data-audit.mjs
// 跑法（本机任意库）：
//   node scripts/server/central-data-audit.mjs --db <path>
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const i = argv.indexOf('--db')
const DB = i >= 0 && argv[i + 1]
  ? path.resolve(argv[i + 1])
  : '/opt/inventory-app/data/data.db'

if (!fs.existsSync(DB)) { console.error('找不到库：' + DB); process.exit(1) }
const db = new DatabaseSync(DB, { readOnly: true })
const q = (sql) => db.prepare(sql).all()

console.log('库: ' + DB)
console.log('大小: ' + fs.statSync(DB).size + ' 字节')
console.log('integrity_check: ' + Object.values(db.prepare('PRAGMA integrity_check').get())[0])
console.log('')

const tables = q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name)
console.log('=== 表与行数（' + tables.length + ' 张）===')
for (const t of tables) {
  let n = '?'
  try { n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n } catch {}
  console.log('  ' + t.padEnd(28) + String(n).padStart(8))
}

console.log('\n=== 关键业务表：是「真空」还是「没接上」===')
const KEY = ['customers', 'payments', 'supplier_payments', 'transactions', 'products', 'inventory_batches', 'expenses', 'purchase_orders']
for (const t of KEY) {
  if (!tables.includes(t)) { console.log('  ' + t.padEnd(20) + ' 表不存在'); continue }
  const n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n
  console.log('  ' + t.padEnd(20) + String(n).padStart(8) + (n === 0 ? '   ← 空' : ''))
}

if (tables.includes('transactions')) {
  console.log('\n=== transactions 构成 ===')
  for (const r of q("SELECT type, COUNT(*) n FROM transactions GROUP BY type ORDER BY n DESC")) {
    console.log('  type=' + String(r.type).padEnd(5) + String(r.n).padStart(6))
  }
  const out = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out'").get().n
  const outAmt = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND selling_price > 0").get().n
  const shopee = tables.includes('transactions') && db.prepare("PRAGMA table_info(transactions)").all().some((c) => c.name === 'channel')
    ? db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND selling_price > 0 AND channel='Shopee'").get().n
    : null
  console.log('\n=== 首单北极星判据实测 ===')
  console.log('  出库流水                      : ' + out)
  console.log('  其中 售价>0                   : ' + outAmt)
  console.log('  判据 `出库 且 售价>0 且 Shopee`: ' + (shopee === null ? '（无 channel 列，判据不成立）' : shopee))
  console.log('  去渠道条件（会被误判成已出）  : ' + outAmt)
  console.log('\n=== 出库流水按 operator 分布（看数据是怎么进来的）===')
  for (const r of q("SELECT COALESCE(operator,'(空)') op, COUNT(*) n FROM transactions WHERE type='out' GROUP BY op ORDER BY n DESC LIMIT 10")) {
    console.log('  ' + String(r.op).padEnd(30) + String(r.n).padStart(6))
  }
  const last = db.prepare("SELECT MAX(timestamp) t FROM transactions").get().t
  console.log('\n最新一笔流水时间: ' + last)
}

if (tables.includes('customers')) {
  const c = db.prepare('SELECT COUNT(*) n FROM customers').get().n
  console.log('\n=== 客户/应收 ===')
  console.log('  客户数: ' + c + (c === 0 ? '   ← 赊账/应收完全没接上' : ''))
}

console.log('\n（只读，未改动任何数据）')
db.close()
