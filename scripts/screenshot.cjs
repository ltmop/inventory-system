// 用系统 Edge 截取各页面，供视觉自查
const { chromium } = require('playwright')

const SHOTS = [
  ['dashboard', '/#/'],
  ['inbound', '/#/inbound'],
  ['inventory', '/#/inventory'],
  ['outbound', '/#/outbound'],
  ['stock-take', '/#/stock-take'],
  ['suppliers', '/#/suppliers'],
  ['settings', '/#/settings'],
]

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  for (const [name, route] of SHOTS) {
    await page.goto(`http://localhost:5173${route}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1800) // 等入场动画和数字滚动结束
    await page.screenshot({ path: `../screenshots/kimi-review/${name}.png` })
    console.log(`shot: ${name}`)
  }
  // 入库页：模拟扫码命中后的匹配卡片
  await page.goto('http://localhost:5173/#/inbound', { waitUntil: 'networkidle' })
  await page.fill('input', '6923456789012')
  await page.press('input', 'Enter')
  await page.waitForTimeout(800)
  await page.screenshot({ path: '../screenshots/kimi-review/inbound-matched.png' })
  console.log('shot: inbound-matched')
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
