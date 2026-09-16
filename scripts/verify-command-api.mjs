/**
 * 命令接口验收（阶段3：HTTP 命令 API）
 * 起真服务端（内存临时库），验：
 *   GET /api/commands（全集/过滤/单条详情/鉴权）
 *   POST /api/command（{name,params} 通用入口，复用 /api/invoke 的鉴权+限流+幂等）
 *   注册表与代码一致（重新抽取后与提交的 registry 相同）
 * 用法：node scripts/verify-command-api.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDatabase } from '../electron/db.js'
import { createInventoryServer } from '../electron/server.js'

const NL = String.fromCharCode(10)
let pass = 0, fail = 0
const failures = []
function ok(n, c, e) { if (c) { pass++; console.log('  PASS  ' + n) } else { fail++; failures.push(n + (e ? '  [' + e + ']' : '')); console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdapi-'))
const db = openDatabase(path.join(tmp, 'data.db'))
const srv = createInventoryServer({ db, dataDir: tmp, basePort: 0 })

try {
  const boot = await srv.start()
  const st = srv.status()
  const base = `http://127.0.0.1:${st.port}`
  // 注意：status() 不含 token，token 在 start() 返回的 httpUrl 里（?token=）
  const T = new URL(boot.httpUrl).searchParams.get('token')
  ok('取得服务端 token', !!T, 'token 长度=' + String(T || '').length)
  const J = (r) => r.json().catch(() => ({}))
  console.log('服务端已起: ' + base + NL)

  // ---------- GET /api/commands ----------
  let r = await fetch(base + '/api/commands', { headers: { 'x-token': T } })
  let j = await J(r)
  ok('GET /api/commands 返回 200', r.status === 200, 'status=' + r.status)
  ok('命令全集非空（total>100）', Number(j.total) > 100, 'total=' + j.total)
  ok('带分组统计', j.groups && Object.keys(j.groups).length > 10, 'groups=' + (j.groups ? Object.keys(j.groups).length : 0))
  ok('REST 路径单独归类（不混进可执行命令）', Array.isArray(j.restRoutes) && j.commands.every((c) => !c.rest), 'restRoutes=' + (j.restRoutes || []).length)

  r = await fetch(base + '/api/commands?group=product', { headers: { 'x-token': T } })
  j = await J(r)
  ok('按前缀过滤生效（group=product）', r.status === 200 && j.filtered > 0 && j.commands.every((c) => c.group === 'product'), JSON.stringify({ filtered: j.filtered }))

  r = await fetch(base + '/api/commands?q=库存', { headers: { 'x-token': T } })
  j = await J(r)
  ok('按关键字搜索生效（q=库存）', r.status === 200 && Array.isArray(j.commands), 'filtered=' + j.filtered)

  r = await fetch(base + '/api/commands?name=' + encodeURIComponent('data:loadAll'), { headers: { 'x-token': T } })
  j = await J(r)
  ok('单条详情返回元数据 + 三通道示例', r.status === 200 && j.ok === true && !!j.command && !!j.examples?.http, JSON.stringify(j.command || {}))

  r = await fetch(base + '/api/commands?name=' + encodeURIComponent('不存在的命令'), { headers: { 'x-token': T } })
  j = await J(r)
  ok('未知命令详情返回 ok:false 并给提示', r.status === 200 && j.ok === false && !!j.hint, JSON.stringify(j))

  // ---------- 鉴权 ----------
  r = await fetch(base + '/api/commands')
  ok('缺少 token  401', r.status === 401, 'status=' + r.status)
  r = await fetch(base + '/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ok('POST /api/command 缺 token  401', r.status === 401, 'status=' + r.status)

  // ---------- POST /api/command ----------
  r = await fetch(base + '/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': T },
    body: JSON.stringify({ name: 'data:loadAll', params: {} }),
  })
  j = await J(r)
  ok('POST /api/command 执行成功（data:loadAll）', r.status === 200 && j.ok === true && !!j.result, 'status=' + r.status)

  r = await fetch(base + '/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': T },
    body: JSON.stringify({ name: '根本不存在:xxx', params: {} }),
  })
  j = await J(r)
  ok('未知命令  404', r.status === 404, 'status=' + r.status + ' ' + JSON.stringify(j))

  // 幂等：同一 idempotencyKey 连发两次，第二次应 idempotent:true（证明复用了 /api/invoke 那套）
  const body = JSON.stringify({ name: 'data:loadAll', params: { idempotencyKey: 'cmdapi-' + Date.now() } })
  const h = { 'content-type': 'application/json', 'x-token': T }
  const r1 = await J(await fetch(base + '/api/command', { method: 'POST', headers: h, body }))
  const r2 = await J(await fetch(base + '/api/command', { method: 'POST', headers: h, body }))
  ok('复用 /api/invoke 的幂等层（第二次 idempotent:true）', r2.idempotent === true, JSON.stringify({ first: r1.ok, second: r2.idempotent }))

  // ---------- 接入指南防腐（2026-09-16 新增）----------
  // 上一版指南（v1）烂掉的原因很朴素：它提的入口是旧的、还提了一个不存在的脚本，
  // 而**没有任何断言盯着它** —— 于是文档慢慢变成传说。这里给它加上牙齿。
  const guide = fs.readFileSync(path.resolve('docs/进销存系统Agent接入指南.md'), 'utf8')
  const cited = [...new Set([...guide.matchAll(/(?:scripts|docs)\/[A-Za-z0-9_\u4e00-\u9fa5.-]+\.(?:mjs|md)/g)].map((m) => m[0]))]
  const gone = cited.filter((p) => !fs.existsSync(path.resolve(p)))
  ok('指南里提到的脚本/文档路径都真实存在（写了不存在的路径就红）', gone.length === 0, '找不到: ' + gone.join(' '))
  ok('指南提到了三条真实入口（自省 / 通用调用 / CLI）',
    guide.includes('/api/commands') && guide.includes('/api/invoke') && guide.includes('inv-cli.mjs'))
  ok('指南讲清了读写规则（写命令要 --yes）', /--yes/.test(guide) && /write: true/.test(guide))
  const reg = JSON.parse(fs.readFileSync(path.resolve('electron/commandRegistry.json'), 'utf8'))
  const declared = (guide.match(/当前\s*\*\*(\d+)\*\*\s*条命令/) || [])[1]
  ok('指南声明的命令总数 = 注册表真实值', Number(declared) === reg.total, '指南=' + declared + ' 注册表=' + reg.total)
  const declaredRead = (guide.match(/其中\s*\*\*(\d+)\*\*\s*条只读/) || [])[1]
  const realRead = reg.commands.filter((c) => c.write === false).length
  ok('指南声明的"只读条数" = 注册表真实值', Number(declaredRead) === realRead, '指南=' + declaredRead + ' 注册表=' + realRead)
  // 指南里那张 REST 清单同样会烂：凡提到的 /api 路径都必须真的存在
  const citedApis = [...new Set([...guide.matchAll(/\/api\/[a-zA-Z/_-]+/g)].map((m) => m[0]))]
  const knownApis = new Set([...reg.restRoutes, '/api/invoke', '/api/command', '/api/commands'])
  const ghostApis = citedApis.filter((p) => !knownApis.has(p))
  ok('指南里提到的 /api 路径都是真实存在的接口', ghostApis.length === 0, '不存在: ' + ghostApis.join(' '))

  // ---------- 注册表与代码一致 ----------
  const before = fs.readFileSync(path.resolve('electron/commandRegistry.json'), 'utf8')
  execFileSync(process.execPath, ['scripts/command-surface.mjs', '--emit-registry'], { stdio: 'pipe' })
  const after = fs.readFileSync(path.resolve('electron/commandRegistry.json'), 'utf8')
  const norm = (s) => s.replace(/"generatedAt"\s*:\s*"[^"]+"/, '')
  ok('提交的注册表与代码一致（重新抽取后除时间戳外相同）', norm(before) === norm(after), '需要重新 --emit-registry')
} catch (e) {
  fail++; failures.push('异常: ' + e.message)
  console.error(NL + '异常: ' + e.message)
} finally {
  try { srv.stop() } catch {}
  try { db.close() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(NL + '================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
if (fail) console.log('未通过:' + NL + ' - ' + failures.join(NL + ' - '))
console.log('======================================')
process.exit(fail ? 1 : 0)