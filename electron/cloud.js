// 云同步引擎：配对 + 快照调度 + 备份上传 + 恢复
// 铁律：try/catch 全部包裹，任何环节挂掉静默降级——云挂了是本地单机版，不是打不开
// 密钥 K 只存本地 cloud.json，永不上传服务器

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { encrypt, encryptBuffer, decryptBuffer, generateKey, deriveKey } from './cloudCrypto.js'
import { buildSnapshot } from './cloudSnapshot.js'

// 云服务器：默认公网 HTTPS（2026-08-30 任务1 起，密码不再明文走公网）；
// 开发/自建可用环境变量 CLOUD_SERVER_URL 覆盖。旧客户端仍可用 http://43.128.20.39（80 端口兼容保留）
const CLOUD_URL = process.env.CLOUD_SERVER_URL || 'https://sync.junchengzn.com'

let db = null
let dbPath = null
let dataDir = null
let backupDir = null
let getIsPro = () => false
let cloudState = {
  paired: false,
  userId: null,
  username: null,
  uploadToken: null,
  viewToken: null,
  keyK: null,
  lastSyncAt: null,
  lastServerAt: null, // 任务9：服务端快照最后修改时间（乐观锁）
  conflictAt: null,   // 任务9：最近一次检测到的云端更新时间
  lastBackupAt: null,
  syncing: false,
  error: null,
  viewUrl: null,
}

const CLOUD_CONFIG = 'cloud.json'

// ---------- B3 调度器状态 ----------
let schedulerTimer = null
let lastMtime = 0
let lastBackupDate = ''
let schedulerRunning = false

// ---------- 初始化 ----------

export function initCloud(database, dbP, dataD, backupD, isProFn) {
  db = database
  dbPath = dbP
  dataDir = dataD
  backupDir = backupD
  if (typeof isProFn === 'function') getIsPro = isProFn
  loadLocalConfig()
  startScheduler()
  // 已配对用户启动：2 秒后立即上传一次快照（不等 60s 首查）
  if (cloudState.paired) {
    setTimeout(() => { syncSnapshot().catch(() => {}) }, 2000)
  }
}

function loadLocalConfig() {
  try {
    const file = path.join(dataDir, CLOUD_CONFIG)
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      const cfg = JSON.parse(raw)
      // 任务4：严格校验凭证四件套（userId/keyK/uploadToken/viewToken 缺一视为未配对），
      // 杜绝「username 有、凭证空」的半写入中间态（历史 bug：注册中断留下 {username} 引发反复重注册）
      if (cfg.userId && cfg.keyK && cfg.uploadToken && cfg.viewToken) {
        cloudState = {
          ...cloudState,
          userId: cfg.userId,
          username: cfg.username ?? null,
          uploadToken: cfg.uploadToken,
          viewToken: cfg.viewToken,
          keyK: cfg.keyK,
          pairedAt: cfg.pairedAt ?? null,
          lastServerAt: cfg.lastServerAt ?? null,
          paired: true,
          viewUrl: buildViewUrl(cfg.viewToken, cfg.keyK),
        }
      } else {
        // 半写入残留：不进入配对态，且立即清掉脏文件（下次配对从干净状态开始）
        try { fs.unlinkSync(file) } catch { /* 忽略 */ }
      }
    }
  } catch { return }
}

function saveLocalConfig() {
  try {
    // 任务4：凭证不全绝不落盘（配对/登录/注册成功路径天然齐全；半途中断不会留下 {username} 残件）
    if (!cloudState.userId || !cloudState.keyK || !cloudState.uploadToken || !cloudState.viewToken) return
    const file = path.join(dataDir, CLOUD_CONFIG)
    const tmpFile = file + '.tmp'
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        userId: cloudState.userId,
        username: cloudState.username,
        uploadToken: cloudState.uploadToken,
        viewToken: cloudState.viewToken,
        keyK: cloudState.keyK,
        pairedAt: cloudState.pairedAt,
        lastServerAt: cloudState.lastServerAt,
      }),
      'utf8',
    )
    // 原子替换：先写临时文件再 rename，崩溃/断电不会留下半截 JSON
    fs.renameSync(tmpFile, file)
    cloudState.paired = true
    cloudState.viewUrl = buildViewUrl(cloudState.viewToken, cloudState.keyK)
  } catch (e) {
    cloudState.error = `保存凭证失败: ${e.message}`
  }
}

function buildViewUrl(viewToken, keyK) {
  if (!viewToken || !keyK) return null
  return `${CLOUD_URL}/v/${viewToken}#key=${keyK}`
}

// ---------- B1 Pro 门控 ----------

function checkPro() {
  return getIsPro()
}

// ---------- B3 调度器 ----------

function startScheduler() {
  if (schedulerRunning) return
  schedulerRunning = true

  // 启动后 10s 首次检查（已配对就尽快自动同步一次）
  setTimeout(() => {
    if (cloudState.paired && checkPro()) {
      const lastSync = cloudState.lastSyncAt ? new Date(cloudState.lastSyncAt).getTime() : 0
      if (Date.now() - lastSync > 6 * 3600 * 1000) {
        syncSnapshot().catch(() => {})
      }
    }
  }, 10_000)

  // 每 5 分钟轮询
  schedulerTimer = setInterval(() => {
    if (!cloudState.paired || !checkPro()) return
    try {
      const mtime = fs.statSync(dbPath).mtimeMs
      const lastSync = cloudState.lastSyncAt ? new Date(cloudState.lastSyncAt).getTime() : 0
      if (mtime !== lastMtime && Date.now() - lastSync > 15 * 60 * 1000) {
        lastMtime = mtime
        syncSnapshot().catch(() => {})
      }
      // 每日备份：日期变更时
      const today = new Date().toISOString().slice(0, 10)
      if (today !== lastBackupDate && mtime !== lastMtime) {
        lastBackupDate = today
        uploadBackup().catch(() => {})
      }
    } catch { return }
  }, 5 * 60 * 1000)
}

export function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null }
  schedulerRunning = false
}

// ---------- 退出前 best-effort 快照 ----------

export async function exitSnapshot() {
  if (!cloudState.paired || !checkPro()) return
  try {
    const p = syncSnapshot()
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
    await Promise.race([p, timeout])
  } catch { return }
}

// ---------- 配对 ----------

export async function pairWithCloud(pairCode) {
  if (!db) return { ok: false, error: '数据库未就绪' }
  try {
    const r = await fetch(`${CLOUD_URL}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode }),
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error || '配对失败' }

    const keyK = cloudState.keyK || generateKey()

    cloudState.userId = data.userId
    cloudState.uploadToken = data.uploadToken
    cloudState.viewToken = data.viewToken
    cloudState.keyK = keyK
    cloudState.pairedAt = new Date().toISOString()
    cloudState.error = null

    saveLocalConfig()
    return { ok: true, viewUrl: cloudState.viewUrl }
  } catch (e) {
    return { ok: false, error: `配对请求失败: ${e.message}` }
  }
}

// ---------- 快照上传 ----------

export async function syncSnapshot(storeName) {
  if (!db || cloudState.syncing) return
  // B1: Pro 门控——付费才能上传，到期即停
  if (!checkPro()) return
  cloudState.syncing = true
  try {
    if (!cloudState.userId || !cloudState.uploadToken) return

    let name = storeName || '我的门店'
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'store_name'").get()
      if (row?.value) name = row.value
    } catch { return }

    const snap = buildSnapshot(db, name)
    const json = JSON.stringify(snap)
    const enc = encrypt(json, cloudState.keyK)

    const r = await fetch(`${CLOUD_URL}/api/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': cloudState.userId,
        'x-token': cloudState.uploadToken,
        // 任务9：乐观锁——带上上次同步拿到的服务端快照时间戳，冲突时服务端拒绝覆盖
        'x-last-sync': cloudState.lastServerAt || '',
      },
      body: JSON.stringify(enc),
    })
    const resp = await r.json().catch(() => null)
    if (r.ok) {
      if (resp?.conflict) {
        // 另一台电脑改过并上传了：不覆盖，明确提示先拉取（任务9：last-write-wins 不再静默）
        cloudState.error = '同步冲突：另一台电脑有新数据，本次未覆盖。请先拉取云端数据再继续'
        cloudState.conflictAt = resp.at || null
      } else {
        cloudState.lastSyncAt = new Date().toISOString()
        cloudState.lastServerAt = resp?.at || null
        cloudState.error = null
        cloudState.conflictAt = null
      }
    } else {
      cloudState.error = `快照同步失败: HTTP ${r.status}`
    }
  } catch (e) {
    cloudState.error = `快照同步失败: ${e.message}`
  } finally {
    cloudState.syncing = false
  }
}

// ---------- 整库备份上传 ----------

export async function uploadBackup() {
  if (!db || !dbPath || !cloudState.userId) return
  if (!checkPro()) return
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const raw = fs.readFileSync(dbPath)
    const { gzipSync } = await import('node:zlib')
    const compressed = gzipSync(raw)
    const enc = encryptBuffer(compressed, cloudState.keyK)
    const today = new Date().toISOString().slice(0, 10)

    const r = await fetch(`${CLOUD_URL}/api/backup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': cloudState.userId,
        'x-token': cloudState.uploadToken,
        'x-date': today,
      },
      body: JSON.stringify(enc),
    })
    if (r.ok) {
      cloudState.lastBackupAt = new Date().toISOString()
      cloudState.error = null
    }
  } catch (e) {
    cloudState.error = `备份上传失败: ${e.message}`
  }
}

// ---------- B2 恢复 ----------

export async function listCloudBackups() {
  if (!cloudState.userId || !cloudState.uploadToken) return { ok: false, error: '未配对' }
  try {
    const r = await fetch(`${CLOUD_URL}/api/backup/list`, {
      headers: { 'x-user-id': cloudState.userId, 'x-token': cloudState.uploadToken },
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function restoreFromCloud(date) {
  if (!cloudState.userId || !cloudState.uploadToken) return { ok: false, error: '未配对' }
  try {
    const r = await fetch(`${CLOUD_URL}/api/backup/download?date=${encodeURIComponent(date)}`, {
      headers: { 'x-user-id': cloudState.userId, 'x-token': cloudState.uploadToken },
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error || '备份不存在' }

    const buf = decryptBuffer({ iv: data.iv, data: data.data }, cloudState.keyK)
    const { gunzipSync } = await import('node:zlib')
    const decompressed = gunzipSync(buf)

    const header = decompressed.slice(0, 16).toString('utf8')
    if (!header.startsWith('SQLite format 3')) {
      return { ok: false, error: '备份文件损坏：非 SQLite 格式' }
    }

    // 校验完整性
    const tmpPath = dbPath + '.restore.tmp'
    fs.writeFileSync(tmpPath, decompressed)

    // 用临时连接做 integrity_check
    const Database = (await import('node:sqlite')).DatabaseSync
    let tmpDb = null
    try {
      tmpDb = new Database(tmpPath)
      const check = tmpDb.prepare('PRAGMA integrity_check').get()
      if (check.integrity_check !== 'ok') {
        try { fs.unlinkSync(tmpPath) } catch { return }
        return { ok: false, error: `备份校验失败: ${check.integrity_check}` }
      }
    } finally {
      if (tmpDb) tmpDb.close()
    }

    // 先自动本地备份当前库
    const { backupNow } = await import('./backup.js')
    try { backupNow(db, dbPath, backupDir) } catch { return }

    // WAL checkpoint + 关闭主库连接
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()

    // 替换：当前库 → .pre-restore.bak 留底 → 恢复文件 → data.db
    const bakPath = dbPath + '.pre-restore.bak'
    try { fs.unlinkSync(bakPath) } catch { return }
    fs.renameSync(dbPath, bakPath)
    fs.renameSync(tmpPath, dbPath)

    return { ok: true, restored: true, date }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------- 吊销链接 ----------

export async function regenViewLink() {
  if (!cloudState.userId) return { ok: false, error: '未配对' }
  try {
    const adminKey = process.env.ADMIN_KEY
    if (!adminKey) return { ok: false, error: '服务器未配置 ADMIN_KEY' }
    const r = await fetch(`${CLOUD_URL}/admin/regen?key=${encodeURIComponent(adminKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: cloudState.userId }),
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error }

    cloudState.viewToken = data.viewToken
    saveLocalConfig()
    return { ok: true, viewUrl: cloudState.viewUrl }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------- 账户登录（多设备）：注册/登录 + 绑定本机为设备 ----------

export async function registerAccount(username, password, note = '', deviceName = '') {
  try {
    // 注册账户
    const r = await fetch(`${CLOUD_URL}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, note }),
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error || '注册失败' }
    // 注册后立刻绑定本机为设备（拿 uploadToken/viewToken），否则没有凭证无法同步
    const bind = await fetch(`${CLOUD_URL}/api/device/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName }),
    })
    const b = await bind.json()
    if (!b.ok) return { ok: false, error: b.error || '注册成功但绑定失败，请重新登录' }
    // 用密码 + 服务器盐派生密钥（所有设备同一密码 → 同一密钥 → 数据互通）
    const keyK = deriveKey(password, b.salt)
    cloudState.userId = b.userId
    cloudState.username = b.username ?? data.username
    cloudState.uploadToken = b.uploadToken
    cloudState.viewToken = b.viewToken
    cloudState.keyK = keyK
    cloudState.pairedAt = new Date().toISOString()
    cloudState.error = null
    saveLocalConfig()
    // 注册并登录成功立即上传快照
    syncSnapshot().catch(() => {})
    return { ok: true, viewUrl: cloudState.viewUrl, username: cloudState.username }
  } catch (e) {
    return { ok: false, error: `注册请求失败: ${e.message}` }
  }
}

export async function loginAccount(username, password, deviceName = '') {
  try {
    const r = await fetch(`${CLOUD_URL}/api/device/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName }),
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error || '登录失败' }
    // 多设备共享关键：用「密码 + 服务器盐」派生密钥。
    // 所有设备输入同一账户密码 → 得到同一把密钥 → 都能解密彼此上传的数据。
    // 不再每台设备随机生成（那样 A 加密的数据 B 永远解不开）。
    const keyK = deriveKey(password, data.salt)
    cloudState.userId = data.userId
    cloudState.username = data.username
    cloudState.uploadToken = data.uploadToken
    cloudState.viewToken = data.viewToken
    cloudState.keyK = keyK
    cloudState.pairedAt = new Date().toISOString()
    cloudState.error = null
    saveLocalConfig()
    // 登录成功立即上传快照（不等调度器）
    syncSnapshot().catch(() => {})
    return { ok: true, viewUrl: cloudState.viewUrl, username: data.username }
  } catch (e) {
    return { ok: false, error: `登录请求失败: ${e.message}` }
  }
}

// ---------- 退出登录（解绑本机）：清空本地凭证，回到未配对 ----------

export function logoutAccount() {
  try {
    const file = path.join(dataDir, CLOUD_CONFIG)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch { /* 删不掉也要清内存态 */ }
  cloudState = {
    paired: false,
    userId: null,
    username: null,
    uploadToken: null,
    viewToken: null,
    keyK: null,
    lastSyncAt: null,
    lastBackupAt: null,
    syncing: false,
    error: null,
    viewUrl: null,
  }
  return { ok: true }
}

// ---------- 状态查询 ----------

export function getCloudState() {
  return { ...cloudState, viewUrl: cloudState.viewUrl }
}
