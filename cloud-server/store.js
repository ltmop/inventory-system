// 云备份存储层：用户目录管理 + 备份版本清理
// 零 npm 依赖，纯 node:fs + node:path + node:crypto
// 铁律：所有写操作先写 .tmp 再 rename（防半截文件）
import fs from 'node:fs'
import path from 'node:path'

const DATA_ROOT = process.env.CLOUD_DATA_ROOT || path.join(process.cwd(), 'data')
const USERS_DIR = path.join(DATA_ROOT, 'users')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  // 安全加固（2026-09-10）：数据目录仅服务属主可进入（Linux 生效；Windows 上 chmod 语义有限，失败忽略）
  try { fs.chmodSync(dir, 0o700) } catch { }
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, filePath)
  // 安全加固（2026-09-10）：凭据/快照/slot.key 一律 0600，替代 umask 默认的 0644
  try { fs.chmodSync(filePath, 0o600) } catch { }
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
  const file = path.join(dir, `${date}.enc`)
  // 多设备保险（2026-09-12）：同一天已有备份时，先把旧的一份挪到 backups-prev/，绝不静默销毁。
  // 场景：两台电脑同一天各上传一次整库备份，后到的会覆盖先到的；这样先到那台的数据仍可恢复。
  // listBackups 只读 backups/，因此对外语义与文件名格式完全不变。
  try {
    if (fs.existsSync(file)) {
      const prevDir = path.join(userDir(userId), 'backups-prev')
      ensureDir(prevDir)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.renameSync(file, path.join(prevDir, `${date}.${stamp}.enc`))
    }
  } catch { /* 旧备份保不住也不能挡住新备份写入 */ }
  atomicWrite(file, JSON.stringify({ iv, data }))
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
  for (const sub of ['backups', 'backups-prev']) {
    const dir = path.join(userDir(userId), sub)
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
}
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
export function registerAccount(username, password, note = '', phone = '', code = '', opts = {}) {
  const uname = String(username || '').trim().toLowerCase()
  if (!uname || uname.length < 2) return { error: '用户名至少 2 个字符' }
  if (!password || String(password).length < 6) return { error: '密码至少 6 位' }
  const ph = String(phone || '').trim()
  // 2026-09-11 修正：/api/account/* 是【进销存设备账号线】，用户名+密码本就是它的设计（客户端没有手机号输入框）；
  // 把「驾驶舱租户线」的强制手机号规则套过来，直接打断了已发布客户端的注册（生产实测 400）。
  // 现改为**策略可配**：默认允许无手机号注册；设 REQUIRE_PHONE_ON_REGISTER=1 才强制（等短信网关上线/对外开放注册时再开）。
  // 传了手机号则仍然必须验证码正确（这条不变）。
  const requirePhone = opts.requirePhone === true
  if (!ph && requirePhone) return { error: '需要手机号 + 短信验证码' }
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
const loginFailures = new Map()  // key: ip + '|' + username -> { count, lockedUntil }
const loginIpHits = new Map()    // ip -> [timestamps]
const registerIpDay = new Map()  // key: ip + '|' + yyyy-mm-dd -> count
// 安全加固（2026-09-10）：同一 IP 跨账号失败聚合（防横向撞库）。
// 只在 IP 可信时启用：未启用可信反代时所有请求的 remoteAddress 都是代理地址，
// 聚合封禁会误伤全站用户（与复核报告 R2 同一根因）→ fail-safe 默认关闭。
const ipFailures = new Map()        // ip -> { count, lockedUntil }
const accountFailTotals = new Map() // username -> 累计失败次数（仅告警/审计用，不锁号）
const IP_AGG_ENABLED = process.env.TRUST_PROXY === '1'
const IP_FAIL_LOCK_THRESHOLD = Number(process.env.IP_FAIL_LOCK_THRESHOLD || 20)

/** 登录前检查：IP 聚合封禁 + IP 限速 + 账号锁定（键含 IP） */
export function checkLoginAllowed(ip, username) {
  const now = Date.now()
  if (IP_AGG_ENABLED) {
    const ir = ipFailures.get(ip)
    if (ir && ir.lockedUntil && now < ir.lockedUntil) {
      const mins = Math.ceil((ir.lockedUntil - now) / 60000)
      return { allowed: false, error: '该网络失败尝试过多，已临时限制，请 ' + mins + ' 分钟后再试' }
    }
  }
  // IP 限速：每分钟 10 次
  const cutoff = now - 60_000
  const ipList = (loginIpHits.get(ip) ?? []).filter((t) => t > cutoff)
  if (ipList.length >= LOGIN_IP_RATE) return { allowed: false, error: '尝试太频繁，请 1 分钟后再试' }
  // 账号锁定检查：锁键含 IP —— 既挡住单一来源的爆破，又避免第三方跨 IP 把正常用户锁死
  const key = ip + '|' + String(username || '').trim().toLowerCase()
  const rec = loginFailures.get(key)
  if (rec && rec.lockedUntil && now < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - now) / 60000)
    return { allowed: false, error: '连续失败次数过多，已锁定，请 ' + mins + ' 分钟后再试' }
  }
  loginIpHits.set(ip, [...ipList, now])
  return { allowed: true, key }
}

/** 登录结果上报：成功清零计数；失败计数，达阈值锁定（账号维度 + 可选 IP 聚合维度） */
export function reportLoginResult(ip, username, success) {
  const uname = String(username || '').trim().toLowerCase()
  const key = ip + '|' + uname
  if (success) {
    loginFailures.delete(key)
    if (IP_AGG_ENABLED) ipFailures.delete(ip)
    accountFailTotals.delete(uname)
    return
  }
  const rec = loginFailures.get(key) ?? { count: 0, lockedUntil: null }
  rec.count += 1
  if (rec.count >= LOGIN_LOCK_THRESHOLD) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS
    rec.count = 0
  }
  loginFailures.set(key, rec)
  accountFailTotals.set(uname, (accountFailTotals.get(uname) ?? 0) + 1)
  if (IP_AGG_ENABLED) {
    const ir = ipFailures.get(ip) ?? { count: 0, lockedUntil: null }
    ir.count += 1
    if (ir.count >= IP_FAIL_LOCK_THRESHOLD) { ir.lockedUntil = Date.now() + LOGIN_LOCK_MS; ir.count = 0 }
    ipFailures.set(ip, ir)
  }
}

/** 安全计数器快照（供体检/告警；不含任何凭据） */
export function securitySnapshot() {
  const now = Date.now()
  const lockedAccounts = []
  for (const [k, v] of loginFailures) if (v.lockedUntil && now < v.lockedUntil) lockedAccounts.push(k)
  const blockedIps = IP_AGG_ENABLED
    ? [...ipFailures].filter(([, v]) => v.lockedUntil && now < v.lockedUntil).map(([k]) => k)
    : []
  return {
    ipAggEnabled: IP_AGG_ENABLED,
    lockedAccounts,
    blockedIps,
    topFailingAccounts: [...accountFailTotals].sort((a, b) => b[1] - a[1]).slice(0, 10),
    smsThisHour: SEND_GLOBAL_HOUR.get(new Date(now).toISOString().slice(0, 13)) ?? 0,
    smsHourlyCap: SEND_GLOBAL_HOURLY,
    auditFailures: AUDIT_FAILURES,
  }
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
  // 安全加固（2026-09-10）：账号不存在 / 密码错误 / 停用 的文案不再区分「存在性」，避免用户枚举
  if (!acc) return { error: '账号或密码错误' }
  if (acc.enabled === false) return { error: '该账号已被停用' }
  if (acc.passwordHash !== hashPassword(password, acc.salt)) return { error: '账号或密码错误' }
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
  // 安全加固（2026-09-10）：原实现在 userId 为空时静默回落到旧共享槽 COCKPIT_SLOT，
  // 任何漏传 userId 的调用都会拿到「全租户共享密钥」。现改为显式抛错（fail-closed）。
  const uid = String(userId || '').trim()
  if (!uid) throw new Error('getOrCreateSlotKey: 缺少 userId（拒绝回落到共享槽）')
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
  // 安全加固（2026-09-10）：账号查不到时不再回落到共享槽，否则会话会读写全租户共享数据
  if (!acc || !acc.userId) throw new Error('createSession: 账号不存在，拒绝建立会话')
  sessions.set(token, { username, userId: acc.userId, expiresAt: Date.now() + (ttlMs || 12 * 60 * 60 * 1000) })
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
// 安全加固（2026-09-10）1/2：验证码哈希改 HMAC + 进程级 pepper。
// VERIFIES 只在内存、重启即失效，故 pepper 无需持久化；多实例可用 CODE_PEPPER 统一。
// 目的：内存转储或日志泄露时无法离线反推 6 位数字码（原为无盐单轮 sha256）。
const CODE_PEPPER = process.env.CODE_PEPPER || crypto.randomBytes(32).toString('hex')
function codeHash(phone, code) {
  return crypto.createHmac('sha256', CODE_PEPPER)
    .update(String(phone || '') + '|' + String(code || '').trim()).digest('hex')
}
// 安全加固（2026-09-10）2/2：短信成本硬上限——每手机号每日上限 + 全局每小时上限。
// 换号轰炸场景下全局小时配额是唯一兜底（弱图形验证码挡不住脚本）。
const SEND_PHONE_DAY = new Map() // key: phone + '|' + yyyy-mm-dd
const SEND_PHONE_DAY_CAP = Number(process.env.SEND_PHONE_DAY_CAP || 10)
const SEND_GLOBAL_HOUR = new Map() // key: yyyy-mm-ddThh
const SEND_GLOBAL_HOURLY = Number(process.env.SEND_GLOBAL_HOURLY || 60)

export function sendCode(phone, ip = '') {
  const ph = String(phone || '').trim()
  if (!/^1\d{10}$/.test(ph)) return { error: '手机号格式不正确' }
  const ent = VERIFIES.get(ph)
  if (ent && ent.lastSendAt && Date.now() - ent.lastSendAt < SEND_PHONE_GAP_MS) return { error: '发送过于频繁，请 1 分钟后再试' }
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  const dkey = ph + '|' + day
  if ((SEND_PHONE_DAY.get(dkey) ?? 0) >= SEND_PHONE_DAY_CAP) return { error: '该手机号今日获取验证码次数已达上限，请明天再试' }
  const hour = new Date(now).toISOString().slice(0, 13)
  if ((SEND_GLOBAL_HOUR.get(hour) ?? 0) >= SEND_GLOBAL_HOURLY) return { error: '验证码发送已达本小时上限，请稍后再试或联系管理员' }
  const ipKey = String(ip || 'unknown')
  const cutoff = now - 60_000
  const ipHits = (SEND_IP_HITS.get(ipKey) || []).filter(t => t > cutoff)
  if (ipHits.length >= SEND_IP_MIN_RATE) return { error: '该网络发送过于频繁，请稍后再试' }
  SEND_IP_HITS.set(ipKey, [...ipHits, now])
  SEND_PHONE_DAY.set(dkey, (SEND_PHONE_DAY.get(dkey) ?? 0) + 1)
  SEND_GLOBAL_HOUR.set(hour, (SEND_GLOBAL_HOUR.get(hour) ?? 0) + 1)
  const code = (process.env.COCKPIT_SMS_MOCK === '1') ? '123456' : String(Math.floor(100000 + Math.random() * 900000)) // dev 测试码 123456；上线走真网关
  VERIFIES.set(ph, { codeHash: codeHash(ph, code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, lastSendAt: Date.now() })
  return { ok: true, mockCode: (process.env.COCKPIT_SMS_MOCK === '1' ? code : undefined) }
}

export function verifyCode(phone, code) {
  const ph = String(phone || '').trim()
  const ent = VERIFIES.get(ph)
  if (!ent) return { error: '请先获取验证码' }
  if (Date.now() > ent.expiresAt) { VERIFIES.delete(ph); return { error: '验证码已过期，请重新获取' } }
  if (ent.attempts >= CODE_MAX_ATTEMPTS) { VERIFIES.delete(ph); return { error: '验证码错误次数过多，请重新获取' } }
  const h = codeHash(ph, code)
  if (h !== ent.codeHash) {
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
  if (!hit) return { error: '手机号未注册或验证码不正确' }
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
// 安全加固（2026-09-10）：① 手机号/邮箱脱敏，避免审计日志本身成为 PII 泄露面；
// ② 写失败不再静默——计数并可经 auditFailures() 观测（原先 catch{} 静默丢日志，破坏不可否认性）。
function maskPii(v) {
  return String(v || '')
    .replace(/(1[3-9]\d)\d{4}(\d{4})/g, '$1****$2')
    .replace(/([\w.+-])[\w.+-]*@([\w-]+\.[\w.-]+)/g, '$1***@$2')
}
let AUDIT_FAILURES = 0
export function auditFailures() { return AUDIT_FAILURES }
export function audit(action, username, detail, userId) {
  try {
    const uid = String(userId || '').trim() || 'unknown'
    const line = JSON.stringify({ ts: new Date().toISOString(), username: maskPii(username) || 'anonymous', userId: uid, action, detail: maskPii(detail) })
    fs.appendFileSync(AUDIT_FILE, line + '\n')
  } catch (e) {
    AUDIT_FAILURES += 1
    try { console.error('[cloud-server] audit 写入失败 x' + AUDIT_FAILURES + ': ' + (e && e.message)) } catch { }
  }
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
export function findCockpitAccByUserId(userId) {
  const id = String(userId || '').trim()
  if (!id) return null
  for (const a of Object.values(loadCockpitAccs())) if (a.userId === id) return a
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
  // ADR-001：建号即签发一次性恢复码（明文只在响应里出现这一次）
  const rc = issueRecoveryCode('owner', ph)
  return { ok: true, account: accs[ph], recoveryCode: rc.recoveryCode }
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
    totalMembers: Object.keys(loadTenantMembers()).length,
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
  // 契约 v1.1：成员会话（kind='member'）与店主会话并存；成员的有效性看成员本身 + 所属租户账号
  if (s.kind === 'member') {
    const m = findTenantMemberByPhone(s.phone)
    if (!m || !m.enabled) { cockpitSessions.delete(token); return null }
    const t = findCockpitAccByUserId(s.userId)
    if (!t || !t.enabled) { cockpitSessions.delete(token); return null }
    return Object.assign({}, s, { account: t, member: publicTenantMember(m) })
  }
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

// ===================================================================
// 租户内成员（tenant_members）—— 契约 v1.1，「员工入单」的身份基础
// 模型：租户(tenantUserId = 一套数据槽) <- 成员(memberId + role) <- 设备(token)
// 铁律：成员与店主**共用同一数据槽**（数据同源）；权限差异由 role 在服务端校验，
//       不靠前端隐藏，也不靠数据分区（同一家店的数据本就该在一起）。
// ===================================================================
const TENANT_MEMBERS_FILE = path.join(DATA_ROOT, 'tenant-members.json')
const INVITES = new Map() // phone -> { codeHash, expiresAt, attempts, tenantUserId, name, role, invitedBy }
const INVITE_TTL_MS = 10 * 60 * 1000
const INVITE_MAX_ATTEMPTS = 5
const MEMBER_ROLES = ['owner', 'manager', 'cashier', 'stock', 'viewer']
// 权限矩阵：**一处定义**，驾驶舱 scopeFilter 与进销存命令层共同引用（契约第 4 节）
const ROLE_ACTIONS = {
  owner: ['data.read', 'data.write', 'pos.sell', 'price.change', 'cost.view', 'stock.in', 'order.delete', 'members.list', 'members.manage', 'cockpit.fullView'],
  manager: ['data.read', 'data.write', 'pos.sell', 'price.change', 'cost.view', 'stock.in', 'members.list', 'cockpit.fullView'],
  cashier: ['data.read', 'data.write', 'pos.sell'],
  stock: ['data.read', 'data.write', 'stock.in'],
  viewer: ['data.read'],
}
export function roleCan(role, action) {
  const r = MEMBER_ROLES.includes(String(role)) ? String(role) : 'viewer'
  return (ROLE_ACTIONS[r] || []).includes(String(action))
}
export function roleMatrix() { return JSON.parse(JSON.stringify(ROLE_ACTIONS)) }
export function listRoles() { return MEMBER_ROLES.slice() }
/** 会话的有效角色：成员看 role；店主看 isOwner；其余按最小权限 viewer */
export function sessionRole(sess) {
  if (!sess) return 'viewer'
  if (sess.role && MEMBER_ROLES.includes(sess.role)) return sess.role
  return sess.isOwner ? 'owner' : 'viewer'
}

function loadTenantMembers() { try { return JSON.parse(fs.readFileSync(TENANT_MEMBERS_FILE, 'utf8')) } catch { return {} } }
function saveTenantMembers(m) { ensureDir(DATA_ROOT); atomicWrite(TENANT_MEMBERS_FILE, JSON.stringify(m)) }
export function findTenantMemberByPhone(phone) { const ph = String(phone || '').trim(); return ph ? (loadTenantMembers()[ph] || null) : null }
export function findTenantMemberById(memberId) {
  const id = String(memberId || '').trim()
  if (!id) return null
  for (const m of Object.values(loadTenantMembers())) if (m.memberId === id) return m
  return null
}
export function listTenantMembers(tenantUserId) {
  const t = String(tenantUserId || '').trim()
  return Object.values(loadTenantMembers()).filter((m) => m.tenantUserId === t)
}
/** 对外脱敏视图：绝不外泄 salt / passHash */
export function publicTenantMember(m) {
  if (!m) return null
  return { memberId: m.memberId, phone: m.phone, name: m.name, role: m.role, enabled: !!m.enabled, createdAt: m.createdAt, invitedBy: m.invitedBy || '' }
}

/** 店主添加成员：生成一次性邀请码（10 分钟 TTL、5 次尝试、用后即焚）。
 *  邀请码由**店主本人转达**给员工（当前无短信网关，这比假装发短信更诚实、今天就能用）。 */
export function inviteTenantMember({ tenantUserId, phone, name, role, invitedBy }) {
  const t = String(tenantUserId || '').trim()
  if (!t) return { error: '缺少 tenantUserId' }
  const ph = String(phone || '').trim()
  if (!/^1\d{10}$/.test(ph)) return { error: '手机号格式不正确' }
  const rl = String(role || '').trim()
  if (!MEMBER_ROLES.includes(rl)) return { error: '角色不合法（可选：' + MEMBER_ROLES.join(' / ') + '）' }
  if (rl === 'owner') return { error: 'owner 只能通过店主账号使用，不支持邀请' }
  if (loadCockpitAccs()[ph]) return { error: '该手机号本身就是账号，无需邀请' }
  const exist = findTenantMemberByPhone(ph)
  if (exist && exist.tenantUserId !== t) return { error: '该手机号已加入其他租户' }
  if (exist && exist.enabled) return { error: '该成员已在本租户中' }
  const code = String(Math.floor(100000 + Math.random() * 900000))
  INVITES.set(ph, { codeHash: codeHash(ph, code), expiresAt: Date.now() + INVITE_TTL_MS, attempts: 0, tenantUserId: t, name: String(name || '').trim(), role: rl, invitedBy: String(invitedBy || '') })
  return { ok: true, phone: ph, role: rl, inviteCode: code, expiresInSec: Math.floor(INVITE_TTL_MS / 1000) }
}

/** 员工凭邀请码加入并首次设置密码 */
export function acceptTenantInvite({ phone, inviteCode, password }) {
  const ph = String(phone || '').trim()
  const ent = INVITES.get(ph)
  if (!ent) return { error: '请先让店主发起邀请' }
  if (Date.now() > ent.expiresAt) { INVITES.delete(ph); return { error: '邀请码已过期，请店主重新发起' } }
  if (ent.attempts >= INVITE_MAX_ATTEMPTS) { INVITES.delete(ph); return { error: '邀请码错误次数过多，请店主重新发起' } }
  if (codeHash(ph, String(inviteCode || '').trim()) !== ent.codeHash) {
    ent.attempts += 1
    INVITES.set(ph, ent)
    const left = INVITE_MAX_ATTEMPTS - ent.attempts
    return { error: left > 0 ? ('邀请码不正确，还可尝试 ' + left + ' 次') : '邀请码错误次数过多，请店主重新发起' }
  }
  if (!password || String(password).length < 6) return { error: '密码至少 6 位' }
  INVITES.delete(ph) // 用后即焚
  const members = loadTenantMembers()
  const salt = crypto.randomBytes(16).toString('hex')
  const memberId = 'm_' + crypto.randomBytes(8).toString('hex')
  members[ph] = {
    memberId, tenantUserId: ent.tenantUserId, phone: ph, name: ent.name || ph.slice(-4), role: ent.role,
    enabled: true, salt, passHash: cockpitScryptHash(password, salt),
    invitedBy: ent.invitedBy, createdAt: new Date().toISOString(), lastLoginAt: null,
  }
  saveTenantMembers(members)
  // ADR-001：成员入伙即签发一次性恢复码（明文只在响应里出现这一次）
  const rc = issueRecoveryCode('member', ph)
  return { ok: true, member: publicTenantMember(members[ph]), recoveryCode: rc.recoveryCode }
}

/** 成员登录：手机号 + 密码 -> { member, tenant }（tenant 决定数据槽） */
export function tenantMemberLogin(phone, password) {
  const ph = String(phone || '').trim()
  const m = findTenantMemberByPhone(ph)
  if (!m) return { error: '账号或密码错误' }
  if (!m.enabled) return { error: '该成员已被停用，请联系店主' }
  if (!cockpitVerifyScrypt(password, m.passHash, m.salt)) return { error: '账号或密码错误' }
  const owner = findCockpitAccByUserId(m.tenantUserId)
  if (!owner || !owner.enabled) return { error: '所属租户账号不可用，请联系店主' }
  const members = loadTenantMembers()
  members[ph] = Object.assign({}, m, { lastLoginAt: new Date().toISOString() })
  saveTenantMembers(members)
  return { ok: true, member: members[ph], tenant: owner }
}
export function setTenantMemberEnabled(phone, enabled) {
  const ph = String(phone || '').trim()
  const members = loadTenantMembers()
  if (!members[ph]) return { error: '成员不存在' }
  members[ph].enabled = !!enabled
  saveTenantMembers(members)
  return { ok: true, member: publicTenantMember(members[ph]) }
}

/** 成员会话：userId = 租户槽（数据与店主同源），memberId/role 决定权限 */
export function createTenantMemberSession(token, member, tenant, ttlMs = 12 * 60 * 60 * 1000) {
  cockpitSessions.set(token, {
    kind: 'member', phone: member.phone, name: member.name,
    userId: member.tenantUserId || tenant.userId, isOwner: false,
    memberId: member.memberId, role: member.role,
    expiresAt: Date.now() + ttlMs,
  })
}
export function pendingTenantInvites() { return INVITES.size }

// ===================================================================
// 密码找回兜底（无短信网关场景）——恢复码 / 管理员重置 / 已登录改密
// 设计依据：ADR-001「注册/改密流程强制加恢复码（一次性、离线保存）」，
// 它同时是方案 A（客户端持钥）的前置：持钥后忘记密码 = 数据永久丢失，没有恢复码不能上线。
// 铁律：恢复码只存 scrypt 哈希，明文仅在签发那一次返回；用后立即作废并换发新码。
// ===================================================================
export function setTenantMember(phone, patch) {
  const ph = String(phone || '').trim()
  const members = loadTenantMembers()
  if (!members[ph]) return null
  members[ph] = Object.assign({}, members[ph], patch)
  saveTenantMembers(members)
  return members[ph]
}

const REC_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混 I/O/0/1
function genRecoveryCode() {
  const b = crypto.randomBytes(20)
  let s = ''
  for (let i = 0; i < b.length; i++) s += REC_ALPHA[b[i] % 32]
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16)
}
export function normalizeRecoveryCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z2-9]/g, '') }

/** 签发新恢复码（旧的自动作废）。返回明文，**仅此一次**。 */
export function issueRecoveryCode(kind, phone) {
  const ph = String(phone || '').trim()
  const code = genRecoveryCode()
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = cockpitScryptHash(normalizeRecoveryCode(code), salt)
  if (kind === 'member') {
    if (!setTenantMember(ph, { recSalt: salt, recHash: hash, recIssuedAt: new Date().toISOString() })) return { error: '成员不存在' }
  } else {
    if (!findCockpitAccByPhone(ph)) return { error: '账号不存在' }
    updateCockpitAcc(ph, { recSalt: salt, recHash: hash, recIssuedAt: new Date().toISOString() })
  }
  return { ok: true, recoveryCode: code }
}

/** 已登录改密：验原密码 -> 换新密码 -> 顺带换发恢复码（旧码作废） */
export function changeOwnPassword({ kind, phone, oldPassword, newPassword }) {
  if (!newPassword || String(newPassword).length < 6) return { error: '新密码至少 6 位' }
  const ph = String(phone || '').trim()
  if (kind === 'member') {
    const m = findTenantMemberByPhone(ph)
    if (!m) return { error: '成员不存在' }
    if (!m.enabled) return { error: '该成员已被停用' }
    if (!cockpitVerifyScrypt(oldPassword, m.passHash, m.salt)) return { error: '原密码不正确' }
    const salt = crypto.randomBytes(16).toString('hex')
    setTenantMember(ph, { salt, passHash: cockpitScryptHash(newPassword, salt) })
  } else {
    const a = findCockpitAccByPhone(ph)
    if (!a) return { error: '账号不存在' }
    if (!cockpitVerifyScrypt(oldPassword, a.passHash, a.salt)) return { error: '原密码不正确' }
    const salt = crypto.randomBytes(16).toString('hex')
    updateCockpitAcc(ph, { salt, passHash: cockpitScryptHash(newPassword, salt) })
  }
  const rc = issueRecoveryCode(kind, ph)
  return { ok: true, recoveryCode: rc.recoveryCode }
}

/** 管理员重置（路由层用 ADMIN_KEY 门禁）：账号或成员都支持，并换发恢复码 */
export function adminResetCockpitPassword(phone, newPassword) {
  const ph = String(phone || '').trim()
  if (!newPassword || String(newPassword).length < 6) return { error: '新密码至少 6 位' }
  const a = findCockpitAccByPhone(ph)
  if (a) {
    const salt = crypto.randomBytes(16).toString('hex')
    updateCockpitAcc(ph, { salt, passHash: cockpitScryptHash(newPassword, salt), enabled: true })
    clearCockpitFail(ph)
    const rc = issueRecoveryCode('owner', ph)
    return { ok: true, target: 'owner', phone: ph, recoveryCode: rc.recoveryCode }
  }
  const m = findTenantMemberByPhone(ph)
  if (m) {
    const salt = crypto.randomBytes(16).toString('hex')
    setTenantMember(ph, { salt, passHash: cockpitScryptHash(newPassword, salt) })
    clearCockpitFail(ph)
    const rc = issueRecoveryCode('member', ph)
    return { ok: true, target: 'member', phone: ph, recoveryCode: rc.recoveryCode }
  }
  return { error: '该手机号既不是账号也不是成员' }
}

/** 用恢复码重置密码（无需短信）。成功即作废旧码并换发新码。错误文案不区分存在性。 */
export function recoverByCode(phone, code, newPassword) {
  const ph = String(phone || '').trim()
  if (!newPassword || String(newPassword).length < 6) return { error: '新密码至少 6 位' }
  const norm = normalizeRecoveryCode(code)
  if (!norm) return { error: '请输入恢复码' }
  const acc = findCockpitAccByPhone(ph)
  const mem = acc ? null : findTenantMemberByPhone(ph)
  const target = acc || mem
  if (!target) return { error: '手机号或恢复码不正确' }
  if (!target.recHash || !target.recSalt) return { error: '该手机号尚未生成恢复码，请联系管理员重置' }
  if (!cockpitVerifyScrypt(norm, target.recHash, target.recSalt)) return { error: '手机号或恢复码不正确' }
  const salt = crypto.randomBytes(16).toString('hex')
  const passHash = cockpitScryptHash(newPassword, salt)
  const kind = acc ? 'owner' : 'member'
  if (kind === 'member') setTenantMember(ph, { salt, passHash })
  else updateCockpitAcc(ph, { salt, passHash })
  clearCockpitFail(ph)
  const rc = issueRecoveryCode(kind, ph)
  return { ok: true, kind, recoveryCode: rc.recoveryCode }
}

// ===================================================================
// 进销存业务数据 · 按记录增量同步（契约 v1.1 /api/tenant/*）
// 解决：原 /api/snapshot 是「整库快照覆盖 + x-last-sync 冲突拒绝」，两个员工同时开单会静默丢单。
// 做法：以 (kind, id) 为同步单元，逐记录合并；冲突不覆盖、如实回传（绝不静默丢失）。
// 铁律：服务端**只存密文**（iv+data），明文业务数据永不落盘；与驾驶舱知识库快照（/api/cockpit/snapshot）是两个数据平面。
// ===================================================================
// 契约修订（2026-09-12，待 IAM 会签）：kind 由 6 种扩到 19 种。
// 原因：客户端有 19 张要同步的表，原 6 种覆盖不到 13 张  其中 inventory_batches（FIFO 批次）
//       最关键：不同步它，跨设备拉回的单据会引用不存在的批次。
// 做法：kind = 本地表名的单数化（原 6 种沿用不变，stock_takes 继续用老的 'stocktake'）。
// 纯加法、向后兼容：原 6 种语义一字不变；'order' 之类非表名仍是非法类型（原测试断言不受影响）。
const BIZ_KINDS = [
  //  原有 6 种（语义不变） 
  'transaction', 'product', 'customer', 'supplier', 'stocktake', 'payment',
  //  新增 13 种：补齐 19 张同步表 
  'inventory_batch', 'stock_take_item', 'category', 'unit', 'expense',
  'purchase_order', 'purchase_order_item', 'price_tier', 'kit', 'kit_item',
  'supplier_payment', 'waste_log', 'payment_register',
]
function bizLogFile(userId) { return path.join(userDir(userId), 'bizlog.json') }
function loadBizLog(userId) {
  try { const j = JSON.parse(fs.readFileSync(bizLogFile(userId), 'utf8')); if (j && j.records) return j } catch { }
  return { cursor: 0, records: {} }
}
function saveBizLog(userId, lg) { ensureDir(userDir(userId)); atomicWrite(bizLogFile(userId), JSON.stringify(lg)) }

export function tenantSync(userId, opts = {}) {
  const uid = String(userId || '').trim()
  if (!uid) return { error: '缺少租户标识' }
  const lg = loadBizLog(uid)
  const changes = Array.isArray(opts.changes) ? opts.changes.slice(0, 2000) : []
  const applied = []
  const conflicts = []
  let seq = Number(lg.cursor) || 0
  for (const c of changes) {
    const kind = String(c && c.kind || '').trim()
    const id = String(c && c.id || '').trim()
    if (!kind || !id) continue
    if (BIZ_KINDS.indexOf(kind) < 0) return { error: '不支持的记录类型: ' + kind }
    const key = kind + '|' + id
    const prev = lg.records[key]
    const inAt = String(c.updatedAt || '')
    // 冲突判据：服务端已有更新版本 -> 不覆盖，如实回传，交由客户端呈现/重放
    if (prev && String(prev.updatedAt || '') > inAt) {
      conflicts.push({ kind, id, serverUpdatedAt: prev.updatedAt, clientUpdatedAt: inAt, server: { iv: prev.iv || '', data: prev.data || '', deleted: !!prev.deleted } })
      continue
    }
    seq += 1
    lg.records[key] = { seq, kind, id, updatedAt: inAt || new Date().toISOString(), deleted: !!c.deleted, iv: c.deleted ? '' : String(c.iv || ''), data: c.deleted ? '' : String(c.data || '') }
    applied.push(key)
  }
  if (applied.length) { lg.cursor = seq; saveBizLog(uid, lg) }
  const since = Number(opts.cursor) || 0
  const lim = Math.min(Math.max(Number(opts.limit) || 500, 1), 1000)
  const rest = Object.values(lg.records).filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq)
  const out = rest.slice(0, lim).map((r) => ({ kind: r.kind, id: r.id, updatedAt: r.updatedAt, deleted: !!r.deleted, iv: r.iv || '', data: r.data || '', seq: r.seq }))
  return { ok: true, cursor: Number(lg.cursor) || 0, applied, conflicts, changes: out, hasMore: rest.length > out.length }
}

/** 业务数据水位（不含任何明文；供体检/排障） */
export function tenantBizStats(userId) {
  const lg = loadBizLog(String(userId || ''))
  const byKind = {}
  for (const r of Object.values(lg.records)) byKind[r.kind] = (byKind[r.kind] || 0) + 1
  return { cursor: Number(lg.cursor) || 0, totalRecords: Object.keys(lg.records).length, byKind }
}
