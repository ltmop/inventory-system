// 临时截图脚本：操作日志页 + 仪表盘（临期卡片）+ 库存临期筛选 + 供应商对账 + 设置备份卡片
// 只加载一次 app：启动动画和低库存弹窗只处理一次，之后用 hash 做 SPA 内跳转（不触发重载）
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => console.log('pageerror:', e.message))

  await page.goto('http://localhost:5173/#/', { waitUntil: 'networkidle' })
  await page.mouse.click(700, 450) // 点掉启动动画（点击任意处跳过）
  await page.waitForTimeout(800)
  const close = page.getByRole('button', { name: '关闭' })
  if (await close.isVisible().catch(() => false)) await close.click()
  await page.waitForTimeout(400)

  const open = async (hash, wait = 900) => {
    await page.evaluate((h) => { location.hash = h }, hash)
    await page.waitForTimeout(wait)
  }

  await open('#/audit')
  await page.screenshot({ path: '../screenshots/audit.png' })
  console.log('shot: audit')

  await open('#/', 1800) // 等数字滚动动画
  await page.screenshot({ path: '../screenshots/dashboard-expiring.png' })
  console.log('shot: dashboard-expiring')

  await open('#/inventory?filter=expiring')
  await page.screenshot({ path: '../screenshots/inventory-expiring.png' })
  console.log('shot: inventory-expiring')

  await open('#/settings')
  await page.screenshot({ path: '../screenshots/settings-backup.png' })
  console.log('shot: settings-backup')

  // 供应商对账弹窗：点第一行的「对账」
  await open('#/suppliers')
  await page.getByRole('button', { name: '对账' }).first().click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: '../screenshots/supplier-statement.png' })
  console.log('shot: supplier-statement')

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
