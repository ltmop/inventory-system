// 真机实测：**本次构建的前端** + **真实看店服务（真库 324 商品）**，验证「子类」看得见/搜得到。
//
// 【为什么要自己起个代理】真机看店服务（127.0.0.1:17532）**不发 CORS 头**：
//   实测 OPTIONS /api/invoke → 405，POST 响应里没有 access-control-allow-origin。
//   所以浏览器页面跨源直连它会被拦。这里让页面与 /api 同源：
//   本脚本既伺服 dist/ 静态文件，又把 /api/invoke 原样转发给真机服务（带上真 token）。
//   → 页面同源、无 CORS 问题；后端仍是**真的**（真 SQLite、324 个商品），不是桩。
//
// 【为什么不用运行中的桌面窗口】那个窗口跑的是已发布的 1.0.14 旧包，验不了本次改动。
//   这里用 dist/（刚构建的新前端）+ 真后端，才能同时证明"新代码"与"真数据"。
//
// 【只读】全程只调 data:loadAll + 前端本地筛选；不点保存/删除，不写任何数据。
//
// 跑法：
//   $env:LAN_TOKEN = (Get-Content "$env:APPDATA\fishing-inventory\server-token.txt" -Raw).Trim()
//   node scripts/verify-subcategory-real.cjs
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const DIST = path.resolve(__dirname, '..', 'dist')
const UPSTREAM = process.env.LAN_UPSTREAM || 'http://127.0.0.1:17532'
const TOKEN = process.env.LAN_TOKEN || ''

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return true }
  fail++
  console.log('  ✗ ' + name + (extra !== undefined ? '\n      → ' + extra : ''))
  return false
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json',
}

if (!TOKEN) { console.log('缺 LAN_TOKEN 环境变量'); process.exit(2) }
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('缺 dist/index.html，先跑 npm run build'); process.exit(2) }

let proxied = 0
const server = http.createServer((req, res) => {
  // —— /api/invoke 原样转发给真机服务（同源的关键）——
  if (req.url.startsWith('/api/')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      proxied++
      try {
        const up = await fetch(UPSTREAM + req.url, {
          method: req.method,
          headers: { 'content-type': 'application/json', 'x-token': TOKEN },
          body: req.method === 'POST' ? body : undefined,
        })
        const text = await up.text()
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json; charset=utf-8' })
        res.end(text)
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'proxy: ' + e.message }))
      }
    })
    return
  }
  // —— 静态文件（SPA：找不到就给 index.html）——
  let rel = decodeURIComponent(req.url.split('?')[0])
  if (rel === '/') rel = '/index.html'
  let file = path.join(DIST, rel)
  if (!file.startsWith(DIST)) file = path.join(DIST, 'index.html')
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

;(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  console.log('伺服本次构建 dist/ ：' + base)
  console.log('转发 /api/invoke →：' + UPSTREAM + '（真库）')
  console.log('')

  const b = await chromium.launch({ channel: 'msedge' })
  const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))

  // 局域网/主机模式：api.ts 在无 window.fi 时读 fi-lan-token → createHttpBackend(同源)
  await p.addInitScript(({ t }) => {
    localStorage.setItem('fi-lan-token', t)
    localStorage.setItem('fi-cloud-guest', '1')
    localStorage.removeItem('fi-central-url')
  }, { t: TOKEN })

  await p.goto(base + '/#/inventory', { waitUntil: 'load' }).catch(() => {})
  await p.waitForTimeout(3000)

  const DISMISS = ['跳过引导，直接进入系统', '先保留演示数据，稍后再说', '知道了', '先不登录，直接用', '先用本机数据', '看步骤就够了，继续', '下一步']
  for (let i = 0; i < 12; i++) {
    const overlay = await p.evaluate(() => Array.from(document.querySelectorAll('div')).some((d) => (d.className || '').toString().includes('fixed inset-0 z-50')))
    if (!overlay) break
    await p.evaluate((labels) => {
      const bs = Array.from(document.querySelectorAll('button'))
      for (const lab of labels) { const btn = bs.find((x) => (x.textContent || '').includes(lab)); if (btn) { btn.click(); return } }
    }, DISMISS)
    await p.waitForTimeout(600)
  }
  await p.waitForTimeout(1200)
  // 引导可能把路由推走，回库存页
  await p.evaluate(() => { if (location.hash !== '#/inventory') location.hash = '#/inventory' })
  await p.waitForTimeout(2000)

  const head = await p.evaluate(() => ({
    hash: location.hash,
    ths: Array.from(document.querySelectorAll('th')).map((t) => (t.textContent || '').trim()),
    snippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  }))
  console.log('  当前 hash=' + head.hash)
  console.log('  表头: ' + JSON.stringify(head.ths))
  if (errs.length) console.log('  页面错误: ' + JSON.stringify(errs.slice(0, 3)))

  ok('代理真的转发到了真机服务（请求数 > 0）', proxied > 0, 'proxied=' + proxied)
  ok('库存查询表头出现「子类」列', head.ths.includes('子类'), JSON.stringify(head.ths))

  const colIdx = head.ths.indexOf('子类')
  const grid = await p.evaluate((i) => {
    const th = document.querySelectorAll('th').length
    const rows = Array.from(document.querySelectorAll('tbody tr'))
      .map((tr) => Array.from(tr.querySelectorAll('td')))
      .filter((tds) => tds.length === th)
    const vals = rows.map((tds) => (tds[i]?.textContent || '').trim())
    return { rowCount: rows.length, vals, filled: vals.filter((v) => v && v !== '—').length }
  }, colIdx)
  console.log('  首屏商品行 ' + grid.rowCount + '，子类非空 ' + grid.filled + ' → ' + JSON.stringify(grid.vals.slice(0, 6)))
  ok('首屏有商品行渲染出来', grid.rowCount > 0, 'rows=' + grid.rowCount)
  ok('首屏至少一行显示了真实子类值（不是占位 —）', grid.filled > 0, 'filled=' + grid.filled)

  // ───────── 关键词搜索：用一个只可能出现在子类里的片段 ─────────
  const input = p.locator('input[placeholder*="子类"]')
  ok('搜索框提示语已含「子类」（本次改动的可见证据）', (await input.count()) > 0)
  await p.evaluate(() => {
    const el = Array.from(document.querySelectorAll('input')).find((x) => (x.placeholder || '').includes('子类'))
    if (!el) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '粗弯倒刺')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await p.waitForTimeout(1600)
  const after = await p.evaluate(() => {
    const txt = document.body.innerText || ''
    const m = txt.match(/共\s*(\d+)\s*个商品/)
    const th = document.querySelectorAll('th').length
    const rows = Array.from(document.querySelectorAll('tbody tr'))
      .map((tr) => Array.from(tr.querySelectorAll('td')))
      .filter((tds) => tds.length === th)
    return { count: m ? Number(m[1]) : null, rows: rows.length, hit: txt.includes('粗弯倒刺') }
  })
  console.log('  搜「粗弯倒刺」后：共 ' + after.count + ' 个商品，渲染 ' + after.rows + ' 行')
  ok('按子类搜索把结果收敛到 1 个商品', after.count === 1, 'count=' + after.count)
  ok('命中的那一行把子类原值显示了出来', after.hit)

  // ───────── 编辑弹窗的子类建议（datalist）─────────
  // 趁搜索还锁着那一个「伊势尼(粗弯倒刺深)」商品时打开它的编辑弹窗 —— 该商品品类=鱼钩，
  // 所以 datalist 里应当出现鱼钩用过的子类（正是"可复用"要证明的事）。
  const editBtn = p.locator('button[title="编辑商品"]')
  const nEdit = await editBtn.count()
  ok('表格里有「编辑商品」按钮', nEdit > 0, 'count=' + nEdit)
  if (nEdit > 0) {
    await editBtn.first().click()
    await p.waitForTimeout(1000)
    const dl = await p.evaluate(() => {
      const d = document.querySelector('datalist#sub-category-choices-edit')
      const inp = Array.from(document.querySelectorAll('input')).find((x) => x.getAttribute('list') === 'sub-category-choices-edit')
      return {
        exists: !!d,
        options: d ? d.options.length : 0,
        sample: d ? Array.from(d.options).slice(0, 5).map((o) => o.value) : [],
        inputValue: inp ? inp.value : null,
        listAttr: inp ? inp.getAttribute('list') : null,
      }
    })
    console.log('  编辑弹窗 datalist: options=' + dl.options + ' 样本=' + JSON.stringify(dl.sample))
    ok('编辑弹窗里有子类 datalist', dl.exists)
    ok('子类输入框挂上了 list=', dl.listAttr === 'sub-category-choices-edit', 'list=' + dl.listAttr)
    ok('datalist 里有可复用的候选值（鱼钩用过的子类）', dl.options > 0, 'options=' + dl.options)
    ok('当前商品的子类原值原样留在输入框（没有被"受控化"抹掉）',
      dl.inputValue === '伊势尼(粗弯倒刺深)', 'value=' + JSON.stringify(dl.inputValue))
    await p.keyboard.press('Escape') // 只关弹窗，不点保存、不写库
    await p.waitForTimeout(600)
  }

  // ───────── 清掉搜索，验高级筛选里的子类下拉 ─────────
  await p.evaluate(() => {
    const el = Array.from(document.querySelectorAll('input')).find((x) => (x.placeholder || '').includes('子类'))
    if (!el) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await p.waitForTimeout(1200)
  // ⚠️ Radix 的 Select 是 **pointerdown** 才展开的：必须用真实鼠标点击，
  //    合成 el.click() 不触发 → 上一版就是栽在这里（options=0）。
  await p.locator('button', { hasText: '高级筛选' }).first().click()
  await p.waitForTimeout(700)
  const subTrigger = p.locator('button[role="combobox"]').filter({ hasText: '子类' })
  const nTrig = await subTrigger.count()
  ok('高级筛选里出现「子类」下拉触发器', nTrig > 0, 'count=' + nTrig)
  if (nTrig > 0) {
    await subTrigger.first().click()
    await p.waitForTimeout(900)
  }
  const opts = await p.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => (o.textContent || '').trim()))
  console.log('  子类下拉前 8 项: ' + JSON.stringify(opts.slice(0, 8)))
  ok('下拉展开后有选项', opts.length > 0, 'options=' + opts.length)
  ok('下拉含「全部子类」', opts.includes('全部子类'), JSON.stringify(opts.slice(0, 3)))
  ok('下拉选项来自真实子类值（不止"全部子类"一项）', opts.length > 1, 'options=' + opts.length)


  console.log('')
  console.log('================ 结果 ================')
  console.log('PASS ' + pass + '   FAIL ' + fail)
  if (errs.length) { console.log('页面错误 ' + errs.length + ' 条，前 3：'); errs.slice(0, 3).forEach((e) => console.log('  ' + e)) }

  await b.close()
  server.close()
  process.exit(fail === 0 ? 0 : 1)
})()
