#!/usr/bin/env node
/**
 * inv-cli —— 进销存的**命令行接口**（CLI）
 *
 * 为什么要有它（2026-09-14）：
 *   系统早就有 HTTP 命令 API（`GET /api/commands`、`POST /api/command`）和命令台 UI，
 *   但 `electron/commandApi.js` 里那句 CLI 示例写的是 `node -e ""` —— **等于没有 CLI**。
 *   于是「用脚本/AI 批量干活」只能手写 curl：自己拼 URL、自己找 token、自己记 JSON 形状。
 *   这个脚本把那三件事收成一条命令。
 *
 * 用法：
 *   node scripts/inv-cli.mjs guide
 *   node scripts/inv-cli.mjs list [--group <组>] [--q <关键词>] [--readonly|--writes] [--json]
 *   node scripts/inv-cli.mjs groups
 *   node scripts/inv-cli.mjs doc <命令名> [--json]
 *   node scripts/inv-cli.mjs run <命令名> [--params '<JSON>'] [--yes] [--json]
 *
 * 连接（优先级：命令行 > 环境变量 > 默认）：
 *   --url   <地址>   INV_URL    默认 http://127.0.0.1:17532（本机看店服务）
 *   --token <令牌>   INV_TOKEN  默认读 %APPDATA%\fishing-inventory\server-token.txt
 *   --out   <文件>               把输出同时写到文件（给脚本/自动化用，不必解析 stdout）
 *
 * ⚠️ 安全设计（2026-09-16 更新）：**只读命令直接跑；写命令必须 --yes**。
 *   注册表 `electron/commandRegistry.json` 现在带 `write` 标记（会改账/改库/改本机文件的为 true），
 *   CLI 据此放行或拦下。三条铁律：
 *     · 拿不到 `write` 标记（老版本服务端、命令不在表里）→ **一律按写处理**（fail-safe），
 *       绝不会因为"读不到标记"就把改账命令放行；
 *     · 判断在**发请求之前**做（`die()` 是 process.exit，不能先发一次请求再说）；
 *     · `--yes` 永远能跑（人要显式确认时不受标记影响）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)

/** 取 --key value 形式的参数 */
function opt(name, fallback = undefined) {
  const i = argv.indexOf('--' + name)
  if (i === -1) return fallback
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const FLAG = (name) => argv.includes('--' + name)

const AS_JSON = FLAG('json')
const OUT_FILE = typeof opt('out') === 'string' ? String(opt('out')) : ''
const URL_BASE = String(opt('url', process.env.INV_URL || 'http://127.0.0.1:17532')).replace(/\/$/, '')

// 输出缓冲：同时写 stdout 和 --out 指定的文件。
// 有 --out 是为了**自动化**（脚本/AI 直接读文件，不必解析终端输出），
// 顺带让测试能在不捕获子进程管道的情况下断言输出。
let BUF = ''
function say(s = '') {
  BUF += String(s) + '\n'
  console.log(s)
}
function flush() {
  if (!OUT_FILE) return
  try { fs.writeFileSync(OUT_FILE, BUF, 'utf8') } catch { /* 写不进就算了，stdout 还有 */ }
}

/** 本机令牌：与 electron/server.js 的 loadOrCreateToken 同一个文件 */
function localToken() {
  const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'fishing-inventory', 'server-token.txt')
  try {
    const t = fs.readFileSync(p, 'utf8').trim()
    return /^[0-9a-f]{32}$/.test(t) ? t : ''
  } catch {
    return ''
  }
}
const TOKEN = String(opt('token', process.env.INV_TOKEN || localToken() || ''))

function die(msg, code = 1) {
  BUF += '✗ ' + msg + '\n'
  console.error('✗ ' + msg)
  flush()
  process.exit(code)
}

function usage() {
  say(`inv-cli —— 进销存命令行接口

用法：
  node scripts/inv-cli.mjs guide                             # 5 分钟接入说明
  node scripts/inv-cli.mjs list [--group <组>] [--q <关键词>] [--readonly|--writes] [--json]
  node scripts/inv-cli.mjs groups
  node scripts/inv-cli.mjs doc <命令名> [--json]
  node scripts/inv-cli.mjs run <命令名> [--params '<JSON>' | --params-file <文件>] [--yes] [--json]

连接：
  --url <地址>    默认 ${URL_BASE}
  --token <令牌>  默认读本机 %APPDATA%\\fishing-inventory\\server-token.txt
  --out <文件>    把输出同时写到文件（给脚本用）
  也可用环境变量 INV_URL / INV_TOKEN

读写：
  标了「读」的命令可以直接跑；标了「写」的命令必须加 --yes（会改账/改库/改本机文件）。
  用 list --readonly 只看只读命令。
`)
}

function guide() {
  say(`进销存系统 —— Agent 接入（5 分钟）

三条路，同一套命令、同一个令牌：

1) 先看有什么能调（只读自省）
   GET  ${URL_BASE}/api/commands                  全部命令（带 说明 / 读写 / 是否本机）
   GET  ${URL_BASE}/api/commands?name=<命令名>     单条详情（含示例）
   CLI  node scripts/inv-cli.mjs list --readonly   只列"可以直接跑"的

2) 调一条命令（通用入口）
   POST ${URL_BASE}/api/invoke    body {"channel":"<命令名>","payload":{...}}   头 x-token: <令牌>
   （/api/command 是同一个入口，body 用 {"name":...,"params":{...}}）
   CLI  node scripts/inv-cli.mjs run <命令名> --params '{}'          ← 只读命令，直接跑
        node scripts/inv-cli.mjs run <命令名> --params '{}' --yes    ← 写命令，必须加 --yes

3) 只读 REST（GET，适合做看板 / 定时巡检）
   /api/summary  /api/low-stock  /api/inventory  /api/today  /api/customers  /api/audit
   /api/analytics/overview  /api/analytics/trend  /api/analytics/category
   /api/analytics/top  /api/analytics/stockValue  /api/commands

令牌从哪来：本机 %APPDATA%\\fishing-inventory\\server-token.txt
  （界面里在「设置 → 手机看店」也能看到；中心库模式下要用**中心库那台**的令牌）
  也可用 --token / INV_TOKEN / --url / INV_URL 覆盖。

安全：写命令（create/update/delete/pay/restore/set…）会改账，必须显式 --yes。
      本机专属命令（local=true）只能在这台桌面机上跑，手机/中心库打不到。
`)
}

async function call(pathname, init = {}) {
  if (!TOKEN) {
    die('拿不到令牌：请确认本机应用已启动（会生成 server-token.txt），或用 --token / INV_TOKEN 指定')
  }
  let r
  try {
    r = await fetch(URL_BASE + pathname, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-token': TOKEN, ...(init.headers || {}) },
    })
  } catch (e) {
    die(`连不上 ${URL_BASE} —— 应用没开、或「手机看店/局域网服务」没启动（错误：${e.message}）`)
  }
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { die(`返回不是 JSON（HTTP ${r.status}）：` + text.slice(0, 200)) }
  if (r.status === 401) die('令牌不对（HTTP 401）—— 从本机 server-token.txt 复制，或用 --token 指定')
  if (!r.ok) die(`请求失败 HTTP ${r.status}：` + (data?.error || text.slice(0, 200)))
  return data
}

/**
 * **非致命**的调用：失败返回 { ok:false, error } 而不是退出。
 * 用来"问一句再决定"，绝不能因为它失败就把整个命令打断（老服务端可能没这个端点）。
 */
async function tryCall(pathname) {
  if (!TOKEN) return { ok: false, error: '拿不到令牌' }
  try {
    const r = await fetch(URL_BASE + pathname, { headers: { 'content-type': 'application/json', 'x-token': TOKEN } })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
    return { ok: true, data: await r.json() }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 把 {result:x} 与直接对象统一成业务结果 */
const unwrap = (d) => (d && typeof d === 'object' && 'result' in d ? d.result : d)

/**
 * 一行里显示读写标记。
 * ⚠️ 拿不到标记时显示 `[写?]` 而**不是** `[读]` —— 老版本服务端的注册表没有 write 字段，
 *    把"不知道"显示成"只读"正好是危险的那个方向（人会以为可以直接跑）。
 */
const mark = (c) => (c.write === false ? '[读]' : c.write === true ? '[写]' : '[写?]') + (c.local ? '[本机]' : '')

async function cmdList() {
  const qs = new URLSearchParams()
  const g = opt('group'); if (g && g !== true) qs.set('group', String(g))
  const q = opt('q'); if (q && q !== true) qs.set('q', String(q))
  const r = await call('/api/commands' + (qs.toString() ? '?' + qs : ''))
  let cmds = r.commands || []
  const ONLY_READ = FLAG('readonly'), ONLY_WRITE = FLAG('writes')
  // 过滤也要 fail-safe：只有**明确** write===false 才算只读；"不知道"归到写那一侧
  if (ONLY_READ) cmds = cmds.filter((c) => c.write === false)
  if (ONLY_WRITE) cmds = cmds.filter((c) => c.write !== false)
  if (AS_JSON) { say(JSON.stringify({ ...r, filtered: cmds.length, commands: cmds }, null, 2)); return }
  const groups = r.groups || {}
  say(`共 ${r.total} 个命令${ONLY_READ ? '（只看只读）' : ONLY_WRITE ? '（只看写）' : ''}，本次列出 ${cmds.length} 个`)
  if (!cmds.some((c) => typeof c.write === 'boolean')) {
    say('⚠️ 这台服务端的注册表**没有读写标记**（老版本）—— 一律按「写」处理：run 全部需要 --yes。')
    say('   升级到带标记的版本后，只读命令就能直接跑了。')
  }
  say('分组：' + Object.entries(groups).map(([k, n]) => `${k}(${n})`).join('  '))
  say('')
  for (const c of cmds) {
    say(`  ${mark(c).padEnd(12)} ${String(c.name).padEnd(32)} ${c.desc || ''}`)
  }
  if ((r.restRoutes || []).length) {
    say('')
    say('只读 REST（GET，同一套 token）：')
    for (const x of r.restRoutes) say('  ' + (x.path || x))
  }
}

async function cmdGroups() {
  const r = await call('/api/commands')
  if (AS_JSON) { say(JSON.stringify(r.groups || {}, null, 2)); return }
  for (const [k, n] of Object.entries(r.groups || {}).sort((a, b) => b[1] - a[1])) {
    say(`  ${String(k).padEnd(14)} ${n}`)
  }
}

async function cmdDoc() {
  const name = argv[1]
  if (!name) die('用法：doc <命令名>')
  const r = await call('/api/commands?name=' + encodeURIComponent(name))
  if (AS_JSON) { say(JSON.stringify(r, null, 2)); return }
  if (r.ok === false) die(r.error || ('未找到命令 ' + name))
  const c = r.command || {}
  say('命令  : ' + c.name)
  say('分组  : ' + (c.group || '-'))
  say('说明  : ' + (c.desc || '-'))
  say('读写  : ' + (c.write === true ? '写（会改账/改库/改本机文件）—— run 必须加 --yes'
    : c.write === false ? '读（只查不改）—— run 可以直接跑'
      : '未知（老版本注册表）—— 按写处理，run 需要 --yes'))
  say('范围  : ' + (c.local ? '本机专属（只能在这台桌面机上跑）' : c.http ? '本机 + 中心库/局域网都能调' : '本机'))
  if (c.impl) say('实现  : ' + c.impl)
  say('可用  : ' + (r.channels || []).join(' / '))
  if (c.params || c.args) say('参数  : ' + JSON.stringify(c.params ?? c.args))
  if (r.examples) {
    say('')
    say('HTTP  : ' + r.examples.http)
    say('IPC   : ' + r.examples.ipc)
    say('CLI   : node scripts/inv-cli.mjs run ' + c.name + " --params '{}'" + (c.write === false ? '' : ' --yes'))
  }
}

async function cmdRun() {
  const name = argv[1]
  if (!name) die("用法：run <命令名> [--params '<JSON>'] [--yes]")
  const raw = opt('params')
  const pfile = opt('params-file')
  let params = {}
  if (pfile && pfile !== true) {
    // 为什么要有它：Windows 上把一整串 JSON 塞进命令行很容易被引号规则吃掉
    //（实测 PowerShell 下 `--params '{"a":1}'` 传过去会变成坏 JSON）。
    // 参数长一点就该走文件 —— 对 Agent 尤其重要，它拼长 JSON 比人更容易踩这个坑。
    try { params = JSON.parse(fs.readFileSync(String(pfile), 'utf8')) } catch (e) { die('--params-file 读不了或不是合法 JSON：' + e.message) }
  } else if (raw && raw !== true) {
    try { params = JSON.parse(String(raw)) } catch (e) { die('--params 不是合法 JSON：' + e.message + '\n  提示：参数长/带引号时改用 --params-file <文件>') }
  }

  // ⚠️ 确认必须在**任何会写数据的请求之前**，而且"问标记"这一步不能致命：
  //    老版本服务端没有 write 字段、或命令不在表里 → 一律按写处理（fail-safe）。
  //    第一版先发了一次 /api/commands 想拿描述，结果在没有该端点的版本上直接 404 退出，
  //    连「请加 --yes」这句提示都没打出来 —— 所以这里用 tryCall。
  if (!FLAG('yes')) {
    const probe = await tryCall('/api/commands?name=' + encodeURIComponent(name))
    const c = probe.ok ? probe.data?.command : null
    if (!probe.ok) {
      die(`拒绝执行 ${name}：问不到它的读写标记（${probe.error}）—— 按写处理。\n  确认要执行就加 --yes：\n    node scripts/inv-cli.mjs run ${name} --params '${JSON.stringify(params)}' --yes`)
    }
    if (!c) {
      die(`拒绝执行 ${name}：注册表里没有这条命令（可能是打错名字）。\n  用 list 查全集；确认要执行就加 --yes：\n    node scripts/inv-cli.mjs run ${name} --params '${JSON.stringify(params)}' --yes`)
    }
    if (c.write !== false) {
      const why = c.write === true
        ? `拒绝执行 ${name}（**写命令**，会改账/改库/改本机文件）。`
        : `拒绝执行 ${name}（这台服务端没有读写标记，按「写」处理）。`
      die(`${why}\n  说明：${c.desc || '(无)'}\n  确认要执行就加 --yes：\n    node scripts/inv-cli.mjs run ${name} --params '${JSON.stringify(params)}' --yes`)
    }
  }

  const r = unwrap(await call('/api/command', { method: 'POST', body: JSON.stringify({ name, params }) }))
  if (AS_JSON) { say(JSON.stringify(r, null, 2)); return }
  if (r === null || r === undefined) { say('（命令执行成功，无返回值）'); return }
  if (typeof r === 'object') say(JSON.stringify(r, null, 2))
  else say(String(r))
}

const sub = argv[0]
if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { usage(); flush(); process.exit(0) }
const run = { guide, list: cmdList, groups: cmdGroups, doc: cmdDoc, run: cmdRun }[sub]
if (!run) { console.error('✗ 未知子命令: ' + sub + '\n'); usage(); flush(); process.exit(2) }
await run()
flush()
