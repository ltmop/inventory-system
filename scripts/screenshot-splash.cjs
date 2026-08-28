// 截启动动画中段（鱼出水定格）与仪表盘，验证动画效果
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://localhost:5173/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600) // 鱼已出水 + 店名定格
  await page.screenshot({ path: '../screenshots/splash.png' })
  console.log('shot: splash')
  await page.waitForTimeout(2500) // splash 退出 + 仪表盘数字滚动完成
  const dismiss = page.getByRole('button', { name: '知道了' })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click() // 关掉低库存开机弹窗
  await page.waitForTimeout(600)
  await page.screenshot({ path: '../screenshots/dashboard.png' })
  console.log('shot: dashboard')
  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
