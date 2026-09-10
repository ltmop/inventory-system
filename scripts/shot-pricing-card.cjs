// 定价建议卡渲染证据（决策层 MVP-2）· 用构建产物 dist/ 直接跑（base:'./'，无需 dev server）。
// 目的：证明 ReportsPage 的定价建议卡能渲染、无 pageerror、列与护栏文案正确。
// ⚠️ 卡内数据是「渲染夹具」（shape 与 buildPricing 输出一致），用于截图留档，不代表真实库数字。
// 真实库引擎输出见：node scripts/inv-analytics.mjs pricing --pretty
const { chromium } = require('playwright')
const path = require('path')

const FIXTURE = {
  generatedAt: new Date().toISOString(),
  dataWindowOk: true,
  basis: 'sales',
  totalCandidate: 3,
  byPriority: { P0: 1, P1: 1, P2: 1 },
  avgMarginPct: 17.0,
  skipped: { noCost: 2, noPrice: 0, clearance: 1, guardMove: 4, normal: 296 },
  thresholds: { minMargin: 0.15, maxMargin: 0.6, windowDays: 90, guardMoveDays: 30, range: { FLOOR: [1.05, 1.15], RAISE: [1.35, 1.6], CUT: [1.1, 1.25] } },
  note: '参考价取自近90天真实成交中位价（证据强）',
  items: [
    { id: 9001, name: 'PRC-A 亏本样例', category: '定价', stock: 10, unitCostYuan: 100, refPriceYuan: 80, refPriceSource: '近90天成交中位价', suggestPriceYuan: null, marginPct: -25, tiedCostYuan: 1000, lastSaleDaysAgo: 5, recentOut30: 1, priority: 'P0', action: '亏本在售：立即调价或停售', suggestRange: { low: 105, high: 115 }, tiers: [], reason: ['成交价低于成本 20 元', '参考价来源：近90天成交中位价'], guard: null },
    { id: 9002, name: 'PRC-B 毛利偏低样例', category: '定价', stock: 10, unitCostYuan: 100, refPriceYuan: 110, refPriceSource: '近90天成交中位价', suggestPriceYuan: null, marginPct: 9.09, tiedCostYuan: 1000, lastSaleDaysAgo: 5, recentOut30: 1, priority: 'P1', action: '毛利偏低：建议提价', suggestRange: { low: 135, high: 160 }, tiers: [], reason: ['毛利率 9.09%', '参考价来源：近90天成交中位价'], guard: null },
    { id: 9003, name: 'PRC-C 可降价样例', category: '定价', stock: 10, unitCostYuan: 100, refPriceYuan: 300, refPriceSource: '近90天成交中位价', suggestPriceYuan: null, marginPct: 66.67, tiedCostYuan: 1000, lastSaleDaysAgo: 45, recentOut30: 0, priority: 'P2', action: '毛利偏高且近30天无动销：可降价促动销', suggestRange: { low: 110, high: 125 }, tiers: [{ tier: 'wholesale', priceYuan: 50 }], reason: ['毛利率 66.67%', '参考价来源：近90天成交中位价', '45天无出库', '价格档「wholesale」50元 低于成本，需核对'], guard: null },
  ],
}

;(async () => {
  // 构建产物是 ES module 构建，file:// 会被 CORS 拦（模块加载失败）→ 必须走 http。
  // 用 `npx vite preview --port 4173` 起在独立端口（不影响任何现有服务），跑完即关。
  const url = (process.env.PRICING_URL || 'http://localhost:4173') + '/#/reports'
  const b = await chromium.launch({ channel: 'msedge' })
  const p = await b.newPage({ viewport: { width: 1500, height: 1400 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))

  // 在应用启动前注入 window.fi，让 React 首屏就能拿到 IPC 数据
  await p.addInitScript((fx) => {
    const noop = () => {}
    window.fi = window.fi || {}
    window.fi.invoke = (ch) => {
      if (ch === 'pricing:get') return Promise.resolve(fx)
      if (ch === 'clearance:get') return Promise.resolve({ items: [], totalCandidate: 0, recoverableCost: 0, byPriority: { P0: 0, P1: 0, P2: 0 } })
      if (ch === 'cloud:status') return Promise.resolve({ paired: false, username: null, lastSyncAt: null, lastBackupAt: null, syncing: false, error: null, viewUrl: null, needsRestore: false, pendingBackup: null })
      // 其余通道默认给「空数组」：store 的 loadAll 会对返回值直接 .filter/.map，给 {} 会 TypeError
      return Promise.resolve([])
    }
    window.fi.onUpdateAvailable = window.fi.onUpdateAvailable || noop
    window.fi.onUpdateNotAvailable = window.fi.onUpdateNotAvailable || noop
    window.fi.onUpdateProgress = window.fi.onUpdateProgress || noop
  }, FIXTURE)

  await p.goto(url, { waitUntil: 'load' }).catch(() => {})
  await p.waitForTimeout(2500)
  for (const t of ['知道了', '先用本机数据', '先不登录', '去入库补货']) {
    const btn = p.getByText(t, { exact: false })
    if (await btn.count()) { try { await btn.first().click(); await p.waitForTimeout(700) } catch (e) { /* ignore */ } }
  }
  await p.waitForTimeout(2000)

  const info = await p.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const title = all.filter((x) => (x.textContent || '').trim().startsWith('定价建议')).sort((a, c) => (a.textContent || '').length - (c.textContent || '').length)[0]
    if (!title) return { found: false, body: (document.body.innerText || '').slice(0, 300) }
    // 往上爬到「仍以标题开头」的最外层祖先 = 卡片根（不依赖 class 名，class 里可能根本没有 card）
    let card = title
    while (card.parentElement && (card.parentElement.textContent || '').trim().startsWith('定价建议')) card = card.parentElement
    const txt = card.innerText || ''
    return {
      found: true,
      cls: card.className,
      text: txt.slice(0, 500),
      rows: card.querySelectorAll('tbody tr').length,
      hasP0: txt.includes('P0 亏本'),
      hasRange: txt.includes('105.00') && txt.includes('115.00'),
      hasGuardReason: txt.includes('低于成本'),
      hasAction: txt.includes('可降价促动销'),
    }
  })
  console.log('PRICING CARD:', JSON.stringify(info, null, 2))
  console.log('pageerrors:', errors.length ? JSON.stringify(errors) : 'none')

  const handle = await p.evaluateHandle(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const title = all.filter((x) => (x.textContent || '').trim().startsWith('定价建议')).sort((a, c) => (a.textContent || '').length - (c.textContent || '').length)[0]
    let card = title
    while (card.parentElement && (card.parentElement.textContent || '').trim().startsWith('定价建议')) card = card.parentElement
    return card
  })
  try { await handle.asElement().screenshot({ path: path.resolve(__dirname, '../screenshots/pricing-card-mvp2.png') }) }
  catch (e) { await p.screenshot({ path: path.resolve(__dirname, '../screenshots/pricing-card-mvp2.png') }) }
  console.log('shot: screenshots/pricing-card-mvp2.png')
  await b.close()
  process.exit(info.found && info.rows === 3 && errors.length === 0 ? 0 : 1)
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })
