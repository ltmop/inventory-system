// B 通道（前端局部热更）的**发布侧**打包脚本
//
//   node scripts/build-web-bundle.mjs --check          # 只校验，不写任何文件（发布前先跑这个）
//   node scripts/build-web-bundle.mjs                  # 生成 release/web/（latest.json + <版本>/**）
//   node scripts/build-web-bundle.mjs --version 1.1.8.1
//
// 它只产出到本地 release/web/，**不会**碰线上。上传是单独一步（见 docs/运维-桌面端局部更新-Runbook.md）。
//
// 🔴 关键设计：本脚本用**客户端同一套校验函数**（electron/webUpdate.js 的 validateManifest /
//    isSafeRelPath）给自己出的清单做自检 —— 所以"能发布出去"与"客户端肯收"是同一条判据，
//    不存在"发布侧松、客户端紧"导致的线上静默拒收。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest, isSafeRelPath, isAllowedSource, readSupportedChannels, sha256Hex, cmpVersion, VERSION_FILE, ALLOWED_EXT, CODE_ALLOWED_EXT } from '../electron/webUpdate.js'
import { channelsUsedInSrc } from './lib/channels.mjs'
import { computeCodeClosure } from './lib/code-closure.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const CHECK_ONLY = process.argv.includes('--check')

let fail = 0
const bad = (msg) => { fail++; console.log('  ✗ ' + msg) }
const good = (msg) => console.log('  ✓ ' + msg)

const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
const distDir = path.join(REPO, 'dist')
const outRoot = path.resolve(REPO, arg('out', path.join('release', 'web')))
const baseRoot = arg('base-url', 'https://sync.junchengzn.com/updates/web/')
const minShellVersion = arg('min-shell', pkgVersion)

console.log('=== ① 前置：dist 存在、有 web-version.txt ===')
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  bad('dist/index.html 不存在 —— 先跑 npm run build')
  process.exit(1)
}
good('dist/index.html 存在')
let webVersion = arg('version', '')
if (!webVersion) {
  try { webVersion = fs.readFileSync(path.join(distDir, VERSION_FILE), 'utf8').trim() } catch { /* 下面报错 */ }
}
if (!/^\d+(\.\d+){0,3}$/.test(webVersion)) {
  bad(`拿不到合法的前端版本号（dist/${VERSION_FILE}）："${webVersion}" —— 前端热更必须有独立版本号`)
} else {
  good(`前端版本 ${webVersion}（壳版本 ${pkgVersion}，minShellVersion ${minShellVersion}）`)
}
// 下载地址必须**以版本号结尾**（清单在 .../updates/web/latest.json，文件在 .../updates/web/<版本>/**）。
// 少了版本段不会在校验时红，但会让**每一个文件**都 404 —— 真机验证时踩过，所以这里强制拼上。
// ⚠️ 用 `/updates/` 前缀是有原因的：`sync.junchengzn.com` 只有 `/updates/*` 这一个现成的静态托管
//    （Caddy 把该域名整个反代给 inventory-cloud，没有 `/web/` 路由）。详见 electron/webUpdate.js。
const baseUrl = baseRoot.replace(/\/+$/, '') + '/' + webVersion + '/'
if (!isAllowedSource(baseUrl)) bad(`下载地址必须 https（或本机 127.0.0.1 验证）：${baseUrl}`)
else good(`下载地址 ${baseUrl}`)

console.log('\n=== ② 收集 dist 文件（路径安全 + 后缀白名单）===')
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) { walk(abs); continue }
    const rel = path.relative(distDir, abs).split(path.sep).join('/')
    const safe = isSafeRelPath(rel)
    if (!safe) {
      const ext = path.extname(rel).toLowerCase()
      bad(ALLOWED_EXT.has(ext)
        ? `路径不合法：${rel}`
        : `后缀不在白名单：${rel} ${ext ? '(' + ext + ')' : ''} —— 热更包只装业务层，加白名单要改 electron/webUpdate.js 的 ALLOWED_EXT`)
      continue
    }
    const buf = fs.readFileSync(abs)
    files.push({ path: rel, size: buf.byteLength, sha256: sha256Hex(buf) })
  }
}
walk(distDir)
files.sort((a, b) => (a.path < b.path ? -1 : 1))
const totalBytes = files.reduce((s, f) => s + f.size, 0)
if (fail === 0) good(`${files.length} 个文件，合计 ${(totalBytes / 1048576).toFixed(1)} MB`)

console.log('\n=== ③ 口径层（C 通道）：闭包必须完整，且不能依赖 electron ===')
let codeFiles = []
let codeBytes = 0
if (process.argv.includes('--no-code')) {
  good('--no-code：本次不带口径层 —— 客户端会把口径层退回内置（这也是"单独撤掉一个坏口径层"的办法）')
} else {
  const cl = computeCodeClosure(path.join(REPO, 'electron'))
  if (cl.electronImports.length) {
    bad(`口径层闭包里 import 了 electron：${cl.electronImports.join(', ')} —— 主进程模块换不掉，这些文件不能进热更包`)
  }
  if (cl.escapes.length) bad(`口径层有相对 import 跳出 electron/：${cl.escapes.join(' | ')}`)
  for (const rel of cl.files) {
    if (!isSafeRelPath(rel, CODE_ALLOWED_EXT)) { bad(`口径层路径/后缀不合法：${rel}`); continue }
    const buf = fs.readFileSync(path.join(REPO, 'electron', ...rel.split('/')))
    codeFiles.push({ path: rel, size: buf.byteLength, sha256: sha256Hex(buf) })
  }
  codeBytes = codeFiles.reduce((s, f) => s + f.size, 0)
  const ext = [...cl.externals.keys()].sort()
  good(`${codeFiles.length} 个文件 / ${(codeBytes / 1024).toFixed(1)} KB（外部依赖：${ext.join(' ') || '无'}）`)
}

console.log('\n=== ④ 通道闭包：热更包引用的通道必须 ⊆ 当前壳支持的通道 ===')
const channels = [...channelsUsedInSrc(REPO)].sort()
// 与客户端同一套算法：preload 白名单（本机 IPC）∪ server.js 路由（中心库模式下走 HTTP，不过 preload）
const supported = readSupportedChannels(path.join(REPO, 'electron', 'preload.cjs'), path.join(REPO, 'electron', 'server.js'))
const missing = channels.filter((c) => !supported.has(c))
console.log(`  渲染层用到 ${channels.length} 个 · 壳放行 ${supported.size} 个`)
if (missing.length) bad(`热更包用到壳不支持的通道：${missing.join(' ')}（客户端会**拒绝加载**，避免"点了没反应"）`)
else good('通道全部落在壳的放行名单里')

console.log('\n=== ⑤ 用客户端同一套判据自检清单 ===')
const manifest = {
  webVersion,
  minShellVersion,
  baseUrl,
  publishedAt: new Date().toISOString(),
  channels,
  files,
  ...(codeFiles.length ? { codeFiles } : {}),
}
const v = validateManifest(manifest, {
  shellVersion: minShellVersion, // 最老的、要能收下这个包的壳
  currentWebVersion: '0.0.0',
  supportedChannels: supported,
})
if (!v.ok) bad('客户端会拒绝这个清单：' + v.reason)
else good(`客户端判据通过（前端 ${v.files.length} 文件 / ${(v.totalBytes / 1048576).toFixed(1)} MB / 通道 ${v.channels.length} / 口径层 ${v.codeFiles.length} 文件 ${(v.codeBytes / 1024).toFixed(1)} KB）`)

console.log('\n=== ⑥ 不许倒退：不能低于线上已发布的版本 ===')
const latestPath = path.join(outRoot, 'latest.json')
if (fs.existsSync(latestPath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(latestPath, 'utf8'))
    if (cmpVersion(webVersion, prev.webVersion) <= 0) {
      bad(`本地 release/web/latest.json 已是 ${prev.webVersion}，不能发布 ${webVersion}（版本号必须先涨）`)
    } else good(`${prev.webVersion} → ${webVersion}`)
  } catch { bad('本地 latest.json 坏了，先修它再发布（否则会覆盖掉版本记录）') }
} else good('本地还没有已发布记录（首次发布）')

if (fail) {
  console.log(`\n结果：${fail} 项不合格 —— **不要上传**`)
  process.exit(1)
}

if (CHECK_ONLY) {
  console.log('\n结果：--check 模式，全部通过，未写任何文件')
  process.exit(0)
}

console.log('\n=== ⑦ 写出 release/web/（版本目录只增不改）===')
const verDir = path.join(outRoot, webVersion)
if (fs.existsSync(verDir)) {
  bad(`版本目录已存在：${verDir} —— 同版本号不许覆盖（热更包必须不可变，否则客户端校验会飘）`)
  process.exit(1)
}
for (const f of files) {
  const dest = path.join(verDir, ...f.path.split('/'))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(distDir, ...f.path.split('/')), dest)
}
// 口径层：源在 electron/ 下，按同样的相对路径摆放（客户端会原样装到 dataDir/code/<版本>/）
for (const f of codeFiles) {
  const dest = path.join(verDir, ...f.path.split('/'))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'electron', ...f.path.split('/')), dest)
}
fs.mkdirSync(outRoot, { recursive: true })
fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2), 'utf8')
good(`已写出 ${verDir}`)
good(`已写出 ${latestPath}`)
console.log(`\n上传（单独一步，先备份）：把 ${outRoot} 整个传到中心库/发布机的静态目录 web/ 下`)
console.log(`下一次改前端：把 public/${VERSION_FILE} 改成 ${webVersion.split('.').slice(0, 3).join('.')}.${(parseInt(webVersion.split('.')[3] || '0', 10) + 1)} 再跑本脚本`)
