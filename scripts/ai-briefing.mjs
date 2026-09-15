#!/usr/bin/env node
// AI 简报试算（**只算不推**）——把"这周该动手的事"用店里真实数据算出来，打印给人看。
//
// 用法：
//   node scripts/ai-briefing.mjs                     # 本机库（%APPDATA%\fishing-inventory\data.db）
//   node scripts/ai-briefing.mjs --db <path>          # 别的库（例如从中心库拉的只读快照）
//   node scripts/ai-briefing.mjs --json               # 结构化结果（给后续推送用）
//
// 安全：**只读打开**（readOnly: true），不写一个字节、不发网络。
// 口径：全部来自 electron/commands/ —— 低库存用 reports.lowStockProducts，
//       营业额/毛利用 analytics 头部那三行公式；本脚本只排版，不做业务判断。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const asJson = args.includes('--json')

const dbPath = argVal('--db') || path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'fishing-inventory', 'data.db')
if (!fs.existsSync(dbPath)) { console.error('找不到数据库：' + dbPath); process.exit(2) }

const { DatabaseSync } = await import('node:sqlite')
const { buildBriefing } = await import(pathToFileURL(path.join(REPO, 'electron', 'commands', 'briefing.js')).href)

const db = new DatabaseSync(dbPath, { readOnly: true })
const b = buildBriefing(db)

if (asJson) {
  console.log(JSON.stringify(b, null, 2))
  db.close()
  process.exit(0)
}

const money = (cents) => '¥' + (cents / 100).toFixed(2)
const L = []
const p = (s = '') => L.push(s)

p('════════ 本周该做什么（试算稿 · 没有推送给任何人）════════')
p('数据来源：' + dbPath)
p('生成时间：' + b.generatedAt.replace('T', ' ').slice(0, 19))
p('')
p('【数据体检】真实零售（有售价的出库）共 ' + b.data.retailSalesTotal + ' 笔'
  + (b.data.lastRetailAt ? '，最后一笔在 ' + String(b.data.lastRetailAt).slice(0, 10) + '（' + b.data.daysSinceLastSale + ' 天前）' : '（一笔都没有）'))
p('【结论】' + b.headline)

// ---- ① 账对不上：**永远都显示**（它不需要零售数据，是今天就能修的事）----
p('')
p('━━ ① 账对不上（先修这个）━━')
let any1 = false
if (b.stock.negative.length) {
  any1 = true
  p('  负库存 ' + b.stock.negative.length + ' 个：')
  for (const r of b.stock.negative.slice(0, 5)) p('    · ' + [r.brand, r.model].filter(Boolean).join(' ') + '（' + r.sku_code + '）' + r.stock + ' 件 → 查出入库记录，先补回非负')
}
if (b.stock.outNoBatch.length) {
  any1 = true
  p('  卖过但从没有入库批次 ' + b.stock.outNoBatch.length + ' 个：')
  for (const r of b.stock.outNoBatch.slice(0, 5)) p('    · ' + [r.brand, r.model].filter(Boolean).join(' ') + '（' + r.sku_code + '）出过 ' + r.outCount + ' 次 → 补入库，或确认是赠送/样品')
}
if (b.stock.take) {
  const t = b.stock.take
  p('  最近一次盘点 ' + (t.take_no ?? '#' + t.id) + '：状态「' + (t.status ?? '?') + '」，共 ' + t.totalItems + ' 项，已盘 ' + t.counted + ' 项' + (t.notCounted ? '，**还有 ' + t.notCounted + ' 项没盘**' : ''))
  if (t.diffCount) {
    any1 = true
    p('  已盘出的差异 ' + t.diffCount + ' 项，最大的几条：')
    for (const r of t.items.slice(0, 5)) p('    · ' + [r.brand, r.model].filter(Boolean).join(' ') + '：账面 ' + r.system_qty + ' → 实盘 ' + r.actual_qty + (r.reason ? '（' + r.reason + '）' : ''))
  } else if (t.counted === 0) {
    any1 = true   // 「还没开始盘」本身就是待办
    p('    （不是"没差异"，是**还没开始盘** —— 这一条本身就是待办）')
  }
}
if (b.stock.channelZero.length) {
  any1 = true
  const shipped = b.stock.channelZero.reduce((s, r) => s + r.shipped, 0)
  p('  渠道商品账上没库存也没成本 ' + b.stock.channelZero.length + ' 个（共发货 ' + shipped + ' 件）：')
  for (const r of b.stock.channelZero.slice(0, 3)) p('    · ' + [r.brand, r.model].filter(Boolean).join(' ') + '：库存 ' + r.stock + '、货值 ' + money(r.value) + '，已发 ' + r.shipped + ' 件')
  p('    → 这些货在优选仓，本机账里既没库存也没价值：跨境那部分的账目前在系统里是空的')
}
if (!any1) p('  没发现账对不上的地方 ✓')

// ---- ②③：只有"数据够"时才出建议；不够就说清为什么，不出 ----
if (!b.data.enough) {
  p('')
  p('━━ ② 该补货 / ③ 毛利异常：**这次不出建议** ━━')
  p('  原因：')
  for (const r of b.data.reasons) p('    · ' + r)
  p('  → 这三条不是"没发现问题"，是"现在的数据回答不了"。先解决数据，再说自动化。')
} else {
  p('')
  p('━━ ② 该补货（低库存 ∩ 近 ' + b.restock.windowDays + ' 天有**真实零售**）━━')
  if (b.restock.needs.length) {
    for (const r of b.restock.needs.slice(0, 10)) {
      p('  · ' + r.name + '：现有 ' + r.stock + '（预警线 ' + r.threshold + '），近 ' + b.restock.windowDays + ' 天零售 ' + r.soldInWindow + ' 件（日均 ' + r.dailyAvg + '）')
      p('      → 补 ' + r.suggestQty + ' 件（补到够卖 ' + r.coverDays + ' 天）' + (r.location ? '  货位 ' + r.location : ''))
    }
  } else p('  没有"既缺货又有零售动销"的商品。')
  if (b.restock.lowButSlow.length) {
    p('  ⚠️ ' + b.restock.lowButSlow.length + ' 个低于预警线但近 ' + b.restock.windowDays + ' 天没有零售 —— **不建议补**，该考虑清仓：')
    for (const r of b.restock.lowButSlow.slice(0, 5)) p('    · ' + r.name + '：库存 ' + r.stock + ' / 预警线 ' + r.threshold)
  }
  if (b.restock.channelOnly.length) {
    p('  ⚠️ ' + b.restock.channelOnly.length + ' 个只发过优选仓、没有零售记录 —— 该不该补取决于优选仓那边卖了多少，**本机看不到**，所以不替你决定：')
    for (const r of b.restock.channelOnly.slice(0, 5)) p('    · ' + r.name + '：库存 ' + r.stock + '，近 ' + b.restock.windowDays + ' 天发走 ' + r.shippedInWindow + ' 件')
  }

  p('')
  p('━━ ③ 单品毛利异常（近 ' + b.margin.windowDays + ' 天 vs 前 ' + b.margin.windowDays + ' 天）━━')
  if (b.margin.anomalies.length) {
    for (const m of b.margin.anomalies.slice(0, 8)) {
      p('  · ' + m.name + '：毛利率 ' + m.prevRate + '% → ' + m.recentRate + '%（降 ' + m.dropPoints + ' 个点）')
      p('      → 核一下是降价卖了，还是成本涨了没改售价')
    }
  } else {
    p('  没有可比对的单品（可比 ' + b.margin.comparedCount + ' 个）。**这不等于没问题** —— 是样本还不够。')
  }
}

p('')
p('────────────────────────────────────────────')
p('本次没有向任何人推送任何消息（按你的选择：先只算不推）。')
p('请只看三件事：①准不准 ②有没有"必须今天动手"的紧迫感 ③会不会太吵。')

console.log(L.join('\n'))
db.close()
