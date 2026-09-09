#!/usr/bin/env node
// 清仓建议引擎（decision MVP-1）fixture 断言：校验 P0/P1/P2 判据、阈值、护栏、空库、与 dormant 同源、只读证明。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { openDatabase } from '../electron/db.js'
import * as cmd from '../electron/commands.js'

let passed = 0
const ok = (name, cond, extra) => { if (!cond) { console.error('X ' + name + (extra ? '  [' + extra + ']' : '')); process.exit(1) } passed++; console.log('OK ' + name) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clr-fi-'))
const dbPath = path.join(root, 'data.db')
const db = openDatabase(dbPath)
let bno = 0
const pad = (n) => String(n).padStart(2, '0')
const dstr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const dstrT = (d) => dstr(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
const offsetDate = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d }

function seedProduct(sku, category, costYuan, qty, opts = {}) {
  const unitCost = Math.round(costYuan * 100 / qty) // 单件成本分
  const p = cmd.createProduct(db, { sku_code: sku, barcode: null, category, brand: '牌', model: sku, cost_price: unitCost, suggest_price: null, location: null, status: '在售' })
  const expiry = opts.expiryInDays != null ? dstr(offsetDate(opts.expiryInDays)) : null
  bno++
  db.prepare('INSERT INTO inventory_batches(batch_no, product_id, quantity, cost_price, expiry_date, inbound_date) VALUES (?,?,?,?,?,?)').run('B-' + sku + '-' + bno, p.id, qty, unitCost, expiry, dstr(offsetDate(-30)))
  if (opts.clearance) db.prepare('UPDATE products SET is_clearance=1 WHERE id=?').run(p.id)
  if (opts.lastSaleDaysAgo != null) {
    const t = dstrT(offsetDate(-opts.lastSaleDaysAgo))
    db.prepare("INSERT INTO transactions(product_id,type,quantity,selling_price,unit_price,timestamp) VALUES (?,?,?,?,?,?)").run(p.id, 'out', (opts.qtySold || 1), unitCost, unitCost, t)
  }
  return p
}

seedProduct('CLR-A', '渔轮', 860, 20, { lastSaleDaysAgo: 200, expiryInDays: 23 })
seedProduct('CLR-B', '渔钩', 800, 20, { lastSaleDaysAgo: 200 })
seedProduct('CLR-C', '渔网', 800, 20, { lastSaleDaysAgo: 100, expiryInDays: 30 })
seedProduct('CLR-D', '鱼线', 300, 20, { lastSaleDaysAgo: 100 })
seedProduct('CLR-E', '鱼竿', 800, 20, { lastSaleDaysAgo: 5 })

db.close()

const fish = path.join(root, 'fishing-inventory')
fs.mkdirSync(fish, { recursive: true })
fs.copyFileSync(dbPath, path.join(fish, 'data.db'))
const sizeBeforeClear = fs.statSync(path.join(fish, 'data.db')).size

const script = path.resolve(process.cwd(), 'scripts/inv-analytics.mjs')
const run = spawnSync('node', [script, 'clearance'], { env: { ...process.env, APPDATA: root }, encoding: 'utf8' })
if (run.status !== 0) { console.error('clearance CLI 失败: ' + run.stderr); process.exit(1) }
const r = JSON.parse(run.stdout)

const itemA = r.items.find(x => x.name.includes('CLR-A'))
ok('A 判据 P0 + 区间[516,731]', itemA && itemA.priority === 'P0' && itemA.suggestRange && Math.abs(itemA.suggestRange.low - 516) <= 1 && Math.abs(itemA.suggestRange.high - 731) <= 1, JSON.stringify(itemA?.suggestRange))
const itemB = r.items.find(x => x.name.includes('CLR-B'))
ok('B 判据 P1（无到期）', itemB && itemB.priority === 'P1' && itemB.expiryInDays === null, JSON.stringify(itemB?.priority))
const itemC = r.items.find(x => x.name.includes('CLR-C'))
ok('C 判据 P1（滞销+临期30）', itemC && itemC.priority === 'P1' && itemC.expiryInDays === 30, JSON.stringify(itemC?.priority))
ok('D 压货<500 不出现', !r.items.some(x => x.name.includes('CLR-D')))
ok('E 近30天动销 不给P0', !r.items.some(x => x.name.includes('CLR-E')))

// ⑥ 空库无销售
const db2 = openDatabase(path.join(root, 'data-empty.db'))
const p2 = cmd.createProduct(db2, { sku_code: 'EMPTY-1', barcode: null, category: 'x', brand: 'x', model: 'x', cost_price: 1000, suggest_price: null, location: null, status: '在售' })
db2.prepare('INSERT INTO inventory_batches(batch_no, product_id, quantity, cost_price, expiry_date, inbound_date) VALUES (?,?,?,?,?,?)').run('B-EMPTY-1', p2.id, 5, 1000, null, dstr(offsetDate(-30)))
db2.prepare('DELETE FROM transactions').run() // 清空种子流水 → anySale=0，验证数据窗口不足
db2.close()
const fish2 = path.join(path.join(root, 'empty'), 'fishing-inventory'); fs.mkdirSync(fish2, { recursive: true })
fs.copyFileSync(path.join(root, 'data-empty.db'), path.join(fish2, 'data.db'))
const r2 = JSON.parse(spawnSync('node', [script, 'clearance'], { env: { ...process.env, APPDATA: path.join(root, 'empty') }, encoding: 'utf8' }).stdout)
ok('空库无销售 dataWindowOk=false', r2.dataWindowOk === false && r2.items.length === 0)

// ⑦ 与 dormant 同源
const d = JSON.parse(spawnSync('node', [script, 'dormant'], { env: { ...process.env, APPDATA: root }, encoding: 'utf8' }).stdout)
const dA = d.items.find(x => String(x.sku).includes('CLR-A'))
ok('金额与 dormant 同源', dA && Math.abs(parseFloat(dA.tiedCapital) - itemA.tiedCostYuan) <= 1, dA?.tiedCapital + ' vs ' + itemA?.tiedCostYuan)

// ⑧ 只读证明
const fs2 = fs.statSync(path.join(fish, 'data.db')).size
ok('只读证明（DB 大小不变）', fs2 === sizeBeforeClear, sizeBeforeClear + ' vs ' + fs2)

console.log('\n===== clearance fixture: ' + passed + ' passed =====')
process.exit(0)
