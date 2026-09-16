// 发布链（A4，审计 2026-08-31）：一条命令完成发布 SOP。
// 用法：
//   node scripts/release.mjs            全流程：检查→打包→产物→部署→三样验证
//   node scripts/release.mjs --check    只做前置检查（不改服务器）
//   node scripts/release.mjs --skip-build  跳过打包，用 %TEMP%\fi-release 已有产物
//   node scripts/release.mjs --skip-build --web-only
//                                       只重发官网（download/ + index.html 版本号），
//                                       不碰 updates/ 与 latest.yml。
//                                       用在「自动更新源已发好、官网漏了」的时候 ——
//                                       此时服务器版本已等于本地，版本递增检查会挡住全流程。
//
// 复盘教训的自动化：
//   1. ASCII 文件名 inventory-system-setup-x.y.z.exe（避开中文 URL 编码）
//   2. latest.yml 由脚本生成，path 与文件必然一致（杜绝文件名不一致事故）
//   3. 部署前备份服务器 latest.yml（可回滚）
//   4. 三样验证内建（GET 下载 / sha512 / 版本号）
//   5. 本脚本只部署发布产物，绝不碰服务器源码（index.js/store.js）——避免旧版覆盖新版
//
// ⚠️ 这是**唯一的发布入口**。曾经另有一个 scripts/publish-update.mjs 只做 updates/ 那半边，
//    与本事重复且少做官网 —— 已删除，避免"两个发布真相"（2026-09-13）。
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
// 官网下载页的版本号改写逻辑已抽到 scripts/lib/download-page.mjs（纯函数，可单测）——
// 这块踩过三次坑，`npm run check:web` 用固定夹具 + 线上实页把它钉住，不用真发一版才知道改坏没有。
import {
  desktopMentions,
  replaceDesktopMentions,
  rewriteDownloadPage,
  pointMainButtonAtLocal,
  assertPageCurrent,
} from './lib/download-page.mjs'
// 官网「其余页面」（产品页 / docs / 首页数据区）与下载页「版本信息」三处的同步 ——
// 这几处以前 release.mjs 从来不管，靠人记得手工改，已经漏过三次（含一次产品页下载按钮 404）。
import {
  replaceSiteDesktopVersion,
  assertSiteCurrent,
  rewriteVersionFacts,
  readVersionFacts,
  hasChangelogEntry,
} from './lib/site-version.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TMP_OUT = path.join(os.tmpdir(), 'fi-release')
const SERVER = 'ubuntu@43.128.20.39'
const UPDATES_DIR = '/opt/inventory-cloud/updates'
const DOWNLOAD_DIR = '/var/www/junchengzn/download'
// 服务器授权密钥（2026-08-31 起 adjczn 被拒）
// ⚠️ 2026-09-14 实测：`~/.ssh/skey-junchengzn.pem` **已不存在**（本机只剩 `junchengzn.pem`，
//    与 `~/.ssh/config` 里 Host juncheng 的 IdentityFile 一致）。旧代码把缺文件当成
//    "SSH 连不上服务器"，白查了半小时网络 —— 现在按候选列表找，找不到就明说是**缺钥匙**。
const SSH_KEY_CANDIDATES = [
  path.join(os.homedir(), '.ssh', 'skey-junchengzn.pem'),
  path.join(os.homedir(), '.ssh', 'junchengzn.pem'),
]
const SSH_KEY = SSH_KEY_CANDIDATES.find(p => fs.existsSync(p))
if (!SSH_KEY) throw new Error('找不到服务器私钥，试过：' + SSH_KEY_CANDIDATES.join(' / ') + '（这只钥匙用来连 ' + 'ubuntu@43.128.20.39' + '，与网络无关）')
const SSH_BASE = ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15']

function sh(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: ROOT, ...opts })
  if (r.error) throw new Error('命令失败: ' + cmd + ' → ' + r.error.message)
  return r
}
function ssh(remoteCmd) {
  return spawnSync('ssh', [...SSH_BASE, SERVER, remoteCmd], { encoding: 'utf8' })
}
function scpTo(local, remote) {
  const r = spawnSync('scp', [...SSH_BASE, local, SERVER + ':' + remote], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('scp 失败 ' + local + ': ' + (r.stderr || r.stdout))
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const ASCII_EXE = 'inventory-system-setup-' + version + '.exe'
const ASCII_BLOCKMAP = ASCII_EXE + '.blockmap'
const DOWNLOAD_EXE = 'general-inventory-setup-' + version + '.exe'
const PUB_URL = (pkg.build?.publish?.url || pkg.publish?.url || '').replace(/\/$/, '') + '/'

function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}
function compareVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

// 官网下载页的版本号改写逻辑在 scripts/lib/download-page.mjs（见文件顶部 import）

function preCheck({ webOnly = false } = {}) {
  console.log('=== [1/5] 前置检查 ===')
  if (!PUB_URL.startsWith('https://')) throw new Error('publish.url 不是 https: ' + PUB_URL + '（复盘 3.1：发布前验证发布配置）')
  console.log('  publish.url:', PUB_URL, 'OK')
  console.log('  appId:', pkg.build?.appId, 'OK')
  // ⚠️ 这里以前把 ssh 失败吞成空字符串，于是打印「服务器版本: (无)」——看起来像"服务器还没发过版"，
  //    实际是"根本没连上"。现在 ssh 非 0 直接中止（latest.yml 真的不存在时 grep 仍是 0，不受影响）。
  const curRes = ssh('grep ^version: ' + UPDATES_DIR + '/latest.yml 2>/dev/null | head -1')
  if (curRes.status !== 0) throw new Error('读服务器 latest.yml 失败（exit ' + curRes.status + '）：' + ((curRes.stderr || '').trim().split('\n')[0] || '(无输出)'))
  const cur = curRes.stdout.trim()
  const curVer = (cur.match(/version:\s*(\S+)/) || [])[1]
  if (curVer && compareVer(version, curVer) <= 0) {
    // --web-only 是「updates 已发好、只补官网」，此时服务器版本等于本地是正常状态
    if (webOnly) console.log('  （--web-only：跳过版本递增检查；服务器 ' + curVer + ' = 本地 ' + version + '）')
    else throw new Error('本地 ' + version + ' 不高于服务器 ' + curVer + '（版本必须递增）')
  }
  console.log('  服务器版本:', curVer || '(无)', '→ 本次:', version, 'OK')
  const gs = sh('git status --porcelain').stdout.trim()
  if (gs) console.log('  ⚠️ git 有未提交改动（建议先 commit）')
  else console.log('  git 工作区干净 OK')
  const s = ssh('echo ok')
  if (s.status !== 0 || s.stdout.trim() !== 'ok') {
    // ⚠️ 2026-09-14：以前只说「SSH 连不上」，把「钥匙不对/不由」和「网络不通」混成一句。
    //    现在把 ssh 自己吐的话带出来，否则下一次还是查网络。
    throw new Error('SSH 连不上 ' + SERVER + '（exit ' + s.status + '）：' + ((s.stderr || s.stdout || '').trim().split('\n')[0] || '(无输出)'))
  }
  console.log('  SSH 连通 OK')
}

function build() {
  console.log('=== [2/5] 打包 ===')
  execSync('node scripts/dist.cjs', { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
  const exes = fs.readdirSync(TMP_OUT)
    .filter(f => f.endsWith('.exe') && f.includes('Setup ' + version))
    .map(f => ({ f, m: fs.statSync(path.join(TMP_OUT, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (!exes[0]) throw new Error('未找到 ' + version + ' 打包产物')
  const srcExe = path.join(TMP_OUT, exes[0].f)
  if (!fs.existsSync(srcExe + '.blockmap')) throw new Error('缺 blockmap')
  return { srcExe }
}

function prepare({ srcExe }) {
  console.log('=== [3/5] 产物准备 ===')
  const workDir = path.join(os.tmpdir(), 'fi-release-' + version)
  fs.mkdirSync(workDir, { recursive: true })
  const exe = path.join(workDir, ASCII_EXE)
  const bm = path.join(workDir, ASCII_BLOCKMAP)
  fs.copyFileSync(srcExe, exe)
  fs.copyFileSync(srcExe + '.blockmap', bm)
  const size = fs.statSync(exe).size
  const sha = sha512Base64(exe)
  const ymlPath = path.join(workDir, 'latest.yml')
  fs.writeFileSync(ymlPath, [
    'version: ' + version,
    'files:',
    '  - url: ' + ASCII_EXE,
    '    sha512: ' + sha,
    '    size: ' + size,
    'path: ' + ASCII_EXE,
    'sha512: ' + sha,
    "releaseDate: '" + new Date().toISOString() + "'",
    '',
  ].join('\n'), 'utf8')
  console.log('  ' + ASCII_EXE, '(' + size + ' B) sha512 ' + sha.slice(0, 20) + '…')
  console.log('  latest.yml path=' + ASCII_EXE + '（与文件一致 OK）')
  return { workDir, exe, bm, ymlPath, sha, size }
}

/** 部署自动更新源（updates/ + latest.yml） */
function deployUpdates(a) {
  console.log('=== [4/5] 部署 updates（自动更新源）===')
  ssh('sudo cp ' + UPDATES_DIR + '/latest.yml ' + UPDATES_DIR + '/latest.yml.bak-$(date +%Y%m%d-%H%M%S) 2>/dev/null; echo bak-ok')
  scpTo(a.exe, '/tmp/' + ASCII_EXE)
  scpTo(a.bm, '/tmp/' + ASCII_BLOCKMAP)
  scpTo(a.ymlPath, '/tmp/latest.yml')
  const ins = ssh(
    'sudo mv /tmp/' + ASCII_EXE + ' ' + UPDATES_DIR + '/ && ' +
    'sudo mv /tmp/' + ASCII_BLOCKMAP + ' ' + UPDATES_DIR + '/ && ' +
    'sudo mv /tmp/latest.yml ' + UPDATES_DIR + '/latest.yml && ' +
    'ls ' + UPDATES_DIR + '/ | grep ' + version
  )
  if (ins.status !== 0) throw new Error('部署 updates 失败: ' + ins.stderr)
  console.log('  updates/ ' + ASCII_EXE + ' OK')
}

/** 部署官网：download/ 目录 + index.html / docs/index.html 的版本号 */
function deployWeb(a) {
  console.log('=== [4b] 部署官网下载页 ===')
  // ① 安装包放官网域名（页面主按钮指着它，也让"官网线路"名副其实）
  scpTo(a.exe, '/tmp/' + DOWNLOAD_EXE)
  const dl = ssh(
    'sudo mv /tmp/' + DOWNLOAD_EXE + ' ' + DOWNLOAD_DIR + '/ && ' +
    // ⚠️ 2026-09-16 修正：这里以前是 `sudo mv "$f" archive/ 2>/dev/null`，而 archive/ **根本不存在**，
    //    于是 mv 一直静默失败（stderr 被吞）—— 旧安装包既没归档也没删除，只是继续堆在 download/ 里，
    //    而用户早就要求"旧的去除"。现在先 mkdir -p，再去掉 2>/dev/null 让失败能真的中止发布。
    'cd ' + DOWNLOAD_DIR + ' && sudo mkdir -p archive && for f in general-inventory-setup-*.exe; do case "$f" in *' + version + '*) ;; *) sudo mv "$f" archive/ || exit 1; esac; done && ls ' + DOWNLOAD_DIR
  )
  if (dl.status !== 0) throw new Error('部署 download/ 失败: ' + (dl.stderr || dl.stdout))
  console.log('  download/ 根目录:', dl.stdout.trim().split('\n').join(' '), 'OK')

  // ② 真正的下载页就是 download/index.html
  // ⚠️ 2026-09-13 修正：这段以前只改 /var/www/junchengzn/index.html 与 docs/index.html 的版本文案，
  //    而站点改版后**下载页是 /download/index.html**、桌面按钮直指更新源的 exe。
  //    结果官网连续三个版本（1.0.10 / 1.0.11 / 1.0.12）没跟上，页面上还挂着 1.0.10 的直链。
  //    现在以 download/index.html 为准，并且**从页面里读出旧桌面版本号**再替换 ——
  //    绝不做"整页替换所有版本号"，否则会把手机版 1.1.1 一起改坏。
  const pagePath = DOWNLOAD_DIR + '/index.html'
  const rd = ssh('cat ' + pagePath)
  if (rd.status !== 0) throw new Error('读取下载页失败: ' + pagePath)
  // 改写逻辑（含三条守卫）在 scripts/lib/download-page.mjs，`npm run check:web` 有固定夹具守着
  const res = rewriteDownloadPage(rd.stdout, version)
  const oldV = res.oldV
  if (res.desktopBefore.length) console.log('  桌面版本号文案：' + res.desktopBefore.join(' / ') + ' → ' + version)
  // 主按钮指向官网本地文件；备用线路保持指更新源
  // ⑤ 下载页「版本信息」三处（发布日期 / 安装包大小 / 校验指纹）—— 2026-09-16 之前**从不更新**，
  //    已漏过两次；其中校验指纹写错会让客户以为文件被篡改，对 B 端下载是硬伤。
  //    发布日期取本次产物 latest.yml 的 releaseDate，而不是「今天」：
  //    --web-only 是「updates 早发好了、只补官网」，用「今天」会把发布日期改成补页面那天。
  const releaseDate = (fs.readFileSync(a.ymlPath, 'utf8').match(/releaseDate:\s*'?(\d{4}-\d{2}-\d{2})/) || [])[1]
    || new Date().toISOString().slice(0, 10)
  const facts = rewriteVersionFacts(pointMainButtonAtLocal(res.html, version), {
    date: releaseDate,
    size: a.size,
    sha16: a.sha.slice(0, 16),
  })
  const page = facts.html
  console.log('  版本信息：' + (facts.touched.length
    ? facts.touched.join(' / ') + ' 已更新 → ' + releaseDate + ' / ' + a.size + ' B / ' + a.sha.slice(0, 16)
    : '三处已是当前值') + ' OK')
  ssh('sudo cp -p ' + pagePath + ' ' + pagePath + '.bak-$(date +%Y%m%d%H%M%S)')
  const tmpPage = path.join(os.tmpdir(), 'fi-web-download-index.html')
  fs.writeFileSync(tmpPage, page, 'utf8')
  scpTo(tmpPage, '/tmp/web-download-index.html')
  const up = ssh('sudo mv /tmp/web-download-index.html ' + pagePath)
  if (up.status !== 0) throw new Error('上传下载页失败')
  console.log('  下载页：' + (oldV === version ? '已是 ' + version + '（版本号未改动）' : oldV + ' → ' + version) + ' OK')

  // ③ 其余页面一并跟上：主站首页（含数据区）/ 三个产品页 / docs 首页。
  // ⚠️ 这些页面 release.mjs 以前**从来没管过**，于是：
  //    · 产品页主按钮 href 指着已被归档的 general-inventory-setup-1.0.9.exe → 公网实测 404；
  //    · 产品页 / docs / 首页数据区的版本号长期停在旧值（1.1.8 发布后仍写 1.0.9 / 1.0.10）。
  //    改写逻辑在 lib/site-version.mjs：与 oldV 无关、幂等、手机版文件名受保护，可单测。
  const crossPages = [
    ['/var/www/junchengzn/index.html', '主站首页'],
    ['/var/www/junchengzn/products/inventory.html', '产品页-进销存'],
    ['/var/www/junchengzn/products/cockpit.html', '产品页-驾驶舱'],
    ['/var/www/junchengzn/products/minidb.html', '产品页-数据台'],
    ['/var/www/junchengzn/docs/index.html', 'docs 首页'],
  ]
  let crossSeq = 0
  for (const [remote, label] of crossPages) {
    const r = ssh('cat ' + remote)
    if (r.status !== 0) { console.log('  ' + label + ' 读不到（可能没这个页面），跳过'); continue }
    const rr = replaceSiteDesktopVersion(r.stdout, version)
    assertSiteCurrent(rr.html, version, label)
    if (!rr.touched.length) { console.log('  ' + label + ' 已是 ' + version + ' OK'); continue }
    const tmp = path.join(os.tmpdir(), 'fi-cross-' + (crossSeq++) + '.html')
    fs.writeFileSync(tmp, rr.html, 'utf8')
    ssh('sudo cp -p ' + remote + ' ' + remote + '.bak-$(date +%Y%m%d%H%M%S)')
    scpTo(tmp, '/tmp/fi-cross.html')
    const mv = ssh('sudo mv /tmp/fi-cross.html ' + remote)
    if (mv.status !== 0) throw new Error(label + ' 上传失败')
    console.log('  ' + label + '：' + rr.touched.join(' / ') + ' → ' + version + ' OK')
  }

  // ③b 更新日志有没有为本版本写条目 —— 没写只**告警**：文案得人写，脚本不代编。
  const invPage = ssh('cat /var/www/junchengzn/products/inventory.html')
  if (invPage.status === 0) {
    if (hasChangelogEntry(invPage.stdout, version)) console.log('  更新日志已含 v' + version + ' 条目 OK')
    else console.log('  ⚠️ 更新日志里还没有 v' + version + ' 的条目 —— 请人工补上（脚本不代写文案）')
  }

  // ④ 复核
  const chk = ssh("grep -c '" + version + "' " + pagePath)
  if (!chk.stdout.trim() || chk.stdout.trim() === '0') throw new Error('下载页更新后未找到 ' + version)
  console.log('  复核：下载页含 ' + version + '（' + chk.stdout.trim() + ' 行）OK')
}

function deploy(a) {
  deployUpdates(a)
  deployWeb(a)
}

function verify() {
  console.log('=== [5/5] 三样验证 ===')
  const yml = sh('curl -s ' + PUB_URL + 'latest.yml').stdout
  if (!yml.includes('version: ' + version)) throw new Error('验证1失败：latest.yml 版本不是 ' + version)
  console.log('  验证1: latest.yml 版本 ' + version + ' OK')
  const s = ssh('sha512sum ' + UPDATES_DIR + '/' + ASCII_EXE)
  const serverHex = (s.stdout.match(/[0-9a-f]{128}/) || [])[0]
  const localHex = Buffer.from(sha512Base64(path.join(os.tmpdir(), 'fi-release-' + version, ASCII_EXE)), 'base64').toString('hex')
  if (!serverHex || serverHex.toLowerCase() !== localHex.toLowerCase()) throw new Error('验证2失败：sha512 不匹配')
  console.log('  验证2: sha512 匹配 OK')
  const dl = sh('curl -sL -o NUL -w %{http_code} ' + PUB_URL + ASCII_EXE).stdout.trim()
  if (dl !== '200') throw new Error('验证3失败：更新包下载 HTTP ' + dl)
  console.log('  验证3: 更新包 GET 200 OK')
  console.log('')
  console.log('✅ 发布完成：' + version + '（updates + download + 官网页面）')
}

/** 官网下载验证（--web-only 与全流程都跑；证明官网那个 URL 真能下到） */
function verifyWeb() {
  console.log('=== [5b] 官网下载验证 ===')
  const pageUrl = 'https://junchengzn.com/download/'
  const page = sh('curl -sL ' + pageUrl).stdout
  if (!page.includes(version)) throw new Error('官网下载页里没有 ' + version + ' → ' + pageUrl)
  console.log('  官网下载页含 ' + version + ' OK')
  // ⚠️ 「页面含本版本」这条太弱：页面上 chip / exe 名 / 备用线路 任意一处有它就能过，
  //    而**主按钮文案**（用户唯一会读的那行）可以是旧版本。1.1.6 发布时就真的这样过了。
  //    所以改用 lib 里的 assertPageCurrent：主按钮文案必须写本版本 + 页面不许残留旧桌面版本号。
  const chk = assertPageCurrent(page, version)
  console.log('  官网主按钮文案含 ' + version + ' OK（' + chk.button.text + '）')
  console.log('  页面所有桌面版本号文案都是 ' + version + ' OK')
  // ⚠️ 新增：下载页「版本信息」三处必须与更新源里的**实际产物**一致。
  //    校验指纹写错等于告诉客户「这个文件被篡改过」，对 B 端下载是硬伤
  //    （2026-09-16 查出页面上写的是上一个版本的指纹与大小）。
  const yml = sh('curl -s ' + PUB_URL + 'latest.yml').stdout
  const ymlSize = (yml.match(/size:\s*(\d+)/) || [])[1]
  const ymlSha = (yml.match(/sha512:\s*([A-Za-z0-9+/=]+)/) || [])[1]
  const facts = readVersionFacts(page)
  if (!facts.date || !facts.size || !facts.sha16) {
    throw new Error('官网下载页「版本信息」三处读不全（页面结构可能变了）：' + JSON.stringify(facts))
  }
  if (ymlSize && facts.size.replace(/,/g, '') !== ymlSize) {
    throw new Error('官网写的安装包大小 ' + facts.size + ' 与实际产物 ' + ymlSize + ' 不一致')
  }
  if (ymlSha && facts.sha16 !== ymlSha.slice(0, 16)) {
    throw new Error('官网校验指纹 ' + facts.sha16 + ' 与实际产物 ' + ymlSha.slice(0, 16) + ' 不一致')
  }
  console.log('  版本信息三处：' + facts.date + ' / ' + facts.size + ' 字节 / ' + facts.sha16 + ' OK')
  const url = 'https://junchengzn.com/download/' + DOWNLOAD_EXE
  const code = sh('curl -sL -o NUL -w %{http_code} ' + url).stdout.trim()
  if (code !== '200') throw new Error('官网下载包 GET 失败：HTTP ' + code + ' → ' + url)
  console.log('  官网下载包 GET 200 OK  ' + url)
}

const args = process.argv.slice(2)
const WEB_ONLY = args.includes('--web-only')
if (args.includes('--check')) { preCheck({ webOnly: WEB_ONLY }); console.log(''); console.log('✅ 前置检查通过，可发布 ' + version); process.exit(0) }
preCheck({ webOnly: WEB_ONLY })
const built = args.includes('--skip-build')
  ? { srcExe: path.join(TMP_OUT, fs.readdirSync(TMP_OUT).filter(f => f.includes('Setup ' + version) && f.endsWith('.exe')).sort().reverse()[0]) }
  : build()
const arts = prepare(built)
if (WEB_ONLY) {
  // 只补官网：不碰 updates/ 与 latest.yml，但**仍然复核 updates 没被动过**
  deployWeb(arts)
  verify()
  verifyWeb()
} else {
  deploy(arts)
  verify()
  verifyWeb()
}
