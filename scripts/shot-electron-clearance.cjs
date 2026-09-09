const { _electron } = require('playwright')
;(async () => {
  const app = await _electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173' }, timeout: 60000 })
  const win = await app.firstWindow()
  await win.waitForTimeout(4000)
  for (const t of ['先用本机数据','先不登录','去入库补货','知道了']) { const b = win.getByText(t, { exact: false }); if (await b.count()) { try { await b.first().click(); await win.waitForTimeout(900) } catch(e){} } }
  await win.waitForTimeout(1000)
  await win.goto('http://localhost:5173/#/reports').catch(()=>{})
  await win.waitForTimeout(3500)
  // 滚动到清仓卡并只截该卡（给验收官的干净卡图）
  await win.evaluate(() => { const n=Array.from(document.querySelectorAll('*')).filter(x=>(x.textContent||'').trim().startsWith('清仓建议')).sort((a,b)=>(a.textContent||'').length-(b.textContent||'').length)[0]; const card=n?n.closest('[class*=card]'):null; if(card) card.scrollIntoView({block:'center'}) })
  await win.waitForTimeout(1200)
  const card = win.locator('[class*=card]').filter({ hasText: '清仓建议' }).first()
  try { await card.screenshot({ path: '../screenshots/clearance-card-real-react.png' }) } catch (e) { await win.screenshot({ path: '../screenshots/clearance-card-real-react.png', fullPage: true }) }
  console.log('shot saved')
  await app.close()
})().catch(e => { console.error('ERR ' + e.message); process.exit(1) })
