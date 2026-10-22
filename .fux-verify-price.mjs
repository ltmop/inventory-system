import { chromium } from 'playwright'
const TOKEN = process.argv[2]
const OUT = 'C:/Users/Administrator/Desktop/库存管理/.fux'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
await ctx.addInitScript((t) => { try { localStorage.setItem('fi-server','https://app.junchengzn.com'); localStorage.setItem('fi-mobile-token', t); localStorage.setItem('fi-guided','1'); localStorage.setItem('fi-operator','老板') } catch(e){} }, TOKEN)
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e.message).slice(0,120)))
await page.route('**/api/invoke**', async (route) => { const req=route.request(); try { const r=await fetch(req.url(),{method:req.method(),headers:{'Content-Type':'application/json'},body:req.postData()||undefined}); await route.fulfill({status:r.status,contentType:'application/json',body:await r.text()}) } catch(e){ await route.fulfill({status:502,contentType:'application/json',body:'{"ok":false}'}) } })
await page.goto('http://127.0.0.1:8099/?token=' + TOKEN, { waitUntil:'networkidle', timeout:90000 })
await page.waitForTimeout(3800)
await page.locator('#app .cat', { hasText: '饵料' }).first().click()
await page.waitForTimeout(2000)
const cards = await page.evaluate(() => [...document.querySelectorAll('#app .pcard')].map(c=>c.innerText.replace(/\n+/g,' ')))
console.log('饵料分类卡片（前 12）:')
cards.slice(0,12).forEach(c=>console.log('  ' + c))
console.log('')
console.log('【修①】显示「未定价」的: ' + JSON.stringify(cards.filter(c=>/未定价/.test(c))))
console.log('【修①】还显示 ¥0 的: ' + JSON.stringify(cards.filter(c=>/¥0(?!\d)/.test(c))))
await page.screenshot({ path: OUT + '/fix_pos2.png' })
console.log('JS 报错: ' + (errs.length ? errs.join(' | ') : '(无)'))
await browser.close()