// 重构后验证：3 个关键页面 after 截图 + 分页翻页功能验证（向 zustand store 注入测试数据，仅本次会话有效，不改代码）
const { chromium } = require('playwright')

const BASE = 'http://localhost:5173'

async function skipSplashAndDialog(page) {
  await page.mouse.click(720, 450).catch(() => {})
  await page.waitForTimeout(1200)
  const knowBtn = page.locator('button', { hasText: '知道了' })
  if (await knowBtn.count()) {
    await knowBtn.first().click().catch(() => {})
    await page.waitForTimeout(400)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  // ── 1. after 截图（与 before 同机位） ──
  for (const [name, route] of [['inventory', '/#/inventory'], ['outbound', '/#/outbound'], ['customers', '/#/customers']]) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' })
    await skipSplashAndDialog(page)
    await page.screenshot({ path: `../screenshots/refactor-after-${name}.png` })
    console.log(`shot: refactor-after-${name}`)
  }

  // ── 2. 库存页分页：注入 137 个商品 → 共 151 条，验证翻页/换每页条数 ──
  await page.goto(`${BASE}/#/inventory`, { waitUntil: 'networkidle' })
  await skipSplashAndDialog(page)
  await page.evaluate(async () => {
    const m = await import('/src/store/appStore.ts')
    const st = m.useAppStore.getState()
    const tpl = st.products[0]
    const fake = Array.from({ length: 137 }, (_, i) => ({
      ...tpl,
      id: 9000 + i,
      sku_code: `TEST-SKU-${String(i + 1).padStart(3, '0')}`,
      brand: '测试品牌',
      model: `分页测试商品 ${i + 1} 号`,
      status: '已盘点',
      min_stock: 0,
    }))
    m.useAppStore.setState({ products: [...st.products, ...fake] })
  })
  await page.waitForTimeout(500)
  const pg = page.locator('[data-slot="pagination"]')
  await assert(await pg.locator('text=第 1-50 条，共 151 条').count() === 1, '库存页：初始显示「第 1-50 条，共 151 条」')
  await pg.locator('button[title="下一页"]').click()
  await page.waitForTimeout(300)
  await assert(await pg.locator('text=第 51-100 条，共 151 条').count() === 1, '库存页：下一页 →「第 51-100 条」')
  await pg.locator('button', { hasText: /^4$/ }).click()
  await page.waitForTimeout(300)
  await assert(await pg.locator('text=第 151-151 条，共 151 条').count() === 1, '库存页：点页码 4 → 最后一页「第 151-151 条」')
  await pg.locator('button[title="上一页"]').click()
  await page.waitForTimeout(300)
  await assert(await pg.locator('text=第 101-150 条，共 151 条').count() === 1, '库存页：上一页 →「第 101-150 条」')
  // 换每页条数 20 → 回第 1 页
  await pg.locator('button[role="combobox"]').click()
  await page.locator('[role="option"]', { hasText: '20 条' }).click()
  await page.waitForTimeout(300)
  await assert(await pg.locator('text=第 1-20 条，共 151 条').count() === 1, '库存页：换每页 20 条 → 回第 1 页「第 1-20 条」')
  // 筛选变化回第 1 页：翻到第 2 页后搜关键词
  await pg.locator('button[title="下一页"]').click()
  await page.waitForTimeout(200)
  await page.fill('input[placeholder*="搜索SKU"]', '分页测试商品 1 号')
  await page.waitForTimeout(800) // 300ms 防抖 + 渲染
  await assert(await pg.locator('text=第 1-1 条，共 1 条').count() === 1, '库存页：筛选变化回第 1 页（搜索结果 1 条）')
  await page.fill('input[placeholder*="搜索SKU"]', '')
  await page.waitForTimeout(800)
  await pg.locator('button[role="combobox"]').click()
  await page.locator('[role="option"]', { hasText: '50 条' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: '../screenshots/refactor-after-inventory-paged.png' })
  console.log('shot: refactor-after-inventory-paged')

  // ── 3. 客户页分页：注入 60 个客户 → 共 63 条，翻一页 ──
  await page.goto(`${BASE}/#/customers`, { waitUntil: 'networkidle' })
  await skipSplashAndDialog(page)
  await page.evaluate(async () => {
    const m = await import('/src/store/appStore.ts')
    const st = m.useAppStore.getState()
    const tpl = st.customers[0]
    const fake = Array.from({ length: 60 }, (_, i) => ({
      ...tpl,
      id: 8000 + i,
      name: `分页客户${String(i + 1).padStart(2, '0')}`,
      outstanding: 0,
      notes: '',
    }))
    m.useAppStore.setState({ customers: [...st.customers, ...fake] })
  })
  await page.waitForTimeout(500)
  const cpg = page.locator('[data-slot="pagination"]')
  await assert(await cpg.locator('text=第 1-50 条，共 63 条').count() === 1, '客户页：初始「第 1-50 条，共 63 条」')
  await cpg.locator('button[title="下一页"]').click()
  await page.waitForTimeout(300)
  await assert(await cpg.locator('text=第 51-63 条，共 63 条').count() === 1, '客户页：下一页 →「第 51-63 条」')
  await page.screenshot({ path: '../screenshots/refactor-after-customers-paged.png' })
  console.log('shot: refactor-after-customers-paged')

  // ── 4. 操作日志分页：注入 160 条日志 → 共 160+ 条（上限 200），翻一页 ──
  await page.goto(`${BASE}/#/audit`, { waitUntil: 'networkidle' })
  await skipSplashAndDialog(page)
  await page.evaluate(async () => {
    const m = await import('/src/store/appStore.ts')
    const st = m.useAppStore.getState()
    const tpl = st.auditLogs[0]
    const fake = Array.from({ length: 160 }, (_, i) => ({
      ...tpl,
      id: 7000 + i,
      created_at: new Date(Date.now() - i * 60000).toISOString(),
    }))
    m.useAppStore.setState({ auditLogs: [...fake, ...st.auditLogs] })
  })
  await page.waitForTimeout(800)
  const apg = page.locator('[data-slot="pagination"]')
  const total = await page.evaluate(async () => {
    const m = await import('/src/store/appStore.ts')
    return Math.min(m.useAppStore.getState().auditLogs.length, 200)
  })
  await assert(await apg.locator(`text=第 1-50 条，共 ${total} 条`).count() === 1, `日志页：初始「第 1-50 条，共 ${total} 条」`)
  await apg.locator('button[title="下一页"]').click()
  await page.waitForTimeout(300)
  await assert(await apg.locator(`text=第 51-100 条，共 ${total} 条`).count() === 1, '日志页：下一页 →「第 51-100 条」')
  await page.screenshot({ path: '../screenshots/refactor-after-audit-paged.png' })
  console.log('shot: refactor-after-audit-paged')

  await browser.close()
  console.log('\n全部断言通过')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
