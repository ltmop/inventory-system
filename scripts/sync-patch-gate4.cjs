// 数据同步补丁 闸④：打包产物真机启动 + cloud:dismissRestore IPC 桥存在 + 账号页恢复引导挂载点
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

  win.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))

  // cloud:status 应返回 needsRestore 字段（未配对时为 false/undefined，不报错）
  const st = await win.evaluate(() => window.fi.invoke('cloud:status').catch((e) => ({ err: String(e) })))
  console.log('cloud:status →', JSON.stringify(st))
  const statusOk = st && !st.err
  console.log('cloud:status IPC:', statusOk ? 'OK' : 'FAIL')

  // cloud:dismissRestore 通道存在（未配对时主进程应正常应答而非 unknown channel）
  const dis = await win.evaluate(() => window.fi.invoke('cloud:dismissRestore').catch((e) => ({ err: String(e) })))
  console.log('cloud:dismissRestore →', JSON.stringify(dis))
  const dismissOk = dis && (dis.ok === true || dis.err === undefined)
  console.log('cloud:dismissRestore IPC:', dismissOk ? 'OK' : 'FAIL')

  // 账号页渲染（CloudCard 挂载点：登录表单或已配对管理界面）
  await win.waitForFunction(() => !document.body.innerText.includes('正在加载本地数据'), { timeout: 20000 })
  await win.evaluate(() => { window.location.hash = '#/account' })
  await win.waitForTimeout(2500)
  const bodyText = await win.evaluate(() => document.body.innerText)
  const hasCloud = bodyText.includes('云备份') || bodyText.includes('云账号') || bodyText.includes('配对')
  console.log('账号页云同步卡:', hasCloud ? '已渲染' : '未渲染')
  await win.screenshot({ path: '../screenshots/sync-patch-account.png' })

  await app.close()
  if (!statusOk) throw new Error('cloud:status IPC 异常')
  if (!dismissOk) throw new Error('cloud:dismissRestore IPC 异常')
  if (!hasCloud) throw new Error('账号页云同步卡未渲染')
  console.log('\n闸④ PASS')
})().catch((e) => {
  console.error('闸④ FAIL:', e.message)
  process.exit(1)
})
