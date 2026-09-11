// 云备份 + 远程看店 · HTTP 服务
// 零 npm 依赖，纯 node:http + node:crypto
// 铁律：服务器只存密文，没有任何接口能写回本地业务库
import http from 'node:http'
import crypto from 'node:crypto'
import * as store from './store.js'

const PORT = parseInt(process.env.PORT || '3100', 10)
const ADMIN_KEY = process.env.ADMIN_KEY
if (!ADMIN_KEY) {
  console.warn('[cloud-server] 未设置 ADMIN_KEY 环境变量，/admin 路由不可用')
}

const MAX_BODY = 100 * 1024 * 1024 // 100MB（备份用）

// ---------- 启动守卫与开关（安全加固 2026-09-10） ----------
// CAPTCHA_REQUIRED=1 时发码接口强制图形验证码（需客户端已支持；默认关，见 /api/cockpit/sendCode）
const CAPTCHA_REQUIRED = process.env.CAPTCHA_REQUIRED === '1'
// CORS：默认保持历史行为 '*'；可用 ALLOW_ORIGIN 收紧为具体来源（如 http://127.0.0.1:18866）
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*'
// 短信测试模式：开发环境可用（任何手机号 123456），生产环境 fail-closed 拒绝启动。
// 目的：把「部署时忘了 unset COCKPIT_SMS_MOCK」从静默后门变成可见的启动失败。
if (process.env.COCKPIT_SMS_MOCK === '1') {
  if (process.env.NODE_ENV === 'production') {
    console.error('[cloud-server] ✗ 启动被拒绝：生产环境（NODE_ENV=production）禁止 COCKPIT_SMS_MOCK=1。')
    console.error('  该开关会让任意手机号用固定验证码 123456 完成注册/找回密码，等同后门。')
    console.error('  处理：确保启动环境不含 COCKPIT_SMS_MOCK（pm2 restart inventory-cloud --update-env），再重启。')
    process.exit(1)
  }
  console.warn('[cloud-server] ⚠ 短信为测试模式（COCKPIT_SMS_MOCK=1，任何手机号可用 123456），仅限开发环境！')
}

// ---------- 工具 ----------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': ALLOW_ORIGIN })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY) { req.destroy(); reject(new Error('body too large')) }
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function randomHex(n) { return crypto.randomBytes(n).toString('hex') }

// ---------- 客户端真实 IP（安全加固 2026-09-10） ----------
// 反代（Caddy/Nginx）后 req.socket.remoteAddress 恒为代理地址，会让全部限流退化成「全站单桶」：
// 注册日限变全站 20/天、登录限变全站 10/分、失败锁定键里的 IP 维度失去意义。
// 仅在明确信任反代时（TRUST_PROXY=1）采用 X-Forwarded-For，且取「最右一跳」：
// 代理无论追加还是覆盖 XFF，最右值都是它实际看到的客户端 IP，可抗客户端伪造。
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
function clientIp(req) {
  if (TRUST_PROXY) {
    const raw = req.headers['x-forwarded-for']
    if (typeof raw === 'string' && raw.trim()) {
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
      if (parts.length) return parts[parts.length - 1].slice(0, 64)
    }
    const real = req.headers['x-real-ip']
    if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 64)
  }
  return req.socket.remoteAddress ?? 'unknown'
}

// ---------- ADMIN_KEY 校验（安全加固 2026-09-10） ----------
// 原实现：明文 !==  比较、可用 query string 传（进访问日志）、无失败锁定（可在线爆破）。
// 现：常量时间比较 + 优先 x-admin-key 头 + 按 IP 失败锁定；未提供密钥不计失败（不影响自助注册）。
function safeKeyEqual(got, expect) {
  if (!got || !expect) return false
  const a = crypto.createHash('sha256').update(String(got)).digest()
  const b = crypto.createHash('sha256').update(String(expect)).digest()
  return crypto.timingSafeEqual(a, b)
}
const adminFails = new Map() // ip -> { count, lockedUntil }
const ADMIN_FAIL_THRESHOLD = Number(process.env.ADMIN_FAIL_THRESHOLD || 10)
const ADMIN_FAIL_LOCK_MS = 15 * 60 * 1000
function adminLocked(ip) {
  const r = adminFails.get(ip)
  if (!r || !r.lockedUntil) return false
  if (Date.now() > r.lockedUntil) { adminFails.delete(ip); return false }
  return true
}
function recordAdminFail(ip) {
  const r = adminFails.get(ip) || { count: 0, lockedUntil: 0 }
  r.count += 1
  if (r.count >= ADMIN_FAIL_THRESHOLD) { r.lockedUntil = Date.now() + ADMIN_FAIL_LOCK_MS; r.count = 0 }
  adminFails.set(ip, r)
}
function adminKeyFrom(req, bodyObj, url) {
  const h = req.headers['x-admin-key']
  if (typeof h === 'string' && h) return { key: h, via: 'header' }
  if (bodyObj && bodyObj.adminKey) return { key: bodyObj.adminKey, via: 'body' }
  const q = url && url.searchParams.get('key')
  if (q) return { key: q, via: 'query' }
  return { key: '', via: 'none' }
}
/** 返回 { ok:true } 或 { ok:false, status, error }；未提供密钥不计数 */
function checkAdminKey(req, bodyObj, url) {
  const ip = clientIp(req)
  if (adminLocked(ip)) return { ok: false, status: 429, error: '管理员密钥尝试过多，已临时限制，请稍后再试' }
  const { key, via } = adminKeyFrom(req, bodyObj, url)
  if (!key) return { ok: false, status: 401, error: '需要 ADMIN_KEY' }
  if (!ADMIN_KEY || !safeKeyEqual(key, ADMIN_KEY)) {
    recordAdminFail(ip)
    return { ok: false, status: 401, error: '需要 ADMIN_KEY' }
  }
  adminFails.delete(ip)
  if (via === 'query') console.warn('[cloud-server] ⚠ ADMIN_KEY 经 query string 传递（会进访问日志），建议改用 x-admin-key 请求头')
  return { ok: true, via }
}

function checkToken(req, expected) {
  const t = req.headers['x-token']
  if (!t || t !== expected) return false
  return true
}

// ---------- 驾驶舱账号 · scrypt 哈希 + 登录失败锁定（零依赖，内置 node:crypto） ----------
function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex')
}
function verifyScrypt(password, hash, salt) {
  try {
    const h = crypto.scryptSync(String(password), String(salt), 64).toString('hex')
    const a = Buffer.from(h, 'hex')
    const b = Buffer.from(String(hash), 'hex')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch { return false }
}
// 登录失败锁定统一由 store.checkLoginAllowed / store.reportLoginResult 负责（2026-09-10 复核）。
// 此处原有一套从未被调用的本地锁实现（loginLocked/recordLoginFail/clearLoginFail），
// 属死代码且与 store 版并存易误用，已移除。

// ---------- 用户鉴权中间件 ----------

function requireUser(req, res) {
  // 多设备：优先按 uploadToken 匹配设备 → userId；兼容旧版按 x-user-id 单 token
  const token = req.headers['x-token']
  if (token) {
    const hit = store.findDeviceByToken(token)
    if (hit) return hit.userId
    // 旧版单 token 兼容：x-user-id + meta.uploadToken
    const userId = req.headers['x-user-id']
    if (userId && fs.existsSync(store.userDir(userId))) {
      const meta = store.loadMeta(userId)
      if (meta.uploadToken === token) return userId
    }
  }
  const userId = req.headers['x-user-id']
  if (!userId || !fs.existsSync(store.userDir(userId))) {
    json(res, 401, { ok: false, error: '未配对或用户不存在' })
    return null
  }
  return userId
}

function requireUploadAuth(req, res) {
  const userId = requireUser(req, res)
  if (!userId) return null
  const token = req.headers['x-token']
  if (!token) { json(res, 401, { ok: false, error: '缺少 uploadToken' }); return null }
  // 多设备 devices 匹配 or 旧单 token 匹配
  const hit = store.findDeviceByToken(token)
  if (hit) return hit.userId
  const meta = store.loadMeta(userId)
  if (meta.uploadToken === token) return userId
  json(res, 401, { ok: false, error: 'uploadToken 无效' })
  return null
}

// 简洁 fs import
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,x-token,x-user-id,x-date,x-admin-key' })
    res.end()
    return
  }

  // ======== GET /updates/* —— 自动更新源（latest.yml + 安装包静态托管） ========
  if (req.method === 'GET' && pathname.startsWith('/updates/')) {
    const __dirname = fileURLToPath(new URL('.', import.meta.url))
    const rel = pathname.slice('/updates/'.length)
    const safe = rel.split('/').filter((p) => p && p !== '..' && !p.includes('\\')).join('/')
    const full = path.join(__dirname, 'updates', safe)
    try {
      const st = fs.statSync(full)
      if (st.isFile()) {
        const ext = full.split('.').pop().toLowerCase()
        const types = { yml: 'text/yaml', yaml: 'text/yaml', exe: 'application/octet-stream', blockmap: 'application/octet-stream' }
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        fs.createReadStream(full).pipe(res)
        return
      }
    } catch { /* 404 below */ }
    return json(res, 404, { ok: false, error: 'update file not found' })
  }

  // ======== GET /cockpit-updates/* —— 驾驶舱自动更新源（latest.yml + Setup exe 静态托管；独立于进销存 /updates/*） ========
  if (req.method === 'GET' && pathname.startsWith('/cockpit-updates/')) {
    const __dirname = fileURLToPath(new URL('.', import.meta.url))
    // FIX 2026-09-11: pathname is the raw (percent-encoded) request path, so any artifact whose name
    // contains a space or a non-ASCII char could never be served (statSync on '%E4%BB%BB...' always
    // failed -> 404), which silently broke auto-update for every previous release. Decode first.
    let rel = pathname.slice('/cockpit-updates/'.length)
    try { rel = decodeURIComponent(rel) } catch (e) { rel = '' }
    const safe = rel.split('/').filter((p) => p && p !== '..' && !p.includes('\\')).join('/')
    const full = path.join(__dirname, 'cockpit-updates', safe)
    try {
      const st = fs.statSync(full)
      if (st.isFile()) {
        const ext = full.split('.').pop().toLowerCase()
        const types = { yml: 'text/yaml', yaml: 'text/yaml', exe: 'application/octet-stream', blockmap: 'application/octet-stream' }
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        fs.createReadStream(full).pipe(res)
        return
      }
    } catch { /* 404 below */ }
    return json(res, 404, { ok: false, error: 'update file not found' })
  }

  try {
    // ======== GET /api/account/captcha（发码前图形验证码：零依赖数学题，防脚本） ========
    if (req.method === 'GET' && pathname === '/api/account/captcha') {
      return json(res, 200, { ok: true, ...store.createCaptcha() })
    }

    // ======== POST /api/account/send-code（手机验证码；限流 + TTL 5min + code 哈希） ========
    if (req.method === 'POST' && pathname === '/api/account/send-code') {
      const body = JSON.parse((await readBody(req)).toString())
      if (!store.verifyCaptcha(body.captchaId, body.captchaAnswer)) return json(res, 400, { ok: false, error: '图形验证码错误，请刷新重试' })
      const ip = clientIp(req)
      const r = store.sendCode(body.phone, ip)
      if (r.error) return json(res, 400, { ok: false, error: r.error })
      store.audit('account.sendCode', 'anonymous', String(body.phone || ''))
      return json(res, 200, { ok: true, message: '验证码已发送', ...(r.mockCode ? { mockCode: r.mockCode } : {}) })
    }

    // ======== POST /api/account/forgot（找回密码：手机号+验证码+新密码） ========
    if (req.method === 'POST' && pathname === '/api/account/forgot') {
      const body = JSON.parse((await readBody(req)).toString())
      const r = store.forgotPasswordByPhone(body.phone, body.code, body.newPassword)
      if (r.error) return json(res, 400, { ok: false, error: r.error })
      store.audit('account.forgot', r.username, String(body.phone || ''))
      return json(res, 200, { ok: true, username: r.username, message: '密码已重置，请用新密码登录' })
    }

    // ======== POST /api/account/logout（注销当前会话令牌） ========
    if (req.method === 'POST' && pathname === '/api/account/logout') {
      store.revokeSession(req.headers['x-token'])
      return json(res, 200, { ok: true })
    }

    // ======== POST /api/account/register（多设备账户注册，可带手机号+验证码） ========
    if (req.method === 'POST' && pathname === '/api/account/register') {
      // 任务2：每 IP 每天注册上限（防脚本灌号）
      const ip = clientIp(req)
      const regOk = store.checkRegisterAllowed(ip)
      if (!regOk.allowed) return json(res, 429, { ok: false, error: regOk.error })
      const body = JSON.parse((await readBody(req)).toString())
      // 安全加固（2026-09-10）：自助注册强制 手机号+验证码；管理员（ADMIN_KEY）可建无手机号账号
      const ak = checkAdminKey(req, body, url)
      if (ak.status === 429) return json(res, 429, { ok: false, error: ak.error })
      const r = store.registerAccount(body.username, body.password, body.note || '', body.phone, body.code, { requirePhone: !ak.ok })
      if (r.error) return json(res, 400, { ok: false, error: r.error })
      const slotKey = store.getOrCreateSlotKey(r.userId) // 每账号独立槽密钥
      store.audit('account.register', r.username, '', r.userId)
      return json(res, 200, { ok: true, userId: r.userId, username: r.username, salt: r.salt, slotKey })
    }

    // ======== POST /api/account/login（多设备账户登录） ========
    if (req.method === 'POST' && pathname === '/api/account/login') {
      const body = JSON.parse((await readBody(req)).toString())
      // 任务2：IP 限速 + 连续失败 5 次锁 15 分钟（防暴力破解）
      const ip = clientIp(req)
      const allow = store.checkLoginAllowed(ip, body.username)
      if (!allow.allowed) return json(res, 429, { ok: false, error: allow.error })
      const r = store.loginAccount(body.username, body.password)
      if (r.error) {
        store.reportLoginResult(ip, body.username, false)
        return json(res, 401, { ok: false, error: r.error })
      }
      store.reportLoginResult(ip, body.username, true)
      const meta = store.loadMeta(r.userId)
      const token = randomHex(32)
      store.createSession(token, r.username, 12 * 60 * 60 * 1000) // 多租户：账号登录下发会话令牌(12h)
      const slotKey = store.getOrCreateSlotKey(r.userId)
      store.audit('account.login', r.username, '', r.userId)
      return json(res, 200, { ok: true, userId: r.userId, username: r.username, token, slotKey, expiresIn: 12 * 60 * 60, note: meta.note || '', salt: r.salt, phone: r.phone || '' })
    }

    // ======== POST /api/device/bind（多设备绑定：账户登录后追加一台设备） ========
    if (req.method === 'POST' && pathname === '/api/device/bind') {
      const body = JSON.parse((await readBody(req)).toString())
      // 任务2：登录类接口同样限速 + 失败锁定（防爆破绑定通道）
      const ip = clientIp(req)
      const allow = store.checkLoginAllowed(ip, body.username)
      if (!allow.allowed) return json(res, 429, { ok: false, error: allow.error })
      const r = store.loginAccount(body.username, body.password)
      if (r.error) {
        store.reportLoginResult(ip, body.username, false)
        return json(res, 401, { ok: false, error: r.error })
      }
      store.reportLoginResult(ip, body.username, true)
      const dev = store.bindDevice(r.userId, body.deviceName, body.note || '')
      return json(res, 200, { ok: true, userId: r.userId, deviceId: dev.deviceId, uploadToken: dev.uploadToken, viewToken: dev.viewToken, salt: r.salt })
    }

    // ======== POST /api/pair（原配对码：一次性码换凭证；现支持多设备复用同一账户） ========
    if (req.method === 'POST' && pathname === '/api/pair') {
      const body = JSON.parse((await readBody(req)).toString())
      const code = body.pairCode?.trim()
      if (!code) return json(res, 400, { ok: false, error: '缺少 pairCode' })
      const userId = store.validatePairCode(code)
      if (!userId) return json(res, 403, { ok: false, error: '配对码无效或已过期' })
      // 多设备：同一 userId 重复配对 → 追加一台设备（保留云端数据）
      const dev = store.bindDevice(userId, body.deviceName, body.note || '')
      return json(res, 200, { ok: true, userId, deviceId: dev.deviceId, uploadToken: dev.uploadToken, viewToken: dev.viewToken })
    }

    // ======== POST /api/snapshot ========
    if (req.method === 'POST' && pathname === '/api/snapshot') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      const body = JSON.parse((await readBody(req)).toString())
      if (!body.iv || !body.data) return json(res, 400, { ok: false, error: '缺少 iv/data' })
      // 任务9（审计 2026-08-30）：多机并发冲突检测——客户端带上上次拿到的快照时间戳，
      // 若云端已被其他设备更新过（快照 mtime 比客户端认知的新），拒绝覆盖并提示先拉取
      const serverAt = store.snapshotMtime(userId)
      const clientLastSync = req.headers['x-last-sync']
      if (clientLastSync && serverAt && clientLastSync < serverAt) {
        return json(res, 200, { ok: true, conflict: true, at: serverAt, detail: '另一台电脑有新数据，请先拉取再修改' })
      }
      const saved = store.saveSnapshot(userId, body.iv, body.data)
      return json(res, 200, { ok: true, at: saved.at })
    }

    // ======== POST /api/backup ========
    if (req.method === 'POST' && pathname === '/api/backup') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      const date = req.headers['x-date']
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: '缺少或非法 x-date (YYYY-MM-DD)' })
      const body = JSON.parse((await readBody(req)).toString())
      if (!body.iv || !body.data) return json(res, 400, { ok: false, error: '缺少 iv/data' })
      store.saveBackup(userId, date, body.iv, body.data)
      store.cleanOldBackups(userId, 30)
      return json(res, 200, { ok: true })
    }

    // ======== GET /api/backup/list ========
    if (req.method === 'GET' && pathname === '/api/backup/list') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      return json(res, 200, { ok: true, files: store.listBackups(userId) })
    }

    // ======== GET /api/backup/download ========
    if (req.method === 'GET' && pathname === '/api/backup/download') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      const date = url.searchParams.get('date')
      if (!date) return json(res, 400, { ok: false, error: '缺少 date' })
      const backup = store.loadBackup(userId, date)
      if (!backup) return json(res, 404, { ok: false, error: '备份不存在' })
      return json(res, 200, { ok: true, iv: backup.iv, data: backup.data })
    }

    // ======== GET /api/snapshot/fetch (手机页用，viewToken 鉴权) ========
    if (req.method === 'GET' && pathname === '/api/snapshot/fetch') {
      const t = url.searchParams.get('t')
      if (!t) return json(res, 401, { ok: false, error: '缺少 viewToken' })
      // 多设备：按 viewToken 找设备 → userId（含旧单 token 兼容）
      let found = store.findDeviceByViewToken(t)
      if (!found) {
        const users = store.listUsers()
        for (const u of users) {
          const meta = store.loadMeta(u.userId)
          if (meta.viewToken === t && !meta.viewTokenOld.includes(t)) { found = u.userId; break }
        }
      }
      if (!found) return json(res, 401, { ok: false, error: 'viewToken 无效或已吊销' })
      const snap = store.loadSnapshot(found)
      if (!snap) return json(res, 404, { ok: false, error: '暂无快照数据' })
      return json(res, 200, { ok: true, iv: snap.iv, data: snap.data })
    }

    // ======== GET /v/{viewToken} ========
    if (pathname.startsWith('/v/')) {
      const token = pathname.slice(3)
      let valid = !!store.findDeviceByViewToken(token)
      if (!valid) {
        const users = store.listUsers()
        for (const u of users) {
          const meta = store.loadMeta(u.userId)
          if (meta.viewToken === token && !meta.viewTokenOld.includes(token)) { valid = true; break }
        }
      }
      if (!valid) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>404</h1><p>链接无效或已吊销，请联系老板重新生成</p>')
        return
      }
      const html = fs.readFileSync(fileURLToPath(new URL('./view.html', import.meta.url)), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // ====== CEO驾驶舱 · 独命名空间（绝不改 /api/pair、/api/snapshot、/api/account/*、/api/backup*） ======
    // V2：phone+短验码 · scrypt · 每账号独立槽位 · KB 仅店主账号持有（存取走会话 userId 对应槽）

    // ======== POST /api/cockpit/sendCode（发码：短验码限流 + 校验；dev 固定 123456） ========
    if (req.method === 'POST' && pathname === '/api/cockpit/sendCode') {
      const body = JSON.parse((await readBody(req)).toString())
      // 安全加固（2026-09-10）：与 /api/account/send-code 对齐，支持发码前图形验证码。
      // 默认不强制（CAPTCHA_REQUIRED=1 开启）以免打断已发布的 v3.2.x 客户端；
      // 短信成本的真正防线在 store.sendCode：每号每日上限 + 全局每小时配额 + 每号 60s 间隔。
      if (CAPTCHA_REQUIRED && !store.verifyCaptcha(body.captchaId, body.captchaAnswer)) {
        return json(res, 400, { ok: false, error: '图形验证码错误，请刷新重试' })
      }
      const ip = clientIp(req)
      const r = store.sendCode(body.phone, ip)
      if (r.error) return json(res, 400, { ok: false, error: r.error })
      store.audit('cockpit.sendCode', 'anonymous', String(body.phone || ''))
      return json(res, 200, { ok: true, message: '验证码已发送', ...(r.mockCode ? { mockCode: r.mockCode } : {}) })
    }

    // ======== POST /api/cockpit/register（自助注册：手机号+短验码+密码；一键一手机；默认非店主空槽） ========
    if (req.method === 'POST' && pathname === '/api/cockpit/register') {
      const body = JSON.parse((await readBody(req)).toString())
      const ip = clientIp(req)
      const regOk = store.checkRegisterAllowed(ip)
      if (!regOk.allowed) return json(res, 429, { ok: false, error: regOk.error })
      // 短信绕行：adminKey 有效 = 店长/管理员担保建号，免短信验证码（未接真实 SMS 前的降级路径；客户自助注册仍需短信码）
      const ak = checkAdminKey(req, body, url)
      if (ak.status === 429) return json(res, 429, { ok: false, error: ak.error })
      const isAdmin = ak.ok
      if (!isAdmin) {
        const codeOk = store.verifyCode(body.phone, body.sms_code)
        if (!codeOk.ok) return json(res, 400, { ok: false, error: codeOk.error || '验证码错误或已过期' })
      }
      const owner = !!body.isOwner && isAdmin
      const r = store.createCockpitAcc({ phone: body.phone, name: body.name, password: body.password, isOwner: owner })
      if (r.error) return json(res, 400, { ok: false, error: r.error })
      if (owner) { store.migrateSharedSlotToOwner(r.account.userId); store.getCockpitSlotKey(r.account.userId) }
      store.touchCockpitSeen(r.account.phone)
      const token = randomHex(32)
      store.createCockpitSession(token, r.account, 12 * 60 * 60 * 1000)
      const slotKey = store.getCockpitSlotKey(r.account.userId)
      store.audit('cockpit.register', r.account.name, r.account.phone, r.account.userId)
      return json(res, 201, { ok: true, phone: r.account.phone, name: r.account.name, isOwner: r.account.isOwner, userId: r.account.userId, token, slotKey, expiresIn: 12 * 60 * 60 })
    }

    // ======== POST /api/cockpit/login（手机号或账号名 + 密码；失败锁定限流） ========
    if (req.method === 'POST' && pathname === '/api/cockpit/login') {
      const body = JSON.parse((await readBody(req)).toString())
      const id = (body.phone || body.username || body.name || '').trim()
      const password = body.password || ''
      // 安全加固（2026-09-10）：本端点原先没有任何 IP 限速（对照 /api/account/login 有），
      // 攻击者可跨账号无限爆破。现与账号登录共用同一限流器（命名空间 cockpit:）。
      const ip = clientIp(req)
      const limKey = 'cockpit:' + id.toLowerCase()
      const allow = store.checkLoginAllowed(ip, limKey)
      if (!allow.allowed) return json(res, 429, { ok: false, error: allow.error })
      if (store.cockpitLoginLocked(id)) return json(res, 429, { ok: false, error: '尝试过多，账号已临时锁定，请稍后再试' })
      let acc = store.findCockpitAccByPhone(id) || store.findCockpitAccByName(id)
      if (!acc || !store.cockpitVerifyScrypt(password, acc.passHash, acc.salt)) {
        store.recordCockpitFail(id)
        store.reportLoginResult(ip, limKey, false)
        store.audit('cockpit.login.fail', String(id), '', acc ? acc.userId : '')
        return json(res, 401, { ok: false, error: '手机号/账号或密码错误' })
      }
      if (!acc.enabled) return json(res, 403, { ok: false, error: '账号已停用' })
      store.clearCockpitFail(id)
      store.reportLoginResult(ip, limKey, true)
      const token = randomHex(32)
      store.createCockpitSession(token, acc, 12 * 60 * 60 * 1000)
      store.updateCockpitAcc(acc.phone, { lastLoginAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
      const slotKey = store.getCockpitSlotKey(acc.userId)
      store.audit('cockpit.login', acc.name, acc.phone, acc.userId)
      return json(res, 200, { ok: true, phone: acc.phone, name: acc.name, isOwner: acc.isOwner, userId: acc.userId, token, slotKey, expiresIn: 12 * 60 * 60 })
    }

    // ======== POST /api/cockpit/forgot（找密码：手机号+短验码重置） ========
    if (req.method === 'POST' && pathname === '/api/cockpit/forgot') {
      const body = JSON.parse((await readBody(req)).toString())
      const codeOk = store.verifyCode(body.phone, body.sms_code)
      if (!codeOk.ok) return json(res, 400, { ok: false, error: codeOk.error || '验证码错误或已过期' })
      const acc = store.findCockpitAccByPhone(body.phone)
      if (!acc) return json(res, 400, { ok: false, error: '手机号未注册或验证码不正确' })
      if (!body.new_password || String(body.new_password).length < 6) return json(res, 400, { ok: false, error: '新密码至少 6 位' })
      const salt = randomHex(16)
      store.updateCockpitAcc(acc.phone, { salt, passHash: scryptHash(body.new_password, salt) })
      store.clearCockpitFail(acc.phone) // 已用短信码验证身份，重置后清除登录锁定，用户可立即用新密码登录
      store.audit('cockpit.forgot', acc.name, acc.phone, acc.userId)
      return json(res, 200, { ok: true, message: '密码已重置，请用新密码登录' })
    }

    // ======== POST /api/cockpit/owner（ADMIN_KEY 指定/绑定店主账号为 KB 持有者；迁移旧共享槽 KB） ========
    if (req.method === 'POST' && pathname === '/api/cockpit/owner') {
      const body = JSON.parse((await readBody(req)).toString())
      const akOwner = checkAdminKey(req, body, url)
      if (!akOwner.ok) return json(res, akOwner.status, { ok: false, error: akOwner.error })
      let acc = store.findCockpitAccByPhone(body.phone)
      if (acc) { store.updateCockpitAcc(acc.phone, { isOwner: true }); acc = store.findCockpitAccByPhone(body.phone) }
      else {
        if (!body.password || String(body.password).length < 6) return json(res, 400, { ok: false, error: '新店主需设密码（≥6位）' })
        const r = store.createCockpitAcc({ phone: body.phone, name: body.name, password: body.password, isOwner: true })
        if (r.error) return json(res, 400, { ok: false, error: r.error })
        acc = r.account
      }
      store.migrateSharedSlotToOwner(acc.userId)
      store.getCockpitSlotKey(acc.userId)
      store.audit('cockpit.owner.set', acc.name, acc.phone, acc.userId)
      return json(res, 200, { ok: true, phone: acc.phone, isOwner: true, userId: acc.userId, message: '已设为店主，KB 槽位归属该账号' })
    }

    // ======== POST /api/cockpit/logout（撤销会话令牌） ========
    if (req.method === 'POST' && pathname === '/api/cockpit/logout') {
      store.revokeCockpitSession(req.headers['x-token'])
      return json(res, 200, { ok: true })
    }

    // ======== GET /api/cockpit/stats（用户/在线/今日新增；店主或 ADMIN_KEY 可见） ========
    if (req.method === 'GET' && pathname === '/api/cockpit/stats') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      const ak = checkAdminKey(req, null, url)
      if (ak.status === 429) return json(res, 429, { ok: false, error: ak.error })
      const isAdmin = ak.ok
      if (!sess && !isAdmin) return json(res, 401, { ok: false, error: '需店主账号登录或 ADMIN_KEY' })
      if (sess && !sess.isOwner && !isAdmin) return json(res, 403, { ok: false, error: '仅店主可见用户/在线统计' })
      return json(res, 200, { ok: true, ...store.cockpitStats() })
    }

    // ======== GET /api/cockpit/snapshot/fetch（会话鉴权，读该账号自己槽位） ========
    if (req.method === 'GET' && pathname === '/api/cockpit/snapshot/fetch') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      store.touchCockpitSeen(sess.phone)
      store.audit('cockpit.fetch', sess.name, '', sess.userId)
      const snap = store.loadSnapshot(sess.userId)
      if (!snap) return json(res, 404, { ok: false, error: '暂无快照数据' })
      return json(res, 200, { ok: true, iv: snap.iv, data: snap.data })
    }

    // ======== POST /api/cockpit/snapshot（会话鉴权，写该账号自己槽位） ========
    if (req.method === 'POST' && pathname === '/api/cockpit/snapshot') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      const body = JSON.parse((await readBody(req)).toString())
      if (!body.iv || !body.data) return json(res, 400, { ok: false, error: '缺少 iv/data' })
      store.saveSnapshot(sess.userId, body.iv, body.data)
      store.touchCockpitSeen(sess.phone)
      store.audit('cockpit.snapshot', sess.name, `${(body.data || '').length} bytes`, sess.userId)
      return json(res, 200, { ok: true, at: new Date().toISOString() })
    }
    // ======== 租户成员（契约 v1.1）：店主加员工 -> 员工凭邀请码加入 -> 登录即用同一套数据 ========
    // GET /api/cockpit/permissions（当前会话的角色与可用动作；两个产品共用同一矩阵）
    if (req.method === 'GET' && pathname === '/api/cockpit/permissions') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      const role = store.sessionRole(sess)
      return json(res, 200, { ok: true, role, memberId: sess.memberId || '', tenantUserId: sess.userId, actions: store.roleMatrix()[role] || [], matrix: store.roleMatrix() })
    }

    // POST /api/cockpit/members（店主添加成员 -> 返回邀请码，由店主转达给员工）
    if (req.method === 'POST' && pathname === '/api/cockpit/members') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      if (!store.roleCan(store.sessionRole(sess), 'members.manage')) return json(res, 403, { ok: false, error: '当前身份无此权限（仅店主可添加成员）' })
      const body = JSON.parse((await readBody(req)).toString())
      const rt = store.inviteTenantMember({ tenantUserId: sess.userId, phone: body.phone, name: body.name, role: body.role, invitedBy: sess.phone })
      if (rt.error) return json(res, 400, { ok: false, error: rt.error })
      store.audit('cockpit.member.invite', sess.name, '', sess.userId)
      return json(res, 200, { ok: true, phone: rt.phone, role: rt.role, inviteCode: rt.inviteCode, expiresInSec: rt.expiresInSec, message: '把邀请码告诉该员工（10 分钟内有效），让他在自己电脑上凭手机号+邀请码设置密码' })
    }

    // GET /api/cockpit/members（成员列表；店主/店长可见）
    if (req.method === 'GET' && pathname === '/api/cockpit/members') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      if (!store.roleCan(store.sessionRole(sess), 'members.list')) return json(res, 403, { ok: false, error: '当前身份无此权限' })
      return json(res, 200, { ok: true, members: store.listTenantMembers(sess.userId).map(store.publicTenantMember), roles: store.listRoles() })
    }

    // POST /api/cockpit/members/accept（员工凭邀请码加入并首次设密码 -> 直接返回会话）
    if (req.method === 'POST' && pathname === '/api/cockpit/members/accept') {
      const body = JSON.parse((await readBody(req)).toString())
      const ip = clientIp(req)
      const limKey = 'member-accept:' + String(body.phone || '').trim()
      const allow = store.checkLoginAllowed(ip, limKey)
      if (!allow.allowed) return json(res, 429, { ok: false, error: allow.error })
      const rt = store.acceptTenantInvite({ phone: body.phone, inviteCode: body.inviteCode || body.code, password: body.password })
      if (rt.error) { store.reportLoginResult(ip, limKey, false); return json(res, 400, { ok: false, error: rt.error }) }
      store.reportLoginResult(ip, limKey, true)
      const lg = store.tenantMemberLogin(body.phone, body.password)
      if (lg.error) return json(res, 401, { ok: false, error: lg.error })
      const token = randomHex(32)
      store.createTenantMemberSession(token, lg.member, lg.tenant)
      const slotKey = store.getCockpitSlotKey(lg.tenant.userId)
      store.audit('cockpit.member.accept', lg.member.name, '', lg.member.tenantUserId)
      return json(res, 200, { ok: true, memberId: lg.member.memberId, role: lg.member.role, name: lg.member.name, phone: lg.member.phone, userId: lg.tenant.userId, isOwner: false, token, slotKey, expiresIn: 12 * 60 * 60 })
    }

    // POST /api/cockpit/members/login（成员登录：手机号 + 密码）
    if (req.method === 'POST' && pathname === '/api/cockpit/members/login') {
      const body = JSON.parse((await readBody(req)).toString())
      const id = String(body.phone || body.memberId || '').trim()
      if (!id) return json(res, 400, { ok: false, error: '请输入手机号' })
      const ip = clientIp(req)
      const limKey = 'member:' + id.toLowerCase()
      const allow = store.checkLoginAllowed(ip, limKey)
      if (!allow.allowed) return json(res, 429, { ok: false, error: allow.error })
      const lg = store.tenantMemberLogin(id, body.password || '')
      if (lg.error) { store.reportLoginResult(ip, limKey, false); store.audit('cockpit.member.login.fail', String(id), '', ''); return json(res, 401, { ok: false, error: lg.error }) }
      store.reportLoginResult(ip, limKey, true)
      const token = randomHex(32)
      store.createTenantMemberSession(token, lg.member, lg.tenant)
      const slotKey = store.getCockpitSlotKey(lg.tenant.userId)
      store.audit('cockpit.member.login', lg.member.name, '', lg.member.tenantUserId)
      return json(res, 200, { ok: true, memberId: lg.member.memberId, role: lg.member.role, name: lg.member.name, phone: lg.member.phone, userId: lg.tenant.userId, isOwner: false, token, slotKey, expiresIn: 12 * 60 * 60 })
    }

    // POST /api/cockpit/members/disable（停用成员；仅店主；跨租户操作直接拒绝）
    if (req.method === 'POST' && pathname === '/api/cockpit/members/disable') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      if (!store.roleCan(store.sessionRole(sess), 'members.manage')) return json(res, 403, { ok: false, error: '当前身份无此权限（仅店主可停用成员）' })
      const body = JSON.parse((await readBody(req)).toString())
      const m = body.memberId ? store.findTenantMemberById(body.memberId) : store.findTenantMemberByPhone(body.phone)
      if (!m) return json(res, 404, { ok: false, error: '成员不存在' })
      if (m.tenantUserId !== sess.userId) return json(res, 403, { ok: false, error: '跨租户操作被拒绝' })
      const rt = store.setTenantMemberEnabled(m.phone, body.enabled === undefined ? false : !!body.enabled)
      if (rt.error) return json(res, 400, { ok: false, error: rt.error })
      store.audit('cockpit.member.disable', sess.name, '', sess.userId)
      return json(res, 200, { ok: true, member: rt.member })
    }
    // ======== POST /api/tenant/sync（进销存业务数据：按记录增量同步；服务端只存密文） ========
    if (req.method === 'POST' && pathname === '/api/tenant/sync') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      const role = store.sessionRole(sess)
      if (!store.roleCan(role, 'data.read')) return json(res, 403, { ok: false, error: '当前身份无读取权限' })
      const body = JSON.parse((await readBody(req)).toString())
      const hasPush = Array.isArray(body.changes) && body.changes.length > 0
      if (hasPush && !store.roleCan(role, 'data.write')) return json(res, 403, { ok: false, error: '当前身份无写入权限（只读）' })
      const r = store.tenantSync(sess.userId, { cursor: body.cursor, changes: body.changes, limit: body.limit })
      if (r.error) return json(res, 400, { ok: false, error: r.error })
      if (r.applied.length) store.audit('tenant.sync', sess.name, r.applied.length + ' 条变更', sess.userId)
      return json(res, 200, r)
    }

    // ======== GET /api/tenant/status（本租户业务数据水位；供体检/排障） ========
    if (req.method === 'GET' && pathname === '/api/tenant/status') {
      const sess = store.validateCockpitSession(req.headers['x-token'])
      if (!sess) return json(res, 401, { ok: false, error: '未登录或会话已过期' })
      return json(res, 200, { ok: true, ...store.tenantBizStats(sess.userId) })
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      const ak = checkAdminKey(req, null, url)
      if (!ak.ok) {
        res.writeHead(ak.status, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>' + ak.status + '</h1><p>' + (ak.status === 429 ? '尝试过多，请稍后再试' : '需要 ADMIN_KEY') + '</p>')
        return
      }
      const html = fs.readFileSync(fileURLToPath(new URL('./admin.html', import.meta.url)), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // ======== POST /admin/* (需要 admin key) ========
    if (pathname.startsWith('/admin/')) {
      const ak = checkAdminKey(req, null, url)
      if (!ak.ok) return json(res, ak.status, { ok: false, error: ak.error })

      // 生成配对码
      if (pathname === '/admin/pair' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        const userId = randomHex(16)
        store.initUser(userId)
        const code = store.createPairCode(userId)
        const meta = store.loadMeta(userId)
        meta.note = body.note || ''
        store.saveMeta(userId, meta)
        return json(res, 200, { ok: true, pairCode: code, userId })
      }

      // 吊销 viewToken
      if (pathname === '/admin/regen' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        const userId = body.userId
        if (!userId) return json(res, 400, { ok: false, error: '缺少 userId' })
        const meta = store.loadMeta(userId)
        if (meta.viewToken) meta.viewTokenOld.push(meta.viewToken)
        meta.viewToken = randomHex(16)
        store.saveMeta(userId, meta)
        return json(res, 200, { ok: true, viewToken: meta.viewToken })
      }

      // 删除用户
      if (pathname === '/admin/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        if (!body.userId) return json(res, 400, { ok: false, error: '缺少 userId' })
        const dir = store.userDir(body.userId)
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
        return json(res, 200, { ok: true })
      }

      // 用户列表
      if (pathname === '/admin/users' && req.method === 'GET') {
        return json(res, 200, { ok: true, users: store.listUsers() })
      }

      // 任务3：重置密码（按用户名；重置后旧密码失效，需重新绑定设备）
      if (pathname === '/admin/reset-password' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        const r = store.resetPassword(body.username, body.newPassword)
        if (r.error) return json(res, 400, { ok: false, error: r.error })
        return json(res, 200, { ok: true, username: r.username, detail: '密码已重置，请用新密码重新登录并绑定设备' })
      }
    }

    // ======== 404 ========
    json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    console.error('[cloud-server]', e.message)
    json(res, 500, { ok: false, error: e.message || 'internal error' })
  }
})

server.listen(PORT, () => {
  console.log(`[cloud-server] 云备份服务已启动，端口 ${PORT}`)
  if (!ADMIN_KEY) console.warn('[cloud-server] ⚠ 未设置 ADMIN_KEY')
  if (!TRUST_PROXY) console.warn('[cloud-server] ⚠ 未启用 TRUST_PROXY：若本服务在 Caddy/Nginx 反代之后，全部限流会退化为「全站单桶」（复核报告 R2）。反代场景请设 TRUST_PROXY=1。')
  if (!CAPTCHA_REQUIRED) console.warn('[cloud-server] ⚠ 发码未强制图形验证码（CAPTCHA_REQUIRED!=1）；当前靠「每号每日上限 + 全局每小时配额」兜底短信成本。')
})

process.on('SIGTERM', () => { server.close(); process.exit(0) })
process.on('SIGINT', () => { server.close(); process.exit(0) })
