// 发布链（A4，审计 2026-08-31）：一条命令完成发布 SOP。
// 用法：
//   node scripts/release.mjs            全流程：检查→打包→产物→部署→三样验证
//   node scripts/release.mjs --check    只做前置检查（不改服务器）
//   node scripts/release.mjs --skip-build  跳过打包，用 %TEMP%\fi-release 已有产物
//
// 复盘教训的自动化：
//   1. ASCII 文件名 inventory-system-setup-x.y.z.exe（避开中文 URL 编码）
//   2. latest.yml 由脚本生成，path 与文件必然一致（杜绝文件名不一致事故）
//   3. 部署前备份服务器 latest.yml（可回滚）
//   4. 三样验证内建（GET 下载 / sha512 / 版本号）
//   5. 本脚本只部署发布产物，绝不碰服务器源码（index.js/store.js）——避免旧版覆盖新版
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TMP_OUT = path.join(os.tmpdir(), 'fi-release')
const SERVER = 'ubuntu@43.128.20.39'
const UPDATES_DIR = '/opt/inventory-cloud/updates'
const DOWNLOAD_DIR = '/var/www/junchengzn/download'
// 服务器授权密钥（2026-08-31 起 adjczn 被拒，skey-junchengzn.pem 有效）
const SSH_KEY = path.join(os.homedir(), '.ssh', 'skey-junchengzn.pem')
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

function preCheck() {
  console.log('=== [1/5] 前置检查 ===')
  if (!PUB_URL.startsWith('https://')) throw new Error('publish.url 不是 https: ' + PUB_URL + '（复盘 3.1：发布前验证发布配置）')
  console.log('  publish.url:', PUB_URL, 'OK')
  console.log('  appId:', pkg.build?.appId, 'OK')
  const cur = ssh('grep ^version: ' + UPDATES_DIR + '/latest.yml 2>/dev/null | head -1').stdout.trim()
  const curVer = (cur.match(/version:\s*(\S+)/) || [])[1]
  if (curVer && compareVer(version, curVer) <= 0) throw new Error('本地 ' + version + ' 不高于服务器 ' + curVer + '（版本必须递增）')
  console.log('  服务器版本:', curVer || '(无)', '→ 本次:', version, 'OK')
  const gs = sh('git status --porcelain').stdout.trim()
  if (gs) console.log('  ⚠️ git 有未提交改动（建议先 commit）')
  else console.log('  git 工作区干净 OK')
  const s = ssh('echo ok')
  if (s.status !== 0 || s.stdout.trim() !== 'ok') throw new Error('SSH 连不上 ' + SERVER)
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
  return { workDir, exe, bm, ymlPath, sha }
}

function deploy(a) {
  console.log('=== [4/5] 部署 ===')
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
  scpTo(a.exe, '/tmp/' + DOWNLOAD_EXE)
  const dl = ssh(
    'sudo mv /tmp/' + DOWNLOAD_EXE + ' ' + DOWNLOAD_DIR + '/ && ' +
    'cd ' + DOWNLOAD_DIR + ' && for f in general-inventory-setup-*.exe; do case "$f" in *' + version + '*) ;; *) sudo mv "$f" archive/ 2>/dev/null; esac; done && ls ' + DOWNLOAD_DIR
  )
  console.log('  download/ 根目录:', dl.stdout.trim().split('\n').join(' '), 'OK')
  // 官网 index.html + docs/index.html 版本号更新：下载→node 正则替换→上传
  // （不用 bash sed 反向引用——$1/$2 在 shell 会被展开，曾把链接改坏；node 替换无此问题）
  const webFiles = ['index.html', 'docs/index.html']
  const tmpDir = path.join(os.tmpdir(), 'fi-web-' + version)
  fs.mkdirSync(tmpDir, { recursive: true })
  for (const f of webFiles) {
    const r = ssh('cat /var/www/junchengzn/' + f)
    if (r.status !== 0) throw new Error('读取官网文件失败: ' + f)
    let html = r.stdout
    html = html.replace(/(general-inventory-setup-)[0-9.]+(\.exe)/g, '$1' + version + '$2')
    html = html.replace(/(桌面 v)[0-9.]+/g, '$1' + version)
    fs.writeFileSync(path.join(tmpDir, f), html, 'utf8')
    scpTo(path.join(tmpDir, f), '/tmp/' + f)
    const up = ssh('sudo mv /tmp/' + f + ' /var/www/junchengzn/' + f)
    if (up.status !== 0) throw new Error('上传官网文件失败: ' + f)
  }
  const chk = ssh("grep -c '" + version + "' /var/www/junchengzn/index.html /var/www/junchengzn/docs/index.html")
  if (chk.status !== 0 || !chk.stdout.includes(version)) throw new Error('官网版本号更新后未找到 ' + version)
  console.log('  官网 index/docs 版本号更新 OK')
}

function verify() {
  console.log('=== [5/5] 三样验证 ===')
  const yml = sh('curl -s ' + PUB_URL + 'latest.yml').stdout
  if (!yml.includes('version: ' + version)) throw new Error('验证1失败：latest.yml 版本不是 ' + version)
  console.log('  验证1: latest.yml 版本 ' + version + ' OK')
  const s = ssh('sha512sum ' + UPDATES_DIR + '/' + ASCII_EXE)
  const serverHex = (s.stdout.match(/[0-9a-f]{128}/) || [])[0]
  const localHex = Buffer.from(sha512Base64(fs.readFileSync(path.join(os.tmpdir(), 'fi-release-' + version, ASCII_EXE))), 'base64').toString('hex')
  if (!serverHex || serverHex.toLowerCase() !== localHex.toLowerCase()) throw new Error('验证2失败：sha512 不匹配')
  console.log('  验证2: sha512 匹配 OK')
  const dl = sh('curl -sL -o NUL -w %{http_code} ' + PUB_URL + ASCII_EXE).stdout.trim()
  if (dl !== '200') throw new Error('验证3失败：更新包下载 HTTP ' + dl)
  console.log('  验证3: 更新包 GET 200 OK')
  console.log('')
  console.log('✅ 发布完成：' + version + '（updates + download + 官网页面）')
}

const args = process.argv.slice(2)
if (args.includes('--check')) { preCheck(); console.log(''); console.log('✅ 前置检查通过，可发布 ' + version); process.exit(0) }
preCheck()
const built = args.includes('--skip-build')
  ? { srcExe: path.join(TMP_OUT, fs.readdirSync(TMP_OUT).filter(f => f.includes('Setup ' + version) && f.endsWith('.exe')).sort().reverse()[0]) }
  : build()
const arts = prepare(built)
deploy(arts)
verify()
