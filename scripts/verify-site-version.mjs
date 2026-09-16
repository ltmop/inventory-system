// 官网「其余页面」版本号同步的闸门（并进 npm run check:web）
//
// 为什么有这个脚本：release.mjs 从 2026-08 起只管下载页和首页文案，其余页面靠人记得手改，
// 于是漏了三次：产品页主按钮 href 指着已归档的 1.0.9.exe（公网实测 404）、
// 首页数据区 / docs 页版本号长期停在旧值、下载页「版本信息」三处（日期/大小/指纹）从没更新过。
// 现在把这五种写法抽进 lib/site-version.mjs，这里把它们钉死。
//
// 本脚本三层：
//   A. 固定夹具（离线，手写最小页面）：把五种写法、幂等、手机版保护、更新日志不许动，逐条钉死；
//   B. 真实页面往返（本地有站点检出才跑）：对 D:\junchengzn.com 的六个真实页面做
//      「降到旧版本 → 再升回目标版本」，要求**逐字节还原** —— 只有真实 DOM 才暴露得出来的错，
//      写在夹具里永远发现不了。站点目录不存在则跳过。
//   C. 线上实页（网络不通则跳过）：抓五个跨页链接的线上页面，断言没有残留旧桌面版本号。
//
// ⚠️ C 段是"发布后"的门禁：bump 完版本还没跑 release 时它必然红，那是预期。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  desktopLabels,
  pMoreVersions,
  exeVersions,
  parenVersions,
  homepageDatum,
  replaceSiteDesktopVersion,
  assertSiteCurrent,
  rewriteVersionFacts,
  readVersionFacts,
  hasChangelogEntry,
} from './lib/site-version.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version

// 站点检出目录：默认本机 D:\junchengzn.com，可用 SITE_DIR 覆盖；不存在就跳过 B 段。
// ⚠️ 这里是"测试的输入路径"，不是"正确性依赖" —— 目录不在只影响覆盖度，不影响 A/C 两段。
const SITE_DIR = process.env.SITE_DIR || 'D:/junchengzn.com'

// 旧版本一律用结构性不会撞车的假值（同 verify-download-page.mjs 的教训：
// 夹具里的"旧版本"绝不能写成"当前版本恰好是多少"）。
const STALE = '0.9.9'
const MOBILE = '1.1.3' // 手机版号，故意与桌面不同

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  ok(name, a === e, '实际 ' + a + '，期望 ' + e)
}
function throws(name, fn, needle) {
  try { fn(); fail++; console.log('  FAIL  ' + name + '  ← 没有抛错') }
  catch (e) { ok(name, !needle || String(e.message).includes(needle), '报错内容：' + e.message) }
}

console.log('=== A. 固定夹具（离线）===')
console.log('  目标版本（读 package.json）:', VERSION)
ok('A0 夹具前提：旧版本 ' + STALE + ' ≠ 目标版本 ' + VERSION, STALE !== VERSION)
ok('A0 夹具前提：手机版 ' + MOBILE + ' ≠ 目标版本 ' + VERSION, MOBILE !== VERSION)

// 夹具按**线上真实 DOM** 写（见各条后面的文件行号注释）。
const PAGE = `<!doctype html><html><head>
<meta name="description" content="免费下载通用进销存桌面版 v${STALE}：扫码开单">
</head><body>
<span class="chip">免费 · 桌面 v${STALE} · 手机 v${MOBILE}</span>
<p class="card-tag">桌面 v${STALE} · 手机 v${MOBILE}</p>
<a href="/download/general-inventory-setup-${STALE}.exe" class="btn btn-accent btn-lg">免费下载 Windows 版 v${STALE}</a>
<a href="https://sync.junchengzn.com/updates/inventory-system-setup-${STALE}.exe" rel="noopener">备用下载</a>
<a href="/download/fishing-inventory-mobile-${MOBILE}.apk">下载手机 APP v${MOBILE}（安卓）</a>
<div class="p-feat"><h3><span class="dot"></span>当前版本</h3><p>桌面版 v${STALE} · 手机版 v${MOBILE}</p></div>
<section class="p-more">
  <a href="/download/">免费下载 Windows 版 <small>· v${STALE}</small></a>
  <a href="inventory.html">通用进销存系统 <small>· 桌面 v${STALE}</small></a>
</section>
<section class="p-log">
  <div class="entry"><span class="ver">v1.0.9<small>2026-09-09</small></span><div><h4>同步与防重</h4></div></div>
  <div class="entry"><span class="ver">v0.3.2<small>2026-08-28</small></span><div><h4>报表三件套</h4></div></div>
</section>
<a class="btn btn-accent" href="../download/general-inventory-setup-${STALE}.exe" download>下载 Setup (v${STALE})</a>
<p>系统加功能 / 修 Bug / 数据库迁移 / 打包 / 部署全流程技能包（v2.0.0）。</p>
<a class="btn" href="inventory-system-dev-2.0.0.zip" download>下载技能包 ZIP</a>
</body></html>`

// A1 五种写法全部命中
{
  const r = replaceSiteDesktopVersion(PAGE, VERSION)
  const out = r.html
  eq('A1 桌面 v / 桌面版 v / Windows 版 v 全部换新', desktopLabels(out), [VERSION])
  eq('A1 p-more 的 <small>· vX</small> 换新', pMoreVersions(out), [VERSION])
  eq('A1 两种 exe 命名都换新', [...new Set(exeVersions(out))], [VERSION])
  eq('A1 半角括号 (vX) 换新', parenVersions(out), [VERSION])
  // 第 5 种写法（首页数据区）在本页不存在，由 A6 单独覆盖
  eq('A1 四种写法都被登记为已改动', r.touched, ['桌面 v 文案', 'p-more 链接', '安装包链接', '括号版本号'])
  ok('A1 旧版本号一个不剩', !out.includes('v' + STALE) && !out.includes('setup-' + STALE))
}

// A2 幂等：发布脚本会重复跑
{
  const once = replaceSiteDesktopVersion(PAGE, VERSION).html
  const twice = replaceSiteDesktopVersion(once, VERSION).html
  ok('A2 重复改写结果一致（幂等）', once === twice)
  eq('A2 已是对目标版本时 touched 为空', replaceSiteDesktopVersion(once, VERSION).touched, [])
}

// A3 手机版一根头发都不许动 —— 桌面版号与手机版号相同时最容易被整页盲替换改坏
{
  const out = replaceSiteDesktopVersion(PAGE, VERSION).html
  ok('A3 手机版 apk 文件名没动', out.includes('fishing-inventory-mobile-' + MOBILE + '.apk'))
  ok('A3 手机版文案没动（手机 v / 手机版 v）', out.includes('手机 v' + MOBILE) && out.includes('手机版 v' + MOBILE))
  const SAME = PAGE.split(MOBILE).join(VERSION) // 反例：整页盲替换
  ok('A3 反例：整页盲替换确实会改坏手机版（这就是当年坑②的证据）',
    SAME.includes('fishing-inventory-mobile-' + VERSION + '.apk'))
}

// A4 更新日志是"历史"，绝不能被当成"当前版本位"改写
{
  const marked = ['v1.0.9', 'v0.3.2']
  for (const v of marked) {
    ok('A4 更新日志历史条目 ' + v + ' 未被改写', PAGE.includes('<span class="ver">' + v + '<small>'))
  }
  const out = replaceSiteDesktopVersion(PAGE, VERSION).html
  ok('A4 改写后历史条目仍在', out.includes('<span class="ver">v1.0.9<small>2026-09-09</small>'))
  ok('A4 历史条目不会让自检误报', assertSiteCurrent(out, VERSION, '夹具'))
}

// A5 不属于桌面版的东西不许碰：全角括号的 dev-kit v2.0.0、非 setup 命名的 zip
{
  const out = replaceSiteDesktopVersion(PAGE, VERSION).html
  ok('A5 全角括号（v2.0.0）未被改写', out.includes('（v2.0.0）'))
  ok('A5 inventory-system-dev-2.0.0.zip 未被改写', out.includes('inventory-system-dev-2.0.0.zip'))
}
{
  // 本条是"若有人把 PAREN_VERSION_RE 写成全角、或把 EXE_LINK_RE 放宽到 -dev-"的回归闸门
  eq('A5 探测器不认全角括号版本号', parenVersions('<p>（v2.0.0）</p>'), [])
  eq('A5 探测器不认 -dev- 技能包名', exeVersions('<a href="inventory-system-dev-2.0.0.zip">x</a>'), [])
}

// A6 首页数据区：版本号与「桌面版当前版本」标签分处两个元素，前四种写法都抓不到
{
  const PAGE_HOME = `<div class="datum-grid">
  <div class="datum"><span class="datum-num">10 年</span><span class="datum-label">行业经验</span></div>
  <div class="datum"><span class="datum-num">176</span><span class="datum-label">入库 SKU 承载</span></div>
  <div class="datum"><span class="datum-num">${STALE}</span>
        <span class="datum-label">桌面版当前版本</span></div>
</div>`
  const r = replaceSiteDesktopVersion(PAGE_HOME, VERSION)
  eq('A6 数据区版本号换新', homepageDatum(r.html), VERSION)
  ok('A6 数据区被登记为已改动', r.touched.includes('首页数据区'))
  ok('A6 同页其他 datum-num 没被误伤', r.html.includes('>10 年<') && r.html.includes('>176<'))
  ok('A6 自检通过', assertSiteCurrent(r.html, VERSION, '夹具'))
}

// A7 自检必须抓得住残留（发布前"半更新"就是漏在这里）
{
  const STALE_PAGE = '<span class="chip">桌面 v' + STALE + '</span>'
  throws('A7 残留旧版本号时自检报错', () => assertSiteCurrent(STALE_PAGE, VERSION, '夹具'), '仍残留旧桌面版本号')
  const STALE_DATUM = '<span class="datum-num">' + STALE + '</span><span class="datum-label">桌面版当前版本</span>'
  throws('A7 数据区残留时自检报错', () => assertSiteCurrent(STALE_DATUM, VERSION, '夹具'), '数据区')
  ok('A7 更新日志历史版本不会让自检误报',
    assertSiteCurrent('<span class="ver">v0.3.2<small>2026-08-28</small></span>', VERSION, '夹具'))
}

// A8 真身回归：产品页主按钮 href 曾经指着已归档的 1.0.9.exe → 公网 404
{
  const PAGE_404 = `<a href="/download/general-inventory-setup-1.0.9.exe" class="btn btn-accent btn-lg">免费下载 Windows 版</a>`
  const out = replaceSiteDesktopVersion(PAGE_404, VERSION).html
  eq('A8 归档版 exe 链接被改到当前版本', exeVersions(out), [VERSION])
  ok('A8 href 里的旧版本号没了', !out.includes('setup-1.0.9.exe'))
}

// A9 「版本信息」三处：日期 / 大小 / 校验指纹
console.log('')
console.log('=== A9 下载页「版本信息」三处 ===')
const FACTS_OLD = `<!doctype html><html><body>
<div class="p-feat"><h3><span class="dot"></span>发布日期</h3><p>2026-08-01</p></div>
<div class="p-feat"><h3><span class="dot"></span>安装包大小</h3><p>约 100 MB（104,857,600 字节）</p></div>
<div class="p-feat"><h3><span class="dot"></span>校验指纹</h3><p>SHA-512 前 16 位：AAAAAAAAAAAAAAAA</p></div>
</body></html>`
{
  const SIZE = 124699763
  const SHA = 'Xl2/K+NjxzdaYMz0NZW4Fzq8C5R7IghI/LQs5126e2orA=='
  const f = rewriteVersionFacts(FACTS_OLD, { date: '2026-09-15', size: SIZE, sha16: SHA.slice(0, 16) })
  ok('A9 三处都被登记为已改动', f.touched.length === 3, JSON.stringify(f.touched))
  const back = readVersionFacts(f.html)
  eq('A9 发布日期', back.date, '2026-09-15')
  eq('A9 安装包大小（含千分位）', back.size, '124,699,763')
  eq('A9 校验指纹', back.sha16, SHA.slice(0, 16))
  ok('A9 大小 MB 值按 1024 进制取整', f.html.includes('约 119 MB'), f.html)
  ok('A9 幂等', rewriteVersionFacts(f.html, { date: '2026-09-15', size: SIZE, sha16: SHA.slice(0, 16) }).html === f.html)
  // 指纹写错 = 告诉客户"文件被篡改过"，所以这一条必须是硬比对
  const wrong = readVersionFacts(rewriteVersionFacts(FACTS_OLD, { date: '2026-09-15', size: SIZE, sha16: 'WRONGWRONGWRONG1' }).html)
  ok('A9 指纹写错时读回来就是错的（供发布脚本硬比对）', wrong.sha16 !== SHA.slice(0, 16))
}
{
  const r = rewriteVersionFacts('<html><body>没有版本信息区</body></html>', { date: '2026-09-15', size: 1, sha16: 'X' })
  eq('A9 页面没有版本信息区时不抛错、不动', r.touched, [])
  ok('A9 没有版本信息区时内容不变', r.html === '<html><body>没有版本信息区</body></html>')
}

// A10 更新日志条目探测
console.log('')
console.log('=== A10 更新日志条目探测 ===')
ok('A10 认得出已写条目', hasChangelogEntry('<span class="ver">v' + VERSION + '<small>2026-09-15</small></span>', VERSION))
ok('A10 没写条目时返回 false（脚本只告警、不代写文案）', !hasChangelogEntry('<span class="ver">v1.0.9<small>2026-09-09</small></span>', VERSION))
ok('A10 版本号里的点号被正确转义（不当成通配）', !hasChangelogEntry('<span class="ver">v1x1x8<small>2026-09-15</small></span>', VERSION))

// ── B. 真实页面往返 ────────────────────────────────────────────────────────
console.log('')
console.log('=== B. 真实页面往返（站点检出不在则跳过）===')
console.log('  站点目录:', SITE_DIR)
const REAL_PAGES = [
  'index.html',
  'download/index.html',
  'products/inventory.html',
  'products/cockpit.html',
  'products/minidb.html',
  'docs/index.html',
]
if (!fs.existsSync(SITE_DIR)) {
  console.log('  跳过  站点目录不存在（可用 SITE_DIR 环境变量指定）')
} else {
  for (const rel of REAL_PAGES) {
    const p = path.join(SITE_DIR, rel)
    if (!fs.existsSync(p)) { console.log('  跳过  ' + rel + '（文件不存在）'); continue }
    const real = fs.readFileSync(p, 'utf8')
    // 真实页面当前应当已是目标版本 —— 这是"当前版本位"的定义
    const pre = replaceSiteDesktopVersion(real, VERSION)
    if (pre.touched.length) {
      ok('B ' + rel + ' 当前版本位已是 ' + VERSION, false, '仍是：' + pre.touched.join(' / '))
      continue
    }
    // 往返：降到旧版本 → 再升回目标版本 → 必须逐字节还原。
    // 只有真实 DOM 才暴露得出来的错（缩进、换行、HTML 实体、属性顺序），手写夹具永远发现不了。
    const down = replaceSiteDesktopVersion(real, STALE)
    const up = replaceSiteDesktopVersion(down.html, VERSION)
    ok('B ' + rel + ' 降版确有改动（该页确实含桌面版本位）', down.touched.length > 0)
    ok('B ' + rel + ' 升回后逐字节还原', up.html === real,
      '差异处：' + firstDiff(up.html, real))
    // 手机上不许在往返里被动过
    const apksBefore = (real.match(/fishing-inventory-mobile-[0-9.]+\.apk/g) || []).sort()
    const apksAfter = (up.html.match(/fishing-inventory-mobile-[0-9.]+\.apk/g) || []).sort()
    eq('B ' + rel + ' 手机版 apk 往返后不变', apksAfter, apksBefore)
    ok('B ' + rel + ' 自检通过', assertSiteCurrent(real, VERSION, rel))
  }
}

/** 报出第一处差异的位置与上下文，省得改了 40 行才反推是哪一处 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return 'offset ' + i + ' ' + JSON.stringify(a.slice(i - 30, i + 30)) + ' ≠ ' + JSON.stringify(b.slice(i - 30, i + 30))
  }
  return a.length === b.length ? '(无差异)' : '长度不同 ' + a.length + ' ≠ ' + b.length
}

// ── C. 线上实页 ────────────────────────────────────────────────────────────
console.log('')
console.log('=== C. 线上实页（网络不通则跳过）===')
const LIVE = [
  ['https://junchengzn.com/', '主站首页'],
  ['https://junchengzn.com/products/inventory.html', '产品页-进销存'],
  ['https://junchengzn.com/products/cockpit.html', '产品页-驾驶舱'],
  ['https://junchengzn.com/products/minidb.html', '产品页-数据台'],
  ['https://junchengzn.com/docs/', 'docs 首页'],
]
let online = true
try {
  const probe = await fetch(LIVE[0][0], { signal: AbortSignal.timeout(20000) })
  ok('C0 站点可访问', probe.status === 200, 'HTTP ' + probe.status)
} catch (e) {
  online = false
  console.log('  跳过  线上检查（网络不通或站点未起）：' + (e.message || e))
}
if (online) {
  for (const [url, label] of LIVE) {
    let html = null
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (res.status !== 200) { console.log('  跳过  ' + label + '（HTTP ' + res.status + '）'); continue }
      html = await res.text()
    } catch (e) {
      console.log('  跳过  ' + label + '（' + (e.message || e) + '）')
      continue
    }
    try {
      assertSiteCurrent(html, VERSION, label)
      ok('C ' + label + ' 无残留旧桌面版本号', true)
    } catch (e) {
      ok('C ' + label + ' 无残留旧桌面版本号', false, e.message)
    }
  }
}

console.log('')
console.log('================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
