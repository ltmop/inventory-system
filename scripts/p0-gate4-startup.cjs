// P0 闸④：打包产物真机启动验证（启动耗时 + window.fi 桥 + AI 智能页渲染）
const { _electron: electron } = require('playwright')
const path = require('path')
const os = require('os')

;(async () => {
  const exe = path.join(os.homedir(), 'AppData/Local/Temp/fi-release/win-unpacked/AI智能进销存系统.exe')
  const t0 = Date.now()
  const app = await electron.launch({ executablePath: exe })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  const hasFi = await win.evaluate(() => typeof window.fi !== 'undefined')
  const startupMs = Date.now() - t0
  console.log(`启动到 window.fi 就绪: ${startupMs}ms（闸④ 要求 < 30000ms）→ ${startupMs < 30000 ? 'PASS' : 'FAIL'}`)
  if (!hasFi) throw new Error('window.fi 未注入')

  const info = await win.evaluate(() => window.fi.invoke('app:info'))
  console.log('app:info → 版本', info.version)

  // AI 智能页渲染（P0 额度卡挂载点）
  win.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)) })
  win.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
  // 等初始本地数据加载完再切页（否则路由页被加载屏挡住）
  await win.waitForFunction(() => !document.body.innerText.includes('正在加载本地数据'), { timeout: 20000 })
  await win.evaluate(() => { window.location.hash = '#/ai-hub' })
  await win.waitForTimeout(2500)
  const bodyText = await win.evaluate(() => document.body.innerText)
  const hasCard = bodyText.includes('官方 AI 额度')
  console.log('AI 智能页「官方 AI 额度」卡:', hasCard ? '已渲染' : '未渲染')
  console.log('页面文本片段:', bodyText.replace(/\s+/g, ' ').slice(0, 300))
  await win.screenshot({ path: '../screenshots/p0-aihub.png' })

  // 网关未部署时的降级表现：quota 查询应静默失败（不崩溃）
  const q = await win.evaluate(() => window.fi.invoke('ai:gatewayQuota').catch((e) => ({ err: String(e) })))
  console.log('ai:gatewayQuota（网关未部署，预期优雅失败）→', JSON.stringify(q))

  await app.close()
  if (!hasCard) throw new Error('额度卡未渲染')
  console.log('\n闸④ PASS')
})().catch((e) => {
  console.error('闸④ FAIL:', e.message)
  process.exit(1)
})
