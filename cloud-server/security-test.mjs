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
// 端口基址可覆盖：生产机上 3200/3201 已被 inventory-app 占用（曾导致 C 组假失败），默认改用高位端口
const PBASE = Number(process.env.TEST_PORT_BASE || 39300)
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
const A = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test', SEND_GLOBAL_HOURLY: '100' }, PBASE + 1, 'main')
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
ok('R3 默认允许无手机号注册（进销存客户端只发用户名+密码，必须放行）', r.status === 200 && !!r.body.userId, JSON.stringify(r.body))
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
const B = await startServer({ NODE_ENV: 'production', COCKPIT_SMS_MOCK: '1', ADMIN_KEY, TRUST_PROXY: '1' }, PBASE + 2, 'prodguard')
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
const C = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test', SEND_GLOBAL_HOURLY: '2' }, PBASE + 3, 'quota')
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
const D = await startServer({ ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test' }, PBASE + 4, 'noxff')
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

// ============================== 租户成员（契约 v1.1） ==============================
console.log('\n[G] 租户成员：店主加员工 -> 员工登录 -> 数据同源、权限不同')
const G = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test' }, PBASE + 5, 'members')
if (await waitReady(G)) {
  const AKH = { 'x-admin-key': ADMIN_KEY }
  const ownerPh = '13800009001', empPh = '13800009002'
  const g1 = await call(G, 'POST', '/api/cockpit/register', { ip: '203.0.113.70', headers: AKH, body: { phone: ownerPh, name: '老板', password: 'ownerpass123', isOwner: true } })
  ok('G 店主租户建立', g1.status === 201 && !!g1.body.token, JSON.stringify(g1.body))
  const ownerTok = g1.body.token, ownerUid = g1.body.userId
  const g2 = await call(G, 'POST', '/api/cockpit/members', { ip: '203.0.113.70', headers: { 'x-token': ownerTok }, body: { phone: empPh, name: '收银小张', role: 'cashier' } })
  ok('G 店主添加成员拿到邀请码', g2.status === 200 && /^\d{6}$/.test(String(g2.body.inviteCode)), JSON.stringify(g2.body))
  const g3 = await call(G, 'POST', '/api/cockpit/members/accept', { ip: '203.0.113.71', body: { phone: empPh, inviteCode: '000000', password: 'emppass1234' } })
  ok('G 错误邀请码被拒', g3.status === 400, JSON.stringify(g3.body))
  const g4 = await call(G, 'POST', '/api/cockpit/members/accept', { ip: '203.0.113.71', body: { phone: empPh, inviteCode: g2.body.inviteCode, password: 'emppass1234' } })
  ok('G 员工凭邀请码加入并拿到会话', g4.status === 200 && g4.body.role === 'cashier' && !!g4.body.token, JSON.stringify(g4.body))
  const empTok = g4.body.token
  ok('G 成员与店主共用同一数据槽（数据同源）', g4.body.userId === ownerUid, g4.body.userId + ' vs ' + ownerUid)
  const g5 = await call(G, 'GET', '/api/cockpit/permissions', { ip: '203.0.113.71', headers: { 'x-token': empTok } })
  ok('G 权限矩阵：收银可开单、不可改价', g5.status === 200 && g5.body.actions.indexOf('pos.sell') >= 0 && g5.body.actions.indexOf('price.change') < 0, JSON.stringify(g5.body.actions))
  await call(G, 'POST', '/api/cockpit/snapshot', { ip: '203.0.113.71', headers: { 'x-token': empTok }, body: { iv: 'AAAA', data: 'CASHIER-ORDER' } })
  const g6 = await call(G, 'GET', '/api/cockpit/snapshot/fetch', { ip: '203.0.113.70', headers: { 'x-token': ownerTok } })
  ok('G 店主能立刻读到员工上传的数据（同源）', g6.status === 200 && g6.body.data === 'CASHIER-ORDER', JSON.stringify(g6.body))
  const g7 = await call(G, 'POST', '/api/cockpit/members', { ip: '203.0.113.71', headers: { 'x-token': empTok }, body: { phone: '13800009003', name: 'x', role: 'manager' } })
  ok('G 员工不能添加成员（403）', g7.status === 403, 'status=' + g7.status)
  const g8 = await call(G, 'GET', '/api/cockpit/stats', { ip: '203.0.113.71', headers: { 'x-token': empTok } })
  ok('G 员工不能看经营统计（403）', g8.status === 403, 'status=' + g8.status)
  const g9 = await call(G, 'POST', '/api/cockpit/register', { ip: '203.0.113.80', headers: AKH, body: { phone: '13800009009', name: '另一家', password: 'otherpass123', isOwner: true } })
  const g10 = await call(G, 'POST', '/api/cockpit/members/disable', { ip: '203.0.113.80', headers: { 'x-token': g9.body.token }, body: { phone: empPh } })
  ok('G 跨租户停用被拒（403）', g10.status === 403, 'status=' + g10.status)
  const g11 = await call(G, 'POST', '/api/cockpit/members/disable', { ip: '203.0.113.70', headers: { 'x-token': ownerTok }, body: { phone: empPh } })
  ok('G 店主停用成员', g11.status === 200 && g11.body.member.enabled === false, JSON.stringify(g11.body))
  const g12 = await call(G, 'GET', '/api/cockpit/snapshot/fetch', { ip: '203.0.113.71', headers: { 'x-token': empTok } })
  ok('G 停用后成员会话立即失效（401）', g12.status === 401, 'status=' + g12.status)
  const g13 = await call(G, 'POST', '/api/cockpit/members/login', { ip: '203.0.113.72', body: { phone: empPh, password: 'emppass1234' } })
  ok('G 停用后成员登录被拒且文案明确', g13.status === 401 && /停用/.test(String(g13.body.error)), JSON.stringify(g13.body))
  stop(G)
} else { ok('G 成员服务启动', false, 'not ready') }

// ============================== 按单据增量同步（契约 v1.1） ==============================
console.log('\n[H] 进销存业务数据：按单据增量同步（替代整库覆盖，杜绝静默丢单）')
const H = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test' }, PBASE + 6, 'tenantsync')
if (await waitReady(H)) {
  const AKH = { 'x-admin-key': ADMIN_KEY }
  const h1 = await call(H, 'POST', '/api/cockpit/register', { ip: '198.51.100.10', headers: AKH, body: { phone: '13800008001', name: '渔具店', password: 'pass123456', isOwner: true } })
  const ownerTok = h1.body.token, ownerUid = h1.body.userId
  const im = await call(H, 'POST', '/api/cockpit/members', { ip: '198.51.100.10', headers: { 'x-token': ownerTok }, body: { phone: '13800008002', name: '收银', role: 'cashier' } })
  const emp = await call(H, 'POST', '/api/cockpit/members/accept', { ip: '198.51.100.11', body: { phone: '13800008002', inviteCode: im.body.inviteCode, password: 'emppass1234' } })
  const empTok = emp.body.token
  let h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.10', body: { cursor: 0, changes: [] } })
  ok('H 未登录同步被拒（401）', h.status === 401, 'status=' + h.status)
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.10', headers: { 'x-token': ownerTok }, body: { cursor: 0, changes: [{ kind: 'order', id: 'X', updatedAt: '2026-09-10T00:00:00Z' }] } })
  ok('H 非法记录类型被拒（400）', h.status === 400, JSON.stringify(h.body))
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.10', headers: { 'x-token': ownerTok }, body: { cursor: 0, changes: [
    { kind: 'transaction', id: 'T001', updatedAt: '2026-09-10T10:00:00Z', iv: 'IV-A', data: 'CIPHER-001' },
    { kind: 'transaction', id: 'T002', updatedAt: '2026-09-10T10:01:00Z', iv: 'IV-B', data: 'CIPHER-002' },
  ] } })
  ok('H 店主推送 2 条单据被接受', h.status === 200 && h.body.applied.length === 2 && h.body.cursor === 2, JSON.stringify(h.body))
  const c2 = h.body.cursor
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.11', headers: { 'x-token': empTok }, body: { cursor: 0, changes: [] } })
  ok('H 员工能拉到店主的单据（数据同源）', h.status === 200 && h.body.changes.length === 2, JSON.stringify(h.body.changes && h.body.changes.length))
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.11', headers: { 'x-token': empTok }, body: { cursor: c2, changes: [{ kind: 'transaction', id: 'T003', updatedAt: '2026-09-10T10:02:00Z', iv: 'IV-C', data: 'CIPHER-003' }] } })
  ok('H 员工能新增自己的单据', h.status === 200 && h.body.applied.length === 1 && h.body.cursor === 3, JSON.stringify(h.body))
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.10', headers: { 'x-token': ownerTok }, body: { cursor: 0, changes: [{ kind: 'transaction', id: 'T001', updatedAt: '2026-09-10T09:00:00Z', iv: 'IV-OLD', data: 'STALE' }] } })
  ok('H 更旧版本判为冲突且不覆盖', h.status === 200 && h.body.applied.length === 0 && h.body.conflicts.length === 1, JSON.stringify(h.body))
  ok('H 冲突回传服务端版本（不静默丢单）', h.body.conflicts[0].server.data === 'CIPHER-001', JSON.stringify(h.body.conflicts[0]))
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.10', headers: { 'x-token': ownerTok }, body: { cursor: 0, changes: [{ kind: 'transaction', id: 'T001', updatedAt: '2026-09-10T11:00:00Z', iv: 'IV-N', data: 'CORRECTED-001' }] } })
  ok('H 更新版本正常覆盖', h.status === 200 && h.body.applied.length === 1, JSON.stringify(h.body))
  await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.10', headers: { 'x-token': ownerTok }, body: { cursor: 0, changes: [{ kind: 'transaction', id: 'T002', updatedAt: '2026-09-10T12:00:00Z', deleted: true }] } })
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.11', headers: { 'x-token': empTok }, body: { cursor: 0, changes: [] } })
  const tomb = (h.body.changes || []).filter((x) => x.id === 'T002')[0]
  ok('H 删除墓碑会传播且密文清空', !!tomb && tomb.deleted === true && tomb.data === '', JSON.stringify(tomb))
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.10', headers: { 'x-token': ownerTok }, body: { cursor: 0, changes: [], limit: 1 } })
  ok('H 分页 limit=1 且 hasMore=true', h.status === 200 && h.body.changes.length === 1 && h.body.hasMore === true, JSON.stringify({ n: h.body.changes.length, more: h.body.hasMore }))
  const h2 = await call(H, 'POST', '/api/cockpit/register', { ip: '198.51.100.12', headers: AKH, body: { phone: '13800008009', name: '另一家', password: 'pass123456', isOwner: true } })
  h = await call(H, 'POST', '/api/tenant/sync', { ip: '198.51.100.12', headers: { 'x-token': h2.body.token }, body: { cursor: 0, changes: [] } })
  ok('H 跨租户业务数据隔离', h.status === 200 && h.body.changes.length === 0 && h.body.cursor === 0, JSON.stringify(h.body))
  h = await call(H, 'GET', '/api/tenant/status', { ip: '198.51.100.10', headers: { 'x-token': ownerTok } })
  ok('H 水位接口分类计数正确', h.status === 200 && h.body.totalRecords === 3 && h.body.byKind.transaction === 3, JSON.stringify(h.body))
  let bd = ''
  try { bd = fs.readFileSync(path.join(H.dataRoot, 'users', ownerUid, 'bizlog.json'), 'utf8') } catch (e) { bd = '' }
  ok('H 业务数据只存密文（明文不落盘）', bd.length > 0 && bd.indexOf('CORRECTED-001') >= 0 && bd.indexOf('渔具店') < 0 && bd.indexOf('收银') < 0, bd.slice(0, 120))
  stop(H)
} else { ok('H 增量同步服务启动', false, 'not ready') }

// ============================== 密码兜底通道（无需短信网关） ==============================
console.log('\n[I] 恢复码 / 已登录改密 / 管理员重置 —— 全部不依赖短信')
const I = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test' }, PBASE + 7, 'pwd')
if (await waitReady(I)) {
  const AKH = { 'x-admin-key': ADMIN_KEY }
  const FMT = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/
  let n = 1
  const c2 = (p, body, h, m) => call(I, m || 'POST', p, { ip: '203.0.113.' + ((n++ % 200) + 10), headers: h, body })
  const PH = '13800007001'
  let i1 = await c2('/api/cockpit/register', { phone: PH, name: '老板', password: 'pass123456', isOwner: true }, AKH)
  const rc1 = i1.body.recoveryCode, tok = i1.body.token
  ok('I 建号即签发一次性恢复码', FMT.test(String(rc1)), JSON.stringify(i1.body && i1.body.recoveryCode))
  let i9 = await c2('/api/cockpit/password/change', { old_password: 'WRONG', new_password: 'newpass111' }, { 'x-token': tok })
  ok('I 改密：原密码错误被拒', i9.status === 400, JSON.stringify(i9.body))
  i9 = await c2('/api/cockpit/password/change', { old_password: 'pass123456', new_password: '123' }, { 'x-token': tok })
  ok('I 改密：新密码过短被拒', i9.status === 400, JSON.stringify(i9.body))
  i9 = await c2('/api/cockpit/password/change', { old_password: 'pass123456', new_password: 'newpass111' }, { 'x-token': tok })
  const rc2 = i9.body.recoveryCode
  ok('I 改密成功并换发新恢复码', i9.status === 200 && FMT.test(String(rc2)) && rc2 !== rc1, JSON.stringify(i9.body))
  ok('I 改密需要登录（无 token 401）', (await c2('/api/cockpit/password/change', { old_password: 'pass123456', new_password: 'zzz999999' })).status === 401)
  ok('I 改密后旧密码失效', (await c2('/api/cockpit/login', { phone: PH, password: 'pass123456' })).status === 401)
  ok('I 改密后新密码可登录', (await c2('/api/cockpit/login', { phone: PH, password: 'newpass111' })).status === 200)
  i9 = await c2('/api/cockpit/recover', { phone: PH, recovery_code: 'AAAA-BBBB-CCCC-DDDD', new_password: 'recpass222' })
  ok('I 恢复码错误被拒且不泄露存在性', i9.status === 400 && !/不存在/.test(String(i9.body.error)), JSON.stringify(i9.body))
  ok('I 换发后旧恢复码作废', (await c2('/api/cockpit/recover', { phone: PH, recovery_code: rc1, new_password: 'recpass222' })).status === 400)
  i9 = await c2('/api/cockpit/recover', { phone: PH, recovery_code: rc2, new_password: 'recpass222' })
  const rc3 = i9.body.recoveryCode
  ok('I 恢复码可重置密码（无需短信）', i9.status === 200 && FMT.test(String(rc3)), JSON.stringify(i9.body))
  ok('I 重置后新密码可登录', (await c2('/api/cockpit/login', { phone: PH, password: 'recpass222' })).status === 200)
  ok('I 恢复码用后即焚（不可重放）', (await c2('/api/cockpit/recover', { phone: PH, recovery_code: rc2, new_password: 'again333' })).status === 400)
  ok('I 管理员重置：无 ADMIN_KEY 被拒', (await c2('/api/cockpit/admin/reset-password', { phone: PH, new_password: 'admin99999' })).status === 401)
  i9 = await c2('/api/cockpit/admin/reset-password', { phone: PH, new_password: 'admin99999' }, AKH)
  const rc4 = i9.body.recoveryCode
  ok('I 管理员重置账号成功并换发恢复码', i9.status === 200 && i9.body.target === 'owner' && FMT.test(String(rc4)), JSON.stringify(i9.body))
  ok('I 管理员重置后密码可登录', (await c2('/api/cockpit/login', { phone: PH, password: 'admin99999' })).status === 200)
  const MEM = '13800007002'
  const im = await c2('/api/cockpit/members', { phone: MEM, name: '收银', role: 'cashier' }, { 'x-token': tok })
  const ac = await c2('/api/cockpit/members/accept', { phone: MEM, inviteCode: im.body.inviteCode, password: 'mem123456' })
  const rcM = ac.body.recoveryCode
  ok('I 成员入伙签发恢复码', ac.status === 200 && FMT.test(String(rcM)), JSON.stringify(ac.body))
  i9 = await c2('/api/cockpit/password/change', { old_password: 'mem123456', new_password: 'mem654321' }, { 'x-token': ac.body.token })
  ok('I 成员可自己改密（成员会话识别）', i9.status === 200 && FMT.test(String(i9.body.recoveryCode)), JSON.stringify(i9.body))
  i9 = await c2('/api/cockpit/admin/reset-password', { phone: MEM, new_password: 'memadmin11' }, AKH)
  ok('I 管理员可重置成员密码', i9.status === 200 && i9.body.target === 'member', JSON.stringify(i9.body))
  ok('I 非账号非成员手机号被拒', (await c2('/api/cockpit/admin/reset-password', { phone: '13800007009', new_password: 'nobody123' }, AKH)).status === 400)
  let a1 = '', a2 = ''
  try { a1 = fs.readFileSync(path.join(I.dataRoot, 'cockpit-accounts.json'), 'utf8') } catch (e) {}
  try { a2 = fs.readFileSync(path.join(I.dataRoot, 'tenant-members.json'), 'utf8') } catch (e) {}
  ok('I 账号/成员文件只存恢复码哈希', /"recHash"/.test(a1) && /"recHash"/.test(a2), a1.slice(0, 60))
  ok('I 恢复码明文均未落盘', [rc1, rc2, rc3, rc4, rcM].every((c) => !c || (a1 + a2).indexOf(String(c)) < 0))
  stop(I)
} else { ok('I 密码兜底服务启动', false, 'not ready') }

// ============================== 手机号强制策略开关 ==============================
console.log('\n[J] REQUIRE_PHONE_ON_REGISTER=1 时才强制手机号（策略可配，不是写死）')
const J = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test', REQUIRE_PHONE_ON_REGISTER: '1' }, PBASE + 8, 'phonepolicy')
if (await waitReady(J)) {
  let j1 = await call(J, 'POST', '/api/account/register', { ip: '198.51.100.201', body: { username: 'nophoneX', password: 'pass123456' } })
  ok('J 开关打开：无手机号注册被拒', j1.status === 400 && /手机号/.test(String(j1.body.error)), JSON.stringify(j1.body))
  j1 = await call(J, 'POST', '/api/account/register', { ip: '198.51.100.202', headers: { 'x-admin-key': ADMIN_KEY }, body: { username: 'adminnoPhone', password: 'pass123456' } })
  ok('J 开关打开：管理员仍可无手机号建号', j1.status === 200 && !!j1.body.userId, JSON.stringify(j1.body))
  stop(J)
} else { ok('J 策略服务启动', false, 'not ready') }

// ============================== 汇总 ==============================
// ============================== K：进销存设备令牌也能用增量同步 ==============================
console.log('\n[K] 进销存设备令牌（uploadToken）也能用按记录增量同步（无需先做身份收敛）')
const K = await startServer({ TRUST_PROXY: '1', ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test' }, PBASE + 9, 'devsync')
if (await waitReady(K)) {
  // 两个进销存账号（走管理员通道，免手机号）验证"设备令牌"这条并列鉴权
  let k = await call(K, 'POST', '/api/account/register', { ip: '198.51.100.30', headers: { 'x-admin-key': ADMIN_KEY }, body: { username: 'dev-a', password: 'pass123456' } })
  const uidA = k.body.userId
  const bindA = await call(K, 'POST', '/api/device/bind', { ip: '198.51.100.30', body: { username: 'dev-a', password: 'pass123456', deviceName: 'A' } })
  const tokA = bindA.body.uploadToken
  k = await call(K, 'POST', '/api/account/register', { ip: '198.51.100.31', headers: { 'x-admin-key': ADMIN_KEY }, body: { username: 'dev-b', password: 'pass123456' } })
  const uidB = k.body.userId
  const bindB = await call(K, 'POST', '/api/device/bind', { ip: '198.51.100.31', body: { username: 'dev-b', password: 'pass123456', deviceName: 'B' } })
  const tokB = bindB.body.uploadToken

  k = await call(K, 'POST', '/api/tenant/sync', { ip: '198.51.100.30', body: { cursor: 0, changes: [] } })
  ok('K 无令牌仍被拒（401）', k.status === 401, 'status=' + k.status)
  k = await call(K, 'POST', '/api/tenant/sync', { ip: '198.51.100.30', headers: { 'x-user-id': uidA, 'x-token': 'bogus-token' }, body: { cursor: 0, changes: [] } })
  ok('K 伪造设备令牌被拒（401）', k.status === 401, 'status=' + k.status)
  k = await call(K, 'POST', '/api/tenant/sync', { ip: '198.51.100.30', headers: { 'x-user-id': uidA, 'x-token': tokA }, body: { cursor: 0, changes: [{ kind: 'transaction', id: 'DEV-T1', updatedAt: '2026-09-12T10:00:00Z', iv: 'IV-D1', data: 'CIPHER-D1' }] } })
  ok('K 设备令牌可推送（200 / applied=1）', k.status === 200 && k.body.applied.length === 1 && k.body.cursor === 1, JSON.stringify(k.body))
  k = await call(K, 'POST', '/api/tenant/sync', { ip: '198.51.100.30', headers: { 'x-user-id': uidA, 'x-token': tokA }, body: { cursor: 0, changes: [] } })
  ok('K 设备令牌可拉取', k.status === 200 && k.body.changes.length === 1 && k.body.changes[0].id === 'DEV-T1', JSON.stringify(k.body.changes && k.body.changes.length))
  k = await call(K, 'GET', '/api/tenant/status', { ip: '198.51.100.30', headers: { 'x-user-id': uidA, 'x-token': tokA } })
  ok('K 水位接口可用（设备令牌）', k.status === 200 && k.body.totalRecords === 1, JSON.stringify(k.body))
  k = await call(K, 'POST', '/api/tenant/sync', { ip: '198.51.100.31', headers: { 'x-user-id': uidB, 'x-token': tokB }, body: { cursor: 0, changes: [] } })
  ok('K 跨进销存账号数据隔离', k.status === 200 && k.body.changes.length === 0 && k.body.cursor === 0, JSON.stringify(k.body))
  const hk = await call(K, 'POST', '/api/cockpit/register', { ip: '198.51.100.32', headers: { 'x-admin-key': ADMIN_KEY }, body: { phone: '13800009001', name: 'k', password: 'pass123456', isOwner: true } })
  k = await call(K, 'POST', '/api/tenant/sync', { ip: '198.51.100.32', headers: { 'x-token': hk.body.token }, body: { cursor: 0, changes: [] } })
  ok('K 回归：驾驶舱会话路径未被破坏', k.status === 200 && k.body.cursor === 0, JSON.stringify(k.body))
  stop(K)
} else { ok('K 设备令牌同步服务启动', false, 'not ready') }

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
if (fail) { console.log('未通过：\n - ' + failures.join('\n - ')) }
console.log('======================================')
process.exit(fail ? 1 : 0)
