// Electron UI 验证：云同步账户登录 UI + 5 大导航
const { _electron: electron } = require('playwright')

;(async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(3000)

  const title = await win.title()
  console.log('窗口标题:', title)

  // 5 大导航
  const navTexts = await win.evaluate(() => Array.from(document.querySelectorAll('aside a')).map(a => a.textContent.trim()))
  console.log('导航:', JSON.stringify(navTexts))

  // 设置页 → CloudCard 账户登录
  await win.evaluate(() => { window.location.hash = '#/settings' })
  await win.waitForTimeout(1000)
  const settingsHtml = await win.evaluate(() => document.querySelector('main')?.innerHTML || '')
  console.log('设置页含云备份卡:', settingsHtml.includes('云备份'))
  console.log('设置页含登录账户:', settingsHtml.includes('登录账户'))
  console.log('设置页含注册账户:', settingsHtml.includes('注册账户'))

  await app.close()
  console.log('\nUI 验证完成')
})().catch((e) => { console.error('UI 验证失败:', e.message); process.exit(1) })
