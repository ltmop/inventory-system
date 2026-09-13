// 「检查更新」验证：① 源码判据（三种结果是否真的能表达）② 用真实数据链路预测按钮会显示什么
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

const upd = fs.readFileSync(path.join(ROOT, 'electron', 'updater.js'), 'utf8')
const mainJs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8')
const settings = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'SettingsPage.tsx'), 'utf8')

console.log('=== ① 后端：三种结果都能表达，不再把失败伪装成"已是最新" ===')
ok('返回 ok:true/false 区分成功与失败', /ok:\s*true/.test(upd) && /ok:\s*false/.test(upd))
ok('成功且有新版时给 hasUpdate:true', /hasUpdate:\s*cmpVersion\([^)]*\)\s*>\s*0/.test(upd))
ok('失败分支带 error（能把原因显示给用户）', /ok:\s*false,\s*error:/.test(upd))
ok('用 app.getVersion() 取当前版本（不是构建时写死的常量）', /app\.getVersion\(\)/.test(upd))
ok('版本比较是数字比较，不是字符串比较', /function cmpVersion/.test(upd) && !/latestVersion\s*!==\s*currentVersion/.test(upd))
ok('拿不到版本号也算失败（不当成已是最新）', /更新源没有返回版本号/.test(upd))

console.log('\n=== ② main.js：handler 不再把失败吞成只有 checkedAt ===')
const handlerSeg = mainJs.split("'update:check'")[1]?.slice(0, 420) ?? ''
ok('handler 透传 checkForUpdates 的结果', /return await checkForUpdates\(\)/.test(handlerSeg))
ok('handler 的兜底也带 ok:false + error', /ok:\s*false,\s*error:/.test(handlerSeg))

console.log('\n=== ③ 界面：状态始终可见 + 失败也设 lastCheckAt ===')
ok('有显式的结果状态机', /updateResult/.test(settings) && /'latest' \| 'hasNew' \| 'failed'/.test(settings))
ok('成功路径设 lastCheckAt', /setLastCheckAt\(stamp\(\)\)/.test(settings))
const catchSeg = settings.split('} catch (e) {')[1]?.slice(0, 300) ?? ''
ok('失败路径**也**设 lastCheckAt（这是"点了没反应"的根因）', /setLastCheckAt\(stamp\(\)\)/.test(catchSeg))
ok('状态渲染不再被 lastCheckAt 挡住', !/\{lastCheckAt && updateMsg &&/.test(settings))
ok('界面显示当前版本号', /当前 v\{APP_VERSION\}/.test(settings))
ok('三种措辞都在：已是最新 / 发现新版本 / 检查失败', /已是最新/.test(settings) && /发现新版本/.test(settings) && /检查失败/.test(settings))

console.log('\n=== ④ 真实数据链路：按钮现在会显示什么 ===')
const yml = await (await fetch('https://sync.junchengzn.com/updates/latest.yml')).text()
const feedVer = (yml.match(/^version:\s*(\S+)/m) || [])[1]
console.log('  更新源上的最新版本: ' + feedVer)
// 当前安装的版本（app.getVersion() 读的就是打包进 asar 的 package.json version）
const dir = path.join(process.env.LOCALAPPDATA, 'Programs', 'inventory-system')
const exe = path.join(dir, 'AI智能进销存系统.exe')
const v = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath "${exe}").VersionInfo.FileVersion`], { encoding: 'utf8' })
const installed = (v.stdout || '').trim()
console.log('  本机已安装版本    : ' + installed)
const cmp = (a, b) => {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0), pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d }
  return 0
}
const predicted = cmp(feedVer, installed) > 0 ? '发现新版本 v' + feedVer : '已是最新'
console.log('  ⇒ 按修复后的逻辑，点「检查更新」应显示：**' + predicted + '**')
ok('更新源返回了合法版本号', !!feedVer && /^\d+\.\d+/.test(feedVer), String(feedVer))
ok('本机版本可读', /^\d+\.\d+/.test(installed), installed)

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
