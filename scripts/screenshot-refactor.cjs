// 重构前后对比截图：node scripts/screenshot-refactor.cjs <tag>
// 产物：screenshots/refactor-<tag>-<page>.png
const { chromium } = require('playwright')

const tag = process.argv[2] || 'before'

const SHOTS = [
  ['inventory', '/#/inventory'],
  ['outbound', '/#/outbound'],
  ['customers', '/#/customers'],
]

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  for (const [name, route] of SHOTS) {
    await page.goto(`http://localhost:5173${route}`, { waitUntil: 'networkidle' })
    // 跳过启动动画（点击即跳过）
    await page.mouse.click(720, 450).catch(() => {})
    await page.waitForTimeout(1500)
    // 低库存弹窗（库存页自动弹出）：关掉再截
    const knowBtn = page.locator('button', { hasText: '知道了' })
    if (await knowBtn.count()) {
      await knowBtn.first().click().catch(() => {})
      await page.waitForTimeout(400)
    }
    await page.screenshot({ path: `../screenshots/refactor-${tag}-${name}.png` })
    console.log(`shot: refactor-${tag}-${name}`)
  }
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
