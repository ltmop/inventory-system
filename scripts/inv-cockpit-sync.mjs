#!/usr/bin/env node
// 进销存实时数据同步器：调用 inv-analytics 读取真实经营数据 → 更新驾驶舱数据源 MD。
// 让驾驶舱 overview / 任务看板看到的是实时数据，而不是手动快照。
// 用法：node scripts/inv-cockpit-sync.mjs [--db 数据库路径]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ANALYTICS = path.join(__dirname, 'inv-analytics.mjs')

// 驾驶舱数据源文件（与 config.json dataSources.inventory 指向一致）
const COCKPIT_FILE = process.env.COCKPIT_INV_FILE || 'D:\\A1-AI知识库\\42-跨境电商运营\\库存经营数据.md'
// 业务真实进度（驾驶舱「首单」卡片数据源）：首单状态自动同步为数据库实时判定
const PROGRESS_FILE = process.env.COCKPIT_PROGRESS_FILE || 'D:\\A1-AI知识库\\11-运营体系\\业务真实进度.md'

function runAnalytics(cmd, args = []) {
  const out = execFileSync(process.execPath, [ANALYTICS, cmd, ...args], { encoding: 'utf8' }).trim()
  return JSON.parse(out)
}

function fmt(n) {
  // 已是元字符串或数字
  if (typeof n === 'string') return n
  return Number(n).toFixed(2)
}

try {
  const overview = runAnalytics('overview')
  const stock = runAnalytics('stock')
  const firstSale = runAnalytics('first-sale')
  const customers = runAnalytics('customers')

  const now = new Date()
  const ts = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')

  // 低库存：stock.lowStock 数量
  const lowCount = stock.lowStock.length
  // 零库存
  const zeroCount = stock.lowStock.filter(x => x.stock <= 0).length
  // 首单状态
  const firstStatus = firstSale.hasFirstSale ? '✅ 已出（' + (firstSale.firstSaleAt || '') + '，累计 ' + firstSale.outCount + ' 单）' : '❌ 未出'

  const md = `---
tags: [库存, 进销存, 驾驶舱]
分类: D:
状态: 进行中
---

# 库存经营数据

> 来源：进销存本地数据库（inv-analytics 实时读取，非手动快照）
> 数据时间：${ts}

## 经营总览

| 指标 | 当前 | 口径 |
|---|---|---|
| 在库商品 SKU | ${overview.productCount} | products 表计数 |
| 库存总件数 | ${overview.stock.qty} | inventory_batches 求和 |
| 库存成本金额(元) | ${overview.stock.value} | SUM(stock*cost_price)/100 |
| 今日销售额(元) | ${overview.today.revenue} | transactions type=out |
| 今日毛利(元) | ${overview.today.profit} | selling_price - unit_price |
| 本月销售额(元) | ${overview.month.revenue} | 当月 type=out |
| 本月毛利(元) | ${overview.month.profit} | 当月毛利 |
| 累计销售额(元) | ${overview.total.revenue} | 全部 type=out |
| 首单状态 | ${firstStatus} | first-sale |

## 库存健康

| 指标 | 数量 | 说明 |
|---|---|---|
| 低库存商品 | ${lowCount} | stock < min_stock |
| 零库存商品 | ${zeroCount} | stock <= 0 |
| 临期商品 | ${stock.expiring.length} | 30 天内到期 |
| 滞销SKU(有库存零销售) | ${stock.slowMoving.length} | 90 天无出库 |

## 客户欠款 Top 5

${customers.slice(0, 5).map(c => '- ' + c.name + '：欠 ' + c.debt + ' 元').join('\n') || '（无欠款客户）'}

---
`

  fs.mkdirSync(path.dirname(COCKPIT_FILE), { recursive: true })
  fs.writeFileSync(COCKPIT_FILE, md, 'utf8')

  // 同步「业务真实进度.md」的首单状态（驾驶舱首单卡片数据源）
  // 首单完成依据 = 进销存数据库存在 type=out 销售记录（实时判定，非手动改）
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      let pmd = fs.readFileSync(PROGRESS_FILE, 'utf8')
      const firstNew = firstSale.hasFirstSale
        ? '| 首单 | ✅ 完成 | ' + (firstSale.firstSaleAt || '') + ' 首单已出，累计 ' + firstSale.outCount + ' 单 | — |'
        : '| 首单 | ❌ 未出 | 进销存数据库暂无销售记录（实时判定） | — |'
      if (pmd.includes('| 首单 |')) {
        pmd = pmd.replace(/\|\s*首单\s*\|.*/, firstNew)
      } else {
        pmd += '\n' + firstNew + '\n'
      }
      fs.writeFileSync(PROGRESS_FILE, pmd, 'utf8')
      console.log('OK 业务真实进度首单状态已同步: ' + firstStatus)
    }
  } catch (e) {
    console.log('WARN 业务进度同步跳过: ' + e.message)
  }

  console.log('OK 驾驶舱数据源已更新: ' + COCKPIT_FILE)
  console.log('  数据时间: ' + ts)
  console.log('  首单: ' + firstStatus)
  console.log('  库存: ' + overview.stock.qty + ' 件 / ' + overview.stock.value + ' 元')
  console.log('  本月销售: ' + overview.month.revenue + ' 元 / 毛利 ' + overview.month.profit + ' 元')
} catch (e) {
  console.error('ERR: ' + e.message)
  process.exit(1)
}
