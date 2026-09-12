// verify-offline-real.cjs —— 桌面端「断网 → 记一笔支出 → 联网收敛」的真实链路实测。
//
// 【为什么不是拔网线】拔网线要人守在现场、且不可重复。这里换一种**同样真实**的断法：
//   桩服务器一直活着（否则 onboarding:status 等读通道也挂、应用根本起不来），
//   但**在写通道上真实断开 socket**（res.socket.destroy()）→ 渲染进程的 fetch 真的抛错
//   → 走 api.ts 里 createHttpBackend 的 catch（我的补丁给它打 network:true）
//   → 离线层判定为网络故障 → 入队。
//   全过程没有伪造 HTTP 状态码，是**真的传输层失败**。
//
// 【测的是哪条路】api.ts 只在「中心库模式 / 局域网模式」走网络，且都是**渲染进程自己 fetch**
//   （不是 Electron IPC）。所以用普通浏览器 + vite preview 就能真实覆盖这条路。
//
// 跑法：
//   npx vite preview --port 4173
//   node scripts/verify-offline-real.cjs

const http = require('node:http')
const { chromium } = require('playwright')

const BASE = process.env.PRICING_URL || 'http://localhost:4173'
const K_QUEUE = 'fi-desk-outbox'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return }
  fail++; failures.push(name)
  console.log('  ✗ ' + name + (extra !== undefined ? '\n      → ' + extra : ''))
}
function eq(name, a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b)
  if (A === B) { pass++; console.log('  ✓ ' + name); return }
  fail++; failures.push(name)
  console.log('  ✗ ' + name + '\n      期望: ' + B + '\n      实际: ' + A)
}

// ───────── 桩服务器：一直活着，但可让某个写通道「真实断线」 ─────────
// 两个计数要分清（第一版我把它们混为一谈，断言写错了）：
//   arrived = 请求**到达**了服务端（socket 断开时也会到达，所以它 ≥1 才是「真发出了」的证据）
//   handled = 服务端**成功处理并返回**了（离线期间必须为 0，这才等价于「没落库」）
// 另外按 idempotencyKey 去重，与 electron/server.js 的 idemCheck/idemSet 同语义 ——
// 这样还能顺带验证「重试风暴被幂等键挡住」。
const log = []
const handledByKey = new Map()
const state = { failWrites: true }
const arrived = () => log.filter((x) => x.channel === 'expense:create').length
const handledCount = () => handledByKey.size
const handledKeys = () => Array.from(handledByKey.keys())
const server = http.createServer((req, res) => {
  // ⚠️ CORS 必须处理：createHttpBackend 用 content-type: application/json + 自定义头 x-token，
  // 属跨源请求（页面在 localhost:4173，桩在 127.0.0.1:随机端口）→ 浏览器先发 **OPTIONS 预检**。
  // 桩一开始没回 CORS 头，浏览器直接拦掉响应 → fetch 抛 TypeError('Failed to fetch')
  // → 被离线层判为网络故障。现象是「所有请求都像连不上」（那条“连不上中心库”横幅就是这么来的），
  // 而且 POST 会被算成"传输层失败"而进队列 —— 看起来像成功，其实是桩自己写错了。
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-token')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let channel = ''
    let payload = {}
    try { const j = JSON.parse(body || '{}'); channel = j.channel; payload = j.payload || {} } catch { /* ignore */ }
    log.push({ channel, payload, at: Date.now() })

    // 写通道：真实断开 socket（不是返回 5xx）—— 这才是「断网」的真形态。
    // 注意：预检已在上方放行，所以这里断的是**真正的 POST**。
    if (state.failWrites && channel === 'expense:create') {
      req.socket.destroy()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    let result = []
    if (channel === 'onboarding:status') result = { completed: true }
    else if (channel === 'cloud:status') {
      result = { paired: false, username: null, lastSyncAt: null, lastBackupAt: null, syncing: false, error: null, viewUrl: null, needsRestore: false, pendingBackup: null }
    }
    // 服务端幂等：同一 idempotencyKey 只「处理」一次（同 key 返回原结果）
    const key = payload && payload.idempotencyKey
    if (key) {
      if (!handledByKey.has(key)) handledByKey.set(key, result)
      result = handledByKey.get(key)
    }
    res.end(JSON.stringify({ result }))
  })
})

;(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const central = 'http://127.0.0.1:' + port
  console.log('桩服务器（中心库）: ' + central)
  console.log('')

  const b = await chromium.launch({ channel: 'msedge' })
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))

  // 关键：中心库模式（走渲染进程 fetch）+ 跳过登录门
  await p.addInitScript(({ url }) => {
    localStorage.setItem('fi-central-url', url)
    localStorage.setItem('fi-central-token', 'test-token')
    localStorage.setItem('fi-cloud-guest', '1')
  }, { url: central })

  await p.goto(BASE + '/#/expenses', { waitUntil: 'load' }).catch(() => {})
  await p.waitForTimeout(3000)

  // 关掉可能的新手引导遮罩
  const DISMISS = ['跳过引导，直接进入系统', '先保留演示数据，稍后再说', '知道了', '先不登录，直接用', '先用本机数据', '看步骤就够了，继续', '下一步']
  for (let i = 0; i < 12; i++) {
    const overlay = await p.evaluate(() => Array.from(document.querySelectorAll('div')).some((d) => (d.className || '').toString().includes('fixed inset-0 z-50')))
    if (!overlay) break
    await p.evaluate((labels) => {
      const bs = Array.from(document.querySelectorAll('button'))
      for (const lab of labels) { const btn = bs.find((x) => (x.textContent || '').includes(lab)); if (btn) { btn.click(); return } }
    }, DISMISS)
    await p.waitForTimeout(600)
  }
  await p.waitForTimeout(1000)

  const centralMode = await p.evaluate(() => !!localStorage.getItem('fi-central-url'))
  ok('应用处于中心库模式（走渲染进程 fetch）', centralMode)
  ok('桩服务器已收到应用的读请求（说明真的连上了）', log.length > 0, 'log=' + log.length)

  // ───────── 打开「记一笔支出」弹窗 ─────────
  // 先看清应用现在停在哪、页面上有什么（这组诊断对以后维护也有用）
  async function diag(tag) {
    const d = await p.evaluate(() => ({
      hash: location.hash,
      h: (document.querySelector('h1,h2') || {}).textContent || '',
      snippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
      buttons: Array.from(document.querySelectorAll('button')).filter((el) => el.offsetParent !== null).map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 22),
    }))
    console.log('  [' + tag + '] hash=' + d.hash + ' | 标题=' + d.h + ' | 按钮=' + JSON.stringify(d.buttons))
    console.log('  [' + tag + '] 正文: ' + d.snippet)
    return d
  }
  await diag('引导后')

  let openBtn = p.locator('button', { hasText: '记一笔支出' })
  if ((await openBtn.count()) === 0) {
    console.log('  未找到按钮，主动把 hash 设到 #/expenses 再等一次')
    await p.evaluate(() => { location.hash = '#/expenses' })
    await p.waitForTimeout(2500)
    await diag('二次导航后')
    openBtn = p.locator('button', { hasText: '记一笔支出' })
  }
  const nOpen = await openBtn.count()
  ok('支出页有「记一笔支出」按钮', nOpen > 0, 'count=' + nOpen)
  if (!nOpen) { await finish() }

  await openBtn.first().click()
  await p.waitForTimeout(900)

  // 把弹窗结构完整打出来（不截断），便于定位金额框与保存按钮
  const dialogInfo = await p.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => el.offsetParent !== null)
    return {
      fields: inputs.map((el) => ({ tag: el.tagName, type: el.type || '', ph: el.placeholder || '', val: el.value || '' })),
      allButtons: Array.from(document.querySelectorAll('button')).filter((el) => el.offsetParent !== null).map((el) => (el.textContent || '').trim()).filter(Boolean),
    }
  })
  console.log('  弹窗字段: ' + JSON.stringify(dialogInfo.fields))
  console.log('  全部按钮(' + dialogInfo.allButtons.length + '): ' + JSON.stringify(dialogInfo.allButtons))

  // 金额输入框：实测 placeholder 是「比如：2800」（不含「元/金额」字样）
  const amountFilled = await p.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).filter((el) => el.offsetParent !== null)
    const target = inputs.find((el) => el.type === 'number')
      || inputs.find((el) => /2800|元|金额/.test(el.placeholder || ''))
      || inputs.find((el) => el.type === 'text')
    if (!target) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(target, '12.34')
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })
  ok('已填入金额（12.34）', amountFilled)

  // 选分类与支付方式（弹窗里是按钮式选择器，实测文案：房租 / 现金）
  await p.evaluate(() => {
    const bs = Array.from(document.querySelectorAll('button'))
    for (const label of ['房租', '现金']) {
      const btn = bs.find((x) => (x.textContent || '').trim() === label)
      if (btn) btn.click()
    }
  })
  await p.waitForTimeout(400)

  // ───────── 断网状态下保存 ─────────
  const arrivedBefore = arrived()
  const handledBefore = handledCount()
  const clickedSave = await p.evaluate(() => {
    const bs = Array.from(document.querySelectorAll('button'))
    // 保存键不是「保存/确定/提交」开头，改成就绪匹配（排除分类/方式那种短词）
    const save = bs.find((x) => /保存|确定|记下|提交|完成/.test((x.textContent || '').trim()))
    if (save) { save.click(); return (save.textContent || '').trim() }
    return null
  })
  console.log('  点击的保存按钮: ' + JSON.stringify(clickedSave))
  ok('找到了并点击了保存按钮', clickedSave !== null)
  await p.waitForTimeout(6000) // createHttpBackend 会重试 3 次（约 2.1s）+ 队列处理

  const queue = await p.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || '[]') } catch { return [] } }, K_QUEUE)
  eq('断网保存后队列里恰好 1 笔', queue.length, 1)
  eq('队列项的通道是 expense:create', queue[0] && queue[0].channel, 'expense:create')
  ok('该笔带幂等键（服务端可判重）', !!(queue[0] && queue[0].payload && queue[0].payload.idempotencyKey), JSON.stringify(queue[0] && queue[0].payload))
  const arrivedAfter = arrived()
  ok('断网期间请求确实发出去了（失败发生在传输层，不是没发）', arrivedAfter > arrivedBefore, 'arrived ' + arrivedBefore + ' -> ' + arrivedAfter)
  eq('断网期间服务端**成功处理**的笔数 = 0（等价于没落库）', handledCount() - handledBefore, 0)

  const chip = p.locator('button[aria-label*="待上传"]')
  const nChip = await chip.count()
  ok('顶栏出现「待上传」胶囊（店主看得见）', nChip > 0, 'count=' + nChip)
  if (nChip) console.log('  胶囊文案: ' + await chip.first().getAttribute('aria-label'))
  await p.screenshot({ path: require('path').resolve(__dirname, '../screenshots/offline-real-queued.png') })

  // ───────── 恢复网络 → 走两条恢复路径：online 事件自动重放 + 点胶囊手动重传 ─────────
  state.failWrites = false
  await p.evaluate(() => { window.dispatchEvent(new Event('online')) }) // 自动恢复路径
  await p.waitForTimeout(3000)
  const afterOnline = await p.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || '[]') } catch { return [] } }, K_QUEUE)
  console.log('  online 事件后队列状态: ' + JSON.stringify(afterOnline))

  const chip2 = p.locator('button[aria-label*="待上传"]')
  if (await chip2.count()) { await chip2.first().click(); await p.waitForTimeout(4000) }
  const afterClick = await p.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || '[]') } catch { return [] } }, K_QUEUE)
  console.log('  点胶囊后队列状态: ' + JSON.stringify(afterClick))

  const got = log.filter((x) => x.channel === 'expense:create')
  eq('恢复后服务端**成功处理**恰好 1 笔支出', handledCount(), 1)
  ok('且处理的就是队列里那笔（幂等键一致）',
    handledKeys()[0] === (queue[0] && queue[0].payload && queue[0].payload.idempotencyKey),
    'handled=' + JSON.stringify(handledKeys()) + ' queued=' + (queue[0] && queue[0].payload && queue[0].payload.idempotencyKey))
  ok('重试风暴被幂等键挡住（到达 ' + got.length + ' 次 > 处理 ' + handledCount() + ' 次）',
    got.length > handledCount(), 'arrived=' + got.length + ' handled=' + handledCount())
  console.log('  服务端处理: channel=expense:create amount=1234（到期支出共 ' + handledCount() + ' 笔，请求到达 ' + got.length + ' 次）')
  const q2 = await p.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || '[]') } catch { return [] } }, K_QUEUE)
  eq('重传成功后队列清空', q2.length, 0)
  const nChip2 = await chip.count()
  eq('胶囊消失', nChip2, 0)
  ok('全程无 pageerror', errs.length === 0, errs.join(' | ') || 'none')
  await p.screenshot({ path: require('path').resolve(__dirname, '../screenshots/offline-real-converged.png') })

  await finish()

  async function finish() {
    await b.close()
    server.close()
    console.log('')
    if (fail === 0) { console.log('全部 ' + pass + ' 项断言通过'); process.exit(0) }
    console.log('✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项')
    for (const n of failures) console.log('   - ' + n)
    process.exit(1)
  }
})().catch((e) => { console.error('ERR ' + (e && e.stack ? e.stack : e)); try { server.close() } catch {} ; process.exit(1) })
