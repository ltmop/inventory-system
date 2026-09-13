// 发布桌面自动更新：把 release/ 下的安装包整理成更新源要的形态并上传。
//
// 为什么需要这个脚本（踩过的坑）：
//   1. 服务端更新源用的是 **ASCII 文件名** `inventory-system-setup-<版本>.exe`，
//      而 electron-builder 产出的是中文名 `AI智能进销存系统 Setup <版本>.exe`。
//      直接把本地 latest.yml 传上去，url 里会带中文和空格 —— 能用但脆（URL 编码、重定向占位符）。
//   2. `dist.cjs` 产出的 latest.yml 指向中文名，与线上既有约定不一致。
//   3. 上传前必须校验 sha512/size 与实际文件一致，否则客户端下载完校验失败、更新装不上。
//
// 更新源位置（已核实）：
//   官网 /updates/* → 302 到 https://sync.junchengzn.com/updates/{file}
//   sync.junchengzn.com 反代 127.0.0.1:3100（pm2: inventory-cloud）
//   文件实际在服务器 /opt/inventory-cloud/updates/
//
// 跑法：
//   node scripts/publish-update.mjs                    # 只准备（在 release/ 下生成 ASCII 命名的三个文件）
//   node scripts/publish-update.mjs --upload           # 准备 + 上传 + 公网校验
//   node scripts/publish-update.mjs --upload --yes     # 跳过交互确认（本会话用它）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RELEASE = path.join(ROOT, 'release')
const HOST = process.env.SSH_HOST || 'juncheng'
const REMOTE_DIR = '/opt/inventory-cloud/updates'
const PUBLIC = 'https://sync.junchengzn.com/updates'
const UPLOAD = process.argv.includes('--upload')
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'NumberOfPasswordPrompts=0', '-o', 'PreferredAuthentications=publickey']

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const CN_EXE = `AI智能进销存系统 Setup ${version}.exe`
const ASCII_EXE = `inventory-system-setup-${version}.exe`
const cnPath = path.join(RELEASE, CN_EXE)
if (!fs.existsSync(cnPath)) { console.error(`找不到安装包：release/${CN_EXE}\n请先跑 npm run dist`); process.exit(1) }

// 1) 复制成 ASCII 名（保留中文原件，方便本地安装）
const outExe = path.join(RELEASE, ASCII_EXE)
fs.copyFileSync(cnPath, outExe)
const cnBlock = cnPath + '.blockmap'
const outBlock = outExe + '.blockmap'
if (fs.existsSync(cnBlock)) fs.copyFileSync(cnBlock, outBlock)
else console.warn('警告：没有 .blockmap，应用内增量更新不可用（全量仍可）')

// 2) 按 electron-updater 格式生成 latest.yml，sha512 必须是文件真实值
const buf = fs.readFileSync(outExe)
const sha512 = crypto.createHash('sha512').update(buf).digest('base64')
const size = buf.length
const yml = [
  `version: ${version}`,
  'files:',
  `  - url: ${ASCII_EXE}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${ASCII_EXE}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n')
const outYml = path.join(RELEASE, 'latest.yml')
fs.writeFileSync(outYml, yml, 'utf8')

console.log('已准备发布产物（release/）：')
console.log('  ' + ASCII_EXE + '  ' + size + ' 字节')
console.log('  ' + ASCII_EXE + '.blockmap  ' + (fs.existsSync(outBlock) ? fs.statSync(outBlock).size + ' 字节' : '(缺)'))
console.log('  latest.yml  version=' + version)
console.log('  sha512=' + sha512.slice(0, 24) + '…')
console.log('\n' + yml.trim())

if (!UPLOAD) { console.log('\n（仅准备。上传请加 --upload）'); process.exit(0) }

// 3) 上传：先备份线上 latest.yml，再传三个文件
const sh = (cmd, args, label) => {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 600000 })
  if (r.error) { console.error('[' + label + '] 失败: ' + r.error.message); process.exit(1) }
  if (r.status !== 0) { console.error('[' + label + '] exit ' + r.status + '\n' + (r.stdout || '') + (r.stderr || '')); process.exit(1) }
  return (r.stdout || '').trim()
}

console.log('\n=== 备份线上 latest.yml ===')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
console.log(sh('ssh', SSH_OPTS.concat([HOST, `sudo cp -p ${REMOTE_DIR}/latest.yml ${REMOTE_DIR}/latest.yml.bak-${stamp} && echo OK && cat ${REMOTE_DIR}/latest.yml | head -3`]), 'backup'))

console.log('\n=== 上传 ===')
for (const f of [ASCII_EXE, ASCII_EXE + '.blockmap', 'latest.yml']) {
  const p = path.join(RELEASE, f)
  if (!fs.existsSync(p)) { console.warn('  跳过（不存在）: ' + f); continue }
  sh('scp', SSH_OPTS.concat([p, `${HOST}:/tmp/${f}`]), 'scp ' + f)
  sh('ssh', SSH_OPTS.concat([HOST, `sudo mv /tmp/${f} ${REMOTE_DIR}/${f} && sudo chown ubuntu:ubuntu ${REMOTE_DIR}/${f}`]), 'mv ' + f)
  console.log('  已上传 ' + f)
}

console.log('\n=== 公网校验 ===')
// 用 GET（本会话已确认线上对 HEAD 的支持不可靠）；用 node 自带 fetch，不依赖本机有没有 curl
const getStatus = async (url) => (await fetch(url, { redirect: 'follow' })).status
console.log('  latest.yml  : ' + (await getStatus(PUBLIC + '/latest.yml')))
console.log('  安装包      : ' + (await getStatus(PUBLIC + '/' + ASCII_EXE)))
const got = await (await fetch(PUBLIC + '/latest.yml')).text()
const gotVer = (got.match(/^version:\s*(\S+)/m) || [])[1]
const gotSha = (got.match(/^sha512:\s*(\S+)/m) || [])[1]
console.log('  线上 version: ' + gotVer + (gotVer === version ? '  ✓' : '  ✗ 期望 ' + version))
console.log('  线上 sha512 : ' + (gotSha === sha512 ? '✓ 与本地一致' : '✗ 不一致！本地=' + sha512))
if (gotVer !== version || gotSha !== sha512) { console.error('\n发布校验未通过。'); process.exit(1) }
console.log('\n发布完成：客户端下次检查更新会拉到 ' + version)
console.log('回滚：服务器上 sudo cp ' + REMOTE_DIR + '/latest.yml.bak-' + stamp + ' ' + REMOTE_DIR + '/latest.yml')
