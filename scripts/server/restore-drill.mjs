// restore-drill.mjs —— B1 真实恢复演练（在服务器上跑；起的是**非生产**实例，随机端口 + 独立 dataDir）
//
// 测什么：从备份把中央库恢复出来、校验、并**真的对外服务**，全程记 wall-clock 秒数 → 这就是可实测的 RTO。
//
// 为什么不只是"能打开"：
//   能打开 ≠ 能服务。备份最常见的失败是「文件在、但应用起不来」或「数据缺一块」。
//   所以这里起一个真的 createInventoryServer（用恢复出来的库），打 /m/ 与 /api/invoke，
//   并把恢复库的关键表计数与**生产库**对比，证明这份备份是忠实副本。
//
// 跑法：/opt/node22/bin/node --experimental-sqlite /opt/inventory-app/restore-drill.mjs

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SNAP_DIR = process.env.SNAP_DIR_5MIN || '/opt/inventory-app/backups-5min'
const PROD = process.env.CENTRAL_DB || '/opt/inventory-app/data/data.db'
const KEY_TABLES = ['products', 'transactions', 'batches', 'customers', 'suppliers', 'expenses', 'stocktakes']

// 可选：命令行传一个具体快照路径（回滚前先验证"那一份"好不好用）；不传则用最新的。
// 加这个参数是为了让运维文档里的命令**不含嵌套引号** —— 这个环境里 ssh 传嵌套引号反复出问题。
const argPath = process.argv[2]
let snap
let newest
if (argPath) {
  if (!fs.existsSync(argPath)) { console.error('SNAPSHOT_NOT_FOUND ' + argPath); process.exit(1) }
  snap = argPath
  newest = path.basename(argPath)
} else {
  const files = fs.readdirSync(SNAP_DIR).filter((f) => /^central-\d{8}-\d{4}\.db$/.test(f)).sort()
  if (files.length === 0) { console.error('NO_SNAPSHOT in ' + SNAP_DIR); process.exit(1) }
  newest = files[files.length - 1]
  snap = path.join(SNAP_DIR, newest)
}

const drillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-drill-'))
const restored = path.join(drillDir, 'restored.db')
const dataDir = path.join(drillDir, 'data')

const now = () => Number(process.hrtime.bigint() / 1000000n)
const T = {}
const t0 = now()

function countsOf(database, list) {
  const out = {}
  for (const t of list) {
    try { out[t] = database.prepare('SELECT COUNT(*) n FROM ' + t).get().n } catch { out[t] = null }
  }
  return out
}

// ── 1) 恢复：把快照取回到新位置（真实灾难里这一步是"从备份位置取回"）
let a = now()
fs.mkdirSync(dataDir, { recursive: true })
fs.copyFileSync(snap, restored)
T.copyMs = now() - a

// ── 2) 校验 + 读关键数据
a = now()
const db = new DatabaseSync(restored)
const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0]
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
const present = KEY_TABLES.filter((t) => tables.includes(t))
const counts = countsOf(db, present)
T.verifyMs = now() - a

// ── 3) 生产库同口径计数（只读查询，用于证明备份是忠实副本）
let prodCounts = null
try {
  const pdb = new DatabaseSync(PROD)
  prodCounts = countsOf(pdb, present)
  pdb.close()
} catch (e) { prodCounts = { error: e.message } }

// ── 4) 真起一个 NON-PROD 实例，用恢复出来的库对外服务
a = now()
const { createInventoryServer } = await import('/opt/inventory-app/electron/server.js')
const srv = createInventoryServer({ db, dataDir, basePort: 0 })
const st = await srv.start()
const base = 'http://127.0.0.1:' + st.port
const token = fs.readFileSync(path.join(dataDir, 'server-token.txt'), 'utf8').trim()

const page = await fetch(base + '/m/?token=' + token)
const html = await page.text()

const inv = await fetch(base + '/api/invoke?token=' + token, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'product:list', payload: { limit: 3 } }),
})
const invJson = await inv.json().catch(() => ({}))
T.bootAndServeMs = now() - a

// ── 5) 顺带验证「恢复出来的库上也带 /m→/m/ 重定向」（这次部署的改动）
const redir = await fetch(base + '/m', { redirect: 'manual' })

await srv.stop()
db.close()
T.totalMs = now() - t0

const prodMatch = prodCounts && !prodCounts.error
  ? present.every((k) => counts[k] === prodCounts[k])
  : null

console.log(JSON.stringify({
  snapshot: newest,
  snapshotBytes: fs.statSync(snap).size,
  integrity,
  tableCount: tables.length,
  restoredCounts: counts,
  prodCounts,
  restoredMatchesProd: prodMatch,
  pageStatus: page.status,
  pageHasOfflineJs: html.includes('offline.js'),
  invokeStatus: inv.status,
  invokeReturnedArray: Array.isArray(invJson.result),
  invokeRows: Array.isArray(invJson.result) ? invJson.result.length : null,
  mRedirectStatus: redir.status,
  mRedirectLocation: redir.headers.get('location'),
  timingMs: T,
  timingSec: { copy: T.copyMs / 1000, verify: T.verifyMs / 1000, bootAndServe: T.bootAndServeMs / 1000, total: T.totalMs / 1000 },
}, null, 2))

fs.rmSync(drillDir, { recursive: true, force: true })
