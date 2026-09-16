// 机器校验：inv-cli 命令行接口 —— 起一个**桩服务器**按真实契约应答，真跑一遍 CLI。
//
// 为什么要起桩：`/api/commands` 与 `/api/command` 是随 1.1.5 才进 server.js 的，
// 而本机装的是 1.1.4 —— 直接打真机会 404，验不出 CLI 的逻辑。桩按**读到的真实契约**应答
// （server.js 里 GET /api/commands?name=|group=|q= 与 POST /api/command {name,params}，都靠 x-token）。
//
// 两个踩过的坑，都写进注释免得下次再犯：
//   ① 用 `spawnSync` 会**阻塞事件循环** —— 桩服务器和被阻塞的主进程在同一个 Node 里，
//      子进程的请求永远等不到应答，直接死锁到超时。必须用异步 spawn。
//   ② 沙箱下不要把子进程 stdout 接到管道；CLI 支持 `--out <文件>`，
//      输出落文件再读，既绕开管道又是 CLI 本来就有用的功能。
//
// 跑法：node scripts/verify-cli.mjs
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'inv-cli.mjs')
const TOK = 'a'.repeat(32)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

const src = fs.readFileSync(CLI, 'utf8')
const strip = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const code = strip(src)

console.log('=== ① 命令面（子命令齐全 + 不硬编码令牌）===')
ok('有 list / groups / doc / run 四个子命令',
  /list:\s*cmdList/.test(code) && /groups:\s*cmdGroups/.test(code) && /doc:\s*cmdDoc/.test(code) && /run:\s*cmdRun/.test(code))
ok('令牌默认从本机 server-token.txt 读（与 server.js 同一文件）',
  /fishing-inventory/.test(code) && /server-token\.txt/.test(code))
ok('令牌只认 32 位十六进制', /\^\[0-9a-f\]\{32\}\$/.test(code))
ok('支持 --url / --token / --out 与 INV_URL / INV_TOKEN', /--url/.test(src) && /--out/.test(src) && /INV_URL/.test(code) && /INV_TOKEN/.test(code))
ok('没有写死的真实令牌', !/[0-9a-f]{32}/.test(code))

console.log('\n=== ② 安全：写命令必须显式 --yes，且确认在任何**写**请求之前 ===')
const runBody = code.slice(code.indexOf('async function cmdRun'), code.indexOf('const sub = argv[0]'))
ok('cmdRun 里有 --yes 门', /if \(!FLAG\('yes'\)\)/.test(runBody))
ok('拒绝文案给出可复制的完整命令', /确认要执行就加 --yes/.test(runBody))
ok('--yes 检查排在 await call( 之前（第一版栽在这：die 是 process.exit，.catch 兜不住）',
  runBody.indexOf("if (!FLAG('yes'))") !== -1 &&
  runBody.indexOf("if (!FLAG('yes'))") < runBody.indexOf('await call('))
ok('只读探测用 tryCall（非致命）：老服务端没有该端点时不会把命令打断',
  /await tryCall\('\/api\/commands\?name='/.test(runBody) && /async function tryCall/.test(code))
ok('拿不到标记 / 命令不在表里 → 一律按写处理（fail-safe）',
  /c\.write !== false/.test(runBody) && /注册表里没有这条命令/.test(runBody) && /问不到它的读写标记/.test(runBody))
ok('list 的读写标记是 fail-safe 的（不知道显示 [写?]，不显示 [读]）',
  /\[写\?\]/.test(code) && /c\.write === false \? '\[读\]'/.test(code))
ok('list --readonly 只认明确 write===false', /ONLY_READ\) cmds = cmds\.filter\(\(c\) => c\.write === false\)/.test(code))

console.log('\n=== ③ 真跑一遍：桩服务器按真实契约应答 ===')
const seen = []
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    seen.push({ method: req.method, path: u.pathname, token: req.headers['x-token'] || '', body })
    if (req.headers['x-token'] !== TOK) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (u.pathname === '/api/commands') {
      const nm = u.searchParams.get('name')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (nm) {
        // 三种情况都要能造出来：写命令(true) / 只读命令(false) / 老版本没有这个字段(undefined)
        const MARK = { 'data:loadAll': true, 'product:list': false, 'legacy:cmd': undefined }
        res.end(JSON.stringify({
          ok: true,
          command: { name: nm, group: 'data', desc: '取全量数据', write: MARK[nm] },
          channels: ['IPC（桌面渲染进程）', 'HTTP（POST /api/command）'],
          examples: { http: 'POST /api/command {"name":"' + nm + '","params":{}}' },
        }))
      } else {
        res.end(JSON.stringify({
          ok: true, total: 3, groups: { data: 1, product: 1, legacy: 1 }, filtered: 3,
          commands: [
            { name: 'data:loadAll', group: 'data', desc: '取全量数据', write: true },
            { name: 'product:list', group: 'product', desc: '商品列表', write: false },
            { name: 'legacy:cmd', group: 'legacy', desc: '老版本没标记' },
          ],
          restRoutes: [{ path: '/api/analytics/overview' }],
        }))
      }
      return
    }
    if (u.pathname === '/api/command' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: { echo: JSON.parse(body || '{}') } }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})

let seq = 0
const run = (args) => new Promise((resolve) => {
  const tag = 'fi-cli-' + (++seq) + '.txt'
  const out = path.join(os.tmpdir(), tag)
  try { fs.unlinkSync(out) } catch { /* 不存在就算了 */ }
  const c = spawn(process.execPath, [CLI, ...args, '--out', out], {
    stdio: 'ignore',
    env: { ...process.env, INV_URL: '', INV_TOKEN: TOK },
  })
  c.on('close', (status) => {
    let text = ''
    try { text = fs.readFileSync(out, 'utf8') } catch { /* 没写出来就是空 */ }
    try { fs.unlinkSync(out) } catch { /* ignore */ }
    resolve({ status, text })
  })
  c.on('error', () => resolve({ status: -1, text: '' }))
})

await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + srv.address().port
const U = ['--url', base, '--token', TOK]

try {
  const l = await run(['list', ...U])
  ok('list 退出码 0', l.status === 0, 'exit=' + l.status + ' ' + l.text.slice(0, 120))
  ok('list 打出命令名与总数', /data:loadAll/.test(l.text) && /共 3 个命令/.test(l.text))
  ok('list 打出只读 REST 提示', /\/api\/analytics\/overview/.test(l.text))

  const g = await run(['groups', ...U])
  ok('groups 退出码 0 且列出分组', g.status === 0 && /data/.test(g.text) && /product/.test(g.text))

  const d = await run(['doc', 'data:loadAll', ...U])
  ok('doc 退出码 0 且显示说明与 CLI 用法', d.status === 0 && /取全量数据/.test(d.text) && /inv-cli\.mjs run data:loadAll/.test(d.text))

  const before = seen.length
  const r1 = await run(['run', 'data:loadAll', ...U])
  ok('写命令 run 不带 --yes 被拒（退出码非 0）', r1.status !== 0)
  ok('拒绝文案让人知道加 --yes', /--yes/.test(r1.text))
  // 2026-09-16 起：拒绝之前允许发**一个只读探测**（问这条命令是不是写命令），
  // 但绝不允许发出**写请求**。旧断言是"一个请求都不发"，那条规则的本意是
  // "别在确认之前动数据" —— 现在按本意精确钉住：POST /api/command 次数必须为 0。
  const during = seen.slice(before)
  ok('拒绝时**没有发出写请求**（POST /api/command 次数为 0）',
    during.filter((s) => s.path === '/api/command').length === 0,
    '发了 ' + during.filter((s) => s.path === '/api/command').length + ' 个写请求')
  ok('拒绝时最多只发 1 个只读探测（GET /api/commands?name=）',
    during.length <= 1 && during.every((s) => s.method === 'GET' && s.path === '/api/commands'),
    JSON.stringify(during.map((s) => s.method + ' ' + s.path)))

  // 只读命令（write:false）**不带 --yes 也能直接跑** —— 这是这一版新增的能力
  const ro = await run(['run', 'product:list', ...U])
  ok('只读命令不带 --yes 能直接跑（退出码 0）', ro.status === 0, ro.text.slice(0, 160))
  ok('只读命令真的发出了调用', seen.filter((s) => s.path === '/api/command').length > 0)

  // 老版本服务端没有 write 字段 → 必须按「写」处理（fail-safe）
  const legacy = await run(['run', 'legacy:cmd', ...U])
  ok('拿不到 write 标记时按写处理（老服务端也拦得住）', legacy.status !== 0 && /没有读写标记|按「写」处理/.test(legacy.text), legacy.text.slice(0, 160))

  const roList = await run(['list', '--readonly', ...U])
  ok('list --readonly 只列只读命令', roList.status === 0 && /product:list/.test(roList.text) && !/data:loadAll/.test(roList.text))
  ok('list 每行带读写标记', /\[读\]/.test(roList.text) && /\[写\]/.test((await run(['list', ...U])).text))

  const gd = await run(['guide', ...U])
  ok('guide 退出码 0 且讲了三条路', gd.status === 0 && /\/api\/commands/.test(gd.text) && /\/api\/invoke/.test(gd.text) && /inv-cli\.mjs run/.test(gd.text))

  const r2 = await run(['run', 'data:loadAll', '--params', '{"a":1}', '--yes', ...U])
  ok('run 加 --yes 后退出码 0', r2.status === 0, r2.text.slice(0, 160))
  const posted = seen.filter((s) => s.path === '/api/command').pop()
  ok('POST /api/command，body 是 {name,params}', !!posted && JSON.parse(posted.body).name === 'data:loadAll' && JSON.parse(posted.body).params.a === 1)
  ok('请求带 x-token', !!posted && posted.token === TOK)
  ok('把服务端结果打出来', /"a": 1/.test(r2.text))

  const bad = await run(['list', '--url', base, '--token', 'b'.repeat(32)])
  ok('令牌错误时给明确提示（401）', bad.status !== 0 && /令牌不对/.test(bad.text))

  const down = await run(['list', '--url', 'http://127.0.0.1:1', '--token', TOK])
  ok('连不上时给明确提示（不是堆栈）', down.status !== 0 && /连不上/.test(down.text))
} finally {
  srv.close()
}

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
