// MCP 外壳的独立自检：一条命令验证「注册表 → MCP tools → 真调一次命令」这条链没断。
//
// 为什么单独一个脚本：test-backend.mjs 里也有 MCP 的端到端断言，但那要跑完整套（几分钟）。
// 改完 mcp-server.mjs 想快速确认时，跑这个就够（会自己起一个临时服务端 + 临时库，不碰生产）。
//
// 用法：node scripts/verify-mcp.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../electron/db.js'
import { createInventoryServer } from '../electron/server.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const ok = (desc, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + desc)
  else { fail++; console.log('  ✗ ' + desc + (detail ? '  [' + detail + ']' : '')) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-mcp-verify-'))
const db = openDatabase(path.join(tmp, 'mcp.db'))
const srv = createInventoryServer({ db, dataDir: path.join(tmp, 'srv'), basePort: 0 })
const st = await srv.start()
const base = `http://127.0.0.1:${st.port}`
const token = fs.readFileSync(path.join(tmp, 'srv', 'server-token.txt'), 'utf8').trim()

console.log('=== MCP 外壳自检（' + base + '）===')
const out = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/mcp-server.mjs', '--url', base, '--token', token, '--selftest'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let so = ''
  let se = ''
  child.stdout.on('data', (d) => { so += d })
  child.stderr.on('data', (d) => { se += d })
  child.on('close', (code) => resolve({ code, so, se }))
})

let info = null
try { info = JSON.parse(out.so) } catch { /* 下面报错 */ }
ok('--selftest 正常退出', out.code === 0, 'code=' + out.code + ' stderr=' + out.se.trim().slice(0, 120))
ok('拿到工具清单（> 50 条，来自 /api/commands 注册表）', !!info && info.tools > 50, info ? 'tools=' + info.tools : out.so.slice(0, 120))
ok('默认只读（没开 --allow-write）', !!info && info.allowWrite === false)
ok('自省接口可用（inventory_command_doc 能取到清单）', !!info && info.docOk === true)

await srv.stop()
db.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(fail === 0 ? '\nMCP 自检全部通过' : `\nMCP 自检未通过：${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
