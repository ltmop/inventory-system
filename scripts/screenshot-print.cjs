// 小票预览 + 价格标签预览截图，供视觉自查（需 dev server 跑在 :5173）
const { chromium } = require('playwright')

// 启动动画每次加载都播，点一下跳过并等它消失
async function skipSplash(page) {
  const splash = page.locator('[aria-label="跳过启动动画"]')
  try {
    await splash.click({ timeout: 8000 })
  } catch {
    /* 已经播完了 */
  }
  await splash.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
}

// 开机会自动弹一次低库存提醒，挡点击，关掉
async function dismissLowStockAlert(page) {
  const btn = page.getByRole('button', { name: '知道了' })
  try {
    await btn.click({ timeout: 5000 })
  } catch {
    /* 没弹 */
  }
}

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('console', (m) => m.type() === 'error' && console.log('console.error:', m.text()))
  page.on('pageerror', (e) => console.log('pageerror:', e.message))

  // 1) 库存页：点第一个商品的「打标签」→ 标签预览
  await page.goto('http://localhost:5173/#/inventory', { waitUntil: 'networkidle' })
  await skipSplash(page)
  await dismissLowStockAlert(page)
  await page.locator('button[title="打印价格标签"]').first().click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: '../screenshots/price-label.png' })
  console.log('shot: price-label')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 2) 出库页：扫码选中 → 确认出库 → 成功后点「打印小票」→ 小票预览
  await page.goto('http://localhost:5173/#/outbound', { waitUntil: 'networkidle' })
  await skipSplash(page)
  await dismissLowStockAlert(page)
  const scan = page.locator('input[placeholder*="扫码或输入"]')
  await scan.fill('6923456789012')
  await scan.press('Enter')
  await page.waitForTimeout(600)
  await page.locator('input[type="number"]').first().fill('2')
  await page.getByRole('button', { name: '确认出库' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '确认执行出库' }).click()
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: '打印小票' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: '../screenshots/receipt.png' })
  console.log('shot: receipt')

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
