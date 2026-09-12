// central-snapshot.mjs —— 中央库 **5 分钟级**快照（B1：把 RPO 从 24 小时压到 5 分钟）
//
// 背景：原来只有 backup-central.mjs 每天 03:30 跑一次 → RPO 实际 24 小时，
//       离 owner 定的 RPO=5 分钟差 288 倍。中央库只有约 384KB，5 分钟一次成本可忽略。
//
// 做法（沿用项目已验证的安全方式，不自己发明）：
//   · **VACUUM INTO** 生成一致副本 —— 直接 cp 活动库在 WAL 下可能拿到撕裂快照，
//     而 VACUUM INTO 由 SQLite 保证一致性，且会自动包含 WAL 里尚未 checkpoint 的写入。
//   · **每份快照都做完整性自检**（PRAGMA integrity_check + 关键表计数）：
//     备份不做校验 = 不知道自己有没有备份成功。校验不过就**保留现场并退出**，不参与轮转。
//   · 两级保留：5 分钟级留最近 36 份（3 小时），小时级留 24 份（1 天）；
//     天级仍由原 backup-central.mjs 负责（14 天）。
//
// 跑法：/opt/node22/bin/node --experimental-sqlite /opt/inventory-app/central-snapshot.mjs
// 可用环境变量覆盖：CENTRAL_DB / SNAP_DIR_5MIN / SNAP_DIR_HOURLY / KEEP_5MIN / KEEP_HOURLY

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const SRC = process.env.CENTRAL_DB || '/opt/inventory-app/data/data.db'
const DIR_5MIN = process.env.SNAP_DIR_5MIN || '/opt/inventory-app/backups-5min'
const DIR_HOURLY = process.env.SNAP_DIR_HOURLY || '/opt/inventory-app/backups-hourly'
const KEEP_5MIN = Number(process.env.KEEP_5MIN || 36)
const KEEP_HOURLY = Number(process.env.KEEP_HOURLY || 24)

const t0 = Date.now()
const d = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes())

function vacuumInto(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest)) fs.rmSync(dest)
  const db = new DatabaseSync(SRC)
  try {
    db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'")
  } finally {
    db.close()
  }
}

function verify(file) {
  const out = { integrity: 'n/a', products: null, batches: null, error: null }
  let db
  try {
    db = new DatabaseSync(file)
    try { out.integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0] } catch (e) { out.integrity = 'query-failed:' + e.message }
    try { out.products = db.prepare('SELECT COUNT(*) n FROM products').get().n } catch (e) { out.error = 'products:' + e.message }
    try { out.batches = db.prepare('SELECT COUNT(*) n FROM batches').get().n } catch { /* 表可能不存在，不算错 */ }
  } catch (e) {
    out.error = 'open:' + e.message
  } finally {
    try { if (db) db.close() } catch { /* ignore */ }
  }
  return out
}

function rotate(dir, keep, rx) {
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir).filter((f) => rx.test(f)).sort()
  while (files.length > keep) fs.unlinkSync(path.join(dir, files.shift()))
  return files.length
}

if (!fs.existsSync(SRC)) {
  console.error('SNAPSHOT_FAIL 源库不存在 ' + SRC)
  process.exit(1)
}

const f5 = path.join(DIR_5MIN, 'central-' + stamp + '.db')
try {
  vacuumInto(f5)
} catch (e) {
  console.error('SNAPSHOT_FAIL VACUUM INTO 失败：' + e.message)
  process.exit(1)
}

const v = verify(f5)
if (v.integrity !== 'ok') {
  // 坏快照：保留现场、不轮转、退出码非 0，好让 cron 日志与监控能发现
  console.error('SNAPSHOT_BAD integrity=' + v.integrity + ' error=' + v.error + ' file=' + f5)
  process.exit(1)
}

const kept5 = rotate(DIR_5MIN, KEEP_5MIN, /^central-\d{8}-\d{4}\.db$/)

// 整点（前 5 分钟内触发的那一次）额外留一份小时级快照
let keptHourly = null
if (d.getMinutes() < 5) {
  const fh = path.join(DIR_HOURLY, 'central-' + stamp.slice(0, 8) + '-' + pad(d.getHours()) + '.db')
  fs.copyFileSync(f5, fh)
  keptHourly = rotate(DIR_HOURLY, KEEP_HOURLY, /^central-\d{8}-\d{2}\.db$/)
}

console.log(JSON.stringify({
  at: d.toISOString(),
  file: path.basename(f5),
  integrity: v.integrity,
  products: v.products,
  batches: v.batches,
  kept5min: kept5,
  keptHourly,
  ms: Date.now() - t0,
}))
