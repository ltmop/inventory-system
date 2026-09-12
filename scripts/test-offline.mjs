// test-offline.mjs —— 桌面离线层（A3）验收夹具
//
// 跑法（仓库根目录下）：
//   node scripts/test-offline.mjs
//   node scripts/test-offline.mjs --mutate=classifier    # 变异自检，见下
//
// 特点：
//   · 不需要 Electron、不需要网络、不需要数据库 —— 全部走注入的假中心库 + 内存存储。
//   · 被测模块固定走 src/lib/offlineTransport.js（已入库 commit 4cbab83）；**找不到就直接失败**，
//     绝不静默跳过 —— 夹具悄悄不测了，比测试失败更危险。
//   · 本文件是新增文件，**不改变** scripts/test-backend.mjs 的断言数（铁律②断言只加不减）。
//   · 变异自检：依据 mattpocock/skills 的 /tdd ——「一个从没红过的套件不是证据」。
//     故意改坏被测模块的一处，看套件是否变红；变异存活 = 那组断言是空的（没检查到东西）。
//
// 覆盖老板指定的 A4 五条：
//   ① 断网 5 单 → 中心库恰好 5 笔、无重复          → 第三节
//   ② 同一 idempotencyKey 连发 3 次 → 1 笔         → 第四节
//   ③ 业务拒绝不入队                               → 第二、五节
//   ④ 队列是传输缓冲不是账本                       → 第七节
//   ⑤ 排除通道离线时明确报错                       → 第六节
// 另含：写通道清单三方一致性（第一节）、断网建档→入库的临时 id 闭环（第八节）、
//      断网读缓存回退（第九节）、队列上限与失败项不无限重试（第十节）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 仓库根 = 本脚本的上一级（scripts/ → 仓库根）。可用 FI_REPO 覆盖。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = process.env.FI_REPO || path.resolve(HERE, '..')

// ---------- 加载被测模块 ----------
const TARGET = path.join(REPO, 'src', 'lib', 'offlineTransport.js')
if (!fs.existsSync(TARGET)) {
  console.error('✗ 找不到被测模块：' + TARGET)
  console.error('  请确认 src/lib/offlineTransport.js 已入库（commit 4cbab83）。夹具不会静默跳过。')
  process.exit(2)
}
const picked = TARGET
const tmp = path.join(os.tmpdir(), 'offlineTransport-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs')

// ---------- 变异自检（--mutate=<名>）----------
// 依据 mattpocock/skills 的 /tdd：「一个从没红过的套件不是证据」。
// 红绿循环本轮没跑过（Agent 无 shell），所以用变异测试补上：故意改坏被测模块的一处，
// 看套件是否**变红**。变异被杀死 = 这组断言真的在检查那处逻辑；变异存活 = 那组断言是空的。
const MUTATE = (process.argv.find((a) => a.startsWith('--mutate=')) || '').split('=')[1] || null
const MUTATIONS = {
  classifier: { from: 'if (st !== null) return st === 502 || st === 503 || st === 504', to: 'if (st !== null) return true', kills: '第二节 故障分类' },
  maxqueue: { from: 'if (q.length >= MAX_QUEUE) throw new Error(', to: 'if (false) throw new Error(', kills: '第十节 队列上限' },
  tmpid: { from: 'if (item.tmpId) res.id = item.tmpId', to: 'if (false) res.id = item.tmpId', kills: '第八节 临时 id 闭环' },
  idem: { from: 'if (writing && !p.idempotencyKey) p.idempotencyKey = newKey()', to: 'if (false) p.idempotencyKey = newKey()', kills: '第三节 幂等键' },
  dedupe: { from: 'q.splice(i, 1); done++', to: 'done++', kills: '第三/七节 成功即出队' },
}
let src = fs.readFileSync(picked, 'utf8')
if (MUTATE) {
  const m = MUTATIONS[MUTATE]
  if (!m) { console.error('未知变异: ' + MUTATE + '（可选: ' + Object.keys(MUTATIONS).join(', ') + '）'); process.exit(2) }
  const n = src.split(m.from).length - 1
  if (n !== 1) { console.error('变异锚点在源码里命中 ' + n + ' 次（需恰好 1 次）：' + m.from); process.exit(2) }
  src = src.replace(m.from, () => m.to)
}
fs.writeFileSync(tmp, src)
const mod = await import(pathToFileURL(tmp).href)

console.log('被测模块: ' + picked)
console.log('仓库根  : ' + REPO)
console.log('')

// ---------- 断言工具 ----------
let pass = 0
let fail = 0
const failures = []
function section(t) { console.log('\n【' + t + '】') }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return }
  fail++; failures.push(name)
  console.log('  ✗ ' + name + (extra !== undefined ? '\n      → ' + extra : ''))
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ✓ ' + name); return }
  fail++; failures.push(name)
  console.log('  ✗ ' + name + '\n      期望: ' + e + '\n      实际: ' + a)
}

// ---------- 假中心库 ----------
function makeCentral() {
  const byKey = new Map()
  const log = []
  let nextId = 1000
  const st = { down: false, biz: null, calls: 0 }
  async function invoke(channel, payload) {
    st.calls++
    if (st.down) throw new Error('connect ECONNREFUSED 127.0.0.1:3200')   // 无 status → 传输层故障
    if (st.biz) { const e = new Error(st.biz.message); e.status = st.biz.status; throw e }
    const key = payload && payload.idempotencyKey
    if (key && byKey.has(key)) return byKey.get(key)      // 幂等：同 key 返回原结果、不新增单据
    const id = nextId++
    const result = { ok: true, id }
    log.push({ channel, payload, id })
    if (key) byKey.set(key, result)
    return result
  }
  return {
    invoke, st, log,
    writeCount: () => log.length,
    distinct: () => byKey.size,
    byChannel: (ch) => log.filter((x) => x.channel === ch),
  }
}

// ---------- 每个小节用全新实例，避免互相污染 ----------
let clock = 1700000000000
function fresh(central) {
  const st = mod.__testables.memStorage()
  let onlineFlag = true
  const api = mod.createOffline({
    inner: { invoke: central.invoke },
    storage: st,
    now: () => (clock += 1000),
    online: () => onlineFlag,
    autoFlush: false,
  })
  return {
    api, st,
    // ⚠️ 断网必须**两边一起改**：模块的 online() 判断 + 假中心库真的失败。
    // 只改 online() 而让传输层成功 = 请求照常写进中心库，测出来的绿是假的
    // （第一版就是这么错的：5 单全写进了中心库，后面几条断言反而"通过"了）。
    // 传 { transport: false } 可只改"我以为断网了"、让传输层照常回 HTTP 状态 ——
    // 用于验证"拿到了 HTTP 状态就是业务裁决，绝不入队"这条优先级。
    setOnline: (v, opt) => {
      onlineFlag = v
      if (!opt || opt.transport !== false) central.st.down = !v
    },
    keys: () => Array.from(st.__mem.keys()),
  }
}
const ALLOWED_KEY = (k) => k === mod.K_QUEUE || k === mod.K_IDMAP || k.indexOf(mod.K_CACHE) === 0

// ============================================================
section('一、写通道清单三方一致性（防漂移：server.js 是权威）')
{
  const serverText = fs.readFileSync(path.join(REPO, 'electron', 'server.js'), 'utf8')
  const sm = serverText.match(/const WRITE_CHANNELS = new Set\(\[([\s\S]*?)\]\)/)
  ok('能从 electron/server.js 提取权威 WRITE_CHANNELS', !!sm)
  const serverList = sm ? [...sm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []

  const mobileText = fs.readFileSync(path.join(REPO, 'electron', 'mobile', 'app.js'), 'utf8')
  const mm = mobileText.match(/const WRITE_CHANNELS = \{([\s\S]*?)\n\}/)
  ok('能从 electron/mobile/app.js 提取 WRITE_CHANNELS 副本', !!mm)
  const mobileList = mm ? [...mm[1].matchAll(/'([^']+)'\s*:/g)].map((x) => x[1]) : []

  eq('server.js 权威清单条数 = 39', serverList.length, 39)
  eq('桌面模块副本与 server.js 逐字逐序一致', mod.WRITE_CHANNELS, serverList)
  eq('mobile 副本与 server.js 集合一致', mobileList.slice().sort(), serverList.slice().sort())
  ok('桌面副本无重复项', new Set(mod.WRITE_CHANNELS).size === mod.WRITE_CHANNELS.length, mod.WRITE_CHANNELS.length)

  ok('NO_QUEUE 的每个通道都确实在写通道集合里（否则排除清单是空转）',
    Object.keys(mod.NO_QUEUE).every((k) => mod.WRITE_CHANNELS.indexOf(k) >= 0),
    JSON.stringify(Object.keys(mod.NO_QUEUE).filter((k) => mod.WRITE_CHANNELS.indexOf(k) < 0)))
  eq('NO_QUEUE 恰好覆盖 stocktake:* / import:batch / photo:*',
    Object.keys(mod.NO_QUEUE).sort(),
    ['import:batch', 'photo:delete', 'photo:save', 'stocktake:complete', 'stocktake:create', 'stocktake:submit', 'stocktake:updateItem'].sort())

  const c = makeCentral(); const f = fresh(c)
  ok('写通道不可缓存（outbound:checkout）', !f.api.readable('outbound:checkout'))
  ok('AI 通道不可缓存（ai:chat）', !f.api.readable('ai:chat'))
  ok('收款码不可缓存（payment:getQr）', !f.api.readable('payment:getQr'))
  ok('普通读通道可缓存（report:today）', f.api.readable('report:today'))
  ok('账号/云/备份/配对/快照/租户通道一律不可缓存',
    ['account:login', 'cloud:push', 'backup:run', 'pair:code', 'snapshot:get', 'tenant:sync'].every((ch) => !f.api.readable(ch)),
    JSON.stringify(['account:login', 'cloud:push', 'backup:run', 'pair:code', 'snapshot:get', 'tenant:sync'].filter((ch) => f.api.readable(ch))))
}

// ============================================================
section('二、故障分类：只有网络故障才可能入队')
{
  const c = makeCentral(); const f = fresh(c)
  const mk = (msg, extra) => { const e = new Error(msg); if (extra) Object.assign(e, extra); return e }

  f.setOnline(true)
  ok('带 status=400 → 业务拒绝（不是网络故障）', !f.api.isNetworkError(mk('x', { status: 400 })))
  ok('带 status=403 → 业务拒绝', !f.api.isNetworkError(mk('x', { status: 403 })))
  ok('带 status=404 → 业务拒绝', !f.api.isNetworkError(mk('x', { status: 404 })))
  ok('带 status=500 → 业务拒绝（服务端已裁决，宁可失败也不误入队）', !f.api.isNetworkError(mk('x', { status: 500 })))
  ok('带 status=502/503/504 → 网络故障（网关层，没进业务路由）',
    [502, 503, 504].every((s) => f.api.isNetworkError(mk('x', { status: s }))))
  ok('显式 network=true → 网络故障', f.api.isNetworkError(mk('x', { network: true })))
  ok('ECONNREFUSED 文案 → 网络故障', f.api.isNetworkError(mk('connect ECONNREFUSED 127.0.0.1:3200')))
  ok('「连不上中心库…」文案 → 网络故障',
    f.api.isNetworkError(mk('连不上中心库——检查网络是否连接、中心库是否在线，稍后重试；已自动重试 3 次')))

  f.setOnline(false)
  ok('无状态 + onLine=false → 网络故障', f.api.isNetworkError(mk('任意未知错误文案')))
  f.setOnline(true)
  ok('无状态 + onLine=true + 非网络文案 → 不算网络故障（保守：宁可失败也不误入队）',
    !f.api.isNetworkError(mk('商品已被删除')))
}

// ============================================================
section('三、断网 5 单 → 中心库恰好 5 笔、无重复（A4 核心验收）')
{
  const c = makeCentral(); const f = fresh(c)
  f.setOnline(false)
  const flags = []
  for (let i = 0; i < 5; i++) {
    const r = await f.api.invoke('outbound:checkout', {
      items: [{ productId: 7, quantity: 1, sellingPrice: 1000 * (i + 1) }],
      payMethod: '现金', operator: '老板',
    })
    flags.push(r && r.ok === true && r.queued === true ? 'queued' : 'other')
  }
  eq('5 次断网开单全部进队列（ok+queued）', flags, ['queued', 'queued', 'queued', 'queued', 'queued'])
  eq('队列长度 = 5', f.api.pendingCount(), 5)
  const idem = f.api.queueDump().map((x) => x.payload.idempotencyKey)
  ok('5 个幂等键互不相同', new Set(idem).size === 5, JSON.stringify(idem))
  ok('幂等键全部非空字符串', idem.every((k) => typeof k === 'string' && k.length > 0))
  eq('断网期间中心库 0 笔（没偷写）', c.writeCount(), 0)

  f.setOnline(true)
  const r1 = await f.api.flush()
  eq('恢复后 flush 传上 5 笔', r1.done, 5)
  eq('flush 后队列清空', f.api.pendingCount(), 0)
  eq('中心库恰好 5 笔', c.writeCount(), 5)
  eq('中心库 5 个不同幂等键（无重复）', c.distinct(), 5)
  eq('金额分毫不差（1000…5000 分）', c.log.map((x) => x.payload.items[0].sellingPrice), [1000, 2000, 3000, 4000, 5000])

  const r2 = await f.api.flush()
  eq('再次 flush done=0（无残留）', r2.done, 0)
  eq('再次 flush 后中心库仍是 5 笔（幂等，不重复记账）', c.writeCount(), 5)
}

// ============================================================
section('四、同一 idempotencyKey 连发 3 次 → 中心库 1 笔')
{
  const c = makeCentral(); const f = fresh(c)
  const ids = []
  for (let i = 0; i < 3; i++) {
    const r = await f.api.invoke('outbound:checkout', { items: [], payMethod: '现金', idempotencyKey: 'FIXED-KEY-1' })
    ids.push(r.id)
  }
  eq('中心库 1 笔', c.writeCount(), 1)
  ok('3 次返回同一个单据 id（服务端幂等命中）', ids[0] === ids[1] && ids[1] === ids[2], JSON.stringify(ids))
}

// ============================================================
section('五、业务拒绝不入队')
{
  const c = makeCentral(); const f = fresh(c)
  c.st.biz = { status: 400, message: '库存不足：可乐 缺 3' }
  let threw = null
  try { await f.api.invoke('outbound:checkout', { items: [], payMethod: '现金' }) } catch (e) { threw = e }
  ok('在线业务拒绝原样抛给调用方', !!threw)
  eq('错误信息透传（页面能显示真实原因）', threw && threw.message, '库存不足：可乐 缺 3')
  eq('在线业务拒绝不入队', f.api.pendingCount(), 0)

  // 关键优先级：系统以为断网了，但传输层**真的**收到了 HTTP 400 → 仍是业务拒绝，绝不入队
  // （真实场景：连上了酒店/商场门户 WiFi，navigator.onLine=false 但请求能到服务器）
  f.setOnline(false, { transport: false })
  let threw2 = null
  try { await f.api.invoke('outbound:checkout', { items: [], payMethod: '现金' }) } catch (e) { threw2 = e }
  ok('即使 onLine=false，只要拿到了 HTTP 状态就不入队', !!threw2, threw2 ? '' : '未抛出')
  eq('此时队列仍为 0', f.api.pendingCount(), 0)

  // 反过来：传输层真的连不上（无 HTTP 状态）→ 必须入队
  f.setOnline(false)
  const queued = await f.api.invoke('outbound:checkout', { items: [], payMethod: '现金' })
  ok('传输层真连不上时正常入队（对照组）', queued && queued.queued === true)
  eq('对照组队列 = 1', f.api.pendingCount(), 1)
}

// ============================================================
section('六、排除通道离线时明确报错，不静默吞掉')
{
  const c = makeCentral(); const f = fresh(c)
  f.setOnline(false)
  for (const [ch, word] of [['stocktake:submit', '盘点'], ['stocktake:create', '盘点'], ['import:batch', '批量导入'], ['photo:save', '照片']]) {
    let e = null
    try { await f.api.invoke(ch, {}) } catch (err) { e = err }
    ok(ch + ' 断网时抛出且含「' + word + '」', !!e && String(e.message).indexOf(word) >= 0, e ? e.message : '未抛出')
  }
  eq('排除通道一律没进队列', f.api.pendingCount(), 0)

  let e2 = null
  try { await f.api.invoke('account:login', { username: 'a', password: 'b' }) } catch (err) { e2 = err }
  ok('账号通道断网时抛出（不返回缓存的登录结果）', !!e2)
  eq('账号通道也不入队', f.api.pendingCount(), 0)
}

// ============================================================
section('七、队列是传输缓冲，不是账本')
{
  const c = makeCentral(); const f = fresh(c)
  f.setOnline(false)
  for (let i = 0; i < 5; i++) {
    await f.api.invoke('outbound:checkout', { items: [{ productId: 1, quantity: 1, sellingPrice: 100 }], payMethod: '现金', operator: '老板' })
  }
  const ks = f.keys()
  ok('入队 5 笔后只写了「队列 / id映射 / 读缓存」三类 key', ks.every(ALLOWED_KEY), JSON.stringify(ks))
  ok('存储里没有任何账本类命名（ledger/transaction/order/stock/journal）',
    !ks.some((k) => /ledger|transaction|order|stock|journal/i.test(k)), JSON.stringify(ks))

  f.setOnline(true)
  await f.api.flush()
  eq('重放成功后队列清空', f.api.pendingCount(), 0)
  eq('中心库 5 笔', c.writeCount(), 5)
  const ks2 = f.keys()
  ok('重放后本地依然没有账本 key（单据只落在中心库）', ks2.every(ALLOWED_KEY), JSON.stringify(ks2))
}

// ============================================================
section('八、断网「新建商品 → 立即入库」不产生孤儿单据（临时 id 闭环）')
{
  const c = makeCentral(); const f = fresh(c)
  f.setOnline(false)
  const p = await f.api.invoke('product:create', { sku_code: 'A1', model: '测试商品', cost_price: 500 })
  ok('断网建档返回临时 id（tmp_ 前缀），不是 undefined',
    typeof p.id === 'string' && p.id.indexOf('tmp_') === 0, String(p.id))
  await f.api.invoke('inbound:create', { productId: p.id, quantity: 3, costPrice: 500, operator: '老板' })
  eq('两张单都在队列里', f.api.pendingCount(), 2)
  const q = f.api.queueDump()
  eq('入库单载荷引用的是临时 id（不是 undefined）',
    q[1] && q[1].payload ? q[1].payload.productId : '(队列里根本没有第 2 张单)', p.id)

  f.setOnline(true)
  await f.api.flush()
  eq('队列清空', f.api.pendingCount(), 0)
  eq('中心库 2 笔', c.writeCount(), 2)
  const created = c.byChannel('product:create')[0]
  const inb = c.byChannel('inbound:create')[0]
  // 全部走防御式取值：断言失败要报「没收到这张单」，不能抛 TypeError 把后面的断言全丢掉
  eq('重放后入库单的 productId 已改写为服务端真 id',
    inb && inb.payload ? inb.payload.productId : '(中心库没收到入库单)',
    created ? created.id : '(中心库没收到建档)')
  ok('改写后不再是 tmp_ 前缀',
    !!inb && !!inb.payload && String(inb.payload.productId).indexOf('tmp_') !== 0,
    inb && inb.payload ? String(inb.payload.productId) : '(中心库没收到入库单)')
}

// ============================================================
section('九、断网读缓存回退（L1）')
{
  const c = makeCentral(); const f = fresh(c)
  const first = await f.api.invoke('report:today', {})
  ok('在线读成功', !!first)
  f.setOnline(false)
  const cached = await f.api.invoke('report:today', {})
  eq('断网时返回上次缓存的数据', cached, first)

  let e1 = null
  try { await f.api.invoke('product:list', { keyword: 'x' }) } catch (e) { e1 = e }
  ok('断网读一个从没缓存过的通道 → 抛出（绝不返回假空结果）', !!e1, e1 ? e1.message : '未抛出')

  let e2 = null
  try { await f.api.invoke('ai:chat', { messages: [] }) } catch (e) { e2 = e }
  ok('AI 通道断网不返回缓存（NO_CACHE）', !!e2)
}

// ============================================================
section('十、边界与已知风险（记录，不掩盖）')
{
  const c = makeCentral(); const f = fresh(c)
  f.setOnline(false)
  for (let i = 0; i < mod.MAX_QUEUE; i++) await f.api.invoke('outbound:checkout', { items: [], payMethod: '现金' })
  eq('队列可攒到上限 MAX_QUEUE = ' + mod.MAX_QUEUE, f.api.pendingCount(), mod.MAX_QUEUE)
  let overflow = null
  try { await f.api.invoke('outbound:checkout', { items: [], payMethod: '现金' }) } catch (e) { overflow = e }
  ok('超上限时明确报错（不静默丢弃单据）',
    !!overflow && String(overflow.message).indexOf('离线单据太多') >= 0, overflow ? overflow.message : '未抛出')

  const c2 = makeCentral(); const f2 = fresh(c2)
  f2.setOnline(false)
  await f2.api.invoke('outbound:checkout', { items: [], payMethod: '现金' })
  f2.setOnline(true)
  c2.st.biz = { status: 400, message: '商品已被删除' }
  await f2.api.flush()
  eq('重放时被中心库业务拒绝 → 标为 failed', f2.api.failedCount(), 1)
  eq('不再计入待上传', f2.api.pendingCount(), 0)
  const callsAfter = c2.st.calls
  await f2.api.flush()
  eq('失败项不会被无限重试', c2.st.calls, callsAfter)
  eq('dropFailed 可人工清场', f2.api.dropFailed(), 0)
}

// ============================================================
console.log('')
try { fs.unlinkSync(tmp) } catch { /* 临时文件删不掉不影响结论 */ }

if (MUTATE) {
  // 变异模式：预期这套断言**必须变红**，否则说明它没覆盖到被改的逻辑
  if (fail > 0) {
    console.log('变异「' + MUTATE + '」被杀死 ✓  共 ' + fail + ' 项断言转红（预期受影响：' + MUTATIONS[MUTATE].kills + '）')
    console.log('这个套件确实会红，不是摆设。')
    process.exit(0)
  }
  console.log('✗ 变异「' + MUTATE + '」存活 —— 全部 ' + pass + ' 项仍然通过，说明这组断言没检查到被改的逻辑（空断言）。')
  process.exit(1)
}

if (fail === 0) {
  console.log('全部 ' + pass + ' 项断言通过')
  console.log('提示：本套件从没红过 = 证据不完整。请再跑一次变异自检，确认它会红：')
  console.log('  node "' + fileURLToPath(import.meta.url) + '" --mutate=classifier')
  process.exit(0)
} else {
  console.log('✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项')
  for (const n of failures) console.log('   - ' + n)
  process.exit(1)
}
