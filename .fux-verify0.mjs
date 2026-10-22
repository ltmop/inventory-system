import { chromium } from 'playwright'
const TOKEN = process.argv[2]
const OUT = 'C:/Users/Administrator/Desktop/库存管理/.fux'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
await ctx.addInitScript((x) => { try {
  localStorage.setItem('fi-server','https://app.junchengzn.com')
  localStorage.setItem('fi-mobile-token', x)
  localStorage.setItem('fi-guided','1'); localStorage.setItem('fi-operator','老板')
} catch(e){} }, TOKEN)
const page = await ctx.newPage()
const dialogs = []
page.on('dialog', async d => { dialogs.push(d.type() + ' :: ' + d.message().slice(0,140)); await d.dismiss() })
await page.route('**/api/invoke**', async (route) => {
  const req = route.request()
  try { const r = await fetch(req.url(), { method: req.method(), headers:{'Content-Type':'application/json'}, body: req.postData() || undefined }); await route.fulfill({ status:r.status, contentType:'application/json', body: await r.text() }) }
  catch(e){ await route.fulfill({ status:502, contentType:'application/json', body:'{"ok":false}' }) }
})
await page.goto('http://127.0.0.1:8099/?token=' + TOKEN, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForTimeout(3500)
// 找售价 0 的商品卡
const zero = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#app .pcard')]
  const hit = cards.filter(c => /¥0(?!\d)/.test(c.innerText))
  return hit.slice(0,3).map(c => c.innerText.replace(/\n+/g,' | '))
})
console.log('当前台面上 ¥0 的商品卡: ' + JSON.stringify(zero))
if (zero.length) {
  const cards = page.locator('#app .pcard')
  const n = await cards.count()
  for (let i = 0; i < n; i++) {
    const t = await cards.nth(i).innerText()
    if (/¥0(?!\d)/.test(t)) {
      await cards.nth(i).click()
      await page.waitForTimeout(1800)
      break
    }
  }
}
console.log('=== 点 ¥0 商品后弹出的对话框 ===')
console.log(dialogs.length ? dialogs.join('\n') : '(没有弹框 —— 说明直接进购物车了)')
const cart = await page.evaluate(() => { const c=document.querySelector('#app .pos-cart'); return c ? c.innerText.replace(/\n+/g,' | ').slice(0,200) : '(无购物车)' })
console.log('=== 购物车状态 ===')
console.log(cart)
await page.screenshot({ path: OUT + '/v_zeroprice.png' })
await browser.close()