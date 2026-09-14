// 中心库模式闸门（npm run check:central）
//
// 守的是 2026-09-14 owner 拍板的方案A：
//   **中心库模式下，本机 data.db 不是权威账本 → 禁止把它整库推上云**（快照 / 每日备份 / 按记录同步）。
//
// 为什么必须有这个脚本，而不是 grep 源码：
//   这类"守卫写了但没接上/接晚了"的坑本项目踩过（官网版本号守卫就是）。
//   `electron/cloud.js` 及其依赖**不 import electron**，所以这里可以：
//     ① 用 electron/db.js 的 openDatabase 开一个**真库**（真 schema + 真迁移）
//     ② 真 import cloud.js，真 initCloud，真调 syncSnapshot / uploadBackup / syncBusinessData
//     ③ 桩掉 fetch，数它到底发没发出去 —— "一个字节都没发"是可以被证明的，不是猜的
//   同时保留静态接线断言：光有闸门、没接上 IPC 或渲染层不上报，一样是白做。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  ok(name, a === e, '实际 ' + a + '，期望 ' + e)
}

const WORK = path.join(os.tmpdir(), 'fi-central-gate')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
const dbPath = path.join(WORK, 'data.db')

// ---------- 真库 + 真 cloud.js ----------
const { openDatabase } = await import(pathToFileURL(path.join(REPO, 'electron', 'db.js')).href)
const opened = openDatabase(dbPath)
const db = opened.db ?? opened
const cloud = await import(pathToFileURL(path.join(REPO, 'electron', 'cloud.js')).href)

// 桩掉 fetch：既记录 URL，也给出各端点足够的响应，让"该发的时候真能发出去"
const calls = []
const stubFetch = async (url) => {
  const u = String(url)
  calls.push(u)
  const body = u.includes('/api/device/bind') ? { ok: true, userId: 'u-gate', username: 'gate', salt: 'salt-gate', uploadToken: 'tok-gate', viewToken: 'view-gate' }
    : u.includes('/api/backup/list') ? { ok: true, files: [] }
      : u.includes('/api/snapshot') ? { ok: true, at: new Date().toISOString() }
        : u.includes('/api/backup') ? { ok: true }
          : u.includes('/api/tenant/sync') ? { ok: true, cursor: 'c1', applied: [], conflicts: [], changes: [], hasMore: false }
            : { ok: true }
  return { ok: true, status: 200, json: async () => body }
}
globalThis.fetch = stubFetch
const hits = (needle) => calls.filter((u) => u.includes(needle)).length
// ⚠️ loginAccount 内部会 fire-and-forget 一次 syncSnapshot（不 await），而 syncSnapshot 有
//    `if (cloudState.syncing) return` 这道并发锁 —— 不等它落地就直接量"这次发了没"，会误判成 0。
//    所以每次测量前先等状态落定（这也是本脚本第一版真实踩到的假失败）。
const settle = async () => {
  for (let i = 0; i < 200; i++) {
    if (!cloud.getCloudState().syncing) return
    await new Promise((r) => setTimeout(r, 10))
  }
}

console.log('=== ① 纯函数语义（整库上传该不该停手）===')
eq('中心库模式 → 明确给出停手原因', typeof cloud.wholeDbUploadBlocked({ centralMode: true }), 'string')
ok('原因里说清了是哪件事被暂停', /不上传整库|备份已暂停/.test(cloud.wholeDbUploadBlocked({ centralMode: true })))
eq('非中心库模式 → 不停手', cloud.wholeDbUploadBlocked({ centralMode: false }), null)

console.log('\n=== ② 行为级：闸门真的接在通道上（真库 + 真 cloud.js + 桩 fetch）===')
cloud.initCloud(db, dbPath, WORK, WORK, () => true)
eq('刚启动（无 central-mode.json）不是中心库模式', cloud.isCentralMode(), false)

const login = await cloud.loginAccount('gate', 'gatepass123', 'gate-device')
ok('登录成功（拿到设备令牌，才有资格谈上传）', login.ok === true, JSON.stringify(login))
await settle()

// 2a 本地模式：整库快照**应该**发出去（证明闸门是开关，不是"永远拦住"）
const n1 = hits('/api/snapshot')
await cloud.syncSnapshot()
await settle()
const n2 = hits('/api/snapshot')
ok('本地模式下 syncSnapshot 真的发了 /api/snapshot（闸门不是恒真）', n2 === n1 + 1, 'before=' + n1 + ' after=' + n2)

// 2b 打开中心库模式：快照 / 备份都必须停手
cloud.setCentralMode(true)
eq('setCentralMode(true) 后状态生效', cloud.isCentralMode(), true)
const s1 = hits('/api/snapshot')
await cloud.syncSnapshot()
await settle()
eq('中心库模式：syncSnapshot 一个字节都没发', hits('/api/snapshot') - s1, 0)

const b1 = hits('/api/backup')
await cloud.uploadBackup()
eq('中心库模式：uploadBackup 一个字节都没发', hits('/api/backup') - b1, 0)

const t1 = hits('/api/tenant/sync')
const biz = await cloud.syncBusinessData()
eq('中心库模式：syncBusinessData 不发 /api/tenant/sync', hits('/api/tenant/sync') - t1, 0)
ok('中心库模式：按记录同步如实返回"没做"（不谎报成功）', biz.ok === false && /中心库/.test(biz.error || ''), JSON.stringify(biz))

// 2c 关掉中心库模式：上传能力回来（双向开关，避免"一开就永久锁死"）
cloud.setCentralMode(false)
const b2 = hits('/api/backup')
await cloud.uploadBackup()
ok('关掉中心库模式后 uploadBackup 又能发了（双向）', hits('/api/backup') - b2 === 1, 'delta=' + (hits('/api/backup') - b2))

console.log('\n=== ③ 重启后仍知道自己是中心库模式（否则启动 2 秒后那次自动快照会漏网）===')
cloud.setCentralMode(true)
const flagFile = path.join(WORK, 'central-mode.json')
ok('落盘文件已生成', fs.existsSync(flagFile))
eq('落盘内容是 {on:true}', JSON.parse(fs.readFileSync(flagFile, 'utf8')).on, true)
// 模拟重启：再 initCloud 一次（内存态被文件覆盖）
cloud.initCloud(db, dbPath, WORK, WORK, () => true)
eq('重启后（渲染层还没上报）就已经知道是中心库模式', cloud.isCentralMode(), true)
const s2 = hits('/api/snapshot')
await cloud.syncSnapshot()
eq('重启后那一次自动快照同样不发', hits('/api/snapshot') - s2, 0)
cloud.setCentralMode(false)
cloud.initCloud(db, dbPath, WORK, WORK, () => true)
eq('断开中心库后重启 → 不再拦（回到本地模式行为）', cloud.isCentralMode(), false)

console.log('\n=== ④ 接线（守卫写了但没接上 = 白做）===')
const mainJs = read('electron/main.js')
const preload = read('electron/preload.cjs')
const serverJs = read('electron/server.js')
const apiTs = read('src/lib/api.ts')
const layoutTsx = read('src/components/layout/Layout.tsx')
ok('main.js 注册了 cloud:setCentralMode', mainJs.includes("ipcMain.handle('cloud:setCentralMode'"))
ok('preload.cjs 放行了 cloud:setCentralMode', preload.includes("'cloud:setCentralMode'"))
ok('server.js **不含**该通道（它只该走本机 IPC，不能发给中心库）', !serverJs.includes('cloud:setCentralMode'))
ok('api.ts 有 reportCentralModeToMain', /export function reportCentralModeToMain/.test(apiTs))
ok('api.ts 在 setCentralConfig 里上报（换模式立刻生效，不用等重启）',
  /setCentralConfig[\s\S]{0,600}?reportCentralModeToMain\(\)/.test(apiTs))
ok('Layout 启动时上报一次（让落盘值自愈）', /reportCentralModeToMain\(\)/.test(layoutTsx))
const cloudJs = read('electron/cloud.js')
ok('syncSnapshot 里有整库闸门', /syncSnapshot[\s\S]{0,400}?wholeDbUploadBlocked\(\)/.test(cloudJs))
ok('uploadBackup 里有整库闸门', /uploadBackup[\s\S]{0,400}?wholeDbUploadBlocked\(\)/.test(cloudJs))
ok('syncBusinessData 里有中心库模式判断', /syncBusinessData[\s\S]{0,300}?isCentralMode\(\)/.test(cloudJs))
ok('initCloud 在 startScheduler 之前读落盘标记', cloudJs.indexOf('loadCentralModeFlag()') < cloudJs.indexOf('startScheduler()'))
ok('cloudState 里有 centralMode 字段', /centralMode:\s*false/.test(cloudJs))

console.log('\n=== ⑤ 方案C：手填 token 不再是常规入口 ===')
const centralCard = read('src/pages/settings/CentralModeCard.tsx')
const settingsPage = read('src/pages/SettingsPage.tsx')
const cloudCard = read('src/pages/settings/CloudCard.tsx')
ok('中心库卡接受 advanced 开关', /advanced\s*=\s*false|advanced\?:/.test(centralCard))
ok('手填 token 的输入框放在 advanced 分支里', /advanced && \([\s\S]{0,900}?type="password"/.test(centralCard))
ok('常规视图告诉用户去「账号」页登录', /账号/.test(centralCard) && /nav\('\/account'\)/.test(centralCard))
ok('常规视图保留「断开（回到本机数据）」', /断开（回到本机数据）/.test(centralCard))
ok('设置页把高级开关传下去了', /<CentralModeCard advanced=\{adv\}/.test(settingsPage))
ok('登录成功但中心库没配上时如实告知（不再静默 catch）',
  /centralNotice/.test(cloudCard) && !/catch \{ \/\* 忽略：退回本地模式/.test(cloudCard))

// ---------- 收尾 ----------
try { cloud.stopScheduler() } catch { /* ignore */ }
try { db.close() } catch { /* ignore */ }
fs.rmSync(WORK, { recursive: true, force: true })

console.log('')
console.log('================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
