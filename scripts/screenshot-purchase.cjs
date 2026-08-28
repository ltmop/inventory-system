// 截取采购订货页（mock 数据），供视觉自查
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  // 列表页
  await page.goto('http://localhost:5173/#/purchase', { waitUntil: 'networkidle' })
  await page.waitForTimeout(4000) // 等开屏动画播完
  await page.keyboard.press('Escape') // 关掉开机自动弹的低库存提醒
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'screenshots/purchase-list.png' })
  console.log('shot: purchase-list')

  // 详情弹窗（点第一行：待收货那张）
  await page.click('table tbody tr:first-child')
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'screenshots/purchase-detail.png' })
  console.log('shot: purchase-detail')

  // 收货弹窗
  await page.click('[role="dialog"] button:has-text("收货入库")')
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'screenshots/purchase-receive.png' })
  console.log('shot: purchase-receive')

  // 仪表盘待收提示
  await page.goto('http://localhost:5173/#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'screenshots/dashboard-po-hint.png' })
  console.log('shot: dashboard-po-hint')

  // 出库确认弹窗：价格档大按钮（光威赤刃设了零售/常客/批发三档）
  await page.goto('http://localhost:5173/#/outbound', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.fill('input', '6923456789012')
  await page.press('input', 'Enter')
  await page.waitForTimeout(600)
  await page.fill('input[type="number"] >> nth=0', '2')
  await page.click('button:has-text("确认出库")')
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'screenshots/outbound-tiers.png' })
  console.log('shot: outbound-tiers')

  // 库存编辑弹窗：价格档次区
  await page.goto('http://localhost:5173/#/inventory', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.click('table tbody tr:first-child button[title="编辑商品"]')
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'screenshots/inventory-tiers.png' })
  console.log('shot: inventory-tiers')

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
