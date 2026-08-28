// 商品图片功能视觉自查：mock 路径商品本来没图，这里在页面里临时生成几张图塞进 store
// （photo_path 支持 data: URL 原样展示，专供这种注入/截图场景），截库存页缩略图列 + 大图预览 + 编辑弹窗图片区
// 前置：vite dev server 已在 5173 端口跑（npm run dev）
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://localhost:5173/#/inventory', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // 开机自动弹的低库存提醒会挡住表格，点「知道了」关掉（Escape 时机不稳）
  const gotIt = page.locator('button:has-text("知道了")')
  if (await gotIt.count()) {
    await gotIt.first().click()
    await page.waitForTimeout(500)
  }

  // 用 canvas 画三张「商品图」（色块 + 简易鱼形 + 品名），转成 JPEG data URL 塞进前三个商品
  await page.evaluate(() => {
    const shots = [
      ['#1d4ed8', '#bfdbfe', '光威 赤刃 3.6m'],
      ['#15803d', '#bbf7d0', '化氏 一味 4.5m'],
      ['#b45309', '#fde68a', '达亿瓦 一击 2.1m'],
    ]
    const urls = shots.map(([bg, fg, label]) => {
      const c = document.createElement('canvas')
      c.width = 800
      c.height = 600
      const ctx = c.getContext('2d')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, 800, 600)
      // 简易鱼形：椭圆身体 + 三角尾巴
      ctx.fillStyle = fg
      ctx.beginPath()
      ctx.ellipse(360, 280, 200, 90, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(540, 280)
      ctx.lineTo(660, 200)
      ctx.lineTo(660, 360)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = bg
      ctx.beginPath()
      ctx.arc(260, 260, 14, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#0f172a'
      ctx.font = 'bold 44px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(label, 400, 520)
      return c.toDataURL('image/jpeg', 0.85)
    })
    const store = window.__fiStore
    // 低库存提醒改成「已看过且不弹」，避免它半路弹出挡点击
    store.setState({ lowStockAlertOpen: false, lowStockAlertShown: true })
    store.setState((s) => ({
      products: s.products.map((p, i) => (i < urls.length ? { ...p, photo_path: urls[i] } : p)),
    }))
  })
  await page.waitForTimeout(300)
  // 若提醒已经弹出则点「知道了」关掉
  if (await gotIt.count()) {
    await gotIt.first().click()
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(800)
  await page.screenshot({ path: '../screenshots/inventory-photo.png' })
  console.log('shot: inventory-photo')

  // 点第一张缩略图 → 大图预览弹窗
  await page.click('button[title="点一下看大图"]')
  await page.waitForTimeout(600)
  await page.screenshot({ path: '../screenshots/inventory-photo-preview.png' })
  console.log('shot: inventory-photo-preview')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 打开第一个商品的编辑弹窗 → 图片区（有图：预览 + 换一张/删除）
  await page.click('button[title="编辑商品"]')
  await page.waitForTimeout(600)
  await page.screenshot({ path: '../screenshots/inventory-photo-edit.png' })
  console.log('shot: inventory-photo-edit')

  await browser.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
