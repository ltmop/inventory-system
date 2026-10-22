// 官网「跨产品版本号」闸门：站点上每个展示位显示的版本，必须等于该产品自己的权威来源。
//
// 为什么独立于 verify-site-version.mjs：
//   那个管的是"桌面端一条线"（下载页/首页/产品页里的桌面版本号），release.mjs 会自动同步它。
//   本脚本管的是**所有产品线**，包括手机端 App、手机端网页层、驾驶舱、数据台 —— 这些**没有自动化**，
//   全靠手改，实测已经漂移（手机端落后一周多、驾驶舱落后 11 个版本）。
//
// 检查的是**线上页面**而不是本地检出：release.mjs 是单向写线上的，不回写 D:\junchengzn.com，
// 所以"本地 == 线上"不成立；能判定对错的只有线上。
//
// 三态设计（避免把"拿不到源"误报成"版本不一致"）：
//   一致 / 不一致(FAIL) / 跳过(SKIP，源不可得，只告警不计失败)
//
// 用法：node scripts/verify-site-products.mjs
//   环境变量可覆盖外部检出路径：MOBILE_DIR / MINIDB_DIR
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SITE_SLOTS,
  compareSlots,
  extractPairedVersions,
  extractSelfBuiltVersion,
  extractWebLayerVersion,
  cardChipVersion,
  datumNumber,
  compareVersions,
} from './lib/site-products.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const MOBILE_DIR = process.env.MOBILE_DIR || 'D:\\mobile-app-ading'
const MINIDB_DIR = process.env.MINIDB_DIR || 'D:\\B9-minidb代码'
const SITE = 'https://junchengzn.com'

let pass = 0, fail = 0, skip = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}
const skipped = (name, why) => { skip++; console.log('  跳过  ' + name + '  （' + why + '）') }

// 三态读源：ok / missing（文件不在，跳过）/ broken（**文件在但读不出来 —— 必须 FAIL**）。
// ⚠️ 2026-09-22 负向测试逼出来的：原先 readJson 用 try/catch 把解析失败吞成 null，
//    于是"package.json 被写坏 / 带 BOM / 内容非法"会被报成"源不可得 → 跳过"，
//    闸门静默放过。**源存在却读不出来是一种故障，不是一种跳过。**
const readSource = (p) => {
  if (!fs.existsSync(p)) return { state: 'missing' }
  try { return { state: 'ok', value: JSON.parse(fs.readFileSync(p, 'utf8')) } }
  catch (e) { return { state: 'broken', err: String(e.message).slice(0, 120) } }
}
const fetchText = async (url, ms = 20000) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return r.ok ? await r.text() : null
  } catch { return null }
}

// ── A. 抽取器夹具（离线，钉死正则；页面改版时这里先红）─────────────────────────
console.log('=== A. 抽取器夹具（离线）===')
{
  const PAIRED = '<span class="chip">免费 · 桌面 v1.2.0 · 手机 v1.3.2</span>'
  const CARD = '<p class="card-tag">桌面 v1.2.0 · 手机 v1.3.2</p>'
  const SELF = '<span class="chip">自研 · 自用 · v1.0.12</span>'
  const WEB = '<p>（当前 1.4.49）比安装包版本高</p>'

  const a = extractPairedVersions(PAIRED)
  ok('A1 从下载页 chip 抽出桌面+手机两个版本', a && a.desktop === '1.2.0' && a.mobileApp === '1.3.2', JSON.stringify(a))
  const b = extractPairedVersions(CARD)
  ok('A2 从首页 card-tag 也能抽（同一形态）', b && b.desktop === '1.2.0' && b.mobileApp === '1.3.2', JSON.stringify(b))
  ok('A3 自研 chip 抽出驾驶舱/数据台版本', extractSelfBuiltVersion(SELF) === '1.0.12')
  ok('A4 抽出手机端网页层版本', extractWebLayerVersion(WEB) === '1.4.49')
  ok('A5 抽不到时返回 null（不抛错）',
    extractPairedVersions('<html>没有版本号</html>') === null &&
    extractSelfBuiltVersion('<html>没有</html>') === null &&
    extractWebLayerVersion('<html>没有</html>') === null)
  ok('A6 版本比较：1.4.49 > 1.4.0（网页层那次漂移就是这种）', compareVersions('1.4.49', '1.4.0') > 0)
  ok('A7 版本比较：1.0.12 > 1.0.1（驾驶舱那次漂移）', compareVersions('1.0.12', '1.0.1') > 0)
  ok('A8 展示位配置覆盖 9 个位置、5 条产品线', SITE_SLOTS.length === 9 &&
    new Set(SITE_SLOTS.flatMap((s) => s.products)).size === 5)
  // 首页有两张自研卡，必须按卡片标题定位；用第一个匹配的提取器会串卡。
  // 这条是 2026-09-25 补的：首页驾驶舱卡停在 v1.0.1 而实际 1.0.13 没被发现，
  // 根因就是那两个位置根本不在 SITE_SLOTS 里。
  const twoCards =
    '<article class="card"><p class="card-tag">自研 · 自用 · v9.9.9</p><h3>CEO 驾驶舱</h3></article>' +
    '<article class="card"><p class="card-tag">自研 · 自用 · v1.1.1</p><h3>经营数据台</h3></article>'
  ok('A9 首页卡片提取器按标题定位、不串卡',
    cardChipVersion('CEO 驾驶舱')(twoCards) === '9.9.9' &&
    cardChipVersion('经营数据台')(twoCards) === '1.1.1' &&
    cardChipVersion('这个产品不存在')(twoCards) === null,
    'cockpit=' + cardChipVersion('CEO 驾驶舱')(twoCards) +
    ' minidb=' + cardChipVersion('经营数据台')(twoCards) +
    ' missing=' + cardChipVersion('这个产品不存在')(twoCards))
}

// ── B. 权威来源 ────────────────────────────────────────────────────────────
console.log('')
console.log('=== B. 权威来源 ===')
const expected = {}
const notes = []

// 桌面端：本仓库的 package.json 是发布版本
expected.desktop = pkg.version
console.log('  桌面端进销存        : ' + expected.desktop + '   (本仓库 package.json)')

// 交叉核对：线上更新源必须与 package.json 一致（发版没推上去的话这里会红）
const yml = await fetchText('https://sync.junchengzn.com/updates/latest.yml')
const ymlVer = yml && (yml.match(/version:\s*(\S+)/) || [])[1]
if (ymlVer) {
  ok('B1 线上更新源 latest.yml 与 package.json 一致', ymlVer === expected.desktop, ymlVer + ' vs ' + expected.desktop)
} else {
  skipped('B1 线上更新源 latest.yml', '取不到')
}

// 手机端 App：仓库 package.json 与 gradle versionName 应当一致
const mobPkgSrc = readSource(path.join(MOBILE_DIR, 'package.json'))
if (mobPkgSrc.state === 'ok' && mobPkgSrc.value?.version) {
  expected.mobileApp = mobPkgSrc.value.version
  console.log('  手机端 App          : ' + expected.mobileApp + '   (' + MOBILE_DIR + '\\package.json)')
  try {
    const gradle = fs.readFileSync(path.join(MOBILE_DIR, 'android/app/build.gradle'), 'utf8')
    const gName = (/versionName\s+"([^"]+)"/.exec(gradle) || [])[1]
    if (gName) {
      ok('B2 手机端 gradle versionName 与 package.json 一致', gName === mobPkgSrc.value.version, gName + ' vs ' + mobPkgSrc.value.version)
    } else {
      skipped('B2 手机端 gradle versionName', '没解析到')
    }
  } catch { skipped('B2 手机端 gradle', '读不到 build.gradle') }
} else if (mobPkgSrc.state === 'broken') {
  ok('手机端 package.json 可解析', false, mobPkgSrc.err)
} else {
  skipped('手机端 App 版本', '读不到 ' + MOBILE_DIR + '\\package.json')
}

// 手机端网页层：线上 manifest 的 webVersion 是权威（它是客户端真正去拿的那份）
const manTxt = await fetchText(SITE + '/download/web/manifest.json')
let man = null
if (manTxt != null) {
  try { man = JSON.parse(manTxt) } catch { man = null }
  if (!man) ok('线上 download/web/manifest.json 可解析', false, '返回了内容但不是合法 JSON')
}
if (man?.webVersion) {
  expected.mobileWeb = man.webVersion
  console.log('  手机端网页层        : ' + expected.mobileWeb + '   (线上 download/web/manifest.json)')
  // 网页层绝不能比原生壳旧（手机端自己的 check-version-sync.mjs 也是这条规则）
  if (expected.mobileApp) {
    ok('B3 网页层版本 >= 手机端原生壳版本', compareVersions(expected.mobileWeb, expected.mobileApp) >= 0,
      'web=' + expected.mobileWeb + ' vs native=' + expected.mobileApp)
  }
} else {
  skipped('手机端网页层版本', '取不到线上 manifest.json')
}

// 驾驶舱：它有自己的更新源（与进销存不是同一个），那才是权威
const ckYml = await fetchText('https://sync.junchengzn.com/cockpit-updates/latest.yml')
const ckVer = ckYml && (ckYml.match(/version:\s*(\S+)/) || [])[1]
if (ckVer) {
  expected.cockpit = ckVer
  console.log('  驾驶舱              : ' + expected.cockpit + '   (cockpit-updates/latest.yml)')
} else {
  skipped('驾驶舱版本', '取不到 cockpit-updates/latest.yml')
}

// 数据台：取**桌面壳**那条线（站点那一页讲的是 Web 界面 + 桌面壳）
const mdSrc = readSource(path.join(MINIDB_DIR, 'desktop/package.json'))
if (mdSrc.state === 'ok' && mdSrc.value?.version) {
  expected.minidb = mdSrc.value.version
  console.log('  数据台（桌面壳线）  : ' + expected.minidb + '   (' + MINIDB_DIR + '\\desktop\\package.json)')
  notes.push('数据台的 Go 服务端/CLI 是另一条版本线，本闸门不取它（站点页面讲的是桌面壳）')
} else if (mdSrc.state === 'broken') {
  ok('数据台 desktop/package.json 可解析', false, mdSrc.err)
} else {
  skipped('数据台版本', '读不到 ' + MINIDB_DIR + '\\desktop\\package.json')
}

// ── C. 线上展示位 ──────────────────────────────────────────────────────────
console.log('')
console.log('=== C. 线上展示位 vs 权威版本 ===')
const pages = [...new Set(SITE_SLOTS.map((s) => s.page))]
const htmls = {}
for (const p of pages) {
  const html = await fetchText(SITE + p)
  if (html == null) { skipped('抓取 ' + p, '取不到'); continue }
  htmls[p] = html
}

const shownBySlot = {}
for (const slot of SITE_SLOTS) {
  const html = htmls[slot.page]
  shownBySlot[slot.label] = html == null ? null : slot.extract(html)
}

const { rows } = compareSlots(shownBySlot, expected)
console.log('  展示位'.padEnd(34) + '产品'.padEnd(14) + '页面显示'.padEnd(14) + '权威版本'.padEnd(14) + '结果')
for (const r of rows) {
  const verdict = r.match ? 'OK' : (r.shown == null || r.expected == null) ? '无法判定' : ('不一致（' + r.note + '）')
  console.log('  ' + r.slot.padEnd(32) + String(r.product).padEnd(14) + String(r.shown ?? '-').padEnd(14) + String(r.expected ?? '-').padEnd(14) + verdict)
  if (!r.match && r.shown != null && r.expected != null) {
    fail++
    console.log('  FAIL  ' + r.slot + ' 的 ' + r.product + ' 是 ' + r.shown + '，应为 ' + r.expected)
  }
}

console.log('')
console.log('================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail + '   跳过 ' + skip)
if (notes.length) notes.forEach((n) => console.log('注：' + n))
if (fail) {
  console.log('')
  console.log('有展示位与权威来源不一致 —— 官网显示的版本号已经漂了，请按上表逐项改正。')
}
process.exit(fail === 0 ? 0 : 1)
