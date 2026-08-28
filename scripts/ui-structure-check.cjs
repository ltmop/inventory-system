// Electron UI 结构验证（只读，不写库）：验证 5 大导航 + 各 hub 页渲染
const { _electron: electron } = require('playwright')
const fs = require('fs')
const path = require('path')

;(async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(3000)

  const title = await win.title()
  console.log('窗口标题:', title)

  // 侧边栏 5 大导航
  const navTexts = await win.evaluate(() => {
    const links = Array.from(document.querySelectorAll('aside a'))
    return links.map((a) => a.textContent.trim())
  })
  console.log('侧边栏导航:', JSON.stringify(navTexts))
  const navOk = ['首页', '入库', '销售', '库存', '我的', '设置'].every((n) => navTexts.includes(n))
  console.log('5 大导航齐全:', navOk ? 'OK' : 'MISSING')

  // 首页（Dashboard）：快捷入口
  const home = await win.evaluate(() => document.querySelector('main')?.innerHTML?.slice(0, 200) || '')
  console.log('首页内容:', home.replace(/\s+/g, ' ').slice(0, 150))

  // 库存 hub 页：分类管理/单位管理入口
  await win.evaluate(() => { window.location.hash = '#/stock-hub' })
  await win.waitForTimeout(800)
  const stockHub = await win.evaluate(() => document.querySelector('main')?.innerHTML || '')
  console.log('库存 hub 含分类管理:', stockHub.includes('分类管理'))
  console.log('库存 hub 含单位管理:', stockHub.includes('单位管理'))
  console.log('库存 hub 含组合商品:', stockHub.includes('组合商品'))
  console.log('库存 hub 无配节:', !stockHub.includes('配节'))

  // 分类管理页
  await win.evaluate(() => { window.location.hash = '#/categories' })
  await win.waitForTimeout(800)
  const catPage = await win.evaluate(() => document.querySelector('main')?.innerHTML || '')
  console.log('分类管理页渲染:', catPage.includes('分类管理'))

  // 行业模板（设置页）
  await win.evaluate(() => { window.location.hash = '#/settings' })
  await win.waitForTimeout(800)
  const settingsPage = await win.evaluate(() => document.querySelector('main')?.innerHTML || '')
  console.log('设置页含行业模板:', settingsPage.includes('行业模板'))
  console.log('设置页含超市模板:', settingsPage.includes('超市 / 便利店'))

  // 我的页
  await win.evaluate(() => { window.location.hash = '#/mine-hub' })
  await win.waitForTimeout(800)
  const mineHub = await win.evaluate(() => document.querySelector('main')?.innerHTML || '')
  console.log('我的页含经营报表:', mineHub.includes('经营报表'))
  console.log('我的页含云同步:', mineHub.includes('云同步'))

  // 销售页
  await win.evaluate(() => { window.location.hash = '#/sales-hub' })
  await win.waitForTimeout(800)
  const salesHub = await win.evaluate(() => document.querySelector('main')?.innerHTML || '')
  console.log('销售页含会员管理:', salesHub.includes('会员管理'))
  console.log('销售页含收款对账:', salesHub.includes('收款对账'))

  await app.close()
  console.log('\nUI 验证完成')
})().catch((e) => { console.error('UI 验证失败:', e.message); process.exit(1) })
