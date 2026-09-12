#!/usr/bin/env node
/**
 * 多端同步就绪迁移  加 guid / updated_at（纯增量、可回滚、默认只读）
 *
 * 背景：要让两台电脑的数据能合并，必须先解决「主键冲突」
 *   现有所有业务表是 INTEGER PRIMARY KEY AUTOINCREMENT，
 *   A 机新单 id=371 与 B 机新单 id=371 是两条不同记录，按 id 合并必然串数据。
 *
 * 本脚本采取**最小侵入**方案（经盘点确认外键网以 products 为中心，整数 id 牵一发动全身）：
 *    不动任何现有整数 id 列，也不动任何外键  现有查询/FK 全部照旧，零回归风险
 *    只新增两列：guid（全局唯一标识，同步用）、updated_at（冲突判定用）
 *    回填历史数据 + 建唯一索引
 * 迁移后，"谁是谁"由 guid 决定，"谁新"由 updated_at 决定，整数 id 退化为纯本机内部编号。
 *
 * 用法：
 *   node scripts/migrate-sync-readiness.mjs                # 只读盘点（默认，不改任何东西）
 *   node scripts/migrate-sync-readiness.mjs --plan          # 打印将要执行的 DDL 清单
 *   node scripts/migrate-sync-readiness.mjs --apply --yes   # 真正执行（先整库备份！务必先关闭客户端）
 *
 * 安全铁律：
 *   1) 默认模式只以 readOnly 打开数据库，不写一个字节
 *   2) --apply 会强制先做整库文件备份，再在**单个事务**内执行，失败整体回滚
 *   3) --apply 要求显式 --yes，且要求你已关闭客户端（脚本无法可靠探测，交给你确认）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

// ---------- 哪些表参与多端同步 ----------
const SYNCABLE = [
  'products', 'inventory_batches', 'transactions', 'stock_takes', 'stock_take_items',
  'categories', 'units', 'suppliers', 'customers', 'payments', 'expenses',
  'purchase_orders', 'purchase_order_items', 'price_tiers', 'kits', 'kit_items',
  'supplier_payments', 'waste_logs', 'payment_registers',
]
// 明确不同步（本机属性 / 无主键 / 按设备计费） 写清理由，避免以后被"顺手同步"埋雷
const NOT_SYNCED = {
  audit_log: '本机审计留痕，不应跨设备混合',
  ai_messages: 'AI 对话上下文，属本机会话',
  ai_insights: 'AI 生成结果，本机可重算',
  ai_usage: 'AI 用量计费，按设备计数',
  ai_usage_log: '同上',
  users: '本机员工登录表，后续由 tenant_members 取代（阶段二）',
  settings: 'key-value 无主键；license_level 绝不能同步，其余 key 需逐个裁定',
}

// ---------- updated_at 的历史回填来源（按盘点结果） ----------
// 本身没有时间列的表：从父表继承（否则一律回落"迁移时刻"，会让历史数据在冲突中错误地获胜）
const UPDATED_AT_PARENT = {
  stock_take_items:   { via: 'stock_take_id', parent: 'stock_takes',    col: 'started_at' },
  purchase_order_items: { via: 'po_id',       parent: 'purchase_orders', col: 'created_at' },
  kit_items:          { via: 'kit_id',       parent: 'kits',           col: 'created_at' },
}
const UPDATED_AT_SOURCE = {
  transactions: 'timestamp',
  inventory_batches: 'created_at',
  stock_takes: 'started_at',
  stock_take_items: null, // 无任何时间列  从父表 stock_takes.started_at 继承
  categories: 'created_at',
  units: 'created_at',
  suppliers: 'created_at',
  customers: 'created_at',
  payments: 'created_at',
  expenses: 'created_at',
  purchase_orders: 'created_at',
  purchase_order_items: null,
  price_tiers: null,
  kits: 'created_at',
  kit_items: null,
  supplier_payments: null,
  waste_logs: null,
  payment_registers: null,
  products: 'updated_at', // 已有，无需回填
}

function uuid() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** 把各种历史时间格式统一成 ISO-8601 UTC（Z 结尾）必须统一，否则"谁新谁赢"会判错 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function normalizeTs(v) {
  if (!v) return null
  const s = String(v).trim()
  if (!s) return null
  // 已是 ISO 带时区
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return s
  // SQLite "YYYY-MM-DD HH:MM:SS"  按本机本地时间解释（历史数据是本地时钟写入的）
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  // 仅日期
  const d2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (d2) {
    const d = new Date(Number(d2[1]), Number(d2[2]) - 1, Number(d2[3]))
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  return null // 无法解析  由调用方决定兜底
}

function resolveDbPath(argv) {
  const i = argv.indexOf('--db')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'fishing-inventory', 'data.db')
}

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const PLAN = argv.includes('--plan') || APPLY
const YES = argv.includes('--yes')
const DB = resolveDbPath(argv)

if (!fs.existsSync(DB)) {
  console.error('找不到数据库: ' + DB)
  process.exit(1)
}

console.log('数据库: ' + DB)
console.log('模式: ' + (APPLY ? '【执行迁移】' : '【只读盘点  不改任何数据】'))
console.log('')

// ---- 收集计划 ----
function collectPlan(db) {
  const plan = []
  for (const t of SYNCABLE) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
    if (!exists) continue
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name)
    const n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n
    const needGuid = !cols.includes('guid')
    const needUpd = !cols.includes('updated_at')
    const src = UPDATED_AT_SOURCE[t] ?? null
    const canSrc = src && cols.includes(src)
    // 时间格式体检
    let fmtBad = 0, needsNorm = 0, tsNull = 0
    if (needUpd && canSrc) {
      for (const r of db.prepare(`SELECT "${src}" v FROM "${t}"`).all()) {
        if (r.v === null || r.v === '') { tsNull++; continue }
        const canon = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
        if (!normalizeTs(r.v)) { fmtBad++; continue }
        if (!canon.test(String(r.v).trim())) needsNorm++
      }
    }
    // 无时间列的表：从父表继承（避免这批历史数据全变成"迁移时刻"而在冲突中永远赢）
    const parentSrc = UPDATED_AT_PARENT[t] || null
    plan.push({ t, n, needGuid, needUpd, src: canSrc ? src : null, parentSrc, fmtBad, needsNorm, tsNull })  }
  return plan
}

const db = new DatabaseSync(DB, { readOnly: !APPLY })
const plan = collectPlan(db)

console.log('表名'.padEnd(24) + '行数'.padStart(7) + '  加guid  加updated_at  回填来源        时间格式异常')
console.log('-'.repeat(104))
let totRows = 0, totGuid = 0, totUpd = 0, totBad = 0
for (const p of plan) {
  totRows += p.n
  if (p.needGuid) totGuid++
  if (p.needUpd) totUpd++
  totBad += p.needsNorm
  console.log(
    p.t.padEnd(24) + String(p.n).padStart(7) + '  ' +
    (p.needGuid ? '  需加 ' : '  已有 ').padEnd(8) +
    (p.needUpd ? '     需加     ' : '     已有     ') +
    (p.needUpd ? (p.src || '(无用父表/迁移时刻)').padEnd(16) : '(已有)'.padEnd(16)) +
    (p.needUpd ? String(p.needsNorm) : '-')
  )
}
console.log('-'.repeat(104))
console.log(`参与同步的表 ${plan.length} 张 / 共 ${totRows} 行；需加 guid 的 ${totGuid} 张，需加 updated_at 的 ${totUpd} 张`)
console.log(`需规范化时间格式的记录 ${totBad} 条（ISO 与 SQLite 两种格式混用，不统一会让"谁新谁赢"判错）`)
console.log('')
console.log('明确不参与同步的表（写清理由，避免以后被顺手同步）：')
for (const [k, v] of Object.entries(NOT_SYNCED)) console.log(`   ${k.padEnd(20)} ${v}`)

if (PLAN && !APPLY) {
  console.log('\n--- 将要执行的 DDL（逐表） ---')
  for (const p of plan) {
    if (p.needGuid) {
      console.log(`ALTER TABLE "${p.t}" ADD COLUMN guid TEXT;`)
      console.log(`UPDATE "${p.t}" SET guid = <uuid> WHERE guid IS NULL;   -- ${p.n} 行`)
      console.log(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_${p.t}_guid" ON "${p.t}"(guid);`)
    }
    if (p.needUpd) {
      console.log(`ALTER TABLE "${p.t}" ADD COLUMN updated_at TEXT;        -- 回填来源: ${p.src || '父表/迁移时刻'}`)
      console.log(`UPDATE "${p.t}" SET updated_at = <规范化ISO> WHERE updated_at IS NULL;`)
    }
  }
}

if (!APPLY) {
  db.close()
  console.log('\n（只读盘点结束，未改动任何数据。真正执行请加 --apply --yes，并先关闭客户端）')
  process.exit(0)
}

// ---------- 以下为执行分支（--apply --yes） ----------
if (!YES) { console.error('\n拒绝执行：--apply 必须同时带 --yes（且请先关闭客户端）'); process.exit(2) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${DB}.bak-preguid-${stamp}`
fs.copyFileSync(DB, backup)
console.log('\n已整库备份: ' + backup)

db.exec('PRAGMA foreign_keys=OFF')
db.exec('BEGIN IMMEDIATE')
try {
  for (const p of plan) {
    if (p.needGuid) {
      db.exec(`ALTER TABLE "${p.t}" ADD COLUMN guid TEXT`)
      const rows = db.prepare(`SELECT rowid AS rid FROM "${p.t}" WHERE guid IS NULL`).all()
      const up = db.prepare(`UPDATE "${p.t}" SET guid = ? WHERE rowid = ?`)
      for (const r of rows) up.run(uuid(), r.rid)
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_${p.t}_guid" ON "${p.t}"(guid)`)
      console.log(`  ${p.t}: guid 回填 ${rows.length} 行`)
    }
    if (p.needUpd) {
      db.exec(`ALTER TABLE "${p.t}" ADD COLUMN updated_at TEXT`)
      // 有自身时间列  用它；没有  从父表继承；都没有  回落迁移时刻
      const rows = p.parentSrc
        ? db.prepare(
            `SELECT c.rowid AS rid, p."${p.parentSrc.col}" AS v FROM "${p.t}" c
             LEFT JOIN "${p.parentSrc.parent}" p ON c."${p.parentSrc.via}" = p.id
             WHERE c.updated_at IS NULL`
          ).all()
        : db.prepare(
            `SELECT rowid AS rid, ${p.src ? `"${p.src}" AS v` : 'NULL AS v'} FROM "${p.t}" WHERE updated_at IS NULL`
          ).all()
      const now = new Date().toISOString()
      const up = db.prepare(`UPDATE "${p.t}" SET updated_at = ? WHERE rowid = ?`)
      let fellBack = 0
      for (const r of rows) {
        const ts = normalizeTs(r.v)
        if (!ts) fellBack++
        up.run(ts || now, r.rid)
      }
      const from = p.parentSrc ? `父表 ${p.parentSrc.parent}.${p.parentSrc.col}` : (p.src || '迁移时刻')
      console.log(`  ${p.t}: updated_at 回填 ${rows.length} 行（来源 ${from}${fellBack ? `；${fellBack} 行无可用时间迁移时刻` : ''}）`)
    }
  }
  // 迁移后自检：guid 不允许为空/重复
  // ---- 规范化：把历史遗留的非 ISO updated_at 统一成 ISO ----
  // 必需：products 等表本来就有 updated_at，其中混着 SQLite 格式（如 "2026-08-10 11:04:13"），
  // 与 ISO 格式直接比大小会判错，必须统一。
  let normCount = 0
  for (const p of plan) {
    const cols = db.prepare(`PRAGMA table_info("${p.t}")`).all().map(c => c.name)
    if (!cols.includes('updated_at')) continue
    const rows = db.prepare(`SELECT rowid AS rid, updated_at AS v FROM "${p.t}" WHERE updated_at IS NOT NULL`).all()
    const up = db.prepare(`UPDATE "${p.t}" SET updated_at = ? WHERE rowid = ?`)
    for (const r of rows) {
      if (ISO_RE.test(String(r.v).trim())) continue
      const ts = normalizeTs(r.v)
      if (ts) { up.run(ts, r.rid); normCount++ }
    }
  }
  if (normCount) console.log(`   规范化历史非 ISO updated_at: ${normCount} 条`)
  let bad = 0
  for (const p of plan) {
    if (!p.needGuid) continue
    const n1 = db.prepare(`SELECT COUNT(*) n FROM "${p.t}" WHERE guid IS NULL`).get().n
    const n2 = db.prepare(`SELECT COUNT(*) n FROM (SELECT guid FROM "${p.t}" GROUP BY guid HAVING COUNT(*)>1)`).get().n
    if (n1 || n2) { bad++; console.error(`   ${p.t}: 空 guid ${n1} / 重复 ${n2}`) }
  }
  if (bad) throw new Error(`自检失败：${bad} 张表 guid 异常`)
  db.exec('COMMIT')
  console.log('\n迁移完成，且 guid 自检通过（无空值、无重复）')
  console.log('回滚方式: 关闭客户端  用 ' + backup + ' 覆盖 data.db  删除 data.db-wal / data.db-shm')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('\n迁移失败已整体回滚: ' + e.message)
  process.exit(1)
}
db.close()