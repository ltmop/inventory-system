// 自动备份：每天凌晨 3:00 + 软件正常退出前 + 设置页手动按钮
// 备份路径 %APPDATA%/fishing-inventory/backup/，保留最近 7 份
// 备份前先 checkpoint(TRUNCATE)，保证拷贝的是完整单文件数据库
import fs from 'node:fs'
import path from 'node:path'

const KEEP = 7
// 距上次备份超过 3 天视为"太久没备份"，状态里带 stale 让前端提醒
const STALE_MS = 3 * 24 * 3600 * 1000

// ---------- 第二备份位置（U 盘/网盘目录等） ----------
// 配置存在数据目录的 backup-config.json：{ extraDir: string|null }
// 最近一次向第二位置复制的失败信息（仅内存留痕，状态接口透出；成功则清空）
let lastExtraError = null

export function loadBackupConfig(configPath) {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return { extraDir: typeof c.extraDir === 'string' && c.extraDir !== '' ? c.extraDir : null }
  } catch {
    return { extraDir: null } // 没配过/文件坏了都按未配置处理
  }
}

export function saveBackupExtraDir(configPath, extraDir) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ extraDir: extraDir ?? null }), 'utf8')
  return { extraDir: extraDir ?? null }
}

// 向第二位置复制同一份备份：失败只记状态不阻断主备份（U 盘没插等情况不能弄坏本地备份）
// 轮转对两个目录独立生效（各留各的最近 7 份）
function copyToExtraDir(dest, extraDir) {
  if (!extraDir) return
  try {
    fs.mkdirSync(extraDir, { recursive: true })
    const extraDest = path.join(extraDir, path.basename(dest))
    fs.copyFileSync(dest, extraDest)
    verifyBackup(dest, extraDest)
    rotateBackups(extraDir)
    lastExtraError = null
  } catch (e) {
    lastExtraError = e.message
    console.error('[backup] 第二备份位置复制失败（主备份不受影响）:', e)
  }
}

async function copyToExtraDirAsync(dest, extraDir) {
  if (!extraDir) return
  try {
    await fs.promises.mkdir(extraDir, { recursive: true })
    const extraDest = path.join(extraDir, path.basename(dest))
    await fs.promises.copyFile(dest, extraDest)
    verifyBackup(dest, extraDest)
    rotateBackups(extraDir)
    lastExtraError = null
  } catch (e) {
    lastExtraError = e.message
    console.error('[backup] 第二备份位置复制失败（主备份不受影响）:', e)
  }
}

export function backupNow(db, dbPath, backupDir, extraDir = null) {
  fs.mkdirSync(backupDir, { recursive: true })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const dest = path.join(backupDir, backupName())
  fs.copyFileSync(dbPath, dest)
  // 校验备份完整性：坏备份（空文件/大小不符）直接删掉并抛错，不留假备份
  verifyBackup(dbPath, dest)
  rotateBackups(backupDir)
  copyToExtraDir(dest, extraDir)
  return dest
}

// 设置页手动备份走异步拷贝，避免大库 copyFileSync 卡住主进程 UI；
// 定时/退出备份必须保持同步：退出阶段事件循环即将结束，异步拷贝可能来不及写完
export async function backupNowAsync(db, dbPath, backupDir, extraDir = null) {
  await fs.promises.mkdir(backupDir, { recursive: true })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const dest = path.join(backupDir, backupName())
  await fs.promises.copyFile(dbPath, dest)
  // 校验不过时 verifyBackup 会删坏备份并抛错，错误经 IPC 抛回设置页展示
  verifyBackup(dbPath, dest)
  rotateBackups(backupDir)
  await copyToExtraDirAsync(dest, extraDir)
  return dest
}

/**
 * 备份状态（设置页展示 + 超期提醒）：
 * { lastBackupAt, backupCount, extraDir, extraDirOk, extraError, dbPath, stale }
 * lastBackupAt/backupCount 直接读备份目录文件列表（文件 mtime 最大值）；
 * extraDirOk = 配了第二位置且目录可写（未配置时为 null）；stale = 距今超过 3 天没备份。
 */
export function backupStatus({ dbPath, backupDir, configPath }) {
  let lastBackupAt = null
  let backupCount = 0
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('inventory_backup_') && f.endsWith('.db'))
    backupCount = files.length
    if (files.length > 0) {
      const maxMtime = files
        .map((f) => fs.statSync(path.join(backupDir, f)).mtimeMs)
        .reduce((a, b) => Math.max(a, b), 0)
      lastBackupAt = new Date(maxMtime).toISOString()
    }
  } catch {
    // 备份目录还没建（首次启动）就当没有备份
  }
  const { extraDir } = loadBackupConfig(configPath)
  let extraDirOk = null
  if (extraDir) {
    try {
      fs.accessSync(extraDir, fs.constants.W_OK)
      extraDirOk = true
    } catch {
      extraDirOk = false
    }
  }
  return {
    lastBackupAt,
    backupCount,
    extraDir,
    extraDirOk,
    extraError: lastExtraError,
    dbPath,
    stale: lastBackupAt !== null && Date.now() - new Date(lastBackupAt).getTime() > STALE_MS,
  }
}

function backupName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `inventory_backup_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`
}

// 备份后校验：目标文件非空且与源文件大小一致，否则删除坏备份并抛错
function verifyBackup(dbPath, dest) {
  const srcSize = fs.statSync(dbPath).size
  const destSize = fs.statSync(dest).size
  if (destSize <= 0 || destSize !== srcSize) {
    fs.rmSync(dest, { force: true })
    throw new Error(`备份校验失败：源 ${srcSize} 字节，备份 ${destSize} 字节，已删除不完整备份`)
  }
}

function rotateBackups(backupDir) {
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('inventory_backup_') && f.endsWith('.db'))
    .sort()
  // 文件名含时间戳，字典序即时间序；删掉最旧的
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    fs.rmSync(path.join(backupDir, f), { force: true })
  }
}

/** 调度每天凌晨 3:00 自动备份，返回停止函数。
 * onError：备份失败时回调（由 main.js 负责弹错误框 + 写 backup-error.log），
 * 不传则只打 console（保持原行为，便于无 Electron 环境测试）；
 * getExtraDir：每次备份前取第二备份位置（配了才复制，可为 null 或返回 null 的函数） */
export function scheduleDailyBackup(db, dbPath, backupDir, onError = null, getExtraDir = null) {
  let timer = null
  const arm = () => {
    const next = new Date()
    next.setHours(3, 0, 0, 0)
    if (next <= new Date()) next.setDate(next.getDate() + 1)
    timer = setTimeout(() => {
      try {
        backupNow(db, dbPath, backupDir, getExtraDir?.() ?? null)
      } catch (e) {
        console.error('[backup] 自动备份失败:', e)
        try {
          onError?.(e)
        } catch {
          // 错误通知本身失败不再抛，避免影响下一轮调度
        }
      }
      arm()
    }, next.getTime() - Date.now())
  }
  arm()
  return () => clearTimeout(timer)
}

/**
 * 从备份文件恢复数据库：把备份文件拷贝覆盖 dbPath。
 * 只负责文件层面的恢复（校验 + 兜底留底 + 覆盖），不重启应用——
 * 调用方（main.js 的 backup:restore handler）必须在恢复后立刻
 * app.relaunch() + app.exit(0)，让进程重开新库，且退出时不得再对旧连接
 * 做 checkpoint/备份（旧连接的内存视图已与新文件脱节）。
 * @param {DatabaseSync} db 当前打开的数据库连接
 * @param {string} backupPath 用户选择的备份文件绝对路径
 * @param {string} dbPath 当前库文件绝对路径
 */
export function restoreBackup(db, backupPath, dbPath) {
  // 校验备份文件存在且非空，拒绝拿坏文件覆盖好库
  if (!fs.existsSync(backupPath)) {
    throw new Error(`备份文件不存在：${backupPath}`)
  }
  if (fs.statSync(backupPath).size <= 0) {
    throw new Error(`备份文件为空，无法恢复：${backupPath}`)
  }
  // 先把 WAL 落盘截断，保证 .pre-restore.bak 留底的是完整单文件库
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  // 兜底留底：覆盖前把当前库拷一份 .pre-restore.bak（参照 db.js 迁移留底的模式），
  // 恢复选错文件时可手动改回 data.db
  fs.copyFileSync(dbPath, dbPath + '.pre-restore.bak')
  fs.copyFileSync(backupPath, dbPath)
}
