// 截图验证价格档自动化：出库页选商品 → 确认出库 → 选批发客户，售价自动变批发价
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://localhost:5173/#/outbound', { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.click('body') // 跳过开屏动画
  await page.waitForTimeout(1500)
  // 开机低库存提醒弹窗：有就关掉
  const dismiss = await page.$('button:has-text("知道了")')
  if (dismiss) {
    await dismiss.click()
    await page.waitForTimeout(500)
  }

  // 搜索并选中商品（product 1 设了零售/常客/批发三档价）
  await page.fill('input', '赤刃')
  await page.waitForTimeout(400)
  await page.press('input', 'Enter')
  await page.waitForTimeout(600)
  await page.fill('input[type="number"] >> nth=0', '2')

  // 打开出库确认框
  await page.click('button:has-text("确认出库")')
  await page.waitForTimeout(600)
  await page.screenshot({ path: '../screenshots/price-auto-1-walkin.png' })
  console.log('shot: price-auto-1-walkin（散客=零售价）')

  // 选批发客户「码头张老板」→ 售价应自动变批发价 72.00
  await page.click('text=散客（不记账）')
  await page.waitForTimeout(400)
  await page.click('text=码头张老板')
  await page.waitForTimeout(600)
  await page.screenshot({ path: '../screenshots/price-auto-2-wholesale.png' })
  console.log('shot: price-auto-2-wholesale（选张老板=自动批发价）')

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
