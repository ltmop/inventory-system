// 验收证据：顶栏「离线 / 待上传」胶囊（A3 离线层的 UI 出口）
//
// 验证三件事：
//   ① 队列里有待上传单据时，顶栏出现胶囊，文案含「待上传」和笔数
//   ② 点胶囊 → 真的调了中心库（invoke 被调用）→ 队列清空 → 胶囊消失
//   ③ 有被拒绝的单据时，胶囊变成红色语义，文案含「被拒绝」
//
// 做法：不驱动整套业务流，而是**预置 localStorage 队列**（就是 offlineTransport.js 真实使用的
// 键 fi-desk-outbox），再让页面自己渲染 —— 这样测的是真实的模块 + 真实的 React 接线。
// window.fi 是桩：默认回 []（够 flush 判定成功并出队）。
//
// 跑法：
//   npx vite preview --port 4173
//   node scripts/verify-topbar-offline-chip.cjs
const { chromium } = require('playwright')
const path = require('path')

const BASE = process.env.PRICING_URL || 'http://localhost:4173'
const K_QUEUE = 'fi-desk-outbox'

const DISMISS = ['跳过引导，直接进入系统', '先保留演示数据，稍后再说', '知道了', '先不登录，直接用', '先用本机数据', '看步骤就够了，继续', '下一步']

function seed(item) { return JSON.stringify([item]) }
const PENDING_ITEM = { id: 'dtest1', channel: 'outbound:checkout', payload: { items: [], payMethod: '现金', idempotencyKey: 'E2E-KEY-1' }, at: Date.now(), tries: 0, failed: false, err: '', tmpId: null }
const FAILED_ITEM = { id: 'dtest2', channel: 'outbound:checkout', payload: { items: [], payMethod: '现金', idempotencyKey: 'E2E-KEY-2' }, at: Date.now(), tries: 1, failed: true, err: '库存不足：可乐 缺 3', tmpId: null }

function stubFi() {
  const noop = () => {}
  window.fi = window.fi || {}
  window.__invoked = []
  // __mode='down' 时**只让 outbound:checkout 失败**（模拟断网）。原因：api.ts 加载时会 autoFlush，
  // 若桩一律成功，预置的待上传单据会在 1.5 秒内被自动传走，胶囊根本来不及出现
  //（第一版就是这么挂的 —— 那次失败反而证明了「开机自动重传」确实在工作）。
  // 场景 A 断言完胶囊出现后，再把 __mode 翻成 'up' 点它，验证真能传上去。
  // 其它通道一律正常，免得整页报错干扰断言。
  window.__mode = 'down'
  window.fi.invoke = (ch) => {
    window.__invoked.push(ch)
    if (ch === 'cloud:status') return Promise.resolve({ paired: false, username: null, lastSyncAt: null, lastBackupAt: null, syncing: false, error: null, viewUrl: null, needsRestore: false, pendingBackup: null })
    // 引导守门读 s.completed；给 [] 会被算成未完成 -> 强制跳 /onboarding
    if (ch === 'onboarding:status') return Promise.resolve({ completed: true })
    if (ch === 'onboarding:finish' || ch === 'onboarding:reset') return Promise.resolve({ ok: true })
    if (window.__mode === 'down' && ch === 'outbound:checkout') return Promise.reject(new Error('连不上中心库'))
    return Promise.resolve([])
  }
  window.fi.onUpdateAvailable = window.fi.onUpdateAvailable || noop
  window.fi.onUpdateNotAvailable = window.fi.onUpdateNotAvailable || noop
  window.fi.onUpdateProgress = window.fi.onUpdateProgress || noop
}

async function dismissOnboarding(p) {
  for (let i = 0; i < 20; i++) {
    const ready = await p.evaluate(() => {
      const hasTopbar = !!document.querySelector('header')
      const overlay = Array.from(document.querySelectorAll('div')).some((d) => (d.className || '').toString().includes('fixed inset-0 z-50'))
      return hasTopbar && !overlay
    })
    if (ready) break
    const clicked = await p.evaluate((labels) => {
      const bs = Array.from(document.querySelectorAll('button'))
      for (const lab of labels) {
        const b = bs.find((x) => (x.textContent || '').includes(lab))
        if (b) { b.click(); return lab }
      }
      return null
    }, DISMISS)
    await p.waitForTimeout(700)
    if (!clicked) await p.waitForTimeout(500)
  }
  await p.waitForTimeout(1200)
}

;(async () => {
  const b = await chromium.launch({ channel: 'msedge' })
  const results = []
  const record = (name, ok, extra) => { results.push({ name, ok }); console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : '')) }

  // ───────── 场景 A：有待上传单据 ─────────
  console.log('\n【场景 A】预置 1 笔待上传 → 胶囊应出现，点击后应真的上传并消失')
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
    const p = await ctx.newPage()
    const errs = []
    p.on('pageerror', (e) => errs.push(e.message))
    await p.addInitScript(stubFi)
    await p.addInitScript((it) => { localStorage.setItem('fi-desk-outbox', it) }, seed(PENDING_ITEM))
    await p.goto(BASE + '/#/', { waitUntil: 'load' }).catch(() => {})
    await p.waitForTimeout(2500)
    await dismissOnboarding(p)

    const chip = p.locator('button[aria-label*="待上传"]')
    const n0 = await chip.count()
    record('① 有 1 笔待上传时胶囊出现', n0 > 0, 'chip count=' + n0)
    const label = n0 ? (await chip.first().getAttribute('aria-label')) : ''
    record('① 胶囊文案含「待上传」和笔数 1', /待上传/.test(label) && /1/.test(label), label)
    await p.screenshot({ path: path.resolve(__dirname, '../screenshots/topbar-offline-pending.png') })

    if (n0) {
      // 断网期间开机自动重传应该试过、但失败并**保留**了单据（不是丢掉）
      const triesDown = (await p.evaluate(() => window.__invoked || [])).filter((c) => c === 'outbound:checkout').length
      record('① 断网时开机自动重传试过且单据被保留', triesDown >= 1, 'invoke 次数=' + triesDown)

      // 恢复网络 → 点胶囊 → 应该真的传上去
      await p.evaluate(() => { window.__mode = 'up' })
      await chip.first().click()
      await p.waitForTimeout(1500)
      const triesUp = (await p.evaluate(() => window.__invoked || [])).filter((c) => c === 'outbound:checkout').length
      record('② 点击后确实又调了一次中心库', triesUp > triesDown, 'before=' + triesDown + ' after=' + triesUp)
      const n1 = await chip.count()
      record('② 上传成功后胶囊消失', n1 === 0, 'chip count=' + n1)
    } else {
      record('① 断网时开机自动重传试过且单据被保留', false, '胶囊没出现，跳过')
      record('② 点击后确实又调了一次中心库', false, '胶囊没出现，跳过')
      record('② 上传成功后胶囊消失', false, '胶囊没出现，跳过')
    }
    record('② 无 pageerror', errs.length === 0, errs.join(' | ') || 'none')
    await ctx.close()
  }

  // ───────── 场景 B：有被拒绝的单据 ─────────
  console.log('\n【场景 B】预置 1 笔被拒绝 → 胶囊应变成红色语义并显示「被拒绝」')
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
    const p = await ctx.newPage()
    const errs = []
    p.on('pageerror', (e) => errs.push(e.message))
    await p.addInitScript(stubFi)
    await p.addInitScript((it) => { localStorage.setItem('fi-desk-outbox', it) }, seed(FAILED_ITEM))
    await p.goto(BASE + '/#/', { waitUntil: 'load' }).catch(() => {})
    await p.waitForTimeout(2500)
    await dismissOnboarding(p)

    const chip = p.locator('button[aria-label*="被拒绝"]')
    const n = await chip.count()
    record('③ 有被拒绝单据时胶囊出现且文案含「被拒绝」', n > 0, 'chip count=' + n)
    const label = n ? (await chip.first().getAttribute('aria-label')) : ''
    record('③ 文案含笔数 1', /1/.test(label), label)
    await p.screenshot({ path: path.resolve(__dirname, '../screenshots/topbar-offline-failed.png') })
    record('③ 无 pageerror', errs.length === 0, errs.join(' | ') || 'none')
    await ctx.close()
  }

  // ───────── 场景 C：一切正常时不应出现 ─────────
  console.log('\n【场景 C】队列为空 → 胶囊不应出现（不制造噪音）')
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
    const p = await ctx.newPage()
    const errs = []
    p.on('pageerror', (e) => errs.push(e.message))
    await p.addInitScript(stubFi)
    await p.goto(BASE + '/#/', { waitUntil: 'load' }).catch(() => {})
    await p.waitForTimeout(2500)
    await dismissOnboarding(p)
    const anyChip = await p.locator('button[aria-label*="待上传"], button[aria-label*="被拒绝"], button[aria-label*="网络已断开"]').count()
    record('④ 队列为空时不出现任何离线胶囊', anyChip === 0, 'chip count=' + anyChip)
    record('④ 无 pageerror', errs.length === 0, errs.join(' | ') || 'none')
    await ctx.close()
  }

  await b.close()
  const failed = results.filter((r) => !r.ok)
  console.log('\n' + (failed.length === 0 ? '全部 ' + results.length + ' 项断言通过' : '✗ ' + failed.length + ' 项失败 / 共 ' + results.length + ' 项'))
  for (const f of failed) console.log('   - ' + f.name)
  process.exit(failed.length === 0 ? 0 : 1)
})().catch((e) => { console.error('ERR ' + (e && e.message)); process.exit(1) })
