// cloud-server 身份链安全回归测试（2026-09-10 复核修复的验收脚本）
// 运行：node security-test.mjs     （零依赖，仅用 node:child_process + fetch）
// 覆盖：R1 发码配额 / R2 真实 IP 与限流桶 / R3 注册强制手机号 / R4 cockpit 登录限速 /
//       R5 ADMIN_KEY 加固 / R10 生产 mock 防呆 / R11 审计脱敏 / 多租户隔离 / 进销存端点回归
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ADMIN_KEY = 'test-admin-key-0123456789'
let pass = 0, fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; failures.push(name + (extra ? '  [' + extra + ']' : '')); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function tmpRoot(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-' + tag + '-')) }

async function startServer(env, port, tag) {
  const dataRoot = tmpRoot(tag)
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(port), CLOUD_DATA_ROOT: dataRoot, ...env },
    windowsHide: true,
  })
  let out = '', err = ''
  proc.stdout.on('data', d => { out += d.toString() })
  proc.stderr.on('data', d => { err += d.toString() })
  return { proc, port, dataRoot, getOut: () => out, getErr: () => err }
}

async function waitReady(s, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch('http://127.0.0.1:' + s.port + '/api/account/captcha'); if (r.status === 200) return true } catch { }
    await sleep(100)
  }
  return false
}

async function call(s, method, p, { body, headers = {}, ip } = {}) {
  const h = { ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  if (ip) h['X-Forwarded-For'] = ip
  const res = await fetch('http://127.0.0.1:' + s.port + p, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j = null
  try { j = await res.json() } catch { }
  return { status: res.status, body: j }
}

async function captchaPayload(s, ip) {
  const c = await call(s, 'GET', '/api/account/captcha', { ip })
  const m = String(c.body.question).match(/(\d+)\s*([+-])\s*(\d+)/)
  const ans = m[2] === '+' ? Number(m[1]) + Number(m[3]) : Number(m[1]) - Number(m[3])
  return { captchaId: c.body.captchaId, captchaAnswer: String(ans) }
}
async function sendCode(s, phone, ip) {
  const cap = await captchaPayload(s, ip)
  return call(s, 'POST', '/api/account/send-code', { ip, body: { phone, ...cap } })
}
function stop(s) { try { s.proc.kill() } catch { } }

// ============================== 主场景 ==============================
console.log('\n[A] 主场景（TRUST_PROXY=1 + 开发短信模式）')
const A = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test', SEND_GLOBAL_HOURLY: '100' }, 3199, 'main')
if (!(await waitReady(A))) { console.log('  ✗ 服务未就绪，输出：'); console.log(A.getOut() + A.getErr()); process.exit(1) }
const IP1 = '203.0.113.10'

// --- R1 发码链 ---
let r = await call(A, 'POST', '/api/account/send-code', { ip: IP1, body: { phone: '13800000001' } })
ok('R1 发码缺图形验证码被拒', r.status === 400, 'status=' + r.status)
r = await call(A, 'POST', '/api/account/send-code', { ip: IP1, body: { phone: '13800000001', captchaId: 'x', captchaAnswer: '999' } })
ok('R1 图形验证码错误被拒', r.status === 400, 'status=' + r.status)
r = await sendCode(A, '13800000001', IP1)
ok('R1 验证码正确可发码', r.status === 200, JSON.stringify(r.body))
r = await sendCode(A, '13800000001', IP1)
ok('R1 同号 60s 内重复发码被拒', r.status === 400, JSON.stringify(r.body))
r = await call(A, 'POST', '/api/cockpit/sendCode', { ip: IP1, body: { phone: '13800000002' } })
ok('R1 cockpit 发码保持兼容（CAPTCHA_REQUIRED 未开启）', r.status === 200, JSON.stringify(r.body))

// --- R3 自助注册强制手机号+验证码 ---
r = await call(A, 'POST', '/api/account/register', { ip: IP1, body: { username: 'nophone1', password: 'pass123456' } })
ok('R3 无手机号注册被拒', r.status === 400 && /手机号/.test(String(r.body.error)), JSON.stringify(r.body))
r = await call(A, 'POST', '/api/account/register', { ip: IP1, body: { username: 'nophone2', password: 'pass123456', phone: '13800000003', code: '000000' } })
ok('R3 验证码错误注册被拒', r.status === 400, JSON.stringify(r.body))
await sendCode(A, '13800000003', IP1)
r = await call(A, 'POST', '/api/account/register', { ip: IP1, body: { username: 'userA', password: 'pass123456', phone: '13800000003', code: '123456' } })
ok('R3 手机号+验证码注册成功', r.status === 200 && !!r.body.slotKey, JSON.stringify(r.body))
const userA = r.body
r = await call(A, 'POST', '/api/account/register', { ip: IP1, body: { username: 'userA', password: 'pass123456', phone: '13800000004', code: '123456' } })
ok('R3 重复用户名被拒', r.status === 400, JSON.stringify(r.body))
r = await call(A, 'POST', '/api/account/register', {
  ip: IP1, headers: { 'x-admin-key': ADMIN_KEY },
  body: { username: 'adminmade', password: 'pass123456' },
})
ok('R3 管理员建号（无手机号）仍可用', r.status === 200 && !!r.body.userId, JSON.stringify(r.body))

// --- R9 用户枚举 ---
r = await call(A, 'POST', '/api/account/login', { ip: '203.0.113.20', body: { username: 'no-such-user-xyz', password: 'whatever123' } })
const msgUnknown = String(r.body.error)
r = await call(A, 'POST', '/api/account/login', { ip: '203.0.113.21', body: { username: 'userA', password: 'wrong-password' } })
const msgWrong = String(r.body.error)
ok('R9 未知用户与错误密码文案一致（不可枚举）', msgUnknown === msgWrong, msgUnknown + ' | ' + msgWrong)

// --- 正常登录 + 多租户隔离 ---
r = await call(A, 'POST', '/api/account/login', { ip: '203.0.113.22', body: { username: 'userA', password: 'pass123456' } })
ok('账号登录成功返回 token+slotKey', r.status === 200 && !!r.body.token && !!r.body.slotKey, JSON.stringify(r.body && r.body.error))
const accA = { token: r.body.token, slotKey: r.body.slotKey, userId: r.body.userId }

const cap1 = { phone: '13900000011', name: 'cockpitA', password: 'pass123456', isOwner: true }
r = await call(A, 'POST', '/api/cockpit/register', { ip: IP1, headers: { 'x-admin-key': ADMIN_KEY }, body: cap1 })
ok('cockpit 店主账号建立（header 传 adminKey）', r.status === 201 && !!r.body.token, JSON.stringify(r.body))
const cA = r.body
const cap2 = { phone: '13900000012', name: 'cockpitB', password: 'pass123456' }
r = await call(A, 'POST', '/api/cockpit/register', { ip: IP1, body: { ...cap2, adminKey: ADMIN_KEY } })
ok('cockpit 建号（body 传 adminKey，向后兼容）', r.status === 201 && !!r.body.token, JSON.stringify(r.body))
const cB = r.body

r = await call(A, 'POST', '/api/cockpit/snapshot', { ip: IP1, headers: { 'x-token': cA.token }, body: { iv: 'AAAA', data: 'BBBB-tenantA-secret' } })
ok('店主 A 上传快照成功', r.status === 200, JSON.stringify(r.body))
r = await call(A, 'GET', '/api/cockpit/snapshot/fetch', { ip: IP1, headers: { 'x-token': cA.token } })
ok('店主 A 可读回自己的快照', r.status === 200 && r.body.data === 'BBBB-tenantA-secret', JSON.stringify(r.body))
r = await call(A, 'GET', '/api/cockpit/snapshot/fetch', { ip: IP1, headers: { 'x-token': cB.token } })
ok('账号 B 读不到 A 的快照（多租户隔离）', r.status === 404, 'status=' + r.status)
r = await call(A, 'GET', '/api/cockpit/snapshot/fetch', { ip: IP1, headers: { 'x-token': 'f'.repeat(64) } })
ok('伪造 token 读取被拒', r.status === 401, 'status=' + r.status)

// --- R2 IP 桶：TRUST_PROXY=1 时 XFF 生效 ---
let statuses = []
for (let i = 0; i < 12; i++) {
  const rr = await call(A, 'POST', '/api/account/login', { ip: '198.51.100.7', body: { username: 'userA', password: 'nope' + i } })
  statuses.push(rr.status)
}
ok('R2 同一真实 IP 连续失败触发 429', statuses.includes(429), JSON.stringify(statuses))
statuses = []
for (let i = 0; i < 12; i++) {
  const rr = await call(A, 'POST', '/api/account/login', { ip: '198.51.100.' + (100 + i), body: { username: 'userA', password: 'nope' + i } })
  statuses.push(rr.status)
}
ok('R2 不同真实 IP 各自独立计数（不误伤）', !statuses.includes(429), JSON.stringify(statuses))

// --- R4 cockpit 登录限速 ---
statuses = []
for (let i = 0; i < 12; i++) {
  const rr = await call(A, 'POST', '/api/cockpit/login', { ip: '198.51.100.50', body: { phone: '13900000011', password: 'bad' + i } })
  statuses.push(rr.status)
}
ok('R4 cockpit 登录连续失败触发 429', statuses.includes(429), JSON.stringify(statuses))
r = await call(A, 'POST', '/api/cockpit/login', { ip: '203.0.113.60', body: { phone: '13900000011', password: 'pass123456' } })
ok('R4 账号锁定生效：换 IP 用正确密码也需等解锁（接受残余，见报告 R4-b）', r.status === 429, 'status=' + r.status)
r = await call(A, 'POST', '/api/cockpit/login', { ip: '203.0.113.61', body: { phone: '13900000012', password: 'pass123456' } })
ok('R4 锁定不波及其他账号（无连坐）', r.status === 200, JSON.stringify(r.body && r.body.error))

// --- R5 ADMIN_KEY 加固 ---
statuses = []
for (let i = 0; i < 12; i++) {
  const rr = await call(A, 'GET', '/api/cockpit/stats', { ip: '198.51.100.90', headers: { 'x-admin-key': 'wrong-key-' + i } })
  statuses.push(rr.status)
}
ok('R5 错误 ADMIN_KEY 连续尝试触发 429 锁定', statuses.includes(429), JSON.stringify(statuses))
r = await call(A, 'GET', '/api/cockpit/stats', { ip: '198.51.100.90', headers: { 'x-admin-key': ADMIN_KEY } })
ok('R5 锁定期间正确密钥也被拒（锁定生效）', r.status === 429, 'status=' + r.status)
r = await call(A, 'GET', '/api/cockpit/stats', { ip: '198.51.100.91', headers: { 'x-admin-key': ADMIN_KEY } })
ok('R5 其他 IP 用正确密钥可访问（按 IP 锁定）', r.status === 200 && r.body.ok === true, JSON.stringify(r.body))
r = await call(A, 'GET', '/api/cockpit/stats?key=' + encodeURIComponent(ADMIN_KEY), { ip: '198.51.100.92' })
ok('R5 query string 传 key 仍兼容（并会告警）', r.status === 200, 'status=' + r.status)

// --- R11 审计脱敏 ---
await sleep(150)
const auditPath = path.join(A.dataRoot, 'audit.log')
let auditTxt = ''
try { auditTxt = fs.readFileSync(auditPath, 'utf8') } catch { }
ok('R11 审计日志已写入', auditTxt.length > 0, 'len=' + auditTxt.length)
ok('R11 审计日志已手机号脱敏', auditTxt.includes('****') && !auditTxt.includes('13800000001'), auditTxt.split('\n').slice(0, 2).join(' | ').slice(0, 200))

// --- 进销存端点回归 ---
r = await call(A, 'POST', '/api/snapshot', { ip: IP1, body: { iv: 'x', data: 'y' } })
ok('回归 /api/snapshot 无 token 仍 401', r.status === 401, 'status=' + r.status)
r = await call(A, 'POST', '/api/pair', { ip: IP1, body: { pairCode: 'not-a-real-code' } })
ok('回归 /api/pair 无效码仍 403', r.status === 403, 'status=' + r.status)
r = await call(A, 'GET', '/api/snapshot/fetch?t=bad', { ip: IP1 })
ok('回归 /api/snapshot/fetch 无效 viewToken 仍 401', r.status === 401, 'status=' + r.status)

stop(A)

// ============================== 生产防呆 ==============================
console.log('\n[B] 生产环境短信 mock 防呆（fail-closed）')
const B = await startServer({ NODE_ENV: 'production', COCKPIT_SMS_MOCK: '1', ADMIN_KEY, TRUST_PROXY: '1' }, 3200, 'prodguard')
let exitCode = null
await Promise.race([
  new Promise(res => B.proc.on('exit', c => { exitCode = c; res() })),
  sleep(6000).then(() => { }),
])
ok('R10 生产 + mock 时拒绝启动（exit=1）', exitCode === 1, 'exitCode=' + exitCode)
ok('R10 给出明确的中文处置指引', /启动被拒绝/.test(B.getErr()), B.getErr().slice(0, 120))
stop(B)

// ============================== 短信配额 ==============================
console.log('\n[C] 短信成本上限')
const C = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test', SEND_GLOBAL_HOURLY: '2' }, 3201, 'quota')
if (await waitReady(C)) {
  const s1 = await sendCode(C, '13700000001', '192.0.2.1')
  const s2 = await sendCode(C, '13700000002', '192.0.2.2')
  const s3 = await sendCode(C, '13700000003', '192.0.2.3')
  ok('C 配额内前两次发码成功', s1.status === 200 && s2.status === 200, s1.status + ',' + s2.status)
  ok('R1 全局每小时配额耗尽后拒绝（短信费用硬上限）', s3.status === 400 && /上限/.test(String(s3.body.error)), JSON.stringify(s3.body))
  stop(C)
} else { ok('C 短信配额服务启动', false, 'not ready') }

// ============================== TRUST_PROXY 关闭时的行为 ==============================
console.log('\n[D] 未启用 TRUST_PROXY（默认）应为抗伪造')
const D = await startServer({ ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test' }, 3202, 'noxff')
if (await waitReady(D)) {
  r = await sendCode(D, '13600000001', '192.0.2.9')
  ok('D 未开 TRUST_PROXY 时发码链正常', r.status === 200, JSON.stringify(r.body))
  statuses = []
  for (let i = 0; i < 12; i++) {
    const rr = await call(D, 'POST', '/api/account/login', { ip: '192.0.2.' + (10 + i), body: { username: 'ghost', password: 'x' + i } })
    statuses.push(rr.status)
  }
  ok('D 伪造 XFF 无法绕过限流（抗伪造默认开）', statuses.includes(429), JSON.stringify(statuses))
  stop(D)
} else { ok('D 服务启动', false, 'not ready') }

// ============================== 共享槽回落脚枪 ==============================
console.log('\n[E] 共享槽回落脚枪与文件权限')
const unitCode = [
  "import * as store from './store.js'",
  "import fs from 'node:fs'",
  "const out = []",
  "let a = false",
  "try { store.getOrCreateSlotKey('') } catch (e) { a = true }",
  "out.push('emptyUserIdThrows=' + a)",
  "let b = false",
  "try { store.createSession('t1', 'no-such-account') } catch (e) { b = true }",
  "out.push('unknownAccountSessionThrows=' + b)",
  "const k = store.getOrCreateSlotKey('userXYZ')",
  "out.push('keyLen=' + k.length)",
  "const st = fs.statSync(process.env.CLOUD_DATA_ROOT + '/users/userXYZ/slot.key')",
  "out.push('mode=' + (st.mode & 0o777).toString(8))",
  "console.log(out.join(' '))",
].join('\n')
const eRoot = tmpRoot('unit')
let eOut = ''
try {
  eOut = execFileSync(process.execPath, ['--input-type=module', '-e', unitCode], { cwd: DIR, env: { ...process.env, CLOUD_DATA_ROOT: eRoot }, encoding: 'utf8' })
} catch (e) { eOut = 'EXEC-ERR ' + (e && e.message) }
ok('E getOrCreateSlotKey 空 userId 抛错（不再回落共享槽）', /emptyUserIdThrows=true/.test(eOut), eOut.trim().slice(0, 200))
ok('E createSession 未知账号抛错（不再回落共享槽）', /unknownAccountSessionThrows=true/.test(eOut), eOut.trim().slice(0, 200))
ok('E 正常 userId 仍可生成 32 字节密钥', /keyLen=43/.test(eOut), eOut.trim().slice(0, 200))
if (process.platform === 'win32') console.log('  SKIP  slot.key 0600 权限断言（Windows 语义有限，由 Linux 生产验证）')
else ok('E slot.key 权限为 0600', /mode=600/.test(eOut), eOut.trim().slice(0, 200))

// ============================== 旧共享槽归档脚本 ==============================
console.log('\n[F] 旧共享槽归档脚本（默认 dry-run，只移动不删除）')
const fRoot = tmpRoot('archive')
const sharedDir = path.join(fRoot, 'users', 'cockpit')
fs.mkdirSync(path.join(sharedDir, 'backups'), { recursive: true })
fs.writeFileSync(path.join(sharedDir, 'slot.key'), 'OLD-SHARED-KEY', 'utf8')
fs.writeFileSync(path.join(sharedDir, 'snapshot.enc'), '{\"iv\":\"a\",\"data\":\"b\"}', 'utf8')
fs.writeFileSync(path.join(sharedDir, 'backups', '2026-01-01.enc'), 'bak', 'utf8')
fs.mkdirSync(path.join(fRoot, 'users', 'owneruid'), { recursive: true })
fs.writeFileSync(path.join(fRoot, 'users', 'owneruid', 'snapshot.enc'), '{}', 'utf8')
fs.writeFileSync(path.join(fRoot, 'cockpit-accounts.json'), JSON.stringify({ '13900000001': { phone: '13900000001', name: 'boss', userId: 'owneruid', isOwner: true } }), 'utf8')
const runArchive = (root, args) => {
  try { return { out: execFileSync(process.execPath, ['archive-shared-slot.mjs', ...args], { cwd: DIR, env: { ...process.env, CLOUD_DATA_ROOT: root }, encoding: 'utf8' }), code: 0 } }
  catch (e) { return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status } }
}
const a1 = runArchive(fRoot, [])
ok('F 默认 dry-run 不移动任何文件', fs.existsSync(sharedDir) && /DRY-RUN/.test(a1.out), a1.out.slice(0, 150))
ok('F dry-run 列出待归档文件与校验值', /slot\.key/.test(a1.out) && /snapshot\.enc/.test(a1.out), a1.out.slice(0, 150))
const a2 = runArchive(fRoot, ['--apply'])
ok('F --apply 只移动不删除并写入清单', !fs.existsSync(sharedDir) && fs.existsSync(path.join(fRoot, 'archive')) && /ARCHIVE-MANIFEST/.test(a2.out), a2.out.slice(0, 200))
ok('F 归档后给出回滚命令', /回滚/.test(a2.out), a2.out.slice(-200))
const fRoot2 = tmpRoot('archive2')
fs.mkdirSync(path.join(fRoot2, 'users', 'cockpit'), { recursive: true })
fs.writeFileSync(path.join(fRoot2, 'cockpit-accounts.json'), JSON.stringify({ x: { phone: '13900000002', userId: 'u2' } }), 'utf8')
const a3 = runArchive(fRoot2, ['--apply'])
ok('F 无店主账号时拒绝归档（防误移）', a3.code === 2 && /ABORT/.test(a3.out), a3.out.slice(0, 150))
ok('F 拒绝后共享槽原样保留', fs.existsSync(path.join(fRoot2, 'users', 'cockpit')))

// ============================== 汇总 ==============================
console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
if (fail) { console.log('未通过：\n - ' + failures.join('\n - ')) }
console.log('======================================')
process.exit(fail ? 1 : 0)
