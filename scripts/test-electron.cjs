// Electron 实跑验证：启动应用 → 检查窗口/IPC/数据库/备份 → 截图
const { _electron: electron } = require('playwright')
const fs = require('fs')
const path = require('path')
const os = require('os')

;(async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(2500)

  const title = await win.title()
  console.log('窗口标题:', title)

  // preload 桥是否就位
  const hasFi = await win.evaluate(() => typeof window.fi !== 'undefined')
  console.log('window.fi 桥:', hasFi ? 'OK' : 'MISSING')
  if (!hasFi) throw new Error('preload 未注入 window.fi')

  // IPC 拉全量数据
  const data = await win.evaluate(() => window.fi.invoke('data:loadAll'))
  console.log('IPC data:loadAll → 商品', data.products.length, '/ 批次', data.batches.length, '/ 流水', data.transactions.length)
  if (data.products.length !== 12) throw new Error('种子数据不对')

  // IPC 写一笔入库，验证真实落库
  const w = await win.evaluate(() =>
    window.fi.invoke('inbound:create', {
      productId: 1, quantity: 3, costPrice: 4300, location: 'A区-东墙-第2层', supplierId: 1, operator: 'Electron验证',
    }),
  )
  console.log('IPC inbound:create →', w.batchNo)
  if (!/^PO\d{8}-\d{3}$/.test(w.batchNo)) throw new Error('批次号格式不对')

  // 页面渲染截图
  await win.waitForTimeout(1200)
  await win.screenshot({ path: '../screenshots/electron-dashboard.png' })
  console.log('截图: ../screenshots/electron-dashboard.png')

  await app.close()

  // 数据库与退出备份是否落盘
  const dataDir = path.join(os.homedir(), 'AppData/Roaming/fishing-inventory')
  const dbExists = fs.existsSync(path.join(dataDir, 'data.db'))
  const backups = fs.existsSync(path.join(dataDir, 'backup'))
    ? fs.readdirSync(path.join(dataDir, 'backup')).filter((f) => f.endsWith('.db'))
    : []
  console.log('数据库文件:', dbExists ? 'OK' : 'MISSING', path.join(dataDir, 'data.db'))
  console.log('退出备份:', backups.length > 0 ? `OK (${backups[backups.length - 1]})` : 'MISSING')
  if (!dbExists || backups.length === 0) throw new Error('落盘验证失败')

  console.log('\nElectron 实跑验证全部通过')
})().catch((e) => {
  console.error('验证失败:', e.message)
  process.exit(1)
})
