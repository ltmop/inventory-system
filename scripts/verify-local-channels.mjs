// 机器校验：**纯本机通道必须走本机 IPC，绝不能发给中心库/主机**。
//
// ---------- 背景（2026-09-14 真机取证，owner 反馈两个症状）----------
//
// owner 原话：「自动提示更新出问题了，而且就是已经登录了，右上角仍然显示的是未登录」
//
// 取证结果：老板的收银机跑在**中心库模式**
//   · localStorage `fi-central-token` = cb8c6506472738e61520114a26a73ab0
//   · 紧随其后的 `url` + `https://app.junchengzn.com`
//   · 运行中的进程（pid 2088）有两条到 43.128.20.39:443 的 ESTABLISHED 连接（app.junchengzn.com）
// 而 `api.ts` 的 rawBackend 在中心库模式下**把所有通道都发给中心库**。于是：
//   · `cloud:status`          → 中心库 unknown channel → Layout 的 .catch 吞掉
//                             → cloud.paired 恒 false → **右上角永远「未登录」**
//   · `update:downloadAndInstall` → 同样 unknown channel → UpdateBanner 的 catch 吞掉
//                             → **点「下载更新」毫无反应**
// 两个症状同一个根因：**把"问本机"的问题发给了别人**。
//
// 这个脚本把"不许再这么发"变成可复算的检查，并守住那条**负事实**：
// 服务器端本来就没有这些通道 —— 所以"在服务器上加通道"不是解法，是错解。
//
// 跑法：node scripts/verify-local-channels.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SRC = path.join(REPO, 'src')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

const readSrc = (rel) => {
  const p = path.join(SRC, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}
// 去掉注释行后再判断，避免"注释里提到它"被误判
const strip = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const api = readSrc('lib/api.ts')
const apiCode = strip(api)
const off = readSrc('lib/offlineTransport.js')
const offCode = strip(off)
const banner = readSrc('components/UpdateBanner.tsx')
const bannerCode = strip(banner)
const serverJs = fs.readFileSync(path.join(REPO, 'electron', 'server.js'), 'utf8')

console.log('=== ① 本机通道名单存在且包含两个已知前缀 ===')
ok('api.ts 导出 LOCAL_ONLY_PREFIXES', /export const LOCAL_ONLY_PREFIXES\s*=/.test(apiCode))
ok('api.ts 导出 isLocalOnlyChannel()', /export function isLocalOnlyChannel\s*\(/.test(apiCode))
const m = apiCode.match(/LOCAL_ONLY_PREFIXES\s*=\s*\[([^\]]*)\]/)
const prefixes = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : []
console.log('  实际名单: ' + JSON.stringify(prefixes))
ok('名单含 cloud:', prefixes.includes('cloud:'))
ok('名单含 update:', prefixes.includes('update:'))

console.log('\n=== ② 出口 backend 会把本机通道转给本机 IPC ===')
ok('backend 不再是离线桥的直通（有包装）', /const offlineBridge\s*=/.test(apiCode) && /export const backend[^=]*=\s*offlineBridge/.test(apiCode))
ok('包装里出现 localBridge() 判定', /localBridge\(\)/.test(apiCode))
ok('本机通道走 local.invoke（IPC）', /if\s*\(\s*local\s*&&\s*isLocalOnlyChannel\(channel\)\s*\)\s*return\s+local\.invoke\(/.test(apiCode))
ok('localBridge 只在 window.fi 存在时返回（浏览器行为不变）',
  /window\.fi\s*\?\s*window\.fi\s*:\s*null/.test(apiCode))

console.log('\n=== ③ 本机通道绕开离线层（不缓存、不排队）===')
ok('offlineTransport 的 NO_CACHE_PREFIX 含 cloud:', /NO_CACHE_PREFIX\s*=\s*\[[^\]]*'cloud:'/.test(offCode))
ok('offlineTransport 的 NO_CACHE_PREFIX 含 update:', /NO_CACHE_PREFIX\s*=\s*\[[^\]]*'update:'/.test(offCode))
ok('NO_QUEUE_PREFIX 仍含 cloud:（回归守卫）', /NO_QUEUE_PREFIX\s*=\s*\[[^\]]*'cloud:'/.test(offCode))
ok('NO_QUEUE_PREFIX 仍含 update:（回归守卫）', /NO_QUEUE_PREFIX\s*=\s*\[[^\]]*'update:'/.test(offCode))
ok('readable() 真的用了 NO_CACHE_PREFIX', /NO_CACHE_PREFIX\)\s*if\s*\(channel\.indexOf\(p\)\s*===\s*0\)\s*return false/.test(offCode))

console.log('\n=== ④ 更新横幅不再静默吞错 ===')
ok('失败分支设了 error 状态', /catch\s*\(e\)[\s\S]{0,400}setError\(/.test(bannerCode))
ok('界面会把 error 渲染出来', /\{error\s*\?/.test(bannerCode))
ok('不再有"静默——用户下次启动还能再试"式的空 catch',
  !/catch\s*\{\s*\n\s*\/\/[^\n]*静默[\s\S]{0,120}\n\s*setDownloading\(false\)/.test(banner))

console.log('\n=== ⑤ 负事实：服务器端本来就没有这些通道（所以不能靠"服务器加通道"解决）===')
const inv = serverJs.split('INVOKE_CHANNELS')[1]?.split(']')[0] ?? ''
const writeCh = serverJs.split('WRITE_CHANNELS')[1]?.split(']')[0] ?? ''
for (const ch of ["'cloud:status'", "'cloud:centralConfig'", "'cloud:loginAccount'", "'update:check'", "'update:downloadAndInstall'"]) {
  ok('server.js 的通道表里没有 ' + ch, !serverJs.includes(ch), '出现了就必须重审本文件的结论')
}
ok('INVOKE_CHANNELS 段可被定位（否则上面的守卫是空的）', inv.length > 0)
ok('WRITE_CHANNELS 段可被定位', writeCh.length > 0)

console.log('\n=== ⑥ IPC 侧确实实现了这些通道（不然转过去也是白转）===')
const preload = fs.readFileSync(path.join(REPO, 'electron', 'preload.cjs'), 'utf8')
const mainJs = fs.readFileSync(path.join(REPO, 'electron', 'main.js'), 'utf8')
ok('preload 放行 cloud:status', preload.includes("'cloud:status'"))
ok('preload 放行 update:downloadAndInstall', preload.includes("'update:downloadAndInstall'"))
ok('main.js 注册 cloud:status', mainJs.includes("'cloud:status'"))
ok('main.js 注册 update:downloadAndInstall', mainJs.includes("'update:downloadAndInstall'"))

console.log('\n=== ⑦ 云账号凭证落盘不许静默失败（同一症状的第二个成因）===')
// 机制：saveLocalConfig() 在凭证不全时静默 return，而 paired 只在写盘成功后置位
//   → 渲染层按 r.ok 显示「已登录（云账号）」，本机其实什么都没存
//   → 下一次 cloud:status 立刻变回未配对 = 用户说的「刚登录就变成未登录」。
// 所以：落盘必须有返回值语义，且两条建立凭证的路径都要检查它、不许谎报成功。
const cloudJs = fs.readFileSync(path.join(REPO, 'electron', 'cloud.js'), 'utf8')
const cloudCode = strip(cloudJs)
const fnStart = cloudCode.indexOf('function saveLocalConfig')
const saveFn = fnStart >= 0 ? cloudCode.slice(fnStart, fnStart + 2200) : ''
ok('saveLocalConfig 有成功返回值 return true', /return true/.test(saveFn))
ok('saveLocalConfig 有失败返回值 return false', /return false/.test(saveFn))
ok('凭证不全时不再静默裸 return（旧写法 viewToken) return 必须消失）',
  !/\|\|\s*!cloudState\.viewToken\)\s*return\b/.test(cloudCode))
ok('凭证不全时写明了原因', /cloudState\.error\s*=\s*'登录凭证不完整/.test(cloudCode))
const guardCount = (cloudCode.match(/if\s*\(\s*!saveLocalConfig\(\)\s*\)/g) || []).length
ok('建立凭证的两条路径（注册/登录）都检查了落盘结果', guardCount >= 2, '实际 ' + guardCount + ' 处')
ok('检查后返回 ok:false，不谎报成功',
  /if\s*\(\s*!saveLocalConfig\(\)\s*\)\s*return\s*\{\s*ok:\s*false/.test(cloudCode))

console.log('\n=== ⑧ 顶栏不许对着一台在用的中心库收银机说「未登录」===')
// 真机取证：收银机是中心库模式（localStorage fi-central-url=https://app.junchengzn.com，
// 桌面/手机/网页同一本账），但没登云账号 → 顶栏只认「云账号 / 员工账号」两档，
// 于是一直显示「未登录」。owner 说的"已经登录了"指的就是"连上中心库"（账号页也这么写）。
const topbar = fs.readFileSync(path.join(SRC, 'components', 'layout', 'TopBar.tsx'), 'utf8')
const topbarCode = strip(topbar)
ok('TopBar 读了中心库配置', /getCentralConfig\(\)/.test(topbarCode))
ok('getCentralConfig 从 @/lib/api 导入', /from\s+'@\/lib\/api'/.test(topbar) && /getCentralConfig/.test(topbar))
ok('身份判据里有「已连接中心库」这一档', /已连接中心库/.test(topbarCode))
ok('中心库那一档排在「未登录」之前（否则永远轮不到）',
  topbarCode.indexOf('已连接中心库') < topbarCode.indexOf("'未登录'"))
ok('云账号仍优先于中心库（登了云账号就显示账号名）',
  topbarCode.indexOf('（云账号）') < topbarCode.indexOf('已连接中心库'))
ok('有悬停说明，避免把「已连接中心库」误当成云账号也登了',
  /identityHint/.test(topbarCode) && /云端备份/.test(topbarCode))

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
