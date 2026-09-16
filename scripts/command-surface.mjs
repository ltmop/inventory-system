#!/usr/bin/env node
/**
 * 命令面抽取与三通道一致性检查（真相源）
 *
 * 背景：同一套业务命令被抄了三遍
 *    electron/main.js 的 handle('x', ...)                （桌面 IPC 实现）
 *    electron/preload.cjs 的 CHANNELS 白名单               （渲染进程可调用面）
 *    electron/server.js 的 INVOKE_CHANNELS/WRITE_CHANNELS （HTTP 接口）
 * 三份不一致就会出"桌面能点、手机打不到"这类幽灵问题。
 *
 * ⚠️ 2026-09-16 重写抽取逻辑（上一版在说假话，比没有还危险）：
 *    上一版用懒匹配从注释一路吃到函数，结果**命中第一个注释后就一路扩张**，
 *    把中间的函数体甚至别的注释一起吞进来。实测后果：
 *      · impl 89/180 为空、desc 102/180 为空；
 *      · ai:chat / ai:parseInboundNote / ai:photoDraft 三条共用 checkAiQuota 的说明；
 *      · ai:quota 的说明里吞进了源码。
 *    Agent 按错的说明调用 = 比没文档更糟，所以这一版：
 *      · **按段切分**：每个 handle( 从其下标切到下一个 handle( 的下标（不再赌"空行"）；
 *      · **按块登记注释**：为每个 export function 找"结束位置紧贴它、中间只有空白/行注释"的那一块；
 *      · 新增 **write 标记**（会改账/改库/改本机文件的命令）；
 *      · 新增 **local 标记**（本机专属通道，故意没有服务端实现）。
 *
 * 用法：node scripts/command-surface.mjs                 # 人类可读报告
 *       node scripts/command-surface.mjs --check         # 只做健康检查（红了 exit 1）
 *       node scripts/command-surface.mjs --emit-registry # 生成 electron/commandRegistry.json
 *       node scripts/command-surface.mjs --json          # JSON（供文档生成器用）
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/**
 * 本机专属的**写**通道：只有 IPC 实现、没有服务端实现，所以不在 server.js 的 WRITE_CHANNELS 里。
 * 判定标准（保守）：**会不会改变本机状态**（写库、写文件、改配置、下载/删除模型、启停服务）。
 * 漏标的后果：Agent 以为它是只读的、随手就跑 —— 所以不确定的一律算写。
 */
const LOCAL_WRITE_CHANNELS = [
  // 备份/恢复：动本机磁盘
  'backup:now', 'backup:restore', 'backup:setExtraDir', 'backup:clearExtraDir',
  // 收款码图片：写本机文件
  'payment:saveQr', 'payment:deleteQr',
  // 授权与密钥：改本机授权状态/密钥文件
  'license:activate', 'ai:bindLicense', 'ai:setKey', 'ai:clearKey', 'ai:setProvider',
  'doubao:setKey', 'doubao:clearKey',
  // 官网/联系方式与本机服务开关：改本机配置
  'site:setContact', 'server:toggle', 'server:regenerateToken',
  // 引导状态
  'onboarding:finish', 'onboarding:reset',
  // 云账号/同步：改云端与本机配置
  'cloud:pair', 'cloud:loginAccount', 'cloud:registerAccount', 'cloud:logout',
  'cloud:setCentralMode', 'cloud:restore', 'cloud:syncNow', 'cloud:syncBusinessNow',
  'cloud:backupNow', 'cloud:regenViewLink', 'cloud:resolveSyncConflict', 'cloud:dismissRestore',
  // 知识库/模板应用/反馈：写库或对外发送
  'knowledge:save', 'knowledge:update', 'knowledge:delete', 'template:apply', 'feedback:send',
  // 本地账号
  'user:login', 'user:logout',
  // 更新与模型下载：动磁盘、重启进程
  'update:downloadAndInstall', 'webupdate:restart', 'flags:set', 'flags:refresh',
  'voice:download', 'tts:download', 'kws:download', 'kws:push', 'kws:reset',
]

/** 1) main.js：按段切分每个 handle(...) —— 从它自己的下标切到下一个 handle( 的下标 */
function fromMain() {
  const s = R('electron/main.js')
  const re = /(?:^|\n)[ \t]*(?:const\s+\w+\s*=\s*)?(?:handle|ipcMain\.handle)\(\s*'([^']+)'/g
  const marks = [...s.matchAll(re)]
  const out = new Map()
  marks.forEach((m, i) => {
    const seg = s.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : s.length)
    // 优先取"直接转发"的形态 => commands.foo(...)，否则取段内第一个 commands.foo
    const direct = /=>\s*(?:await\s+)?commands\.(\w+)\s*\(/.exec(seg)
    const any = /\bcommands\.(\w+)\s*\(/.exec(seg)
    out.set(m[1], {
      impl: (direct && direct[1]) || (any && any[1]) || null,
      usesP: /\(\s*d\s*,\s*p/.test(seg.slice(0, 120)),
    })
  })
  return out
}

/** 2) preload.cjs：CHANNELS 白名单 */
function fromPreload() {
  const s = R('electron/preload.cjs')
  const m = /CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(s)
  if (!m) return new Set()
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
}

/** 3) server.js：INVOKE_CHANNELS（HTTP 面）+ WRITE_CHANNELS（权威的读/写划分）
 *  knownFns：命令层导出过的函数名集合 —— 用来认**裸调用**。
 *  server.js 里 analytics/search 是从命名空间解构出来直接用的（`analyticsOverview(d)`），
 *  只认 `cmds.` 前缀会把这些通道的 impl 全判成空（实测 analytics:* 5 条就是这么漏的）。
 */
function fromServer(knownFns) {
  const s = R('electron/server.js')
  const block = /INVOKE_CHANNELS\s*=\s*\{([\s\S]*?)\n\}/.exec(s)
  const out = new Map()
  if (block) {
    const re = /'([^']+)'\s*:\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*/g
    const marks = [...block[1].matchAll(re)]
    marks.forEach((m, i) => {
      const seg = block[1].slice(m.index, i + 1 < marks.length ? marks[i + 1].index : block[1].length)
      const dotted = /\b(?:cmds|commands)\.(\w+)\s*\(/.exec(seg)
      const bare = [...seg.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((x) => x[1]).find((n) => knownFns.has(n))
      out.set(m[1], { impl: (dotted && dotted[1]) || bare || null, usesP: /\(\s*d\s*,\s*p/.test('(' + m[2] + ')') })
    })
  }
  const wm = /WRITE_CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(s)
  const writes = new Set(wm ? [...wm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [])
  return { invokes: out, writes }
}

/**
 * 4) 命令实现的 JSDoc 描述 —— **按块登记 + 只认紧贴的那一块**。
 *
 * 这里踩过一个很深的坑：用"从注释懒匹配到函数"的做法是**不可靠**的 ——
 * 当最靠前的那个块注释的结束符后面还有代码时，懒匹配会**继续往后扩张**，
 * 直到找到"后面只剩空白"的那个注释为止，于是把中间的函数体甚至别的注释一起吞进来。
 * 表现：文件里第一个块注释变成了很多函数的说明。
 * 所以改成：先把所有块注释按位置登记，再为每个 export function 找
 * "结束位置紧贴它、中间只有空白或 // 行注释"的**那一块**。
 */
function jsdocIndex() {
  const dir = path.join(ROOT, 'electron/commands')
  const idx = new Map()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue
    const s = fs.readFileSync(path.join(dir, f), 'utf8')
    const blocks = [...s.matchAll(/\/\*\*[\s\S]*?\*\//g)].map((b) => ({
      end: b.index + b[0].length,
      text: b[0],
    }))
    for (const m of s.matchAll(/export\s+function\s+(\w+)/g)) {
      let desc = ''
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].end > m.index) continue
        const between = s.slice(blocks[i].end, m.index)
        if (!/^(?:\s|\/\/[^\n]*)*$/.test(between)) continue
        desc = blocks[i].text
          .replace(/^\/\*\*|\*\/$/g, '')
          .split('\n')
          .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 200)
        break
      }
      idx.set(m[1], { file: f, desc })
    }
  }
  return idx
}

/**
 * 5) 本机专属通道（`src/lib/api.ts` 的 LOCAL_ONLY_PREFIXES / LOCAL_ONLY_CHANNELS）。
 * 为什么注册表要知道它：这些通道**故意**没有服务端实现（问的是"这台电脑"），
 * 不标出来的话"只有 IPC、没有 HTTP"会误报七十多条，真正的不一致就被淹掉了。
 */
function fromLocalOnly() {
  const s = R('src/lib/api.ts')
  const prefixes = [...((s.match(/LOCAL_ONLY_PREFIXES\s*=\s*\[([^\]]*)\]/) || [null, ''])[1]).matchAll(/'([^']+)'/g)].map((m) => m[1])
  const block = (s.match(/LOCAL_ONLY_CHANNELS\s*=\s*\[([\s\S]*?)\]\s*as const/) || [null, ''])[1]
  const exact = new Set([...block.matchAll(/'([a-zA-Z]+:[A-Za-z]+)'/g)].map((m) => m[1]))
  return { prefixes, exact, isLocal: (n) => prefixes.some((p) => n.startsWith(p)) || exact.has(n) }
}

const main = fromMain()
const pre = fromPreload()
const docs = jsdocIndex()
const srv = fromServer(new Set(docs.keys()))
const localOnly = fromLocalOnly()
const allNames = [...new Set([...main.keys(), ...pre, ...srv.invokes.keys()])].sort()
const writes = new Set([...srv.writes, ...LOCAL_WRITE_CHANNELS])

const rows = allNames.map((name) => {
  const a = main.get(name)
  const b = srv.invokes.get(name)
  const impl = (a && a.impl) || (b && b.impl) || null
  const jsdoc = impl ? docs.get(impl) : null
  return {
    name,
    isRest: name.startsWith('/api/'),
    group: name.includes(':') ? name.split(':')[0] : (name.startsWith('/api/') ? 'REST 路径' : '(无前缀)'),
    ipc: !!a,
    http: !!b,
    preloadOk: pre.has(name),
    local: localOnly.isLocal(name),
    impl,
    desc: (jsdoc && jsdoc.desc) || '',
    srcFile: (jsdoc && jsdoc.file) || '',
    write: writes.has(name),
  }
})

// ---------- 一致性判定 ----------
const cmdRows = rows.filter((r) => !r.isRest)
// ⚠️ "只有 IPC、没有 HTTP" 里要**排除本机专属通道**：它们故意没有服务端实现。
const onlyIpc = cmdRows.filter((r) => r.ipc && !r.http && !r.local).map((r) => r.name)
const onlyHttp = cmdRows.filter((r) => !r.ipc && r.http).map((r) => r.name)
const ipcNotInPreload = cmdRows.filter((r) => r.ipc && !r.preloadOk).map((r) => r.name)
const preloadNotImpl = [...pre].filter((n) => !main.has(n)).sort()
const noImpl = cmdRows.filter((r) => !r.impl).map((r) => r.name)
const noDesc = cmdRows.filter((r) => !r.desc).map((r) => r.name)
const writeCount = cmdRows.filter((r) => r.write).length

/**
 * 说明串台的判据：**两条命令共用一个 desc，但 impl 不同** = 抽取或映射错了。
 * （共用同一个 impl 是合法的：一个实现挂两个通道名。）
 */
const descShareMismatch = (() => {
  const by = new Map()
  for (const r of cmdRows) {
    if (!r.desc) continue
    if (!by.has(r.desc)) by.set(r.desc, new Set())
    by.get(r.desc).add(r.impl)
  }
  return [...by.entries()]
    .filter(([, impls]) => impls.size > 1)
    .map(([desc, impls]) => ({ desc: desc.slice(0, 60), impls: [...impls] }))
})()

function healthReport() {
  console.log('命令面总览')
  console.log('  总命令数        : ' + cmdRows.length)
  console.log('  IPC 实现        : ' + main.size)
  console.log('  HTTP 实现       : ' + srv.invokes.size)
  console.log('  preload 白名单  : ' + pre.size)
  console.log('  有说明(desc)    : ' + (cmdRows.length - noDesc.length) + ' / ' + cmdRows.length)
  console.log('  能定位实现(impl): ' + (cmdRows.length - noImpl.length) + ' / ' + cmdRows.length)
  console.log('  写命令(write)   : ' + writeCount)
  console.log('')
  const show = (t, arr) => console.log('  ' + t.padEnd(30) + (arr.length ? arr.length + ' 条: ' + arr.slice(0, 8).join(', ') + (arr.length > 8 ? ' …' : '') : '无'))
  console.log('!! 三份拷贝的不一致（"幽灵问题"的来源）')
  show('只有 IPC、没有 HTTP', onlyIpc)
  show('只有 HTTP、没有 IPC', onlyHttp)
  show('有 IPC 实现但 preload 没放行', ipcNotInPreload)
  show('preload 放行但没有实现', preloadNotImpl)
  console.log('')
  console.log('!! 说明质量')
  show('说明串台（同一说明、不同实现）', descShareMismatch.map((d) => d.impls.join('+')))
  show('没有说明', noDesc)
}

if (process.argv.includes('--emit-registry')) {
  const out = path.join(ROOT, 'electron/commandRegistry.json')
  const payload = {
    // 由 scripts/command-surface.mjs --emit-registry 生成，勿手改；
    // 一致性由 scripts/verify-command-api.mjs 与 scripts/gen-command-doc.mjs --check 守护
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: 'main.js(IPC) + server.js(HTTP/WRITE_CHANNELS) + preload.cjs(白名单) + api.ts(本机专属) + commands/*.js(JSDoc)',
    total: cmdRows.length,
    restRoutes: rows.filter((r) => r.isRest).map((r) => r.name),
    writes: cmdRows.filter((r) => r.write).map((r) => r.name).sort(),
    health: {
      withDesc: cmdRows.length - noDesc.length,
      withImpl: cmdRows.length - noImpl.length,
      descShareMismatch: descShareMismatch.length,
    },
    commands: cmdRows.map((r) => ({
      name: r.name,
      group: r.group,
      desc: r.desc,
      impl: r.impl,
      ipc: r.ipc,
      http: r.http,
      preload: r.preloadOk,
      rest: false,
      // write=true：**会改账 / 改库 / 改本机文件或配置** —— Agent 与 CLI 据此决定要不要二次确认
      write: r.write,
      // local=true：**问的是本机**（故意没有服务端实现），只能在桌面机上调
      local: r.local,
    })),
  }
  fs.writeFileSync(out, JSON.stringify(payload, null, 1))
  console.log('已写 electron/commandRegistry.json：' + cmdRows.length + ' 条命令，写命令 ' + writeCount + ' 条，有说明 ' + (cmdRows.length - noDesc.length) + ' 条')
  process.exit(0)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), total: rows.length, commands: rows, inconsistencies: { onlyIpc, onlyHttp, ipcNotInPreload, preloadNotImpl, noImpl, noDesc, descShareMismatch } }, null, 1))
  process.exit(0)
}

healthReport()

if (process.argv.includes('--check')) {
  const problems = []
  if (descShareMismatch.length) problems.push('说明串台 ' + descShareMismatch.length + ' 处（同一说明挂在不同实现上）')
  if (ipcNotInPreload.length) problems.push('有 IPC 实现但 preload 没放行 ' + ipcNotInPreload.length + ' 条')
  if (preloadNotImpl.length) problems.push('preload 放行但没有实现 ' + preloadNotImpl.length + ' 条')
  if (onlyIpc.length) problems.push('只有 IPC、没有 HTTP ' + onlyIpc.length + ' 条（中心库模式下手机/Agent 打不到）')
  console.log('')
  if (problems.length) {
    console.log('!! 不通过：')
    for (const p of problems) console.log('   - ' + p)
    process.exit(1)
  }
  console.log('OK：命令面一致，说明没有串台')
}
