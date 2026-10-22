// 首屏 CTA 的视口自适应 + 两个入口的埋点，用**真实浏览器**验证。
//
// 为什么不用静态断言：这次改的正是"窄屏渲染出来是什么"，而 CSS 媒体查询有没有生效、
// 两个按钮会不会同时出现、点下去埋点有没有真的发出去 —— 只有渲染出来才知道。
// 用本机已装的 Edge（playwright 的 chromium 内核没下载，也没必要下载）。
//
// 用法：node scripts/verify-mobile-cta.mjs
// 输出全 ASCII：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK，中文断言值会失效。
import { chromium } from 'playwright'

const SITE = 'https://junchengzn.com/'
let pass = 0, fail = 0
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log('  PASS  ' + n) }
  else { fail++; console.log('  FAIL  ' + n + (extra ? '  <- ' + extra : '')) }
}

let browser
try {
  browser = await chromium.launch({ channel: 'msedge' })
} catch (e) {
  console.log('无法启动 Edge：' + e.message)
  console.log('（跳过，不算失败 —— 但这次就没验证到渲染）')
  process.exit(0)
}

/** 打开首页并捕获所有 /api/hit 上报；中途不真的下载安装包 */
async function visit(ctxOpts, url = SITE) {
  const ctx = await browser.newContext(ctxOpts)
  const page = await ctx.newPage()
  const hits = []
  page.on('request', (r) => { if (r.url().includes('/api/hit')) hits.push(r.postData() || '') })
  // 别在测试里真拉 119MB / 3.8MB 的包
  await page.route('**/dl/**', (r) => r.abort())
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(400)
  return { ctx, page, hits }
}

console.log('=== A. 手机视口 390x844 ===')
{
  const { ctx, page, hits } = await visit({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  })
  const m = page.locator('.cta-mobile').first()
  const d = page.locator('.cta-desktop').first()
  ok('手机视口：手机版 CTA 可见', await m.isVisible())
  ok('手机视口：Windows CTA 已隐藏（手机装了也用不上）', !(await d.isVisible()))
  ok('手机版 CTA 指向 /dl/app.apk', (await m.getAttribute('href')) === '/dl/app.apk', await m.getAttribute('href'))
  ok('手机版 CTA 文案带「安卓」（诚实标注，iOS 装不了）',
    ((await m.textContent()) || '').includes('安卓'), (await m.textContent()) || '')
  await page.click('.cta-mobile')
  await page.waitForTimeout(1000)
  ok('点手机版 CTA 上报 e=mobile（这条规则以前是死的）',
    hits.some((h) => h.includes('"mobile"')), JSON.stringify(hits))
  ok('同一次访问也上报了 view', hits.some((h) => h.includes('"view"')))
  await ctx.close()
}

console.log('=== B. 桌面视口 1440x900 ===')
{
  const { ctx, page, hits } = await visit({ viewport: { width: 1440, height: 900 } })
  const m = page.locator('.cta-mobile').first()
  const d = page.locator('.cta-desktop').first()
  ok('桌面视口：Windows CTA 可见', await d.isVisible())
  ok('桌面视口：手机版 CTA 已隐藏', !(await m.isVisible()))
  ok('Windows CTA 仍指向 /download/', (await d.getAttribute('href')) === '/download/', await d.getAttribute('href'))
  await page.click('.cta-desktop')
  await page.waitForTimeout(1200)
  ok('点 Windows CTA 上报 e=to-download', hits.some((h) => h.includes('"to-download"')), JSON.stringify(hits))
  await ctx.close()
}

console.log('=== C. 窄屏不该把两套 CTA 同时显示 ===')
{
  const { ctx, page } = await visit({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true })
  const visibleMobile = await page.locator('.cta-mobile:visible').count()
  const visibleDesktop = await page.locator('.cta-desktop:visible').count()
  ok('375px 下手机 CTA 恰好一组可见', visibleMobile === 2, 'visible=' + visibleMobile)
  ok('375px 下 Windows CTA 一个都不可见', visibleDesktop === 0, 'visible=' + visibleDesktop)
  await ctx.close()
}

console.log('=== D. /start/ 上手说明页（手机视口）===')
{
  const { ctx, page } = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'https://junchengzn.com/start/',
  )
  ok('/start/ 能打开且有 h1', await page.locator('h1').first().isVisible())
  ok('/start/ 有 12 个问题（h3 计数）', (await page.locator('h3').count()) === 12,
    'h3=' + (await page.locator('h3').count()))
  ok('/start/ 桌面下载 CTA 可见', await page.locator('a[href="/download/"]').first().isVisible())
  ok('/start/ 手机版 CTA 可见', await page.locator('a[href="/dl/app.apk"]').first().isVisible())
  ok('/start/ 微信 CTA 可见', await page.locator('a[href="/weixin.html"]').first().isVisible())
  await ctx.close()
}

console.log('=== E. /weixin.html 落地页（手机视口）===')
{
  const { ctx, page } = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'https://junchengzn.com/weixin.html',
  )
  const qr = page.locator('img.qr').first()
  ok('二维码图片渲染出来', await qr.isVisible())
  const box = await qr.boundingBox()
  ok('二维码宽度不超出手机屏（<= 390px）', !!box && box.width <= 390, JSON.stringify(box))
  ok('页面上有通往 /start/ 的链接', await page.locator('a[href="/start/"]').first().isVisible())
  ok('页面上有下载入口', await page.locator('a[href="/download/"]').first().isVisible())
  await ctx.close()
}

console.log('=== F. /guides/ 开店指南（手机视口）===')
{
  const { ctx, page } = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'https://junchengzn.com/guides/',
  )
  ok('/guides/ 能打开且有 h1', await page.locator('h1').first().isVisible())
  ok('/guides/ 两个入口都可见',
    (await page.locator('a[href="/guides/free-inventory-software.html"]').first().isVisible()) &&
    (await page.locator('a[href="/guides/supermarket-inventory.html"]').first().isVisible()))
  await ctx.close()

  const g = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'https://junchengzn.com/guides/free-inventory-software.html',
  )
  const h2 = await g.page.locator('h2').count()
  ok('指南页正文有实质结构（h2 >= 5）', h2 >= 5, 'h2=' + h2)
  ok('指南页手机端能看到下载 CTA', await g.page.locator('a[href="/download/"]').first().isVisible())
  // 注意：窄屏下导航被收进汉堡菜单，a[href="/start/"] 的第一条是**隐藏的**导航项。
  // 所以不能用 .first().isVisible()，要问"至少有一条可见"。
  const startLinks = await g.page.locator('a[href="/start/"]:visible').count()
  ok('指南页有回链到 /start/', startLinks >= 1, 'visible links=' + startLinks)
  await g.ctx.close()
}

console.log('=== G. 下载页真实截图（手机视口）===')
{
  const { ctx, page } = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'https://junchengzn.com/download/',
  )
  await page.locator('#screens').scrollIntoViewIfNeeded()
  await page.waitForTimeout(3000)   // images are loading="lazy"
  const imgs = page.locator('#screens img')
  const n = await imgs.count()
  ok('下载页有 3 张产品截图', n === 3, 'count=' + n)
  let loaded = 0
  for (let i = 0; i < n; i++) {
    const w = await imgs.nth(i).evaluate((e) => e.naturalWidth)
    if (w > 0) loaded++
  }
  ok('三张图都真的加载出来（naturalWidth > 0）', loaded === 3, 'loaded=' + loaded)
  let overflow = 0
  for (let i = 0; i < n; i++) {
    const b = await imgs.nth(i).boundingBox()
    if (b && b.width > 391) overflow++
  }
  ok('手机上截图不横向溢出', overflow === 0, 'overflow=' + overflow)
  const cols = await page.locator('#screens .p-screens').evaluate((e) => getComputedStyle(e).gridTemplateColumns)
  ok('手机下截图栅格收成一列', (cols.match(/px/g) || []).length <= 1, 'cols=' + cols)
  await ctx.close()
}

console.log('=== H. 下载页真实截图（桌面视口）===')
{
  const { ctx, page } = await visit({ viewport: { width: 1440, height: 900 } }, 'https://junchengzn.com/download/')
  await page.locator('#screens').scrollIntoViewIfNeeded()
  await page.waitForTimeout(3000)
  const imgs = page.locator('#screens img')
  let loaded = 0
  const n = await imgs.count()
  for (let i = 0; i < n; i++) {
    const w = await imgs.nth(i).evaluate((e) => e.naturalWidth)
    if (w > 0) loaded++
  }
  ok('桌面下三张图都加载', loaded === 3, 'loaded=' + loaded)
  const cols = await page.locator('#screens .p-screens').evaluate((e) => getComputedStyle(e).gridTemplateColumns)
  ok('桌面下截图排成三列', (cols.match(/px/g) || []).length === 3, 'cols=' + cols)
  await ctx.close()
}

console.log('=== I. /projects/ 公司开发项目 ===')
{
  const { ctx, page } = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    'https://junchengzn.com/projects/',
  )
  ok('/projects/ 能打开且有 h1', await page.locator('h1').first().isVisible())
  ok('/projects/ 两张项目卡都在', (await page.locator('.p-case').count()) === 2,
    'count=' + (await page.locator('.p-case').count()))
  ok('/projects/ 有通往驾驶舱源码的外链',
    await page.locator('a[href="https://github.com/ltmop/ceo-cockpit"]').first().isVisible())
  ok('/projects/ 有通往进销存源码的外链',
    await page.locator('a[href="https://github.com/ltmop/inventory-system"]').first().isVisible())
  // 窄屏下导航被收进汉堡菜单，而 /download/ 这个 href 在导航里也有一份 ——
  // 用 .first().isVisible() 会命中那条隐藏的导航项。必须问"至少有一条可见"。
  const dlVisible = await page.locator('a[href="/download/"]:visible').count()
  ok('/projects/ 有下载 CTA', dlVisible >= 1, 'visible links=' + dlVisible)
  const cols = await page.locator('.p-case-grid').evaluate((e) => getComputedStyle(e).gridTemplateColumns)
  ok('手机下项目卡收成一列', (cols.match(/px/g) || []).length <= 1, 'cols=' + cols)
  await ctx.close()
}

console.log('=== J. 首页导航新增「项目」 ===')
{
  const { ctx, page } = await visit({ viewport: { width: 1440, height: 900 } }, 'https://junchengzn.com/')
  ok('桌面导航里有「项目」且可见', await page.locator('.nav-links a[href="/projects/"]').first().isVisible())
  const rights = await page.locator('.nav-links a').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))
  ok('导航没溢出视口（最右项 <= 1440）', Math.max(...rights) <= 1440, 'maxRight=' + Math.round(Math.max(...rights)))
  ok('页脚有「公司开发项目」入口', await page.locator('.footer-contact a[href="/projects/"]').first().isVisible())
  await ctx.close()
}

console.log('=== K. 首屏品牌与排版（2026-09-25 修的三件事）===')
{
  // 手机视口（B/C 流量的落点）
  const m = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'https://junchengzn.com/',
  )
  ok('手机：首屏出现公司名品牌锁形', await m.page.locator('.hero-brand').first().isVisible())
  ok('手机：品牌 LOGO 真的加载出来',
    (await m.page.locator('.hero-brand-mark').first().evaluate((e) => e.naturalWidth)) > 0)
  const navTops = await m.page.locator('.nav-links a')
    .evaluateAll((es) => [...new Set(es.map((e) => Math.round(e.getBoundingClientRect().top)))])
  ok('手机：导航项都在同一行（原来会挤成两行）', navTops.length === 1, 'tops=' + JSON.stringify(navTops))
  const navH = await m.page.locator('.nav').first().evaluate((e) => e.getBoundingClientRect().height)
  ok('手机：导航高度 <= 64px（两行时会到 ~80px）', navH <= 64, 'navH=' + Math.round(navH))
  const titleH = await m.page.locator('.hero-title').first().evaluate((e) => e.getBoundingClientRect().height)
  ok('手机：主标题 <= 2 行（原来「脑」被甩到第 3 行）', titleH <= 100, 'titleH=' + Math.round(titleH))
  await m.ctx.close()

  // 桌面视口
  const d = await visit({ viewport: { width: 1440, height: 900 } }, 'https://junchengzn.com/')
  ok('桌面：品牌锁形在首屏', await d.page.locator('.hero-brand').first().isVisible())
  const cols = await d.page.locator('.hero-inner').evaluate((e) => getComputedStyle(e).gridTemplateColumns)
  ok('桌面：首屏是两栏（右半边不再空着）', (cols.match(/px/g) || []).length === 2, 'cols=' + cols)
  // 首屏右栏已从「CEO COCKPIT 卡」换成自家产品截图（2026-09-25），这里改校验截图
  const shotClipped = await d.page.locator('.hero-shot').first()
    .evaluate((e) => e.getBoundingClientRect().bottom > window.innerHeight)
  ok('桌面：首屏产品截图不被首屏下沿切掉', shotClipped === false)
  const dTitleH = await d.page.locator('.hero-title').first().evaluate((e) => e.getBoundingClientRect().height)
  ok('桌面：主标题 <= 2 行（两栏下标题必须跟着缩小）', dTitleH <= 140, 'titleH=' + Math.round(dTitleH))
  await d.ctx.close()
}

console.log('=== L. favicon 已换成公司 LOGO（透明底）===')
{
  // 首页与一个子页都要指向 LOGO，且那个 PNG 真能加载（不是死链）
  for (const [label, url] of [['首页', 'https://junchengzn.com/'], ['子页 /projects/', 'https://junchengzn.com/projects/']]) {
    const { ctx, page } = await visit({ viewport: { width: 1280, height: 900 } }, url)
    const href = await page.locator('link[rel="icon"]').first().getAttribute('href')
    ok(label + ' 的 favicon 指向 LOGO 资源', !!href && href.includes('brand/favicon-logo'), String(href))
    // 直接按页面解析后的绝对地址取那张图，确认 200 且能解码
    const abs = new URL(href, url).href
    const img = await page.evaluate((u) => new Promise((res) => {
      const i = new Image()
      i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight })
      i.onerror = () => res({ w: 0, h: 0 })
      i.src = u
    }), abs)
    ok(label + ' 的 favicon 图片能加载', img.w > 0 && img.h > 0, JSON.stringify(img))
    await ctx.close()
  }
  // 首页那条约 237 字符的内联 data-URI 黑洞图标应当已经消失
  const { ctx, page } = await visit({ viewport: { width: 1280, height: 900 } }, 'https://junchengzn.com/')
  const hasInlineData = (await page.content()).includes('data:image/svg+xml,<svg')
  ok('首页不再使用内联 data-URI 图标', hasInlineData === false)
  await ctx.close()
}

console.log('=== M. 首屏重点 + 全页留白（2026-09-25 修的两个问题）===')
{
  const { ctx, page } = await visit({ viewport: { width: 1440, height: 900 } }, 'https://junchengzn.com/')

  // ① 首屏说的是什么就给他看什么：不能再出现"标题讲进销存、右栏是驾驶舱"
  const shot = page.locator('.hero-shot img').first()
  const sw = await shot.evaluate((e) => e.naturalWidth)
  ok('首屏右栏是自家进销存的产品截图', sw > 0, 'naturalWidth=' + sw)
  ok('首屏不再出现「CEO COCKPIT」卡（避免第一屏两个产品并列）',
    (await page.locator('.hero .cockpit').count()) === 0)
  const ptCount = await page.locator('.hero-points li').count()
  ok('首屏有三条具体卖点', ptCount >= 3, 'count=' + ptCount)
  ok('桌面：「进入黑洞」没有压住卖点', await page.evaluate(() => {
    const a = document.querySelector('.hero-enter')?.getBoundingClientRect()
    const b = document.querySelector('.hero-points')?.getBoundingClientRect()
    if (!a || !b) return true
    return !(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
  }))

  // ② 首页必须能走到三个产品详情页（原先两张卡是死的，/products/* 从首页不可达）
  for (const [name, href] of [
    ['进销存', '/products/inventory.html'],
    ['驾驶舱', '/products/cockpit.html'],
    ['数据台', '/products/minidb.html'],
  ]) {
    ok('首页能走到「' + name + '」详情页', (await page.locator('a[href="' + href + '"]').count()) >= 1)
  }

  // ③ 留白不能再涨回去：段间距是 clamp(64px, 9vh, 104px)，整页高度设上限
  const pad = await page.locator('section.section').first()
    .evaluate((e) => parseFloat(getComputedStyle(e).paddingTop))
  ok('桌面段间距已收紧（<= 110px，改前 162px）', pad <= 110, 'paddingTop=' + Math.round(pad))
  const docH = await page.evaluate(() => document.documentElement.scrollHeight)
  ok('桌面整页 <= 5000px（改前 5183px）', docH <= 5000, 'docH=' + docH)
  await ctx.close()

  const m = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'https://junchengzn.com/',
  )
  const mPad = await m.page.locator('section.section').first()
    .evaluate((e) => parseFloat(getComputedStyle(e).paddingTop))
  ok('手机段间距已收紧（<= 80px，改前 118px）', mPad <= 80, 'paddingTop=' + Math.round(mPad))
  const mDocH = await m.page.evaluate(() => document.documentElement.scrollHeight)
  ok('手机整页 <= 7100px（改前 7137px）', mDocH <= 7100, 'docH=' + mDocH)
  ok('手机：「进入黑洞」回到文档流，不压卖点', await m.page.evaluate(() => {
    const a = document.querySelector('.hero-enter')?.getBoundingClientRect()
    const b = document.querySelector('.hero-points')?.getBoundingClientRect()
    if (!a || !b) return true
    return !(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
  }))
  await m.ctx.close()
}

console.log('=== N. 手机端空间压缩（2026-09-25 v4）===')
{
  const m = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'https://junchengzn.com/',
  )
  const colCount = (sel) => m.page.locator(sel).first()
    .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)

  // 四宫格改 2×2 是这次压高度的主力（1×4 单列堆叠占了 about/business/data 三段的一大半）
  ok('手机：企业数据四宫格排成 2 列', (await colCount('#about .about-facts')) === 2,
    'cols=' + (await colCount('#about .about-facts')))
  ok('手机：业务四宫格排成 2 列', (await colCount('#business .card-grid')) === 2,
    'cols=' + (await colCount('#business .card-grid')))
  ok('手机：数字四宫格排成 2 列', (await colCount('#data .data-grid')) === 2,
    'cols=' + (await colCount('#data .data-grid')))

  const kmb = await m.page.locator('.kicker').first().evaluate((e) => parseFloat(getComputedStyle(e).marginBottom))
  ok('手机：kicker 下距已收紧（<=14px，改前 22px）', kmb <= 14, 'mb=' + Math.round(kmb))
  const tmb = await m.page.locator('.section-title').first().evaluate((e) => parseFloat(getComputedStyle(e).marginBottom))
  ok('手机：标题下距已收紧（<=26px，改前 40px）', tmb <= 26, 'mb=' + Math.round(tmb))

  const docH = await m.page.evaluate(() => document.documentElement.scrollHeight)
  ok('手机整页 <= 5800px（改前 6761px）', docH <= 5800, 'docH=' + docH)
  await m.ctx.close()

  // 极窄机器必须回落单列，否则字被挤成一条
  const n = await visit(
    { viewport: { width: 320, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'https://junchengzn.com/',
  )
  const narrow = await n.page.locator('#data .data-grid').first()
    .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)
  ok('320px 窄屏：四宫格回落到单列（<=360px 规则生效）', narrow === 1, 'cols=' + narrow)
  await n.ctx.close()

  // 桌面不能被连带改掉
  const d = await visit({ viewport: { width: 1440, height: 900 } }, 'https://junchengzn.com/')
  const dCols = await d.page.locator('#about .about-facts').first()
    .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)
  ok('桌面不受影响：about-facts 仍是 4 列', dCols === 4, 'cols=' + dCols)
  await d.ctx.close()
}

console.log('=== O. 页脚手机适配 + 第二处 18vh（2026-09-25 v5）===')
{
  const m = await visit(
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    'https://junchengzn.com/',
  )
  // 改前：.footer-contact 是 flex 单行，5 条联系方式挤在 390px 里，
  // 每项被压成 159px 高、文字每行两三个字。现在应竖排且每项约 23px。
  const items = await m.page.locator('.footer-contact > *').evaluateAll((els) =>
    els.map((e) => ({ top: Math.round(e.getBoundingClientRect().top), h: Math.round(e.getBoundingClientRect().height) })))
  ok('手机：页脚 5 条联系方式各自独占一行', new Set(items.map((i) => i.top)).size === items.length,
    'tops=' + JSON.stringify(items.map((i) => i.top)))
  ok('手机：每条联系方式高度正常（<=40px，改前 159px）', items.every((i) => i.h <= 40),
    'heights=' + JSON.stringify(items.map((i) => i.h)))
  const fm = await m.page.locator('footer.footer').evaluate((e) => Math.round(parseFloat(getComputedStyle(e).marginTop)))
  ok('手机：页脚 margin-top 已收紧（<=80px，改前 152px）', fm <= 80, 'marginTop=' + fm)
  const brandDir = await m.page.locator('.footer-brand').evaluate((e) => getComputedStyle(e).flexDirection)
  ok('手机：页脚品牌区改为竖排', brandDir === 'column', 'flexDirection=' + brandDir)
  const docH = await m.page.evaluate(() => document.documentElement.scrollHeight)
  ok('手机整页 <= 5600px（改前 6761px，最初 7137px）', docH <= 5600, 'docH=' + docH)
  await m.ctx.close()

  const d = await visit({ viewport: { width: 1440, height: 900 } }, 'https://junchengzn.com/')
  const dfm = await d.page.locator('footer.footer').evaluate((e) => Math.round(parseFloat(getComputedStyle(e).marginTop)))
  ok('桌面：页脚 margin-top 也不再是 18vh（<=100px，改前 162px）', dfm <= 100, 'marginTop=' + dfm)
  await d.ctx.close()
}

await browser.close()
console.log('')
console.log('================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
