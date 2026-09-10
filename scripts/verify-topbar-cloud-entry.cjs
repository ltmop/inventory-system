// 验收证据：右上角头像菜单现在有「云账号登录 / 注册云账号」入口，且能叫出对应 tab。
// 修的是：以前这里只有「登录（店员/老板）」= 员工登录门（读本地 users 表），
// 云账号入口只能在内容区横幅摸到，导致「登不上云账号 / 注册不了 / 同步不了」。
// 跑法：npx vite preview --port 4173 然后 PRICING_URL=http://localhost:4173 node scripts/verify-topbar-cloud-entry.cjs
const { chromium } = require('playwright')
const path = require('path')

;(async () => {
  const base = process.env.PRICING_URL || 'http://localhost:4173'
  const b = await chromium.launch({ channel: 'msedge' })
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))

  // 未配对云账号。⚠️ 不要设 fi-central-url：那会让 api.ts 改走 http 中心库后端（连不上就卡在加载中）。
  // 改为加载后点登录门的「先用本机数据（本地模式）」——它置 guest 标记，Layout 首启 effect 不会再弹门。
  await p.addInitScript(() => {
    const noop = () => {}
    window.fi = window.fi || {}
    window.fi.invoke = (ch) => {
      if (ch === 'cloud:status') return Promise.resolve({ paired: false, username: null, lastSyncAt: null, lastBackupAt: null, syncing: false, error: null, viewUrl: null, needsRestore: false, pendingBackup: null })
      // 引导守门读 s.completed；给 [] 会被算成未完成 -> 强制跳 /onboarding（这是本脚本第一版的坑）
      if (ch === 'onboarding:status') return Promise.resolve({ completed: true })
      if (ch === 'onboarding:finish' || ch === 'onboarding:reset') return Promise.resolve({ ok: true })
      return Promise.resolve([])
    }
    window.fi.onUpdateAvailable = window.fi.onUpdateAvailable || noop
    window.fi.onUpdateNotAvailable = window.fi.onUpdateNotAvailable || noop
    window.fi.onUpdateProgress = window.fi.onUpdateProgress || noop
  })

  await p.goto(base + '/#/', { waitUntil: 'load' }).catch(() => {})
  await p.waitForTimeout(2500)
  // 新手引导是多页向导，Playwright 的 actionability 点击会被遮罩层拦；改用 DOM 直接 click，
  // 并循环到「顶栏头像出现」为止（最多 20 轮）。
  const DISMISS = ['跳过引导，直接进入系统', '先保留演示数据，稍后再说', '知道了', '先不登录，直接用', '先用本机数据', '看步骤就够了，继续', '下一步']
  for (let i = 0; i < 20; i++) {
    // 注意：头像在 DOM 里存在 ≠ 可点。首启云账号门是 fixed inset-0 z-50 全屏遮罩，
    // 必须等遮罩消失（点掉门）才算就绪——这正是用户「右上角点不到」的现象。
    const ready = await p.evaluate(() => {
      const hasAvatar = !!document.querySelector('button[title="当前身份，点击切换"]')
      const overlay = Array.from(document.querySelectorAll('div')).some((d) => (d.className || '').toString().includes('fixed inset-0 z-50'))
      return hasAvatar && !overlay
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

  // 打开右上角头像菜单
  const avatar = p.locator('button[title="当前身份，点击切换"]')
  const avatarCount = await avatar.count()
  if (avatarCount) { await avatar.first().click(); await p.waitForTimeout(600) }

  const menu = await p.evaluate(() => {
    // 下拉菜单根：class 含 top-full 的绝对定位浮层
    const el = document.querySelector('[class*="top-full"]')
    return { menuFound: !!el, text: el ? (el.innerText || '') : '', body: (document.body.innerText || '').slice(0, 700) }
  })
  console.log('avatar buttons found:', avatarCount)
  console.log('MENU:', JSON.stringify(menu, null, 2))
  console.log('has 登录云账号:', menu.text.includes('登录云账号'))
  console.log('has 注册云账号:', menu.text.includes('注册云账号'))
  console.log('has 员工登录:', menu.text.includes('员工登录'))

  await p.screenshot({ path: path.resolve(__dirname, '../screenshots/topbar-cloud-menu.png') })

  // 点「注册云账号」→ 应打开云账号门并停在注册 tab
  let gate = null
  const reg = p.getByText('注册云账号（新店首次开通）', { exact: false })
  if (await reg.count()) {
    await reg.first().click()
    await p.waitForTimeout(1200)
    gate = await p.evaluate(() => {
      const t = document.body.innerText || ''
      return {
        gateOpen: t.includes('注册一个账号，所有电脑登录后数据互通'),
        loginSubtitle: t.includes('登录云账号，多台电脑数据自动同步'),
        hasUserField: !!document.querySelector('input[placeholder*="账号（店名"]'),
        hasPwdField: !!document.querySelector('input[type="password"]'),
        snippet: t.slice(0, 300),
      }
    })
  }
  console.log('AFTER CLICK 注册云账号:', JSON.stringify(gate, null, 2))
  console.log('pageerrors:', errors.length ? JSON.stringify(errors) : 'none')
  await p.screenshot({ path: path.resolve(__dirname, '../screenshots/topbar-cloud-register-gate.png') })

  const pass = menu.menuFound && menu.text.includes('登录云账号') && menu.text.includes('注册云账号')
    && gate && gate.gateOpen && gate.hasPwdField && errors.length === 0
  console.log(pass ? '\nRESULT: PASS — 右上角可登录/注册云账号，注册 tab 正确打开' : '\nRESULT: FAIL')
  await b.close()
  process.exit(pass ? 0 : 1)
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })
