// 云备份存储层：用户目录管理 + 备份版本清理
// 零 npm 依赖，纯 node:fs + node:path + node:crypto
// 铁律：所有写操作先写 .tmp 再 rename（防半截文件）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
  try {
    return fs.readdirSync(USERS_DIR).map(id => {
      const meta = loadMeta(id)
      const snap = path.join(userDir(id), 'snapshot.enc')
      const backups = listBackups(id)
      return {
        userId: id,
        createdAt: meta.createdAt,
        note: meta.note || '',
        lastSync: snap ? fs.statSync(snap).mtime.toISOString() : null,
        backupCount: backups.length,
        paired: !!meta.viewToken,
      }
    })
  } catch {
    return []
  }
}

// ===================================================================
// ========== CEO驾驶舱 · 成员账号 / 会话 / 共享槽 / 审计 ==========
// 增量接入：不进销存共用端点，仅提供驾驶舱专用槽位与成员表
// ===================================================================

const MEMBERS_FILE = path.join(DATA_ROOT, 'members.json')
const AUDIT_FILE = path.join(DATA_ROOT, 'audit.log')
const COCKPIT_SLOT = 'cockpit' // 驾驶舱固定共享槽位（一套共享数据）

export function cockpitSlotId() { return COCKPIT_SLOT }

// ---------- 成员表（管理员建号，无公开自助注册） ----------
function readMembers() {
  if (!fs.existsSync(MEMBERS_FILE)) return []
  try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')) } catch { return [] }
}
function writeMembers(list) {
  const tmp = MEMBERS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list), 'utf8')
  fs.renameSync(tmp, MEMBERS_FILE)
}

export function createMember(username, passwordHash, salt) {
  const name = String(username || '').trim()
  if (!name) return null
  const list = readMembers()
  if (list.find(m => m.username === name)) return null // 用户名已存在
  const member = { username: name, passwordHash, salt, userId: COCKPIT_SLOT, createdAt: new Date().toISOString(), enabled: true }
  list.push(member)
  writeMembers(list)
  return member
}

export function findByUsername(username) {
  const name = String(username || '').trim()
  return readMembers().find(m => m.username === name) || null
}

export function setMemberEnabled(username, enabled) {
  const list = readMembers()
  const m = list.find(x => x.username === String(username || '').trim())
  if (!m) return false
  m.enabled = !!enabled
  writeMembers(list)
  return true
}

export function listMembers() {
  return readMembers().map(m => ({ username: m.username, userId: m.userId, createdAt: m.createdAt, enabled: m.enabled }))
}

// ---------- 驾驶舱共享槽密钥（服务端代管，登录后经 HTTPS 下发） ----------
export function getOrCreateSlotKey() {
  const dir = userDir(COCKPIT_SLOT)
  ensureDir(dir)
  const keyFile = path.join(dir, 'slot.key')
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim()
  const k = crypto.randomBytes(32).toString('base64url') // 与 cloudCrypto.generateKey() 同格式，32字节 base64url
  atomicWrite(keyFile, k)
  return k
}

// ---------- 会话（内存 Map，重启清空；成员重新登录即可） ----------
const sessions = new Map() // token -> { username, userId, expiresAt }

export function createSession(token, username, ttlMs) {
  sessions.set(token, { username, userId: COCKPIT_SLOT, expiresAt: Date.now() + (ttlMs || 12 * 60 * 60 * 1000) })
}

export function validateSession(token) {
  if (!token) return null
  const s = sessions.get(token)
  if (!s) return null
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null }
  const m = readMembers().find(x => x.username === s.username)
  if (!m || !m.enabled) { sessions.delete(token); return null }
  return s
}

export function revokeSession(token) { if (token) sessions.delete(token) }

// ---------- 审计（追加写，真实现：谁、何时、做了什么） ----------
export function audit(action, username, detail) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), username: username || 'anonymous', userId: COCKPIT_SLOT, action, detail: detail || '' })
    fs.appendFileSync(AUDIT_FILE, line + '\n')
  } catch { /* 审计不影响主流程 */ }
}
