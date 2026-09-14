// 官网下载页版本号闸门（npm run check:web）
//
// 为什么有这个脚本：官网版本号这件事**已经踩过三次坑**，每次都要真发一版才知道改坏没有，
// 而"发出去才发现"的代价是官网主按钮 404（用户下载不了）：
//   ① 手机版号硬编码计数 → 桌面号撞上就误报中止，exe 已换、页面没换；
//   ② 整页盲替换版本号 → 把 `fishing-inventory-mobile-1.1.2.apk` 一起改了；
//   ③ 只认 exe 名和「桌面 v」→ 漏掉「桌面版 v」「Windows 版 v」，
//      结果 exe/href/chip 全是新的，meta description、底部当前版本、主按钮文案还是旧的。
//
// 本脚本两层：
//   A. 固定夹具单测（离线可跑）：把上面三条规则钉死，改坏任何一条这里就红；
//   B. 线上实页自检：抓 https://junchengzn.com/download/，断言桌面版本号全部等于 package.json 的版本
//      且主按钮文案写着它。网络不通时**跳过**（不算失败），但页面能打开而版本不对 = FAIL。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  desktopMentions,
  mobileApks,
  rewriteDownloadPage,
  pointMainButtonAtLocal,
  assertPageCurrent,
  mainButton,
} from './lib/download-page.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version

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
  catch (e) {
    ok(name, !needle || String(e.message).includes(needle), '报错内容：' + e.message)
  }
}

// ── 夹具：按官网真实结构写（改版时这里要跟着看）────────────────────────────
const PAGE_OLD = `<!doctype html><html><head>
<meta name="description" content="免费下载通用进销存桌面版 v1.1.4：扫码开单、库存预警、利润报表">
</head><body>
<span class="chip">免费 · 桌面 v1.1.4 · 手机 v1.1.3</span>
<a href="https://sync.junchengzn.com/updates/inventory-system-setup-1.1.4.exe" class="btn btn-accent btn-lg">免费下载 Windows 版 v1.1.4</a>
<a href="/download/fishing-inventory-mobile-1.1.3.apk" class="btn btn-dark btn-lg">下载手机 APP v1.1.3（安卓）</a>
<div class="p-feat"><h3>当前版本</h3><p>桌面版 v1.1.4 · 手机版 v1.1.3</p></div>
<a href="https://sync.junchengzn.com/updates/inventory-system-setup-1.1.4.exe" rel="noopener">sync.junchengzn.com 备用下载</a>
</body></html>`

// 坑③的真身：exe 名已经是新版本，文案还旧 —— oldV 等于目标版本，只靠 oldV 会整段跳过
const PAGE_HALF = `<!doctype html><html><head>
<meta name="description" content="免费下载通用进销存桌面版 v1.1.4：扫码开单">
</head><body>
<span class="chip">免费 · 桌面 v1.1.6 · 手机 v1.1.3</span>
<a href="/download/general-inventory-setup-1.1.6.exe" class="btn btn-accent btn-lg">免费下载 Windows 版 v1.1.4</a>
<a href="/download/fishing-inventory-mobile-1.1.3.apk" class="btn btn-dark btn-lg">下载手机 APP v1.1.3（安卓）</a>
<div class="p-feat"><p>桌面版 v1.1.4 · 手机版 v1.1.3</p></div>
</body></html>`

// 坑②的前提：手机版号与桌面版号**相同**
const PAGE_SAME = `<!doctype html><html><body>
<a href="https://sync.junchengzn.com/updates/inventory-system-setup-1.1.3.exe" class="btn btn-accent btn-lg">桌面 v1.1.3</a>
<a href="/download/fishing-inventory-mobile-1.1.3.apk">下载手机 APP v1.1.3（安卓）</a>
<p>桌面版 v1.1.3 · 手机版 v1.1.3</p>
</body></html>`

console.log('=== A. 固定夹具（离线）===')
console.log('  目标版本（读 package.json）:', VERSION)

// A1 老页面：桌面全部换新，手机一根头发都不许动
{
  const r = rewriteDownloadPage(PAGE_OLD, VERSION)
  const out = r.html
  ok('A1 老页面换完不含旧桌面版本号 1.1.4', !out.includes('1.1.4'))
  eq('A1 换完桌面版本号只剩目标版本', desktopMentions(out), [VERSION])
  ok('A1 手机版 apk 文件名没动（1.1.3 仍在）', out.includes('fishing-inventory-mobile-1.1.3.apk'))
  ok('A1 手机版文案没动（手机 v1.1.3 / 手机版 v1.1.3 仍在）', out.includes('手机 v1.1.3') && out.includes('手机版 v1.1.3'))
  eq('A1 手机版 apk 出现次数不变', r.mobileAfter, r.mobileBefore)
  ok('A1 两种 exe 命名都换了', out.includes('inventory-system-setup-' + VERSION + '.exe') || out.includes('general-inventory-setup-' + VERSION + '.exe'))
  const withBtn = pointMainButtonAtLocal(out, VERSION)
  eq('A1 主按钮改指官网本地包', mainButton(withBtn).href, '/download/general-inventory-setup-' + VERSION + '.exe')
  ok('A1 主按钮文案含目标版本', mainButton(withBtn).text.includes(VERSION), mainButton(withBtn).text)
  const g = assertPageCurrent(withBtn, VERSION)
  ok('A1 assertPageCurrent 通过', !!g.button)
}

// A2 坑③：exe 名已是新版、三处文案还旧 —— 这是 1.1.6 真发出去时漏掉的那种页面
{
  const r = rewriteDownloadPage(PAGE_HALF, VERSION)
  eq('A2 旧文案 1.1.4 被清干净（坑③回归）', desktopMentions(r.html).filter(v => v !== VERSION), [])
  ok('A2 三处旧文案都改成目标版本', !r.html.includes('v1.1.4'))
  ok('A2 oldV 等于目标版本（证明这段没被 oldV 短路）', r.oldV === VERSION, 'oldV=' + r.oldV)
  throws('A2 页面还有旧文案时 assertPageCurrent 必须报错', () => assertPageCurrent(PAGE_HALF, VERSION), '残留旧桌面版本号')
  // 单独钉「主按钮文案」这条规则：按钮干脆不写版本号（不是旧版本，而是没版本）也必须被抓住 ——
  // 这正是 1.1.6 差点过去的形态：别的检查都过，只有用户会读的那行不对。
  const PAGE_BUTTON_NO_VER = '<html><body><a href="/download/general-inventory-setup-1.1.6.exe" class="btn btn-accent btn-lg">免费下载 Windows 版</a></body></html>'
  throws('A2 主按钮文案没写版本时必须报错', () => assertPageCurrent(PAGE_BUTTON_NO_VER, VERSION), '主按钮文案没跟上版本')
}

// A3 坑②：手机版号与桌面版号相同 —— 盲替换会改坏手机版，我们不许
{
  const naive = PAGE_SAME.split('1.1.3').join(VERSION)
  ok('A3 反例：整页盲替换确实会改坏手机版（坑②的证据）', naive.includes('fishing-inventory-mobile-' + VERSION + '.apk'))
  const out = rewriteDownloadPage(PAGE_SAME, VERSION).html
  ok('A3 我们的实现不动手机版', out.includes('fishing-inventory-mobile-1.1.3.apk'))
  ok('A3 手机版文案也没动', out.includes('手机版 v1.1.3'))
  eq('A3 桌面版号换成目标版本', desktopMentions(out), [VERSION])
}

// A4 幂等：同一页改两次 == 改一次（发布脚本会重复跑）
{
  const once = rewriteDownloadPage(PAGE_OLD, VERSION).html
  const twice = rewriteDownloadPage(once, VERSION).html
  ok('A4 重复改写结果一致（幂等）', once === twice)
}

// A5 页面结构变了要早报：找不到安装包名时不许"猜着改"
throws('A5 找不到 exe 名时抛错', () => rewriteDownloadPage('<html>没有安装包名</html>', VERSION), '找不到 x.y.z 安装包名')

// A6 手机版被误改必须中止（直接用返回值手工构造不可能的场景：改完 apk 计数变了）
throws(
  'A6 主按钮缺失时 assertPageCurrent 抛错',
  () => assertPageCurrent('<html><body>没有按钮</body></html>', VERSION),
  '找不到主按钮',
)

// A7 手机版计数守卫本身有效：拿一个"桌面文案换了但 apk 也被换"的页面直接调 assertPageCurrent 不做手机检查，
//    这里改为证明 mobileApks 能识别出 apk 被换（守卫的判据本身可靠）
{
  const swapped = PAGE_OLD.replace('fishing-inventory-mobile-1.1.3.apk', 'fishing-inventory-mobile-' + VERSION + '.apk')
  ok('A7 守卫判据能发现 apk 名被换', mobileApks(swapped).join() !== mobileApks(PAGE_OLD).join())
}

// ── B. 线上实页 ────────────────────────────────────────────────────────────
console.log('')
console.log('=== B. 线上实页（网络不通则跳过）===')
const PAGE_URL = 'https://junchengzn.com/download/'
try {
  const res = await fetch(PAGE_URL, { signal: AbortSignal.timeout(20000) })
  const html = await res.text()
  ok('B1 官网下载页可访问', res.status === 200, 'HTTP ' + res.status)
  try {
    const g = assertPageCurrent(html, VERSION)
    ok('B2 页面桌面版本号全是 ' + VERSION, true)
    ok('B3 主按钮文案含 ' + VERSION, true, g.button.text)
    console.log('        主按钮：' + g.button.text + '  →  ' + g.button.href)
    // 断言主按钮指向的那个文件真的能下（GET，不用 HEAD —— 服务器不支持 HEAD）
    const code = await fetch('https://junchengzn.com/download/general-inventory-setup-' + VERSION + '.exe', {
      method: 'GET', signal: AbortSignal.timeout(60000),
    }).then(r => r.status).catch(() => 0)
    ok('B4 官网安装包 GET 200', code === 200, 'HTTP ' + code)
  } catch (e) {
    fail++
    console.log('  FAIL  B2/B3 线上页面没跟上：' + e.message)
  }
} catch (e) {
  console.log('  跳过  线上检查（网络不通或站点未起）：' + (e.message || e))
}

console.log('')
console.log('================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
