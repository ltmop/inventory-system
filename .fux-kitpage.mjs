import { chromium } from 'playwright'
const TOKEN = process.argv[2]
const OUT='C:/Users/Administrator/Desktop/库存管理/.fux'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport:{width:412,height:900}, deviceScaleFactor:2, isMobile:true, hasTouch:true, locale:'zh-CN' })
await ctx.addInitScript((t)=>{try{localStorage.setItem('fi-server','https://app.junchengzn.com');localStorage.setItem('fi-mobile-token',t);localStorage.setItem('fi-guided','1');localStorage.setItem('fi-operator','老板')}catch(e){}}, TOKEN)
const page = await ctx.newPage()
const errs=[]; page.on('pageerror', e=>errs.push(String(e.message).slice(0,140)))
await page.route('**/api/invoke**', async (route)=>{const req=route.request();try{const r=await fetch(req.url(),{method:req.method(),headers:{'Content-Type':'application/json'},body:req.postData()||undefined});await route.fulfill({status:r.status,contentType:'application/json',body:await r.text()})}catch(e){await route.fulfill({status:502,contentType:'application/json',body:'{"ok":false}'})}})
await page.goto('http://127.0.0.1:8099/?token='+TOKEN,{waitUntil:'networkidle',timeout:90000})
await page.waitForTimeout(3800)
await page.evaluate(()=>{location.hash='kits'})
await page.waitForTimeout(2600)
console.log('套餐页: ' + (await page.evaluate(()=>document.getElementById('app').innerText.replace(/\n+/g,' | ').slice(0,240))))
await page.screenshot({ path: OUT + '/kit_page.png' })
// 点开套餐看明细 + 改/删按钮
await page.locator('#app .card', { hasText: '冻饵一套' }).first().click()
await page.waitForTimeout(2200)
const sheetTxt = await page.evaluate(()=>{const s=document.querySelector('.sheet,.mask,[class*=sheet]'); return s?s.innerText.replace(/\n+/g,' | ').slice(0,300):'(没弹)'})
console.log('明细面板: ' + sheetTxt)
await page.screenshot({ path: OUT + '/kit_sheet.png' })
console.log('JS 报错: ' + (errs.length?errs.join(' | '):'(无)'))
await browser.close()