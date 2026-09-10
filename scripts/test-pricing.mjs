#!/usr/bin/env node
// 定价建议引擎（决策层 MVP-2）fixture 断言：
// 校验 P0/P1/P2 判据、建议区间数值、降档护栏、清仓互斥、无成本/无价跳过、
// 价格档参考、只读证明、以及「无销售无档案价」的不硬出。
// 口径锚点（与 electron/commands/analytics.js 一致，勿混）：
//   transactions.selling_price 在 type='out' 上是【实际成交价】（分）；unit_price 是【成本】（分）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { openDatabase } from '../electron/db.js'
import * as cmd from '../electron/commands.js'

let passed = 0
const ok = (name, cond, extra) => { if (!cond) { console.error('X ' + name + (extra ? '  [' + extra + ']' : '')); process.exit(1) } passed++; console.log('OK ' + name) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-fi-'))
const dbPath = path.join(root, 'data.db')
const db = openDatabase(dbPath)
let bno = 0
const pad = (n) => String(n).padStart(2, '0')
const dstr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const dstrT = (d) => dstr(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
const offsetDate = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d }

// unitCostYuan / sellYuan 均为「元」，内部转分
function seedPriced(sku, unitCostYuan, qty, opts = {}) {
  const costCents = Math.round(unitCostYuan * 100)
  const p = cmd.createProduct(db, { sku_code: sku, barcode: null, category: '定价', brand: '牌', model: sku, cost_price: costCents, suggest_price: null, location: null, status: '在售' })
  bno++
  db.prepare('INSERT INTO inventory_batches(batch_no, product_id, quantity, cost_price, expiry_date, inbound_date) VALUES (?,?,?,?,?,?)').run('B-' + sku + '-' + bno, p.id, qty, costCents, null, dstr(offsetDate(-30)))
  if (opts.clearance) db.prepare('UPDATE products SET is_clearance=1 WHERE id=?').run(p.id)
  if (opts.suggestYuan != null) db.prepare('UPDATE products SET suggest_price=? WHERE id=?').run(Math.round(opts.suggestYuan * 100), p.id)
  if (opts.sellYuan != null) {
    const t = dstrT(offsetDate(-(opts.daysAgo ?? 5)))
    db.prepare("INSERT INTO transactions(product_id,type,quantity,selling_price,unit_price,timestamp) VALUES (?,?,?,?,?,?)")
      .run(p.id, 'out', (opts.qtySold || 1), Math.round(opts.sellYuan * 100), costCents, t)
  }
  return p
}

// A: 成本100 卖80   -> margin -25%  -> P0 亏本（FLOOR 区间）
// B: 成本100 卖110  -> margin 9.09% -> P1 毛利偏低（RAISE 区间）
// C: 成本100 卖300  -> margin 66.67%，45天前成交（>30天护栏窗口）-> P2 可降价（CUT 区间）
// D: 成本100 卖300  -> margin 66.67%，5天前成交（护栏内）-> 不给降价建议
// E: 成本100 卖150  -> margin 33.33% -> 正常，不出现
// F: 成本100 卖300  -> 但已标记清仓 -> 交给清仓引擎，不出现
// G: 成本0          -> 无成本，跳过
const pA = seedPriced('PRC-A', 100, 10, { sellYuan: 80, daysAgo: 5 })
const pB = seedPriced('PRC-B', 100, 10, { sellYuan: 110, daysAgo: 5 })
const pC = seedPriced('PRC-C', 100, 10, { sellYuan: 300, daysAgo: 45 })
const pD = seedPriced('PRC-D', 100, 10, { sellYuan: 300, daysAgo: 5 })
const pE = seedPriced('PRC-E', 100, 10, { sellYuan: 150, daysAgo: 10 })
seedPriced('PRC-F', 100, 10, { sellYuan: 300, daysAgo: 45, clearance: true })
seedPriced('PRC-G', 0, 10, { sellYuan: 300, daysAgo: 45 })
// 价格档：C 的批发档 50 元低于成本 100 元 -> 应出现在 tiers 且 reason 提醒
// tier 取值受 CHECK 约束: retail|regular|VIP|wholesale|promo
db.prepare('INSERT INTO price_tiers(product_id, tier, price) VALUES (?,?,?)').run(pC.id, 'wholesale', 5000)

db.close()

const fish = path.join(root, 'fishing-inventory')
fs.mkdirSync(fish, { recursive: true })
fs.copyFileSync(dbPath, path.join(fish, 'data.db'))
const sizeBefore = fs.statSync(path.join(fish, 'data.db')).size

const script = path.resolve(process.cwd(), 'scripts/inv-analytics.mjs')
const run = spawnSync('node', [script, 'pricing'], { env: { ...process.env, APPDATA: root }, encoding: 'utf8' })
if (run.status !== 0) { console.error('pricing CLI 失败: ' + run.stderr); process.exit(1) }
const r = JSON.parse(run.stdout)

const get = (sku) => r.items.find((x) => x.name.includes(sku))

// ① P0 亏本在售 + FLOOR 区间 = 成本 × [1.05, 1.15]
const a = get('PRC-A')
ok('A 判据 P0 亏本 + 区间[105,115]', a && a.priority === 'P0' && a.suggestRange && Math.abs(a.suggestRange.low - 105) <= 0.01 && Math.abs(a.suggestRange.high - 115) <= 0.01, JSON.stringify(a?.suggestRange))
ok('A 毛利率口径 = -25%（成交价80 vs 成本100）', a && Math.abs(a.marginPct - (-25)) <= 0.01, String(a?.marginPct))

// ② P1 毛利偏低 + RAISE 区间 = 成本 × [1.35, 1.60]
const b = get('PRC-B')
ok('B 判据 P1 毛利偏低 + 区间[135,160]', b && b.priority === 'P1' && Math.abs(b.suggestRange.low - 135) <= 0.01 && Math.abs(b.suggestRange.high - 160) <= 0.01, JSON.stringify(b?.suggestRange))
ok('B 毛利率 9.09% < 下限 15%', b && Math.abs(b.marginPct - 9.09) <= 0.02, String(b?.marginPct))

// ③ P2 毛利偏高且不动销 + CUT 区间 = 成本 × [1.10, 1.25]
const c = get('PRC-C')
ok('C 判据 P2 可降价促动销 + 区间[110,125]', c && c.priority === 'P2' && Math.abs(c.suggestRange.low - 110) <= 0.01 && Math.abs(c.suggestRange.high - 125) <= 0.01, JSON.stringify(c?.suggestRange))
ok('C 近30天无动销(recentOut30=0)', c && c.recentOut30 === 0, String(c?.recentOut30))

// ④ 降档护栏：D 毛利同样 66.67% 但近30天有动销 -> 不给降价建议
ok('D 护栏：近30天动销不给降价建议（不在候选内）', !get('PRC-D'))
ok('D 计入 skipped.guardMove', r.skipped.guardMove >= 1, JSON.stringify(r.skipped))

// ⑤ 正常毛利带内不出现
ok('E 毛利率 33% 正常 -> 不出现', !get('PRC-E'))
ok('E 计入 skipped.normal', r.skipped.normal >= 1, String(r.skipped.normal))

// ⑥ 清仓品互斥：交给清仓引擎，不重复给建议
ok('F 已标记清仓 -> 定价引擎不重复建议', !get('PRC-F'))
ok('F 计入 skipped.clearance', r.skipped.clearance >= 1, String(r.skipped.clearance))

// ⑦ 无成本跳过
ok('G 无成本 -> 跳过', !get('PRC-G'))
ok('G 计入 skipped.noCost', r.skipped.noCost >= 1, String(r.skipped.noCost))

// ⑧ 价格档带出 + 低于成本有提醒
ok('C 带出价格档 tiers(wholesale)', c && Array.isArray(c.tiers) && c.tiers.length === 1 && c.tiers[0].tier === 'wholesale', JSON.stringify(c?.tiers))
ok('C 价格档低于成本 -> reason 有提醒', c && c.reason.some((x) => String(x).includes('wholesale') && String(x).includes('低于成本')), JSON.stringify(c?.reason))

// ⑨ 证据强度与阈值自描述
ok('basis=sales（有带售价成交）', r.basis === 'sales' && r.dataWindowOk === true, String(r.basis))
ok('thresholds 暴露护栏常量(0.15/0.6/30)', r.thresholds && r.thresholds.minMargin === 0.15 && r.thresholds.maxMargin === 0.6 && r.thresholds.guardMoveDays === 30, JSON.stringify(r.thresholds))

// ⑩ avgMarginPct 与 items 自洽
const mean = Math.round((r.items.reduce((s, i) => s + i.marginPct, 0) / r.items.length) * 100) / 100
ok('avgMarginPct 与 items 自洽', Math.abs(r.avgMarginPct - mean) <= 0.01, r.avgMarginPct + ' vs ' + mean)

// ⑪ 优先级排序：P0 在 P1 之前，P1 在 P2 之前
const rank = { P0: 0, P1: 1, P2: 2 }
ok('items 按 P0>P1>P2 排序', r.items.every((it, i) => i === 0 || rank[r.items[i - 1].priority] <= rank[it.priority]))

// ⑫ 只读证明（DB 大小不变）
const sizeAfter = fs.statSync(path.join(fish, 'data.db')).size
ok('只读证明（DB 大小不变）', sizeAfter === sizeBefore, sizeBefore + ' vs ' + sizeAfter)

// ⑬ 既无带价销售、也无档案价 -> 不硬出
const db2 = openDatabase(path.join(root, 'data-empty.db'))
db2.prepare('DELETE FROM transactions').run()
db2.prepare('UPDATE products SET suggest_price = 0').run()
db2.close()
const fish2 = path.join(path.join(root, 'empty'), 'fishing-inventory')
fs.mkdirSync(fish2, { recursive: true })
fs.copyFileSync(path.join(root, 'data-empty.db'), path.join(fish2, 'data.db'))
const r2 = JSON.parse(spawnSync('node', [script, 'pricing'], { env: { ...process.env, APPDATA: path.join(root, 'empty') }, encoding: 'utf8' }).stdout)
ok('无销售且无档案价 -> dataWindowOk=false 且不硬出', r2.dataWindowOk === false && r2.basis === 'none' && r2.items.length === 0, r2.basis + '/' + r2.items.length)

// ⑭ 无销售但档案价可用 -> 降级为 catalog 口径而非空手而归
const db3 = openDatabase(path.join(root, 'data-cat.db'))
db3.prepare('DELETE FROM transactions').run()
db3.prepare("UPDATE products SET suggest_price = 10000 WHERE cost_price > 0").run()
db3.close()
const fish3 = path.join(path.join(root, 'cat'), 'fishing-inventory')
fs.mkdirSync(fish3, { recursive: true })
fs.copyFileSync(path.join(root, 'data-cat.db'), path.join(fish3, 'data.db'))
const r3 = JSON.parse(spawnSync('node', [script, 'pricing'], { env: { ...process.env, APPDATA: path.join(root, 'cat') }, encoding: 'utf8' }).stdout)
ok('无销售但有档案价 -> basis=catalog 且 dataWindowOk=false', r3.basis === 'catalog' && r3.dataWindowOk === false, String(r3.basis))

console.log('\n===== pricing fixture: ' + passed + ' passed =====')
process.exit(0)
