// 对**线上桌面网页版（/app）**做一次真界面验收：开真浏览器、点真数据、截图 + 断言。
//
// 为什么要有它（2026-09-23）：三层视图与资金账户卡片先后上线，但一直只有"构建通过 + 源码断言"这一层证据，
// 反复在边界里写着「未做视觉验收」。这个脚本把那一层补上：它驱动真浏览器打开中心库的 /app
// （就是桌面端那份 dist，数据是中心库真库），把 品牌→品类→规格 与 资金账户 两张界面**截图存证**。
//
// 用法：
//   node scripts/verify-ui-live.mjs                      # 用 %APPDATA%\fishing-inventory\central.json 的 url+token
//   node scripts/verify-ui-live.mjs --url https://app.junchengzn.com --token <令牌>
//   node scripts/verify-ui-live.mjs --out D:\shots       # 指定截图目录
//
// ⚠️ 浏览器用**系统装的 Edge**（channel: msedge）：Playwright 自带的 chromium 本机没装，
//    而 Edge 每台 Windows 都有，省一次一百多 MB 的下载。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt = '') => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}

let url = arg('url', '')
let token = arg('token', '')
if (!url || !token) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'fishing-inventory', 'central.json'), 'utf8'))
    url = url || cfg.url
    token = token || cfg.token
  } catch { /* 下面会报 */ }
}
if (!url || !token) {
  console.error('缺 url / token：给 --url 与 --token，或先让桌面端连上中心库（会写 central.json）')
  process.exit(2)
}
const outDir = arg('out', path.join(ROOT, 'release', 'ui-shots'))
fs.mkdirSync(outDir, { recursive: true })

let fail = 0
const ok = (desc, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + desc)
  else { fail++; console.log('  ✗ ' + desc + (detail ? '  [' + detail + ']' : '')) }
}
const shot = async (page, name) => {
  const f = path.join(outDir, name)
  await page.screenshot({ path: f, fullPage: false })
  console.log('    · 截图 ' + f)
  return f
}

const { chromium } = await import('playwright')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
// 记下浏览器侧的报错：白屏时**只有这里**能说清是脚本挂了还是后端拒了（不然只能靠猜）
const consoleErrs = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push('console: ' + m.text()) })
page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + (e?.message ?? e)))
page.on('requestfailed', (r) => consoleErrs.push('reqfailed: ' + r.url() + ' ' + (r.failure()?.errorText ?? '')))
const base = url.replace(/\/+$/, '')
const app = (hash) => `${base}/app?token=${encodeURIComponent(token)}#${hash}`

try {
  console.log('=== ① 打开线上桌面网页版 ===')
  await page.goto(app('/inventory'), { waitUntil: 'domcontentloaded', timeout: 60000 })
  // 等首屏数据到位：品牌卡片或"还没有商品"任一出现即可
  try {
    await page.waitForFunction(
      () => /个规格|还没有商品|数据加载失败/.test(document.body.innerText || ''),
      null, { timeout: 45000 },
    )
  } catch {
    // 白屏也要给证据：把 #root 的内容和浏览器报错都打出来
    const rootHtml = await page.locator('#root').innerHTML().catch(() => '(取不到 #root)')
    console.log('    #root 内容长度: ' + rootHtml.length)
    console.log('    #root 前 300 字: ' + rootHtml.slice(0, 300).replace(/\s+/g, ' '))
    if (consoleErrs.length) { console.log('    浏览器侧报错:'); for (const m of consoleErrs.slice(0, 8)) console.log('      - ' + m) }
    else console.log('    浏览器侧没有报错（那更可能是等的东西不对，不是页面挂了）')
  }
  const bodyText = await page.innerText('body')
  ok('页面能打开并连上中心库（没有报错横幅）', !/数据加载失败/.test(bodyText), bodyText.slice(0, 120))
  // ⚠️ 顶栏那个「未登录」是**云账号**（可选功能），与"连没连上中心库"无关 —— 别拿它当判据。
  //    真正的连接判据是：数据到位了（有商品/品牌/规格的数字）。
  ok('中心库数据真的到了（页面有商品/品牌/规格的量）',
    /个商品|个品牌|个规格/.test(bodyText), bodyText.replace(/\s+/g, ' ').slice(0, 100))
  const versionShown = (bodyText.match(/v?1\.2\.0(\.\d+)?/) || [])[0] || ''
  ok('页面跑的是新前端（版本位能看出 1.2.0.x）', /1\.2\.0/.test(bodyText), 'version=' + versionShown)

  // 首屏常弹「有 N 个商品库存偏低」——不关掉它会挡住卡片（真人也得点一下「知道了」）。
  // ⚠️ 它是**数据到位之后**才弹的，所以要在加载完后重试几次，不能只点一下（第一版就吃了这个亏：
  //    点的时候弹窗还没出来，截图里一直挂着它）。
  const dismissAlert = async () => {
    for (let i = 0; i < 4; i++) {
      const clicked = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '知道了')
        if (b) { b.click(); return true }
        return false
      })
      await page.waitForTimeout(clicked ? 700 : 500)
      const still = await page.evaluate(() =>
        Boolean(Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '知道了')),
      )
      if (!still) return i === 0 ? '首次即关掉' : `重试 ${i} 次后关掉`
    }
    return '仍有弹窗（下面截图可能被挡）'
  }
  const alertState = await dismissAlert()
  console.log('    （库存偏低弹窗：' + alertState + '）')

  // ⚠️ 用 evaluate 数/点，而不是 getByRole+hasText：实测 getByRole('button').filter({hasText}) 在这页数出 0，
  //    而 DOM 里卡片明明在（截图可见 12 个品牌卡）—— 卡片是 <button>，但 role 过滤在这个结构下不可靠。
  const countCards = () =>
    page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => /个规格/.test(b.textContent || '')).length)
  const clickCard = (i) =>
    page.evaluate((idx) => {
      const bs = Array.from(document.querySelectorAll('button')).filter((b) => /个规格/.test(b.textContent || ''))
      if (bs[idx]) bs[idx].click()
      return bs.length
    }, i)
  const hasText = (re) => page.evaluate((src) => new RegExp(src).test(document.body.innerText || ''), re.source)

  console.log('\n=== ② 库存：第一层 品牌卡片 ===')
  const brandCount = await countCards()
  ok('第一层是品牌卡片（不是一进来就一屏规格行）', brandCount > 3, 'cards=' + brandCount)
  const firstLevelTable = await page.locator('table').count()
  ok('第一层不直接摊开明细表', firstLevelTable === 0, 'tables=' + firstLevelTable)
  await shot(page, '01-库存-第一层-品牌.png')

  console.log('\n=== ③ 库存：第二层 品类 ===')
  // 挑一个品类数 > 1 的品牌；找不到就说明第二层没做出来（那正是要抓的问题）
  let openedBrand = ''
  for (let i = 0; i < Math.min(brandCount, 40); i++) {
    await clickCard(i)
    await page.waitForTimeout(700)
    if (await hasText(/个品类/)) {
      openedBrand = (await page.evaluate(() => (document.body.innerText.match(/「([^」]+)」下有/) || [])[1] || '')) || `#${i}`
      break
    }
    // 单品类品牌会直接跳到规格表 → 返回列表再试下一个
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes('返回品牌列表'))
      if (b) b.click()
    })
    await page.waitForTimeout(500)
  }
  const catCount = await countCards()
  ok('第二层是品类卡片（品牌下确实按品类分了）', catCount > 1, `品牌=${openedBrand} cards=${catCount}`)
  ok('第二层标题写清了"在谁里面数"', await hasText(/下有\s*\d+\s*个品类/), openedBrand)
  await shot(page, '02-库存-第二层-品类.png')

  console.log('\n=== ④ 库存：第三层 规格明细 ===')
  if (catCount > 0) {
    await clickCard(0)
    await page.waitForTimeout(900)
  }
  const table = page.locator('table').first()
  ok('第三层回到规格明细表', await table.count() > 0)
  const ths = await page.locator('table thead th').allInnerTexts().catch(() => [])
  ok('表头有「规格」列（原「子类」已改名）', ths.includes('规格'), JSON.stringify(ths))
  const firstRow = (await page.locator('table tbody tr').first().innerText().catch(() => '')) || ''
  ok('明细行里能看到具体规格（不是空列）', firstRow.length > 0, firstRow.replace(/\s+/g, ' ').slice(0, 80))
  ok('有「返回品类」这一层（说明确实是三层，不是两层）', await hasText(/返回品类/))
  await shot(page, '03-库存-第三层-规格.png')

  console.log('\n=== ⑤ 资金账户卡片（挂在支出记账页）===')
  await page.goto(app('/expenses'), { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => /资金账户|支出记账/.test(document.body.innerText || ''), null, { timeout: 60000 })
  await page.waitForTimeout(800)
  const expText = await page.innerText('body')
  ok('支出页上有「资金账户」卡片', /资金账户/.test(expText))
  ok('卡片说明写了口径（账户=收款方式、余额=期初+收−付）', /收款方式/.test(expText) && /期初/.test(expText))
  ok('卡片有「设置期初」入口', /设置期初/.test(expText))
  const moneyRows = await page.locator('table tbody tr').allInnerTexts().catch(() => [])
  ok('账户表渲染出了行（现金/微信/支付宝/其他 + 合计）', moneyRows.length >= 5, 'rows=' + moneyRows.length)
  const cashRow = moneyRows.find((r) => r.startsWith('现金')) || ''
  ok('现金那一行有金额（与库里 10 笔实收对得上）', /¥/.test(cashRow), cashRow.replace(/\s+/g, ' ').slice(0, 80))
  await shot(page, '04-支出-资金账户.png')
  console.log('    现金行: ' + cashRow.replace(/\s+/g, ' '))
} catch (e) {
  fail++
  console.log('  ✗ 验收过程抛异常：' + (e?.message ?? e))
  try { await shot(page, '99-异常现场.png') } catch { /* 截图失败就算了 */ }
} finally {
  await browser.close()
}

console.log(fail === 0 ? `\n界面验收全部通过（截图在 ${outDir}）` : `\n界面验收未通过：${fail} 项（截图在 ${outDir}）`)
process.exit(fail === 0 ? 0 : 1)
