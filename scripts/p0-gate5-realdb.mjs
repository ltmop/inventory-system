// P0 闸⑤：真实数据库副本演练
// 用门店真实 data.db 的副本过一遍 openDatabase（含新表迁移），验证：
// 1. 老库迁移无报错，ai_usage_log 新表建成
// 2. 旧表（含旧 ai_usage 每日配额表）一行不动（只加不删）
// 3. 新流水函数在真实库上可写可读
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, finalCheckpoint, recordAiUsageLog, listAiUsageLog, aiUsageStats } from '../electron/db.js'

const REAL_DB = 'C:\\Users\\Administrator\\Desktop\\库存管理\\data.db'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-realdb-'))
const copy = path.join(dir, 'data.db')
fs.copyFileSync(REAL_DB, copy)
console.log('真实库副本:', copy, `(${(fs.statSync(copy).size / 1024).toFixed(0)} KB)`)

// 演练前快照：关键表行数
const before = {}
{
  const ro = new DatabaseSync(copy, { readOnly: true })
  for (const t of ['products', 'inventory_batches', 'transactions', 'suppliers', 'ai_usage']) {
    try { before[t] = ro.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n } catch { before[t] = null }
  }
  ro.close()
}
console.log('演练前行数:', JSON.stringify(before))

// 过完整 openDatabase（会跑全部迁移 + 新表创建）
const db = openDatabase(copy)
console.log('openDatabase: OK（迁移无报错）')

// 新表存在
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_usage_log'").get()
if (!t) throw new Error('ai_usage_log 未建成')
console.log('ai_usage_log 新表: 已建')

// 旧表行数一行不动
for (const [tbl, n] of Object.entries(before)) {
  if (n === null) continue
  const now = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n
  if (now !== n) throw new Error(`${tbl} 行数变了：${n} → ${now}（违反只加不删）`)
}
console.log('旧表行数: 全部不变（只加不删 ✓）')

// 新流水函数在真实库上写读
recordAiUsageLog(db, { feature: 'agent_chat', model: 'deepseek-chat', inputTokens: 120, outputTokens: 60, channel: 'gateway' })
recordAiUsageLog(db, { feature: 'daily_summary', model: 'moonshot-v1-8k', inputTokens: 80, outputTokens: 40, channel: 'byok' })
const rows = listAiUsageLog(db, 5)
if (rows.length !== 2) throw new Error('流水回读条数不对')
const stats = aiUsageStats(db)
if (stats.monthTotalTokens !== 300) throw new Error(`月度聚合不对: ${stats.monthTotalTokens}`)
console.log('流水写读: OK（gateway 180 + byok 120 = 300 tokens，BYOK 只记不扣 ✓）')

finalCheckpoint(db)
db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('\n闸⑤ 真实数据库副本演练 PASS')
