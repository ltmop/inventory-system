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
export function registerAccount(username, password, note = '', phone = '', code = '') {
  const uname = String(username || '').trim().toLowerCase()
  if (!uname || uname.length < 2) return { error: '用户名至少 2 个字符' }
  if (!password || String(password).length < 6) return { error: '密码至少 6 位' }
  const ph = String(phone || '').trim()
  if (ph) {
    if (!/^1\d{10}$/.test(ph)) return { error: '手机号格式不正确' }
    const vc = verifyCode(ph, code)
    if (!vc.ok) return { error: vc.error || '验证码错误或已过期' }
  }
  const accounts = loadAccounts()
  if (accounts[uname]) return { error: '该账户已存在，请直接登录' }
  for (const a of Object.values(accounts)) if (a.phone && a.phone === ph) return { error: '该手机号已被注册' }
  const userId = crypto.randomBytes(16).toString('hex')
  const salt = crypto.randomBytes(16).toString('hex')
  accounts[uname] = {
    userId, salt, passwordHash: hashPassword(password, salt),
    phone: ph, enabled: true,
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
export function loginAccount(identifier, password) {
  const id = String(identifier || '').trim().toLowerCase()
  const accounts = loadAccounts()
  let acc = accounts[id]
  let uname = id
  if (!acc && /^1\d{10}$/.test(id)) {
    for (const [name, a] of Object.entries(accounts)) if (a.phone === id) { acc = a; uname = name; break }
  }
  if (!acc) return { error: '账户不存在，请先注册' }
  if (acc.enabled === false) return { error: '该账号已被停用' }
  if (acc.passwordHash !== hashPassword(password, acc.salt)) return { error: '密码不对' }
  return { ok: true, userId: acc.userId, username: uname, phone: acc.phone || '' }
}

/** 列出账户（admin 用） */
export function listAccounts() {
  const accounts = loadAccounts()
  return Object.entries(accounts).map(([username, a]) => ({
    username, userId: a.userId, phone: a.phone || '', enabled: a.enabled !== false, note: a.note, createdAt: a.createdAt,
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

// ===================================================================
// ========== CEO驾驶舱 · 成员账号 / 会话 / 共享槽 / 审计（增量，独立于进销存账号） ==========
// 独立命名空间：members.json ≠ accounts.json；共享槽固定 'cockpit'，一套共享数据
// ===================================================================

const MEMBERS_FILE = path.join(DATA_ROOT, 'members.json')
const AUDIT_FILE = path.join(DATA_ROOT, 'audit.log')
const COCKPIT_SLOT = 'cockpit' // 驾驶舱固定共享槽位

export function cockpitSlotId(userId) { return String(userId || '') }

// ---------- 驾驶舱成员表（管理员建号，无公开自助注册） ----------
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
  const member = { username: name, passwordHash, salt, userId: crypto.randomBytes(16).toString('hex'), createdAt: new Date().toISOString(), enabled: true }
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

// ---------- 共享槽密钥（服务端代管，登录后经 HTTPS 下发；与 cloudCrypto.generateKey 同格式 32字节 base64url） ----------
export function getOrCreateSlotKey(userId = '') {
  const uid = String(userId || '').trim() || COCKPIT_SLOT
  const dir = userDir(uid)
  ensureDir(dir)
  const keyFile = path.join(dir, 'slot.key')
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim()
  const k = crypto.randomBytes(32).toString('base64url')
  atomicWrite(keyFile, k)
  return k
}

// ---------- 会话（内存 Map，重启清空；成员重新登录即可） ----------
const sessions = new Map() // token -> { username, userId, expiresAt }

export function createSession(token, username, ttlMs) {
  const acc = loadAccounts()[String(username || '').trim().toLowerCase()]
  const userId = (acc && acc.userId) || COCKPIT_SLOT
  sessions.set(token, { username, userId, expiresAt: Date.now() + (ttlMs || 12 * 60 * 60 * 1000) })
}

export function validateSession(token) {
  if (!token) return null
  const s = sessions.get(token)
  if (!s) return null
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null }
  const acc = loadAccounts()[String(s.username || '').trim().toLowerCase()]
  if (!acc || acc.enabled === false) { sessions.delete(token); return null }
  return s
}

export function revokeSession(token) { if (token) sessions.delete(token) }

// ---------- 手机验证码 / 找回密码（多租户：账号可自助注册/找回；code 只存哈希；限流/TTL/错误上限） ----------
const VERIFIES = new Map() // phone -> { codeHash, expiresAt, attempts, lastSendAt }
const SEND_IP_HITS = new Map() // ip -> [timestamps]
const CODE_TTL_MS = 5 * 60 * 1000
const CODE_MAX_ATTEMPTS = 5
const SEND_PHONE_GAP_MS = 60 * 1000
const SEND_IP_MIN_RATE = 5

export function sendCode(phone, ip = '') {
  const ph = String(phone || '').trim()
  if (!/^1\d{10}$/.test(ph)) return { error: '手机号格式不正确' }
  const ent = VERIFIES.get(ph)
  if (ent && ent.lastSendAt && Date.now() - ent.lastSendAt < SEND_PHONE_GAP_MS) return { error: '发送过于频繁，请 1 分钟后再试' }
  const now = Date.now()
  const ipKey = String(ip || 'unknown')
  const cutoff = now - 60_000
  const ipHits = (SEND_IP_HITS.get(ipKey) || []).filter(t => t > cutoff)
  if (ipHits.length >= SEND_IP_MIN_RATE) return { error: '该网络发送过于频繁，请稍后再试' }
  SEND_IP_HITS.set(ipKey, [...ipHits, now])
  const code = (process.env.COCKPIT_SMS_MOCK === '1') ? '123456' : String(Math.floor(100000 + Math.random() * 900000)) // dev 测试码 123456；上线走真网关
  VERIFIES.set(ph, { codeHash: crypto.createHash('sha256').update(code).digest('hex'), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, lastSendAt: Date.now() })
  return { ok: true, mockCode: (process.env.COCKPIT_SMS_MOCK === '1' ? code : undefined) }
}

export function verifyCode(phone, code) {
  const ph = String(phone || '').trim()
  const ent = VERIFIES.get(ph)
  if (!ent) return { error: '请先获取验证码' }
  if (Date.now() > ent.expiresAt) { VERIFIES.delete(ph); return { error: '验证码已过期，请重新获取' } }
  if (ent.attempts >= CODE_MAX_ATTEMPTS) { VERIFIES.delete(ph); return { error: '验证码错误次数过多，请重新获取' } }
  const h = crypto.createHash('sha256').update(String(code || '')).digest('hex')
  const devOk = (process.env.COCKPIT_SMS_MOCK === '1' && String(code || '').trim() === '123456')
  if (h !== ent.codeHash && !devOk) {
    ent.attempts += 1
    VERIFIES.set(ph, ent)
    const left = CODE_MAX_ATTEMPTS - ent.attempts
    return { error: left > 0 ? '验证码不正确，还可尝试 ' + left + ' 次' : '验证码错误次数过多，请重新获取' }
  }
  VERIFIES.delete(ph) // 用后即焚
  return { ok: true }
}

export function findByPhone(phone) {
  const ph = String(phone || '').trim()
  const accounts = loadAccounts()
  for (const [name, a] of Object.entries(accounts)) if (a.phone === ph) return { ...a, username: name }
  return null
}

export function forgotPasswordByPhone(phone, code, newPassword) {
  const vc = verifyCode(phone, code)
  if (!vc.ok) return { error: vc.error || '验证码错误或已过期' }
  if (!newPassword || String(newPassword).length < 6) return { error: '新密码至少 6 位' }
  const hit = findByPhone(phone)
  if (!hit) return { error: '该手机号未注册' }
  const uname = hit.username
  const salt = crypto.randomBytes(16).toString('hex')
  const accounts = loadAccounts()
  accounts[uname].salt = salt
  accounts[uname].passwordHash = hashPassword(String(newPassword), salt)
  saveAccounts(accounts)
  return { ok: true, username: uname }
}

// ---------- 图形/滑块验证码（零依赖：数学题验证码，防脚本刷发码；上线可替换为图片/滑块） ----------
const CAPTCHAS = new Map() // id -> { answerHash, expiresAt }
export function createCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1
  const b = Math.floor(Math.random() * 9) + 1
  const plus = Math.random() < 0.5
  const ans = plus ? a + b : a - b
  const id = crypto.randomBytes(8).toString('hex')
  CAPTCHAS.set(id, { answerHash: crypto.createHash('sha256').update(String(ans)).digest('hex'), expiresAt: Date.now() + 3 * 60 * 1000 })
  return { captchaId: id, question: plus ? (a + ' + ' + b + ' = ?') : (a + ' - ' + b + ' = ?') }
}
export function verifyCaptcha(id, answer) {
  const rec = CAPTCHAS.get(String(id || ''))
  if (!rec) return false
  CAPTCHAS.delete(String(id || '')) // 一次性
  if (Date.now() > rec.expiresAt) return false
  const h = crypto.createHash('sha256').update(String(answer ?? '').trim()).digest('hex')
  return h === rec.answerHash
}

// ---------- 审计（追加写，真实现：谁、何时、做了什么） ----------
export function audit(action, username, detail, userId) {
  try {
    const uid = String(userId || '').trim() || COCKPIT_SLOT
    const line = JSON.stringify({ ts: new Date().toISOString(), username: username || 'anonymous', userId: uid, action, detail: detail || '' })
    fs.appendFileSync(AUDIT_FILE, line + '\n')
  } catch { /* 审计不影响主流程 */ }
}

// ===================================================================
// ========== 驾驶舱账号 V2（收尾）：phone+短验码 · scrypt · 每账号槽位 · KB仅店主 ==========
// 独立于进销存 accounts.json，避免 cockpit 与进销存账号混用；满足 scrypt / 每账号隔离 / 统计。
// ===================================================================
const COCKPIT_ACC_FILE = path.join(DATA_ROOT, 'cockpit-accounts.json')
const cockpitSessions = new Map() // token -> { phone, name, userId, isOwner, expiresAt }
const cockpitFailures = new Map() // phone -> { count, lastAt }
const COCKPIT_MAX_FAILS = 5
const COCKPIT_LOCK_MS = 15 * 60 * 1000

function loadCockpitAccs() { try { return JSON.parse(fs.readFileSync(COCKPIT_ACC_FILE, 'utf8')) } catch { return {} } }
function saveCockpitAccs(accs) { ensureDir(DATA_ROOT); atomicWrite(COCKPIT_ACC_FILE, JSON.stringify(accs)) }

export function cockpitScryptHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex')
}
export function cockpitVerifyScrypt(password, hash, salt) {
  try {
    const h = crypto.scryptSync(String(password), String(salt), 64).toString('hex')
    const a = Buffer.from(h, 'hex'), b = Buffer.from(String(hash), 'hex')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch { return false }
}

export function findCockpitAccByPhone(phone) {
  const ph = String(phone || '').trim()
  return ph ? (loadCockpitAccs()[ph] || null) : null
}
export function findCockpitAccByName(name) {
  const n = String(name || '').trim()
  for (const a of Object.values(loadCockpitAccs())) if (a.name === n) return a
  return null
}

// isOwner=true 表示店主账号（持有 KB）；自助注册 isOwner=false（空槽，≠ KB）
export function createCockpitAcc({ phone, name, password, isOwner = false }) {
  const ph = String(phone || '').trim()
  if (!/^1\d{10}$/.test(ph)) return { error: '手机号格式不正确' }
  if (!password || String(password).length < 6) return { error: '密码至少 6 位' }
  const accs = loadCockpitAccs()
  if (accs[ph]) return { error: '该手机号已注册' }
  const nm = String(name || '').trim()
  if (nm && findCockpitAccByName(nm)) return { error: '该账号名已被使用' }
  const userId = crypto.randomBytes(16).toString('hex')
  initUser(userId)
  const salt = crypto.randomBytes(16).toString('hex')
  accs[ph] = { phone: ph, name: nm || ph.slice(-4), userId, salt, passHash: cockpitScryptHash(password, salt), isOwner: !!isOwner, enabled: true, createdAt: new Date().toISOString(), lastLoginAt: null, lastSeenAt: null }
  saveCockpitAccs(accs)
  return { ok: true, account: accs[ph] }
}

export function updateCockpitAcc(phone, patch) {
  const ph = String(phone || '').trim()
  const accs = loadCockpitAccs()
  if (!accs[ph]) return null
  accs[ph] = Object.assign({}, accs[ph], patch)
  saveCockpitAccs(accs)
  return accs[ph]
}

export function listCockpitAccs() { return Object.values(loadCockpitAccs()) }
export function countCockpitAccs() { return Object.keys(loadCockpitAccs()).length }

// 用户/在线统计：online=最近 onlineMs 有活跃；newToday=今日新注册
export function cockpitStats(onlineMs = 5 * 60 * 1000) {
  const accs = Object.values(loadCockpitAccs())
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  return {
    totalUsers: accs.length,
    onlineNow: accs.filter((a) => a.lastSeenAt && (now - new Date(a.lastSeenAt).getTime()) <= onlineMs).length,
    newToday: accs.filter((a) => a.createdAt && a.createdAt.slice(0, 10) === today).length,
  }
}

// 每账号自己的槽位密钥
export function getCockpitSlotKey(userId) {
  const dir = userDir(userId); ensureDir(dir)
  const kf = path.join(dir, 'slot.key')
  if (fs.existsSync(kf)) return fs.readFileSync(kf, 'utf8').trim()
  const k = crypto.randomBytes(32).toString('base64url'); atomicWrite(kf, k); return k
}

// 会话（可撤销+过期，每账号独立槽）
export function createCockpitSession(token, account, ttlMs = 12 * 60 * 60 * 1000) {
  cockpitSessions.set(token, { phone: account.phone, name: account.name, userId: account.userId, isOwner: !!account.isOwner, expiresAt: Date.now() + ttlMs })
}
export function validateCockpitSession(token) {
  if (!token) return null
  const s = cockpitSessions.get(token); if (!s) return null
  if (Date.now() > s.expiresAt) { cockpitSessions.delete(token); return null }
  const a = findCockpitAccByPhone(s.phone)
  if (!a || !a.enabled) { cockpitSessions.delete(token); return null }
  return Object.assign({}, s, { account: a })
}
export function revokeCockpitSession(token) { if (token) cockpitSessions.delete(token) }
export function touchCockpitSeen(phone) { const a = findCockpitAccByPhone(phone); if (a) updateCockpitAcc(phone, { lastSeenAt: new Date().toISOString() }) }

// 登录失败锁定（内存，按手机号）
export function cockpitLoginLocked(phone) {
  const ph = String(phone || '').trim(); const f = cockpitFailures.get(ph)
  if (!f) return false
  if (Date.now() - f.lastAt > COCKPIT_LOCK_MS) { cockpitFailures.delete(ph); return false }
  return f.count >= COCKPIT_MAX_FAILS
}
export function recordCockpitFail(phone) { const ph = String(phone || '').trim(); const f = cockpitFailures.get(ph) || { count: 0, lastAt: 0 }; f.count += 1; f.lastAt = Date.now(); cockpitFailures.set(ph, f) }
export function clearCockpitFail(phone) { cockpitFailures.delete(String(phone || '').trim()) }

// 建店主账号时把旧共享 cockpit 槽的 KB 快照/密钥迁进店主槽位（防数据丢失）
export function migrateSharedSlotToOwner(userId) {
  const src = userDir(COCKPIT_SLOT), dst = userDir(userId)
  if (!fs.existsSync(src)) return false
  ensureDir(dst); let moved = false
  try {
    const snap = path.join(src, 'snapshot.enc'); if (fs.existsSync(snap)) { atomicWrite(path.join(dst, 'snapshot.enc'), fs.readFileSync(snap, 'utf8')); moved = true }
    const key = path.join(src, 'slot.key'); if (fs.existsSync(key)) { atomicWrite(path.join(dst, 'slot.key'), fs.readFileSync(key, 'utf8')); moved = true }
    const bak = path.join(src, 'backups'); if (fs.existsSync(bak)) for (const f of fs.readdirSync(bak)) { const ff = path.join(bak, f); if (fs.statSync(ff).isFile()) { ensureDir(path.join(dst, 'backups')); atomicWrite(path.join(dst, 'backups', f), fs.readFileSync(ff, 'utf8')); moved = true } }
  } catch { }
  return moved
}
