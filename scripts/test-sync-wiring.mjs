/**
 * 阶段2.2 接线 + 首次播种 端到端验证
 * 流程：起真实服务端  initCloud(真实库副本)  loginAccount()  观察服务端是否收到本机全部历史数据
 * 用法：node scripts/test-sync-wiring.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SERVER_DIR = process.env.CLOUD_SERVER_DIR || 'D:/通用进销存/cloud-server'
const PORT = 39702
const BASE = `http://127.0.0.1:${PORT}`
// 关键：cloud.js 在 import 那一刻就固定 CLOUD_SERVER_URL，必须先指向本地测试服务端再动态 import，
// 否则会打到生产域名上去（默认 https://sync.junchengzn.com）
process.env.CLOUD_SERVER_URL = BASE
const cloud = await import('../electron/cloud.js')
const ADMIN_KEY = 'test-admin-key-0123456789'
const REAL_DB = path.join(process.env.APPDATA, 'fishing-inventory', 'data.db')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const failures = []
function ok(n, c, e) { if (c) { pass++; console.log('  PASS  ' + n) } else { fail++; failures.push(n + (e ? '  [' + e + ']' : '')); console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')) } }

const SYNCABLE = ['products','inventory_batches','transactions','stock_takes','stock_take_items','categories','units','suppliers','customers','payments','expenses','purchase_orders','purchase_order_items','price_tiers','kits','kit_items','supplier_payments','waste_logs','payment_registers']

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-wire-'))
const serverRoot = path.join(tmp, 'cloud'); fs.mkdirSync(serverRoot, { recursive: true })
const machDir = path.join(tmp, 'machine'); fs.mkdirSync(machDir, { recursive: true })
const dbPath = path.join(machDir, 'data.db')
fs.copyFileSync(REAL_DB, dbPath)
if (fs.existsSync(REAL_DB + '-wal')) fs.copyFileSync(REAL_DB + '-wal', dbPath + '-wal')

let expect = 0
{
  const d = new DatabaseSync(dbPath, { readOnly: true })
  for (const t of SYNCABLE) expect += d.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE guid IS NOT NULL`).get().n
  d.close()
}
console.log('本机待播种行数（19 张表有 guid 的行）= ' + expect)

console.log('起真实 cloud-server（端口 ' + PORT + '）')
const srv = spawn(process.execPath, ['index.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), CLOUD_DATA_ROOT: serverRoot, ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test', TRUST_PROXY: '1' }, windowsHide: true })
let srvOut = ''
srv.stdout.on('data', (d) => { srvOut += d.toString() })
srv.stderr.on('data', (d) => { srvOut += d.toString() })

let db = null
try {
  let ready = false
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/account/captcha'); if (r.status === 200) { ready = true; break } } catch {} await sleep(100) }
  if (!ready) throw new Error('服务端未就绪:\n' + srvOut)

  const jpost = async (p, b, h = {}) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) } }
  const reg = await jpost('/api/account/register', { username: 'wire', password: 'pass123456' }, { 'x-admin-key': ADMIN_KEY })
  ok('建号成功（管理员通道免手机号）', reg.status === 200 && !!reg.body.userId, JSON.stringify(reg.body))

  // 真跑 app 的接线
  db = new DatabaseSync(dbPath)
  cloud.initCloud(db, dbPath, machDir, path.join(machDir, 'backup'), () => true)
  const lg = await cloud.loginAccount('wire', 'pass123456', 'wire-test')
  ok('loginAccount 成功（接线后登录不报错）', lg.ok === true, JSON.stringify(lg))
  const st = cloud.getCloudState()
  const auth = { userId: st.userId, uploadToken: st.uploadToken }
  ok('拿到 userId + uploadToken', !!auth.userId && !!auth.uploadToken, JSON.stringify(auth))

  // 登录会 fire-and-forget 触发 syncBusinessData（播种 + 推送），轮询等服务端收到
  let total = 0, byKind = {}
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const r = await fetch(BASE + '/api/tenant/status', { headers: { 'x-user-id': auth.userId, 'x-token': auth.uploadToken } })
    const j = await r.json().catch(() => ({}))
    total = Number(j.totalRecords) || 0
    byKind = j.byKind || {}
    if (total >= expect) break
  }
  ok('服务端已收到全部历史数据（首次播种生效）', total === expect, `服务端 ${total} / 本机 ${expect}`)
  ok('按 kind 分类计数正确（商品 324 / 流水 365 / 批次 337）',
     byKind.product === 324 && byKind.transaction === 365 && byKind.inventory_batch === 337,
     JSON.stringify(byKind))

  const bs = cloud.businessSyncStatus()
  ok('本地待推积压已清空（changelog 已裁剪）', !!bs && bs.backlog === 0, JSON.stringify(bs))
  ok('无延后记录（没有解析不到的父引用）', !!bs && bs.deferredRecords === 0, JSON.stringify(bs))

  console.log('\n服务端 byKind:', JSON.stringify(byKind))
} catch (e) {
  fail++; failures.push('异常: ' + e.message); console.error('\n异常: ' + e.message)
} finally {
  try { cloud.stopScheduler() } catch {}
  try { db && db.close() } catch {}
  try { srv.kill() } catch {}
  await sleep(300)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
if (fail) console.log('未通过:\n - ' + failures.join('\n - '))
console.log('======================================')
process.exit(fail ? 1 : 0)