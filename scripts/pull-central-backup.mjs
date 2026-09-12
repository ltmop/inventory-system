// pull-central-backup.mjs —— B1「第二位置」：把中央库快照拉到另一台机器，并在**本地就地校验可恢复性**
//
// 为什么需要它：服务器上的 5 分钟快照和日备份**都在同一块盘上**。那块盘挂了/机器没了，
// 备份跟着一起没。所以必须有第二台机器上的副本。
//
// 关键设计：
//   1) **拉下来就校验**（PRAGMA integrity_check + 关键表计数）——「文件在」不等于「能恢复」。
//      校验不过就 exit 非 0，让计划任务/日志能暴露出来。
//   2) **保留策略**：快照留最近 N 份、日备份留最近 14 份，自动清理，避免只涨不删。
//   3) **每次写一行日志**到本地 _pull.log，方便回头看"到底有没有在拉"。
//   4) 全部可配（环境变量覆盖），换第二位置只改 PULL_DIR 即可。
//
// 用法：node scripts/pull-central-backup.mjs
//   PULL_DIR      本地落盘目录（默认 D:\服务器备份\进销存中央库）
//   SSH_HOST      ssh 别名/主机（默认 juncheng，走 ~/.ssh/config）
//   KEEP_SNAP     保留多少份 5 分钟快照（默认 96）
//   KEEP_DAILY    保留多少份日备份（默认 14）

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const HOST = process.env.SSH_HOST || 'juncheng'
const DIR = process.env.PULL_DIR || 'D:\\服务器备份\\进销存中央库'
const SNAP_REMOTE = process.env.SNAP_REMOTE || '/opt/inventory-app/backups-5min'
const DAILY_REMOTE = process.env.DAILY_REMOTE || '/opt/inventory-app/backups'
const KEEP_SNAP = Number(process.env.KEEP_SNAP || 96)
const KEEP_DAILY = Number(process.env.KEEP_DAILY || 14)
const LOG = path.join(DIR, '_pull.log')

fs.mkdirSync(DIR, { recursive: true })

function log(line) {
  const s = new Date().toISOString() + ' ' + line
  console.log(s)
  try { fs.appendFileSync(LOG, s + '\n') } catch { /* 日志写不进不致命 */ }
}

// 第一行立刻写：这样从日志就能区分「node 压根没起来」和「起来了但卡在某个命令」。
// （加它的原因：计划任务第一次跑时日志没增长，无法判断是哪一种。）
log('START pid=' + process.pid + ' node=' + process.version + ' cwd=' + process.cwd() + ' host=' + HOST + ' dir=' + DIR)

function run(cmd, args) {
  // stdio 显式写成 ['ignore','pipe','pipe']：**stdin 必须关掉**。
  // 原因：在计划任务（非交互会话）里跑时，默认的 stdin 管道会让 ssh 一直等输入而卡死 ——
  // 第一次上线就踩到了：任务启动了 node、也拉起了 ssh，但几分钟不返回、日志一行不写。
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) return { ok: false, out: '', err: cmd + ' 启动失败：' + r.error.message }
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
}

// 统一的 ssh/scp 安全/非交互选项：不提示密码、不做键盘交互、明确超时
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'NumberOfPasswordPrompts=0', '-o', 'PreferredAuthentications=publickey']

function verify(file) {
  let db
  try {
    db = new DatabaseSync(file)
    const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0]
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    const counts = {}
    for (const t of ['products', 'transactions', 'suppliers']) {
      if (tables.includes(t)) counts[t] = db.prepare('SELECT COUNT(*) n FROM ' + t).get().n
    }
    return { ok: integrity === 'ok', integrity, tableCount: tables.length, counts }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    try { if (db) db.close() } catch { /* ignore */ }
  }
}

function prune(dir, rx, keep) {
  const files = fs.readdirSync(dir).filter((f) => rx.test(f)).sort()
  const removed = []
  while (files.length > keep) removed.push(files.shift())
  for (const f of removed) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* ignore */ } }
  return { kept: files.length, removed: removed.length }
}

// ── 1) 列出远端可用文件
const lsSnap = run('ssh', SSH_OPTS.concat([HOST, 'ls ' + SNAP_REMOTE]))
if (!lsSnap.ok) { log('FAIL 无法列出远端快照：' + (lsSnap.err || lsSnap.out)); process.exit(1) }
const snaps = lsSnap.out.split('\n').map((s) => s.trim()).filter((f) => /^central-\d{8}-\d{4}\.db$/.test(f)).sort()
if (snaps.length === 0) { log('FAIL 远端没有 5 分钟快照（检查 cron 是否在跑）'); process.exit(1) }
const newestSnap = snaps[snaps.length - 1]

const lsDaily = run('ssh', SSH_OPTS.concat([HOST, 'ls ' + DAILY_REMOTE]))
const dailies = lsDaily.ok
  ? lsDaily.out.split('\n').map((s) => s.trim()).filter((f) => /^central-\d{8}\.db$/.test(f)).sort()
  : []
const newestDaily = dailies.length ? dailies[dailies.length - 1] : null

// ── 2) 拉取（已存在且大小相同就跳过，省流量）
function pull(remoteDir, name) {
  const remote = remoteDir + '/' + name
  const local = path.join(DIR, name)
  const sizeRes = run('ssh', SSH_OPTS.concat([HOST, 'stat -c %s ' + remote]))
  const remoteSize = sizeRes.ok ? Number(sizeRes.out) : -1
  if (fs.existsSync(local) && fs.statSync(local).size === remoteSize && remoteSize > 0) {
    return { name, skipped: true, size: remoteSize }
  }
  const r = run('scp', SSH_OPTS.concat([HOST + ':' + remote, local]))
  if (!r.ok) return { name, error: r.err || r.out }
  return { name, size: fs.statSync(local).size }
}

const pulledSnap = pull(SNAP_REMOTE, newestSnap)
const pulledDaily = newestDaily ? pull(DAILY_REMOTE, newestDaily) : null

// ── 3) 就地校验（这一步是「第二位置真的有用」的证据）
const vSnap = pulledSnap.error ? { ok: false, error: pulledSnap.error } : verify(path.join(DIR, newestSnap))

// ── 4) 清理
const prSnap = prune(DIR, /^central-\d{8}-\d{4}\.db$/, KEEP_SNAP)
const prDaily = prune(DIR, /^central-\d{8}\.db$/, KEEP_DAILY)

const summary = {
  at: new Date().toISOString(),
  host: HOST,
  dir: DIR,
  snapshot: { name: newestSnap, skipped: !!pulledSnap.skipped, bytes: pulledSnap.size ?? null, error: pulledSnap.error ?? null, verify: vSnap },
  daily: pulledDaily ? { name: pulledDaily.name, skipped: !!pulledDaily.skipped, bytes: pulledDaily.size ?? null, error: pulledDaily.error ?? null } : null,
  pruned: { snapshots: prSnap, daily: prDaily },
}
log(JSON.stringify(summary))

if (!vSnap.ok) {
  log('FAIL 第二位置的快照校验未通过 —— 这份副本不可信，必须排查')
  process.exit(1)
}
log('OK 第二位置副本校验通过（integrity=ok, products=' + vSnap.counts.products + '）')
