import { chromium } from 'playwright'
const TOKEN = process.argv[2]
const OUT = 'C:/Users/Administrator/Desktop/库存管理/.fux'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
await ctx.addInitScript((t) => { try {
  localStorage.setItem('fi-server','https://app.junchengzn.com')
  localStorage.setItem('fi-mobile-token', t)
  localStorage.setItem('fi-guided','1')
  localStorage.setItem('fi-operator','老板')
} catch(e){} }, TOKEN)
const page = await ctx.newPage()
await page.route('**/api/invoke**', async (route) => {
  const req = route.request()
  try { const r = await fetch(req.url(), { method: req.method(), headers:{'Content-Type':'application/json'}, body: req.postData() || undefined }); await route.fulfill({ status:r.status, contentType:'application/json', body: await r.text() }) }
  catch(e){ await route.fulfill({ status:502, contentType:'application/json', body:'{"ok":false}' }) }
})
await page.goto('http://127.0.0.1:8099/?token=' + TOKEN, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForTimeout(3500)
// 1. 点分类「饵料」
await page.locator('#app .cat', { hasText: '饵料' }).first().click()
await page.waitForTimeout(1500)
await page.screenshot({ path: OUT + '/f1_cat.png' })
console.log('[1 点饵料分类] ' + (await page.evaluate(() => document.querySelector('#app .pos-mid').innerText.replace(/\n+/g,' / ').slice(0,220))))
// 2. 点第一个商品加进购物车
await page.locator('#app .pcard').first().click()
await page.waitForTimeout(1500)
await page.screenshot({ path: OUT + '/f2_cart.png' })
console.log('[2 加购物车] ' + (await page.evaluate(() => document.querySelector('#app .pos-cart').innerText.replace(/\n+/g,' / ').slice(0,260))))
// 3. 点收款键看结账面板（不确认，避免写账）
await page.locator('#app .paybtn').first().click()
await page.waitForTimeout(1500)
await page.screenshot({ path: OUT + '/f3_pay.png' })
const sheet = await page.evaluate(() => { const s=document.querySelector('.sheet,.mask,.overlay,[class*=sheet]'); return s ? s.innerText.replace(/\n+/g,' / ').slice(0,300) : '(没弹面板)' })
console.log('[3 收款面板] ' + sheet)
// 4. 库存页 → 点品牌 狼王
await page.evaluate(() => { location.hash = 'stock' })
await page.waitForTimeout(2500)
await page.locator('#app .brand, #app .brow, #app [class*=brand]').first().click().catch(()=>{})
await page.waitForTimeout(1800)
await page.screenshot({ path: OUT + '/f4_brand.png' })
console.log('[4 品牌明细] ' + (await page.evaluate(() => document.getElementById('app').innerText.replace(/\n+/g,' / ').slice(0,300))))
// 5. 点一个商品进详情
await page.locator('#app .pcard, #app .line, #app [class*=row]').first().click().catch(()=>{})
await page.waitForTimeout(1800)
await page.screenshot({ path: OUT + '/f5_prod.png' })
console.log('[5 商品详情] ' + (await page.evaluate(() => document.getElementById('app').innerText.replace(/\n+/g,' / ').slice(0,340))))
await browser.close()