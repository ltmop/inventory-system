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
 *   node scripts/inv-cli.mjs list [--group <组>] [--q <关键词>] [--json]
 *   node scripts/inv-cli.mjs groups
 *   node scripts/inv-cli.mjs doc <命令名> [--json]
 *   node scripts/inv-cli.mjs run <命令名> [--params '<JSON>'] --yes [--json]
 *
 * 连接（优先级：命令行 > 环境变量 > 默认）：
 *   --url   <地址>   INV_URL    默认 http://127.0.0.1:17532（本机看店服务）
 *   --token <令牌>   INV_TOKEN  默认读 %APPDATA%\fishing-inventory\server-token.txt
 *   --out   <文件>               把输出同时写到文件（给脚本/自动化用，不必解析 stdout）
 *
 * ⚠️ 安全设计：`run` **一律要求 --yes**。
 *   注册表（commandRegistry.json）里只有 group，**没有读/写标记**，
 *   所以 CLI 无法可靠区分「查一下」和「改一笔账」。与其猜错，不如一律显式确认——
 *   这是店里的账本，不能让一个脚本随手改。`list` / `doc` 是只读的，不需要 --yes。
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
  node scripts/inv-cli.mjs list [--group <组>] [--q <关键词>] [--json]
  node scripts/inv-cli.mjs groups
  node scripts/inv-cli.mjs doc <命令名> [--json]
  node scripts/inv-cli.mjs run <命令名> [--params '<JSON>'] --yes [--json]

连接：
  --url <地址>    默认 ${URL_BASE}
  --token <令牌>  默认读本机 %APPDATA%\\fishing-inventory\\server-token.txt
  --out <文件>    把输出同时写到文件（给脚本用）
  也可用环境变量 INV_URL / INV_TOKEN

注意：run 必须带 --yes（注册表没有读/写标记，无法可靠区分查询与改账）。
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

/** 把 {result:x} 与直接对象统一成业务结果 */
const unwrap = (d) => (d && typeof d === 'object' && 'result' in d ? d.result : d)

async function cmdList() {
  const qs = new URLSearchParams()
  const g = opt('group'); if (g && g !== true) qs.set('group', String(g))
  const q = opt('q'); if (q && q !== true) qs.set('q', String(q))
  const r = await call('/api/commands' + (qs.toString() ? '?' + qs : ''))
  if (AS_JSON) { say(JSON.stringify(r, null, 2)); return }
  const groups = r.groups || {}
  say(`共 ${r.total} 个命令，本次列出 ${r.filtered} 个`)
  say('分组：' + Object.entries(groups).map(([k, n]) => `${k}(${n})`).join('  '))
  say('')
  for (const c of r.commands || []) {
    say(`  ${String(c.name).padEnd(34)} ${c.group ? '[' + c.group + '] ' : ''}${c.desc || ''}`)
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
  say('可用  : ' + (r.channels || []).join(' / '))
  if (c.params || c.args) say('参数  : ' + JSON.stringify(c.params ?? c.args))
  if (r.examples) {
    say('')
    say('HTTP  : ' + r.examples.http)
    say('IPC   : ' + r.examples.ipc)
    say('CLI   : node scripts/inv-cli.mjs run ' + c.name + " --params '{}' --yes")
  }
}

async function cmdRun() {
  const name = argv[1]
  if (!name) die("用法：run <命令名> [--params '<JSON>'] --yes")
  const raw = opt('params')
  let params = {}
  if (raw && raw !== true) {
    try { params = JSON.parse(String(raw)) } catch (e) { die('--params 不是合法 JSON：' + e.message) }
  }
  // ⚠️ 确认必须在**任何网络请求之前**：die() 是 process.exit(1)，.catch 兜不住。
  //    第一版先发了一次 /api/commands 想顺带拿命令描述，结果在没有该端点的版本上
  //    直接 404 退出，连「请加 --yes」这句提示都没打出来。
  if (!FLAG('yes')) {
    die(`拒绝执行 ${name}（未加 --yes）\n  注册表里只有 group、没有读/写标记，CLI 无法可靠区分「查询」和「改账」。\n  确认要执行就加 --yes：\n    node scripts/inv-cli.mjs run ${name} --params '${JSON.stringify(params)}' --yes`)
  }
  const r = unwrap(await call('/api/command', { method: 'POST', body: JSON.stringify({ name, params }) }))
  if (AS_JSON) { say(JSON.stringify(r, null, 2)); return }
  if (r === null || r === undefined) { say('（命令执行成功，无返回值）'); return }
  if (typeof r === 'object') say(JSON.stringify(r, null, 2))
  else say(String(r))
}

const sub = argv[0]
if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { usage(); flush(); process.exit(0) }
const run = { list: cmdList, groups: cmdGroups, doc: cmdDoc, run: cmdRun }[sub]
if (!run) { console.error('✗ 未知子命令: ' + sub + '\n'); usage(); flush(); process.exit(2) }
await run()
flush()
