// 归档旧共享槽 users/cockpit（复核报告 R7）
// 设计原则：只「移动」不「删除」，默认 dry-run；有多重安全闸，任一不满足即 ABORT。
// 用法：
//   CLOUD_DATA_ROOT=/opt/inventory-cloud/data node archive-shared-slot.mjs            # 预演（默认）
//   CLOUD_DATA_ROOT=/opt/inventory-cloud/data node archive-shared-slot.mjs --apply    # 实际归档
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DATA_ROOT = process.env.CLOUD_DATA_ROOT || path.join(process.cwd(), 'data')
const SHARED = path.join(DATA_ROOT, 'users', 'cockpit')
const ACC_FILE = path.join(DATA_ROOT, 'cockpit-accounts.json')
const APPLY = process.argv.includes('--apply')

function sha256(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return '' } }
function listFiles(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir)) {
    const f = path.join(dir, e)
    if (fs.statSync(f).isDirectory()) listFiles(f, base, acc)
    else acc.push(path.relative(base, f))
  }
  return acc
}
function abort(msg) { console.log('ABORT: ' + msg); process.exit(2) }

if (!fs.existsSync(SHARED)) { console.log('无需处理：未发现旧共享槽 ' + SHARED); process.exit(0) }

let accs = {}
try { accs = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) } catch { accs = {} }

// 闸 1：不允许仍有账号指向共享槽（否则归档即等于让那个账号失去数据）
const stillUsing = Object.values(accs).filter((a) => a && a.userId === 'cockpit')
if (stillUsing.length) abort('仍有账号 userId=cockpit，禁止归档：' + stillUsing.map((a) => a.phone || a.name).join(', '))

// 闸 2：必须已存在店主账号（说明 KB 已迁出，这里只是残留副本）
const owners = Object.values(accs).filter((a) => a && a.isOwner)
if (!owners.length) abort('未发现 isOwner 店主账号，说明 KB 可能尚未迁移，禁止归档')

console.log('[旧共享槽] ' + SHARED)
console.log('[店主账号] ' + owners.map((a) => a.name || a.phone).join(', '))
const files = listFiles(SHARED)
for (const f of files) {
  const p = path.join(SHARED, f)
  console.log('  - ' + f + '  sha256:' + sha256(p).slice(0, 16) + '  ' + fs.statSync(p).size + 'B')
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const dest = path.join(DATA_ROOT, 'archive', 'shared-slot-' + stamp)

if (!APPLY) {
  console.log('')
  console.log('DRY-RUN：未做任何改动。')
  console.log('将执行：移动 ' + SHARED + '  ->  ' + dest)
  console.log('确认无误后执行：node archive-shared-slot.mjs --apply')
  process.exit(0)
}

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.renameSync(SHARED, dest)
const manifest = {
  archivedAt: new Date().toISOString(),
  from: SHARED,
  to: dest,
  note: 'R7 残留归档：只移动未删除；确认 30 天无需回滚后由人工删除',
  files: files.map((f) => ({ rel: f, sha256: sha256(path.join(dest, f)), bytes: fs.statSync(path.join(dest, f)).size })),
}
fs.writeFileSync(path.join(dest, 'ARCHIVE-MANIFEST.json'), JSON.stringify(manifest, null, 2))
console.log('')
console.log('已归档（未删除）：' + dest)
console.log('已写入清单：' + path.join(dest, 'ARCHIVE-MANIFEST.json'))
console.log('回滚：mv "' + dest + '" "' + SHARED + '"')
