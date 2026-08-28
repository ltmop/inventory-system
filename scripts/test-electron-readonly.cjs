// Electron 实跑验证（只读版）：启动应用 → 检查窗口/IPC/数据库/备份 → 截图
// 与 test-electron.cjs 的区别：不写入任何业务数据，避免污染真实库
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

  // IPC 拉全量数据（只读）
  const data = await win.evaluate(() => window.fi.invoke('data:loadAll'))
  console.log('IPC data:loadAll → 商品', data.products.length, '/ 批次', data.batches.length, '/ 流水', data.transactions.length)
  if (data.products.length === 0) throw new Error('商品数据为空')

  // 新 schema 校验：products 应带 sub_category 字段
  if (!('sub_category' in data.products[0])) throw new Error('products 缺 sub_category 字段')
  console.log('sub_category 字段: OK')

  // 新增的 product:update / product:delete 通道应可用（delete 只验证拒绝路径，不产生副作用）
  // 动态找一个有批次的商品（不硬编码 id：清理演示数据后 id 会变化）
  const withBatch = data.batches.find((b) => b.quantity > 0)
  if (!withBatch) throw new Error('没有带库存的批次，无法验证删除拒绝路径')
  const del = await win.evaluate((pid) => window.fi.invoke('product:delete', { id: pid }), withBatch.product_id)
  console.log('product:delete(有批次商品) →', JSON.stringify(del))
  if (del.ok !== false) throw new Error('有批次商品应被拒绝删除')
  // 不存在的 id 也不能返回成功（防止列表过期时误报"删除成功"）
  const delGhost = await win.evaluate(() => window.fi.invoke('product:delete', { id: 999999 }))
  console.log('product:delete(不存在商品) →', JSON.stringify(delGhost))
  if (delGhost.ok !== false) throw new Error('不存在商品应返回失败而非 ok:true')

  // AI 通道：未配置 Key 时应优雅降级（ok:false），不能抛异常
  const aiStatus = await win.evaluate(() => window.fi.invoke('ai:status'))
  console.log('ai:status →', JSON.stringify(aiStatus))
  if (typeof aiStatus.configured !== 'boolean') throw new Error('ai:status 结构不对')
  const aiSummary = await win.evaluate(() =>
    window.fi.invoke('ai:dailySummary', {
      stats: { date: '2026-07-29', qty: 1, revenue: 8500, profit: 4000, topItems: [], lowStock: [] },
    }),
  )
  console.log('ai:dailySummary(未配Key) →', JSON.stringify(aiSummary))
  if (aiSummary.ok !== false) throw new Error('无 Key 时 AI 应静默失败而非成功')
  const aiChat = await win.evaluate(() =>
    window.fi.invoke('ai:chat', { messages: [{ role: 'user', content: '今天赚了多少钱' }] }),
  )
  console.log('ai:chat(未配Key) →', JSON.stringify(aiChat))
  if (aiChat.ok !== false) throw new Error('无 Key 时 ai:chat 应静默失败而非成功')

  // 页面渲染截图
  await win.waitForTimeout(1200)
  fs.mkdirSync('../screenshots', { recursive: true })
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

  console.log('\nElectron 实跑验证（只读）全部通过')
})().catch((e) => {
  console.error('验证失败:', e.message)
  process.exit(1)
})
