#!/usr/bin/env node
/**
 * 接口文档生成器：从 electron/commandRegistry.json 生成 docs/命令接口-接口文档.md
 *
 * 为什么这么做：以前接口文档是手写的，代码一改文档就过期（现有那几份就是这么烂掉的）。
 * 现在文档是**生成物**  改完命令跑两条命令即可，且 --check 能机器校验"文档与代码一致"。
 *
 * 用法：
 *   node scripts/gen-command-doc.mjs           # 生成/更新文档
 *   node scripts/gen-command-doc.mjs --check   # 只校验（不一致则 exit 1，可进 CI/断言闸门）
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const REG = path.join(ROOT, 'electron/commandRegistry.json')
const OUT = path.join(ROOT, 'docs/命令接口-接口文档.md')
const CHECK = process.argv.includes('--check')
const NL = String.fromCharCode(10)

const reg = JSON.parse(fs.readFileSync(REG, 'utf8'))
const cmds = (reg.commands || []).filter((c) => !c.rest)
const groups = {}
for (const c of cmds) (groups[c.group] = groups[c.group] || []).push(c)

const chan = (c) => [c.ipc ? 'IPC' : '', c.http ? 'HTTP' : ''].filter(Boolean).join(' + ') || ''

const lines = []
const P = (s = '') => lines.push(s)

P('# 进销存系统  命令接口文档')
P('')
P('> **本文档是生成物，请勿手改。**')
P('> 生成器：`scripts/gen-command-doc.mjs`　数据源：`electron/commandRegistry.json`')
P('> 注册表由 `scripts/command-surface.mjs --emit-registry` 从三处代码 + JSDoc 抽取而来。')
P('> 校验：`node scripts/gen-command-doc.mjs --check`（不一致即失败）｜命令接口验收：`node scripts/verify-command-api.mjs`')
P('')
P('| 项 | 值 |')
P('|---|---|')
P('| 可执行命令总数 | **' + reg.total + '** |')
P('| 前缀（分组）数 | ' + Object.keys(groups).length + ' |')
P('| 只读 REST 路径 | ' + (reg.restRoutes || []).length + ' |')
P('| 注册表 schemaVersion | ' + reg.schemaVersion + ' |')
P('| 抽取自 | ' + (reg.source || '') + ' |')
P('')
P('---')
P('')
P('## 一、三条通道（同一套命令，三种入口）')
P('')
P('| 通道 | 入口 | 鉴权 | 适用 |')
P('|---|---|---|---|')
P('| **IPC** | 渲染进程 `window.fi.invoke(\'<命令名>\', <参数>)` | Electron contextIsolation + `preload.cjs` 白名单 | 桌面界面、命令台 |')
P('| **HTTP 通用** | `POST /api/command`，体 `{"name":"<命令名>","params":{...}}` | `x-token` 或 `?token=`（与整站同一套）；写命令另受只读令牌限制 | 手机端、中央库、外部 Agent |')
P('| **HTTP 传统** | `POST /api/invoke`，体 `{"channel":"<命令名>","payload":{...}}` | 同上 | 既有手机端/桌面中心库模式（兼容保留） |')
P('| **CLI** | `scripts/inv.mjs`（云同步）、`scripts/inv-analytics.mjs`（经营分析） | 各自配置 | 命令行、脚本、定时任务 |')
P('')
P('> 自省：`GET /api/commands`（全集/`?group=`/`?q=`）、`GET /api/commands?name=<命令名>`（单条详情）；IPC 侧对应 `commands:list` / `commands:describe`。')
P('')
P('### 调用示例')
P('')
P('```bash')
P('# HTTP 通用入口（推荐给外部集成；token 见「设置  手机看店」或中心库状态）')
P("curl -s -X POST http://127.0.0.1:3200/api/command \\")
P("  -H 'content-type: application/json' -H 'x-token: <TOKEN>' \\")
P("  -d '{\"name\":\"data:loadAll\",\"params\":{}}'")
P('')
P('# 先查有哪些命令 / 某条命令怎么调')
P("curl -s http://127.0.0.1:3200/api/commands?q=库存 -H 'x-token: <TOKEN>'")
P("curl -s 'http://127.0.0.1:3200/api/commands?name=product:create' -H 'x-token: <TOKEN>'")
P('```')
P('')
P('```js')
P('// 桌面渲染进程（命令台走的就是这条）')
P("await window.fi.invoke('product:create', { name: '红茶', sku_code: 'SKU-1', cost_price: 10 })")
P('```')
P('')
P('---')
P('')
P('## 二、命令全集（按前缀分组）')
P('')
P('> 描述取自 `electron/commands/*.js` 的 JSDoc；标 `` 表示该函数还没有注释，欢迎顺手补上再重新生成。')
P('')
const order = Object.keys(groups).sort((a, b) => (groups[b].length - groups[a].length) || a.localeCompare(b))
for (const g of order) {
  const list = groups[g].sort((a, b) => a.name.localeCompare(b.name))
  P('### `' + g + '`（' + list.length + ' 条）')
  P('')
  P('| 命令 | 通道 | 说明 | 底层实现 |')
  P('|---|---|---|---|')
  for (const c of list) {
    P('| `' + c.name + '` | ' + chan(c) + ' | ' + (c.desc ? c.desc.replace(/\|/g, '\\|') : '') + ' | ' + (c.impl ? '`' + c.impl + '`' : '') + ' |')
  }
  P('')
}
if ((reg.restRoutes || []).length) {
  P('---')
  P('')
  P('## 三、只读 REST 路径（GET，不属于命令接口）')
  P('')
  P('这些是最早的只读取数接口，图表/外部 Agent 在用；**不要**用 `/api/command` 调它们。')
  P('')
  for (const r of reg.restRoutes) P('- `' + r + '`')
  P('')
}
P('---')
P('')
P('## 四、改动命令后怎么让文档跟上')
P('')
P('```bash')
P('# 1) 改代码（main.js 的 handle / server.js 的 INVOKE_CHANNELS / commands/*.js 的 JSDoc）')
P('# 2) 重新抽取注册表')
P('node scripts/command-surface.mjs --emit-registry')
P('# 3) 重新生成文档')
P('node scripts/gen-command-doc.mjs')
P('# 4) 校验（不一致会 exit 1，可挂进断言闸门）')
P('node scripts/command-surface.mjs && node scripts/gen-command-doc.mjs --check && node scripts/verify-command-api.mjs')
P('```')
P('')
P('> 顺带提醒：新增 IPC 命令时，**别忘了 `electron/preload.cjs` 的 `CHANNELS` 白名单**  ')
P('> 2026-09-13 就踩过一次：通道注册了但没放行，前端调用直接报「未知通道」。')
P('> `node scripts/command-surface.mjs` 会把这个不一致列出来。')
P('')

const doc = lines.join(NL) + NL

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (cur === doc) { console.log(' 接口文档与注册表一致（' + cmds.length + ' 条命令）') ; process.exit(0) }
  console.error(' 接口文档已过期：请运行 node scripts/gen-command-doc.mjs')
  // 给出简要差异提示
  const a = cur.split(NL), b = doc.split(NL)
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  console.error('  首个差异在第 ' + (i + 1) + ' 行：')
  console.error('    文档: ' + JSON.stringify((a[i] || '').slice(0, 100)))
  console.error('    期望: ' + JSON.stringify((b[i] || '').slice(0, 100)))
  process.exit(1)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, doc)
console.log('已生成 docs/命令接口-接口文档.md：' + cmds.length + ' 条命令 / ' + Object.keys(groups).length + ' 个前缀 / ' + (reg.restRoutes || []).length + ' 条 REST 路径')