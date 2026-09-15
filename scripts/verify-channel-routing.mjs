// 通道路由闸门（npm run check:channels）
//
// 守的是一条不变量：
//   **每个渲染层会调用的通道，必须落在三者之一** ——
//     ① server.js 里有（业务通道，中心库模式下打到中心库）
//     ② LOCAL_ONLY_PREFIXES 前缀里（cloud: / update: / site:）
//     ③ LOCAL_ONLY_CHANNELS 精确名单里（问本机的问题）
//   三者都不在 = 中心库模式下必然 404 `unknown channel` → 渲染层 .catch 一吞 → 用户看到「点了没反应」。
//
// 为什么要有这个闸门（2026-09-14 owner 反馈「设置里一堆功能不能用」）：
//   当时实测 **62 个**通道处于"两者都不在"的状态（收款码上传、手机看店、官网、意见反馈、
//   员工账号、价格档、单位管理、知识库…）。逐个人肉发现太慢，而且修完还会再长出来 ——
//   所以把不变量做成闸门：① 新增裸通道立刻红；② 缺口只能从 KNOWN_GAP 里减，不许加。
//
// 另外两条同样重要的检查：
//   · 本机名单里的通道必须**真的在本机注册**（main.js 有 handle + preload 放行），否则"本机化"是空话
//   · 不该出现在服务端的通道（app: / server: / license: / feedback: / update: …）不许出现在 server.js 里
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')
/** 去掉注释后再做"有没有用到 X"这类判断 —— 注释里提到 window.open 不算用到（本闸门第一版就误报过） */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}

// ---------- ① 渲染层实际会调的通道 ----------
const rendererChannels = new Set()
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name
    if (e.isDirectory()) walk(rel)
    else if (/\.(ts|tsx)$/.test(e.name)) {
      for (const m of read(rel).matchAll(/invoke\(\s*'([a-zA-Z]+:[A-Za-z]+)'/g)) rendererChannels.add(m[1])
    }
  }
}
walk('src')

// ---------- ② 两侧的能力表 ----------
// ⚠️ 前缀必须写成 [a-zA-Z]+：驼峰通道名（priceTier:set / category:listWithCount / ai:smartSearch）
//    用 [a-z]+ 会**整条漏掉** → 把已经实现好的通道误判成缺口，然后去"修"没坏的东西（本闸门第一版就是这么错的）。
const serverJs = read('electron/server.js')
const serverChannels = new Set([...serverJs.matchAll(/'([a-zA-Z]+:[A-Za-z]+)'\s*:/g)].map((m) => m[1]))

const apiTs = read('src/lib/api.ts')
const localPrefixes = [...(apiTs.match(/LOCAL_ONLY_PREFIXES\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
const localListBlock = apiTs.match(/LOCAL_ONLY_CHANNELS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? ''
const localChannels = new Set([...localListBlock.matchAll(/'([a-zA-Z]+:[A-Za-z]+)'/g)].map((m) => m[1]))

/**
 * 已知缺口：既不在服务端、也还没归本机的通道。
 * ⚠️ 这张表**只能变短**：修好一个就从这里删掉（不删会导致下面「清单与实际缺口必须完全一致」红）。
 * 每一条都必须写清"为什么还没修"，见 docs/中心库模式-通道缺口清单.md。
 *
 * 2026-09-14：原 62 个缺口已全部处理完 ——
 *   35 个"问本机"的归本机（LOCAL_ONLY_CHANNELS），25 个带账本语义的补进 server.js
 *   （23 个服务端通道 + ai:analyzePhoto / ai:parseInboundNote 归本机，因为它们是纯 AI 能力、
 *    吃的是本机 AI KEY 与用量额度，不需要账本）。
 *   所以现在是**空的** —— 但机制留着：以后新增裸通道，这里仍是唯一合法的登记处。
 */
const KNOWN_GAP = new Map([])

const isLocal = (ch) => localPrefixes.some((p) => ch.startsWith(p)) || localChannels.has(ch)

console.log('=== ① 不变量：每个渲染层通道都有归属 ===')
console.log(`  渲染层通道 ${rendererChannels.size} 个 · 服务端能服务 ${serverChannels.size} 个 · 本机前缀 [${localPrefixes.join(' ')}] · 本机名单 ${localChannels.size} 个`)
const unowned = [...rendererChannels].filter((ch) => !serverChannels.has(ch) && !isLocal(ch) && !KNOWN_GAP.has(ch)).sort()
ok('没有"既不在服务端、也不在本机、也没登记缺口"的通道', unowned.length === 0, unowned.length ? '未归属：' + unowned.join(' ') : '')

console.log('\n=== ② 缺口清单与实际缺口必须完全一致（只能缩，不能涨）===')
const actualGap = [...rendererChannels].filter((ch) => !serverChannels.has(ch) && !isLocal(ch)).sort()
const stale = [...KNOWN_GAP.keys()].filter((ch) => !actualGap.includes(ch)).sort()
const undocumented = actualGap.filter((ch) => !KNOWN_GAP.has(ch)).sort()
ok('清单里没有"其实已经修好"的条目（修好要从清单删掉）', stale.length === 0, stale.length ? '已修好却还挂着：' + stale.join(' ') : '')
ok('实际缺口全部有登记（新增缺口必须一起登记并写原因）', undocumented.length === 0, undocumented.length ? '没登记：' + undocumented.join(' ') : '')
console.log(`  当前缺口 ${actualGap.length} 个（登记 ${KNOWN_GAP.size} 个）：`)
for (const [p, list] of Object.entries(actualGap.reduce((a, c) => { (a[c.split(':')[0]] ??= []).push(c); return a }, {}))) {
  console.log('    ' + p.padEnd(12), list.join(' '))
}

console.log('\n=== ③ 本机名单里的通道必须真的在本机注册 ===')
const mainJs = read('electron/main.js')
const preload = read('electron/preload.cjs')
const notRegistered = [...localChannels].filter((ch) => !mainJs.includes(`'${ch}'`))
const notAllowed = [...localChannels].filter((ch) => !preload.includes(`'${ch}'`))
ok('每个本机通道都在 main.js 注册', notRegistered.length === 0, notRegistered.join(' '))
ok('每个本机通道都在 preload 白名单里放行（否则前端调用被拒）', notAllowed.length === 0, notAllowed.join(' '))
ok('本机名单至少覆盖了 app: / server: / license: / feedback: / payment 收款码', ['app:info', 'app:openExternal', 'server:status', 'license:status', 'feedback:send', 'payment:saveQr'].every((c) => localChannels.has(c)))

console.log('\n=== ④ 不该出现在服务端的通道，server.js 里必须没有 ===')
const MUST_NOT_BE_SERVER = ['app:info', 'app:openExternal', 'server:status', 'server:toggle', 'server:regenerateToken', 'license:status', 'license:activate', 'feedback:send', 'commands:list', 'commands:invoke', 'update:check', 'cloud:status', 'site:contact']
const leaked = MUST_NOT_BE_SERVER.filter((ch) => serverChannels.has(ch))
ok('这些"问本机"的通道没被实现到服务端（实现了就等于把本机行为搬到服务器）', leaked.length === 0, leaked.join(' '))

console.log('\n=== ⑤ 本次修的 5 个症状，逐个钉住 ===')
// 它们都是"该走本机却被发给中心库"（或该走系统浏览器却用了 window.open）
for (const ch of ['payment:saveQr', 'payment:deleteQr', 'server:status', 'app:openExternal', 'feedback:send']) {
  ok(`  ${ch} 已归本机（中心库模式下不再打到服务器）`, isLocal(ch))
}
ok('渲染层不再用 window.open 开外链（会被 setWindowOpenHandler 拒掉）',
  !stripComments(read('src/pages/settings/SiteContactCard.tsx')).includes('window.open') &&
  !stripComments(read('src/pages/HelpPage.tsx')).includes('window.open'))
ok('开外链统一走 openExternalUrl（单一出口，便于以后加白名单）', /export async function openExternalUrl/.test(apiTs) && read('src/pages/settings/SiteContactCard.tsx').includes('openExternalUrl') && read('src/pages/HelpPage.tsx').includes('openExternalUrl'))
// 「关于」里那行部署方式必须来自真实配置：老写死的整句要消失，且用 deployLabel 拼
const settingsPage = read('src/pages/SettingsPage.tsx')
ok('「关于」不再写死"本地单机部署"（改为按中心库配置拼）',
  !settingsPage.includes('SQLite（WAL）· 本地单机部署') && /deployLabel/.test(settingsPage) && /getCentralConfig\(\)/.test(settingsPage))
ok('手机看店二维码优先用 http 地址（微信绕不过自签证书）', /httpUrl \|\| s\?\.url|httpUrl \|\| s\.url/.test(read('src/pages/SettingsPage.tsx')))
ok('unknown channel 有人话翻译（否则用户只看到一句英文）', /friendlyChannelError/.test(apiTs) && /unknown channel/i.test(apiTs))

console.log('')
console.log('================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
