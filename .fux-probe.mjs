import { chromium } from 'playwright'
const TOKEN = process.argv[2]
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
await ctx.addInitScript((t) => { try {
  localStorage.setItem('fi-server','https://app.junchengzn.com')
  localStorage.setItem('fi-mobile-token', t)
  localStorage.setItem('fi-guided','1')
  localStorage.setItem('fi-operator','老板')
} catch(e){} }, TOKEN)
const page = await ctx.newPage()
const all = []
page.on('response', r => all.push(r.status() + ' ' + r.url()))
await page.route('**/api/invoke**', async (route) => {
  const req = route.request()
  try { const r = await fetch(req.url(), { method: req.method(), headers:{'Content-Type':'application/json'}, body: req.postData() || undefined }); await route.fulfill({ status:r.status, contentType:'application/json', body: await r.text() }) }
  catch(e){ await route.fulfill({ status:502, contentType:'application/json', body:'{"ok":false}' }) }
})
await page.goto('http://127.0.0.1:8099/?token=' + TOKEN, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForTimeout(3500)
console.log('=== 404 / 非200 资源 ===')
console.log(all.filter(x => !/ 2\d\d /.test(' ' + x + ' ')).slice(0,12).join('\n') || '(无)')
const cls = await page.evaluate(() => {
  const set = {}
  document.querySelectorAll('#app *').forEach(e => { if (e.className && typeof e.className === 'string') { const k = e.className.split(' ')[0]; set[k] = (set[k]||0)+1 } })
  return set
})
console.log('=== pos 页类名 ===')
console.log(JSON.stringify(cls))
const chips = await page.evaluate(() => [...document.querySelectorAll('#app .cat, #app .chip, #app .pill')].map(e => e.className + ' :: ' + e.innerText.trim().slice(0,12)).slice(0,16))
console.log('=== 分类控件 ===')
console.log(chips.join('\n') || '(未匹配 .cat/.chip/.pill)')
const cards = await page.evaluate(() => { const a = document.querySelectorAll('#app .pgrid > *, #app .card'); return [...a].slice(0,3).map(e => e.className + ' :: ' + e.innerText.trim().slice(0,20)) })
console.log('=== 商品卡 ===')
console.log(cards.join('\n') || '(未匹配)')
await browser.close()