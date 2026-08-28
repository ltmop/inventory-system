// 打包产物验证：直接启动 win-unpacked 里的 .exe（未安装，等同安装后的运行形态）
const { _electron: electron } = require('playwright')
const path = require('path')
const os = require('os')

;(async () => {
  const exe = path.join(os.homedir(), 'AppData/Local/Temp/fi-release/win-unpacked/渔具库存AI管理系统.exe')
  const app = await electron.launch({ executablePath: exe })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(2500)

  console.log('窗口标题:', await win.title())

  const hasFi = await win.evaluate(() => typeof window.fi !== 'undefined')
  if (!hasFi) throw new Error('window.fi 未注入')
  console.log('window.fi 桥: OK')

  const info = await win.evaluate(() => window.fi.invoke('app:info'))
  console.log('app:info → 版本', info.version, '| 数据库', info.dbPath)
  if (info.version !== '1.1.0') throw new Error('版本号不对')

  const data = await win.evaluate(() => window.fi.invoke('data:loadAll'))
  console.log('data:loadAll → 商品', data.products.length, '/ 批次', data.batches.length)
  if (data.products.length < 12) throw new Error('数据不对')

  // 手动备份（设置页按钮背后的 IPC）
  const dest = await win.evaluate(() => window.fi.invoke('backup:now'))
  console.log('backup:now →', dest)

  // 打开设置页截图
  await win.evaluate(() => { window.location.hash = '#/settings' })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: '../screenshots/packaged-settings.png' })
  console.log('截图: ../screenshots/packaged-settings.png')

  await app.close()
  console.log('\n打包产物验证全部通过')
})().catch((e) => {
  console.error('验证失败:', e.message)
  process.exit(1)
})
