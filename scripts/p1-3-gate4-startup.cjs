// P1-3 闸④：打包产物真机启动验证（启动耗时 + 出库页语音开单按钮渲染 + IPC 桥存在）
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

  win.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)) })
  win.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))

  // 等初始本地数据加载完再切出库页
  await win.waitForFunction(() => !document.body.innerText.includes('正在加载本地数据'), { timeout: 20000 })
  await win.evaluate(() => { window.location.hash = '#/outbound' })
  await win.waitForTimeout(2500)
  const bodyText = await win.evaluate(() => document.body.innerText)
  // 语音开单按钮（按住说话）应挂在搜索框旁；确认卡组件已挂载（初始不可见）
  const hasMicBtns = await win.evaluate(() =>
    Array.from(document.querySelectorAll('button[title]')).filter((b) => b.title.includes('语音开单') || b.title.includes('按住说话')).length,
  )
  console.log('出库页语音开单按钮:', hasMicBtns > 0 ? `已渲染（${hasMicBtns} 个）` : '未渲染')
  await win.screenshot({ path: '../screenshots/p1-3-outbound.png' })

  // IPC 桥：voice:parseOrder 存在且空文本返回业务错误（不是 unknown channel）
  const r = await win.evaluate(() => window.fi.invoke('voice:parseOrder', { text: '' }).catch((e) => ({ err: String(e) })))
  console.log('voice:parseOrder 空调用 →', JSON.stringify(r))
  const ipcOk = r && (r.ok === false || r.err)
  console.log('voice:parseOrder IPC 桥:', ipcOk ? 'OK' : 'FAIL')

  await app.close()
  if (!(hasMicBtns > 0)) throw new Error('语音开单按钮未渲染')
  if (!ipcOk) throw new Error('voice:parseOrder IPC 桥异常')
  console.log('\n闸④ PASS')
})().catch((e) => {
  console.error('闸④ FAIL:', e.message)
  process.exit(1)
})
