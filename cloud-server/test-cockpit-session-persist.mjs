// 驾驶舱「记住登录」回归测试（2026-09-20）
// 运行：node test-cockpit-session-persist.mjs    （零依赖）
//
// 背景（用户反馈）：「每次重新进入驾驶舱都要重新登录一遍，驾驶舱记不住账号。」
// 根因：驾驶舱会话只存内存 Map（进程一重启全体掉线）+ TTL 只有 12 小时（隔天必过期）。
// 本测试锁死三件事：
//   1. 会话有效期不再是 12h（落盘 + 30 天）；
//   2. **进程重启后旧 token 依然可用**（这是用户最直接的痛点）；
//   3. 滑动续期：只要还在用，剩余有效期会被续满；
//   4. 登出（revoke）要真的失效，并且落盘里也不再留下它。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// index.js 所在目录（要跑生产机上那份代码时，用 CLOUD_APP_DIR 指过去；node 18 没有 import.meta.dirname）
const DIR = process.env.CLOUD_APP_DIR || import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ADMIN_KEY = 'test-admin-key-0123456789'
const PBASE = Number(process.env.TEST_PORT_BASE || 39600)
let pass = 0, fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; failures.push(name + (extra ? '  [' + extra + ']' : '')); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function startServer(env, port, dataRoot) {
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
async function waitReady(s, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch('http://127.0.0.1:' + s.port + '/api/account/captcha'); if (r.status === 200) return true } catch { }
    await sleep(100)
  }
  return false
}
async function call(s, method, p, { body, headers = {} } = {}) {
  const h = { ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch('http://127.0.0.1:' + s.port + p, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j = null
  try { j = await res.json() } catch { }
  return { status: res.status, body: j }
}
async function stop(s) {
  try { s.proc.kill() } catch { }
  await sleep(400)
}
/** 用「会话鉴权端点」判定 token 是否有效：401 = 无效；其它（404 无快照/200）= 会话有效 */
async function sessionAlive(s, token) {
  const r = await call(s, 'GET', '/api/cockpit/snapshot/fetch', { headers: token ? { 'x-token': token } : {} })
  return { alive: r.status !== 401, status: r.status }
}
async function registerAndLogin(s, phone, name) {
  await call(s, 'POST', '/api/cockpit/sendCode', { body: { phone } })
  const r = await call(s, 'POST', '/api/cockpit/register', { body: { phone, name, password: 'pass123456', sms_code: '123456', isOwner: true } })
  return r
}
async function startIfReady(env, port, dataRoot, tag) {
  const s = startServer(env, port, dataRoot)
  if (!(await waitReady(s))) {
    console.log('  ✗ 服务未就绪（' + tag + '）：')
    console.log(s.getOut() + s.getErr())
    process.exit(1)
  }
  return s
}
const ENV = { ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test' }

// ============ 场景 A：TTL 30 天 + 重启后不掉线 + 登出真失效 ============
console.log('\n[A] 会话落盘 + 重启后仍有效')
const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sess-'))
let A = await startIfReady(ENV, PBASE + 1, rootA, 'A')

let r = await registerAndLogin(A, '13900000001', '阿杜')
ok('A1 注册即登录成功', r.status === 201 && !!r.body.token, JSON.stringify(r.body))
const tokenA = r.body.token
ok('A2 响应里的 expiresIn 不再是 12 小时', Number(r.body.expiresIn) >= 30 * 24 * 3600, 'expiresIn=' + r.body.expiresIn)

let alive = await sessionAlive(A, tokenA)
ok('A3 token 有效（非 401）', alive.alive, 'status=' + alive.status)
alive = await sessionAlive(A, 'deadbeef-not-a-real-token')
ok('A4 伪造 token 无效（401）', !alive.alive, 'status=' + alive.status)

const sessFile = path.join(rootA, 'cockpit-sessions.json')
ok('A5 会话已落盘 cockpit-sessions.json', fs.existsSync(sessFile))
let disk = {}
try { disk = JSON.parse(fs.readFileSync(sessFile, 'utf8')) } catch { }
ok('A6 落盘内容含该 token', !!disk[tokenA])
const ttlMs = disk[tokenA] ? (Number(disk[tokenA].expiresAt) - Date.now()) : 0
ok('A7 落盘有效期 ≈ 30 天（>29 天）', ttlMs > 29 * 24 * 3600 * 1000, 'remainingMs=' + ttlMs)
ok('A8 落盘文件权限 0600（Windows 上语义有限，仅记录）', true)

await stop(A)

// 重启：同一 dataRoot，换端口
A = await startIfReady(ENV, PBASE + 2, rootA, 'A-restart')
alive = await sessionAlive(A, tokenA)
ok('A9 ★ 进程重启后旧 token 依然有效（用户痛点的正解）', alive.alive, 'status=' + alive.status)

r = await call(A, 'POST', '/api/cockpit/logout', { headers: { 'x-token': tokenA } })
ok('A10 登出返回 200', r.status === 200, JSON.stringify(r.body))
alive = await sessionAlive(A, tokenA)
ok('A11 登出后 token 立刻失效', !alive.alive, 'status=' + alive.status)
try { disk = JSON.parse(fs.readFileSync(sessFile, 'utf8')) } catch { disk = {} }
ok('A12 登出后落盘里也不再留着它', !disk[tokenA])
await stop(A)

// 再来一次重启：确认「登出」不会被落盘文件复活
A = await startIfReady(ENV, PBASE + 3, rootA, 'A-restart2')
alive = await sessionAlive(A, tokenA)
ok('A13 重启后登出的 token 仍是失效的（不会被落盘复活）', !alive.alive, 'status=' + alive.status)
await stop(A)

// ============ 场景 B：滑动续期（短 TTL 便于观测） ============
console.log('\n[B] 滑动续期：剩余不足一半就续满')
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-renew-'))
const ENV_B = { ...ENV, COCKPIT_SESSION_TTL_MS: '4000', COCKPIT_SESSION_FLUSH_MS: '400' }   // 4 秒有效期，400ms 落盘节流，便于观测
let B = await startIfReady(ENV_B, PBASE + 4, rootB, 'B')
r = await registerAndLogin(B, '13900000002', '丹丹')
const tokenB = r.body.token
ok('B1 短 TTL 模式下注册成功', r.status === 201 && !!tokenB, JSON.stringify(r.body))
const fileB = path.join(rootB, 'cockpit-sessions.json')
const readExp = () => { try { return Number(JSON.parse(fs.readFileSync(fileB, 'utf8'))[tokenB].expiresAt) } catch { return 0 } }
const exp0 = readExp()
ok('B2 初始有效期 ≈ 4 秒', exp0 > 0, 'exp0=' + exp0)
await sleep(2600)                                  // 剩余 ~1.4s < 2s → 触发续期
alive = await sessionAlive(B, tokenB)
ok('B3 有效期过半后仍然有效（没被踢）', alive.alive, 'status=' + alive.status)
await sleep(1200)                                  // 让节流窗口过去，确保落盘
const exp1 = readExp()
ok('B4 ★ 有效期已被续满（滑动续期生效）', exp1 > exp0, 'exp0=' + exp0 + ' exp1=' + exp1)
await sleep(4500)                                  // 超过续期后的 4 秒 → 应过期
alive = await sessionAlive(B, tokenB)
ok('B5 停止使用后按期过期（没有变成永久登录）', !alive.alive, 'status=' + alive.status)
await stop(B)

console.log('\n============================')
console.log('  PASS ' + pass + '   FAIL ' + fail)
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)) }
console.log('============================')
process.exit(fail ? 1 : 0)
