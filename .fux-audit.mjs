import { chromium } from 'playwright'
import fs from 'node:fs'
const TOKEN = process.argv[2]
const OUT = 'C:/Users/Administrator/Desktop/库存管理/.fux'
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
await ctx.addInitScript((t) => { try {
  localStorage.setItem('fi-server','https://app.junchengzn.com')
  localStorage.setItem('fi-mobile-token', t)
  localStorage.setItem('fi-guided','1')
  localStorage.setItem('fi-operator','老板')
  localStorage.setItem('fi-operators', JSON.stringify(['老板']))
} catch(e){} }, TOKEN)
const page = await ctx.newPage()
const bad = [], errs = []
page.on('response', r => { if (r.status() >= 400 && !/api\/invoke/.test(r.url())) bad.push(r.status() + ' ' + r.url().slice(0, 110)) })
page.on('console', m => { if (m.type()==='error' && !/api\/invoke/.test(m.text())) errs.push(m.text().slice(0,140)) })
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e.message).slice(0,140)))
await page.route('**/api/invoke**', async (route) => {
  const req = route.request()
  try { const r = await fetch(req.url(), { method: req.method(), headers: {'Content-Type':'application/json'}, body: req.postData() || undefined })
    await route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() }) }
  catch (e) { await route.fulfill({ status: 502, contentType:'application/json', body: '{"ok":false}' }) }
})
await page.goto('http://127.0.0.1:8099/?token=' + TOKEN, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForTimeout(3500)
const routes = ['pos','stock','today','inbound','ai','restock','promo','expiring','waste','specbatch','stocktake','kits','parts','customers','receipts','expenses','suppliers','more']
const out = {}
for (const h of routes) {
  await page.evaluate(x => { location.hash = x }, h)
  await page.waitForTimeout(2200)
  const t = await page.evaluate(() => { const a=document.getElementById('app'); return a ? a.innerText.replace(/\n{2,}/g,'\n').slice(0,900) : '' })
  out[h] = t
  await page.screenshot({ path: OUT + '/r_' + h + '.png' })
}
fs.writeFileSync(OUT + '/routes.json', JSON.stringify(out, null, 1))
console.log('=== 请求失败(非API) ===')
console.log(bad.length ? [...new Set(bad)].slice(0,10).join('\n') : '(无)')
console.log('=== JS 报错 ===')
console.log(errs.length ? [...new Set(errs)].slice(0,8).join('\n') : '(无)')
console.log('=== 各页文字 ===')
for (const h of routes) console.log('\n### ' + h + '\n' + out[h].split('\n').filter(Boolean).slice(0,14).join(' / '))
await browser.close()