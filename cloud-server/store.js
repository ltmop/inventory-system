// 云备份存储层：用户目录管理 + 备份版本清理
// 零 npm 依赖，纯 node:fs + node:path + node:crypto
// 铁律：所有写操作先写 .tmp 再 rename（防半截文件）
import fs from 'node:fs'
import path from 'node:path'

const DATA_ROOT = process.env.CLOUD_DATA_ROOT || path.join(process.cwd(), 'data')
const USERS_DIR = path.join(DATA_ROOT, 'users')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, filePath)
}

// ---------- 用户目录 ----------

export function userDir(userId) {
  return path.join(USERS_DIR, userId)
}

export function initUser(userId) {
  const dir = userDir(userId)
  ensureDir(dir)
  ensureDir(path.join(dir, 'backups'))
  // meta.json: { createdAt, note, viewToken, viewTokenOld[] }
  if (!fs.existsSync(path.join(dir, 'meta.json'))) {
    atomicWrite(path.join(dir, 'meta.json'), JSON.stringify({
      createdAt: new Date().toISOString(),
      note: '',
      viewToken: '',
      viewTokenOld: [],
    }))
  }
}

// ---------- 配对码管理（内存 Map，重启清空；配对码一次性使用） ----------

const pairCodes = new Map() // code → { userId, expiresAt }

export function createPairCode(userId) {
  // 6 位数字 + 字母，容易口述/微信复制
  const code = Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('')
  pairCodes.set(code, { userId, expiresAt: Date.now() + 30 * 60 * 1000 }) // 30 min
  // 过期清理（懒惰：取时检查）
  return code
}

export function validatePairCode(code) {
  const entry = pairCodes.get(code)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    pairCodes.delete(code)
    return null
  }
  pairCodes.delete(code) // 一次性使用
  return entry.userId
}

// ---------- 快照 ----------

export function saveSnapshot(userId, iv, data) {
  const dir = userDir(userId)
  ensureDir(dir)
  atomicWrite(path.join(dir, 'snapshot.enc'), JSON.stringify({ iv, data }))
  // 任务9（审计 2026-08-30）：返回快照最后修改时间，客户端用它做多机并发冲突检测
  const stat = fs.statSync(path.join(dir, 'snapshot.enc'))
  return { at: stat.mtime.toISOString() }
}

export function loadSnapshot(userId) {
  const file = path.join(userDir(userId), 'snapshot.enc')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 快照最后修改时间（ISO 字符串）；无快照返回 null。任务9 冲突检测用 */
export function snapshotMtime(userId) {
  const file = path.join(userDir(userId), 'snapshot.enc')
  try {
    if (!fs.existsSync(file)) return null
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}

// ---------- 备份 ----------

export function saveBackup(userId, date, iv, data) {
  const dir = path.join(userDir(userId), 'backups')
  ensureDir(dir)
  atomicWrite(path.join(dir, `${date}.enc`), JSON.stringify({ iv, data }))
}

export function loadBackup(userId, date) {
  const file = path.join(userDir(userId), 'backups', `${date}.enc`)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function listBackups(userId) {
  const dir = path.join(userDir(userId), 'backups')
  ensureDir(dir)
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.enc'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f))
        return { date: f.replace('.enc', ''), size: stat.size }
      })
      .sort((a, b) => b.date.localeCompare(a.date))
  } catch {
    return []
  }
}

/** 保留最近 KEEP 份备份，删掉更旧的 */
export function cleanOldBackups(userId, keep = 30) {
  const dir = path.join(userDir(userId), 'backups')
  ensureDir(dir)
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.enc'))
      .sort()
      .reverse() // 最新的在前
    for (let i = keep; i < files.length; i++) {
      fs.unlinkSync(path.join(dir, files[i]))
    }
  } catch { /* 清理失败不致命 */ }
}

// ---------- 元数据 ----------

export function loadMeta(userId) {
  const file = path.join(userDir(userId), 'meta.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { createdAt: '', note: '', viewToken: '', viewTokenOld: [] }
  }
}

export function saveMeta(userId, meta) {
  atomicWrite(path.join(userDir(userId), 'meta.json'), JSON.stringify(meta))
}

// ---------- 用户列表（给 admin 页用） ----------

export function listUsers() {
  ensureDir(USERS_DIR)
  // 任务3（审计 2026-08-30）：admin 列表补 username——按 userId 从 accounts.json 反查，
  // 让运维能定位账号（此前只有 userId，分不清谁是谁）
  const accounts = loadAccounts()
  const userToName = new Map(Object.entries(accounts).map(([name, a]) => [a.userId, name]))
  try {
    return fs.readdirSync(USERS_DIR).map(id => {
      const meta = loadMeta(id)
      const snap = path.join(userDir(id), 'snapshot.enc')
      const backups = listBackups(id)
      return {
        userId: id,
        username: userToName.get(id) ?? null, // 任务3：补 username
        createdAt: meta.createdAt,
        note: meta.note || '',
        lastSync: (() => { try { return fs.statSync(snap).mtime.toISOString() } catch { return null } })(),
        backupCount: backups.length,
        paired: !!meta.viewToken,
      }
    })
  } catch {
    return []
  }
}

/** 任务3：按用户名重置密码（新盐 + 新 hash）。账号不存在返回 { error } */
export function resetPassword(username, newPassword) {
  const uname = String(username || '').trim().toLowerCase()
  if (!uname) return { error: '用户名不能为空' }
  if (!newPassword || String(newPassword).length < 6) return { error: '新密码至少 6 位' }
  const accounts = loadAccounts()
  const acc = accounts[uname]
  if (!acc) return { error: '账户不存在' }
  const salt = crypto.randomBytes(16).toString('hex')
  acc.salt = salt
  acc.passwordHash = hashPassword(String(newPassword), salt)
  saveAccounts(accounts)
  return { ok: true, username: uname }
}

// ========== 多设备账户体系（v2）：一个账户多台电脑 ==========
// 账户：username + password_hash → userId（固定），多台设备用同一账户
// 设备：每台电脑配对时注册一个 deviceId，共享同一 userId 的云端数据

import crypto from 'node:crypto'

const ACCOUNTS_FILE = path.join(DATA_ROOT, 'accounts.json')

function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveAccounts(accounts) {
  ensureDir(DATA_ROOT)
  atomicWrite(ACCOUNTS_FILE, JSON.stringify(accounts))
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex')
}

/** 注册账户：username 唯一；返回 userId 或 { error } */
export function registerAccount(username, password, note = '') {
  const uname = String(username || '').trim().toLowerCase()
  if (!uname || uname.length < 2) return { error: '用户名至少 2 个字符' }
  if (!password || String(password).length < 6) return { error: '密码至少 6 位' }
  const accounts = loadAccounts()
  if (accounts[uname]) return { error: '该账户已存在，请直接登录' }
  const userId = crypto.randomBytes(16).toString('hex')
  const salt = crypto.randomBytes(16).toString('hex')
  accounts[uname] = {
    userId, salt, passwordHash: hashPassword(password, salt),
    note: String(note || ''), createdAt: new Date().toISOString(),
  }
  saveAccounts(accounts)
  initUser(userId)
  return { ok: true, userId, username: uname }
}


// ---------- 防爆破（任务2，审计 2026-08-30） ----------
// 内存态防护：登录失败计数锁定 / IP 限速 / 注册每日上限。
// 注：进程重启清零（内存态），足够挡住脚本爆破；不做持久化（简单可靠优先）。

const LOGIN_LOCK_THRESHOLD = 5   // 连续失败 5 次
const LOGIN_LOCK_MS = 15 * 60 * 1000 // 锁 15 分钟
const LOGIN_IP_RATE = 10         // 每 IP 每分钟最多 10 次登录尝试
const REGISTER_IP_DAILY = 20     // 每 IP 每天最多注册 20 个账号（防灌号）
const loginFailures = new Map()  // `${ip}|${username}` -> { count, lockedUntil }
const loginIpHits = new Map()    // ip -> [timestamps]
const registerIpDay = new Map()  // `${ip}|${yyyy-mm-dd}` -> count

/** 登录前检查：IP 限速 + 该用户名是否被锁 */
export function checkLoginAllowed(ip, username) {
  const now = Date.now()
  // IP 限速：每分钟 10 次
  const cutoff = now - 60_000
  const ipList = (loginIpHits.get(ip) ?? []).filter((t) => t > cutoff)
  if (ipList.length >= LOGIN_IP_RATE) return { allowed: false, error: '尝试太频繁，请 1 分钟后再试' }
  // 用户名锁定检查
  const key = ip + '|' + String(username || '').trim().toLowerCase()
  const rec = loginFailures.get(key)
  if (rec && rec.lockedUntil && now < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - now) / 60000)
    return { allowed: false, error: `连续失败次数过多，已锁定，请 ${mins} 分钟后再试` }
  }
  loginIpHits.set(ip, [...ipList, now])
  return { allowed: true, key }
}

/** 登录结果上报：成功清零计数；失败计数，达阈值锁定 */
export function reportLoginResult(ip, username, success) {
  const key = ip + '|' + String(username || '').trim().toLowerCase()
  if (success) { loginFailures.delete(key); return }
  const rec = loginFailures.get(key) ?? { count: 0, lockedUntil: null }
  rec.count += 1
  if (rec.count >= LOGIN_LOCK_THRESHOLD) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS
    rec.count = 0
  }
  loginFailures.set(key, rec)
}

/** 注册前检查：每 IP 每天上限（防脚本灌号） */
export function checkRegisterAllowed(ip) {
  const day = new Date().toISOString().slice(0, 10)
  const key = ip + '|' + day
  const count = registerIpDay.get(key) ?? 0
  if (count >= REGISTER_IP_DAILY) return { allowed: false, error: '该网络今日注册太多，明天再试' }
  registerIpDay.set(key, count + 1)
  return { allowed: true }
}

/** 登录账户：校验用户名密码 → userId */
export function loginAccount(username, password) {
  const uname = String(username || '').trim().toLowerCase()
  const accounts = loadAccounts()
  const acc = accounts[uname]
  if (!acc) return { error: '账户不存在，请先注册' }
  if (acc.passwordHash !== hashPassword(password, acc.salt)) return { error: '密码不对' }
  return { ok: true, userId: acc.userId, username: uname }
}

/** 列出账户（admin 用） */
export function listAccounts() {
  const accounts = loadAccounts()
  return Object.entries(accounts).map(([username, a]) => ({
    username, userId: a.userId, note: a.note, createdAt: a.createdAt,
  }))
}

// ---------- 多设备 token 管理（v2） ----------

/** 绑定新设备：给 userId 追加一台设备（独立 uploadToken/viewToken），返回该设备凭证 */
export function bindDevice(userId, deviceName = '', note = '') {
  const meta = loadMeta(userId)
  const devices = Array.isArray(meta.devices) ? meta.devices : []
  const deviceId = crypto.randomBytes(8).toString('hex')
  const uploadToken = crypto.randomBytes(32).toString('hex')
  const viewToken = crypto.randomBytes(16).toString('hex')
  devices.push({
    deviceId, name: String(deviceName || '设备' + (devices.length + 1)), 
    uploadToken, viewToken, boundAt: new Date().toISOString(),
  })
  meta.devices = devices
  meta.note = note || meta.note || ''
  saveMeta(userId, meta)
  return { deviceId, uploadToken, viewToken }
}

/** 按 uploadToken 找设备所属 userId；返回 { userId, device } 或 null */
export function findDeviceByToken(uploadToken) {
  for (const u of listUsers()) {
    const meta = loadMeta(u.userId)
    const devices = Array.isArray(meta.devices) ? meta.devices : []
    const dev = devices.find((d) => d.uploadToken === uploadToken)
    if (dev) return { userId: u.userId, device: dev }
  }
  return null
}

/** 按 viewToken 找设备（远程看店鉴权） */
export function findDeviceByViewToken(viewToken) {
  for (const u of listUsers()) {
    const meta = loadMeta(u.userId)
    const devices = Array.isArray(meta.devices) ? meta.devices : []
    if (devices.some((d) => d.viewToken === viewToken)) return u.userId
  }
  return null
}

/** 设备列表（admin/状态用） */
export function listDevices(userId) {
  const meta = loadMeta(userId)
  return Array.isArray(meta.devices) ? meta.devices : []
}

/** 兼容旧版单 token：把 meta.uploadToken/viewToken 迁移进 devices[0] */
export function ensureDevicesMigrated(userId) {
  const meta = loadMeta(userId)
  if (!Array.isArray(meta.devices) && meta.uploadToken) {
    meta.devices = [{
      deviceId: 'legacy', name: '旧设备', 
      uploadToken: meta.uploadToken, viewToken: meta.viewToken || '',
      boundAt: meta.createdAt || new Date().toISOString(),
    }]
    saveMeta(userId, meta)
  }
  return meta
}
