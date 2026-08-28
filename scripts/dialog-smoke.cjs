const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const prep = async (route) => {
    await page.goto(`http://localhost:5173${route}`, { waitUntil: 'networkidle' })
    await page.mouse.click(720, 450).catch(() => {})
    await page.waitForTimeout(1200)
    const k = page.locator('button', { hasText: '知道了' })
    if (await k.count()) { await k.first().click().catch(() => {}); await page.waitForTimeout(300) }
  }
  const shot = async (name) => { await page.screenshot({ path: `../screenshots/refactor-after-${name}.png` }); console.log('shot:', name) }

  // 供应商对账弹窗（含分页条）
  await prep('/#/suppliers')
  await page.locator('button', { hasText: '对账' }).first().click()
  await page.waitForTimeout(800)
  await shot('dialog-supplier-statement')
  await page.keyboard.press('Escape')

  // 客户详情弹窗
  await prep('/#/customers')
  await page.locator('button', { hasText: '老王' }).first().click()
  await page.waitForTimeout(800)
  await shot('dialog-customer-detail')
  await page.keyboard.press('Escape')

  // 库存编辑弹窗
  await prep('/#/inventory')
  await page.locator('button[title="编辑商品"]').first().click()
  await page.waitForTimeout(500)
  await shot('dialog-inventory-edit')
  await page.keyboard.press('Escape')

  // 出库退货弹窗
  await prep('/#/outbound')
  await page.locator('button', { hasText: '退货登记' }).first().click()
  await page.waitForTimeout(500)
  await shot('dialog-outbound-return')
  await page.keyboard.press('Escape')

  // 出库换货弹窗
  await page.locator('button', { hasText: '换货登记' }).first().click()
  await page.waitForTimeout(500)
  await shot('dialog-outbound-exchange')
  await page.keyboard.press('Escape')

  // 采购详情弹窗
  await prep('/#/purchase')
  await page.locator('tr', { hasText: 'PO20260730-001' }).first().click()
  await page.waitForTimeout(800)
  await shot('dialog-purchase-detail')

  await browser.close()
  console.log('done')
})().catch((e) => { console.error(e); process.exit(1) })
