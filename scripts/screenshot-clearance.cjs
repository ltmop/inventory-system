const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
  await page.goto('http://localhost:5173/#/reports', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500); await page.click('body').catch(()=>{})
  const dismiss = await page.$('button:has-text("知道了")'); if (dismiss) { await dismiss.click().catch(()=>{}); await page.waitForTimeout(500) }
  // 定位清仓建议卡
  const card = await page.locator('text=清仓建议（谁该清').first().locator('xpath=ancestor::div[contains(@class,"card")]').nth(0)
  try { await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(600) } catch(e){ console.log('scroll err ' + e.message) }
  await page.screenshot({ path: '../screenshots/clearance-card.png', fullPage: false })
  const txt = await card.innerText().catch(()=> 'NO_CARD')
  console.log('CARD:\n' + txt.slice(0, 900))
  console.log('shot: clearance-card.png (card region)')
  await browser.close()
})().catch(e => { console.error('ERR ' + e.message); process.exit(1) })
