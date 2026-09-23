#!/usr/bin/env node
/**
 * MCP 外壳（Model Context Protocol，stdio）—— 把本系统已有的**命令面**原样端给任何支持 MCP 的 AI 客户端。
 *
 * 为什么这么薄（2026-09-22 owner 拍板「先把 MCP 外壳包出来」）：
 *   这套系统**早就有一个自描述的命令注册表**了：`electron/commandRegistry.json`（由
 *   `scripts/command-surface.mjs --emit-registry` 从源码现算），HTTP 侧对应
 *     · `GET  /api/commands`            自省（清单/单条/按前缀或关键词过滤）
 *     · `POST /api/command  {name, params}`  调用
 *     · `GET  /api/agent`               接入说明
 *   所以 MCP 不需要"再实现一套能力" —— 只要把注册表翻译成 MCP 的 tools、把 tools/call 转成一次
 *   `/api/command`。**这不是新功能，是把已有的门接到标准插座上。**
 *
 * 零依赖：不引 @modelcontextprotocol/sdk，只用 node 自带能力实现 stdio 上的 JSON-RPC 2.0
 *   （因为项目里没有把 SDK 加进依赖的打算，多一个依赖就多一份要维护/要审计的东西）。
 *
 * 安全默认（与项目一贯立场一致：只读免确认、写操作必须显式授权）：
 *   · 默认**只暴露只读命令**（注册表里 write=false 的那些）；
 *   · 要暴露写命令必须显式给 `--allow-write`（或设 `FI_MCP_ALLOW_WRITE=1`）——
 *     写命令会改账/改库/改本机文件，不该由"接上就能用"的默认值打开。
 *
 * 用法：
 *   node scripts/mcp-server.mjs --url https://app.junchengzn.com --token <令牌>
 *   node scripts/mcp-server.mjs --local                     # 用本机那份 server-token.txt + 127.0.0.1 端口
 *   node scripts/mcp-server.mjs --url ... --token ... --allow-write --selftest
 *
 * 客户端配置示例（Claude Desktop / Cursor 等）：
 *   { "mcpServers": { "inventory": { "command": "node",
 *       "args": ["<仓库路径>/scripts/mcp-server.mjs", "--url", "https://app.junchengzn.com", "--token", "<令牌>"] } } }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const arg = (name, dflt = '') => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const SELFTEST = argv.includes('--selftest')
const ALLOW_WRITE = argv.includes('--allow-write') || process.env.FI_MCP_ALLOW_WRITE === '1'
const GROUP = arg('group', '')
const log = (...a) => { try { console.error('[mcp]', ...a) } catch { /* stderr 关了也不能崩 */ } }

/** 本机模式的 baseUrl：桌面端的旧版通道缺口提示里写着默认端口，这里跟着走 */
const LOCAL_DEFAULT_URL = 'http://127.0.0.1:3200'

function resolveConfig() {
  let url = arg('url', process.env.FI_URL || '')
  let token = arg('token', process.env.FI_TOKEN || '')
  if (argv.includes('--local') || (!url && !token)) {
    // 本机：令牌在桌面端的数据目录里（与「设置 → 手机看店」显示的是同一份）
    const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'fishing-inventory')
    try {
      token = token || fs.readFileSync(path.join(dir, 'server-token.txt'), 'utf8').trim()
    } catch { /* 读不到就算了，下面会报缺令牌 */ }
    url = url || LOCAL_DEFAULT_URL
  }
  return { url: url.replace(/\/+$/, ''), token }
}

const cfg = resolveConfig()
if (!cfg.token) {
  log('缺少令牌：给 --token，或设 FI_TOKEN，或用 --local（读 %APPDATA%\\fishing-inventory\\server-token.txt）')
  process.exit(2)
}

/** 调一次 HTTP 接口；返回 { ok, status, data }，绝不抛（把失败变成 MCP 的 isError 文本） */
async function api(pathname, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(cfg.url + pathname, {
      method,
      headers: { 'content-type': 'application/json', 'x-token': cfg.token },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: { error: '连不上 ' + cfg.url + '：' + (e?.message ?? e) } }
  }
}

/** 命令名 → MCP 工具名：MCP 的工具名只允许 [A-Za-z0-9_-]，而我们的通道名带冒号 */
const toToolName = (channel) => channel.replace(/[:.]/g, '_')

let toolsCache = null
async function loadTools() {
  if (toolsCache) return toolsCache
  const r = await api('/api/commands' + (GROUP ? '?group=' + encodeURIComponent(GROUP) : ''))
  if (!r.ok || !Array.isArray(r.data?.commands)) {
    throw new Error('取命令清单失败（HTTP ' + r.status + '）：' + (r.data?.error || '返回里没有 commands'))
  }
  const byTool = new Map()
  const tools = []
  for (const c of r.data.commands) {
    if (c.write !== false && !ALLOW_WRITE) continue // 默认只放只读
    const name = toToolName(c.name)
    if (byTool.has(name)) continue // 理论不会撞（冒号/点都换成下划线），真撞了保留先到的那条
    byTool.set(name, c.name)
    tools.push({
      name,
      description: (c.desc || '（这条命令还没写说明，用 inventory_command_doc 查）') + (c.write !== false ? '【写操作】' : ''),
      inputSchema: {
        type: 'object',
        properties: {
          params: {
            type: 'object',
            description: '命令参数对象；具体字段见工具 inventory_command_doc（或 GET /api/commands?name=…）。没有参数就省略。',
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
    })
  }
  toolsCache = { tools, byTool }
  return toolsCache
}

/** 两个自省工具：让人（和模型）随时能查到权威清单与单条说明 */
const META_TOOLS = [
  {
    name: 'inventory_command_doc',
    description: '查本系统的命令清单或某一条命令的说明/读写标记（数据源：GET /api/commands，与源码注册表同一份）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '命令名，如 report:lowStock；不填则只统计' },
        q: { type: 'string', description: '按关键词过滤说明' },
        group: { type: 'string', description: '按前缀过滤，如 report' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inventory_agent_guide',
    description: '取接入说明（GET /api/agent）：鉴权方式、入口清单、CLI 路径。接一个新的 MCP 客户端前先读它',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

async function callTool(name, args) {
  if (name === 'inventory_command_doc') {
    const qs = new URLSearchParams()
    if (args?.name) qs.set('name', args.name)
    if (args?.q) qs.set('q', args.q)
    if (args?.group) qs.set('group', args.group)
    const r = await api('/api/commands' + (qs.toString() ? '?' + qs : ''))
    return { text: JSON.stringify(r.data, null, 2), isError: !r.ok }
  }
  if (name === 'inventory_agent_guide') {
    const r = await api('/api/agent')
    return { text: JSON.stringify(r.data, null, 2), isError: !r.ok }
  }
  const { byTool } = await loadTools()
  const channel = byTool.get(name)
  if (!channel) {
    return { text: `未知工具「${name}」。用 inventory_command_doc 查可用命令（默认只暴露只读命令）。`, isError: true }
  }
  const r = await api('/api/command', { method: 'POST', body: { name: channel, params: args?.params ?? {} } })
  if (!r.ok || r.data?.ok === false) {
    return { text: `调用 ${channel} 失败（HTTP ${r.status}）：` + (r.data?.error || JSON.stringify(r.data)), isError: true }
  }
  const out = r.data?.result ?? r.data
  return { text: typeof out === 'string' ? out : JSON.stringify(out, null, 2), isError: false }
}

/** JSON-RPC 2.0 over stdio（MCP 的 stdio 传输：一行一个 JSON 对象） */
async function handle(msg) {
  const { id, method, params } = msg
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

  if (method === 'initialize') {
    return reply({
      // 回客户端要的版本；它没给就用一个我们实现得最完整的（MCP 的版本协商就是这么做的）
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'inventory-system', version: '1.2.0' },
      instructions:
        '这是「AI 智能进销存系统」的只读接口（默认）。数字全部来自命令层，与桌面界面同源。' +
        (ALLOW_WRITE ? '⚠️ 本次启动已开启写命令（--allow-write）。' : '写命令未开启；需要写操作时由店主在桌面端确认。'),
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null // 通知，不回
  if (method === 'ping') return reply({})
  if (method === 'tools/list') {
    let tools = []
    try {
      tools = [...META_TOOLS, ...(await loadTools()).tools]
    } catch (e) {
      return fail(-32603, String(e?.message ?? e))
    }
    return reply({ tools })
  }
  if (method === 'tools/call') {
    const r = await callTool(params?.name, params?.arguments ?? {})
    return reply({ content: [{ type: 'text', text: r.text }], isError: r.isError })
  }
  if (method === 'resources/list') return reply({ resources: [] })
  if (method === 'prompts/list') return reply({ prompts: [] })
  return fail(-32601, '不支持的方法：' + method)
}

// ---------------- 入口 ----------------
if (SELFTEST) {
  // 自检：拉一次清单 + 调一次只读命令，把结果打到 stdout 后退出（给人/CI 看的，不参与 MCP 会话）
  const t = await loadTools()
  const r = await callTool('inventory_command_doc', {})
  console.log(JSON.stringify({
    ok: true,
    url: cfg.url,
    allowWrite: ALLOW_WRITE,
    tools: t.tools.length,
    sample: t.tools.slice(0, 3).map((x) => x.name),
    docOk: !r.isError,
  }, null, 2))
  // ⚠️ 不能立刻 process.exit：此时 undici 的 keep-alive 连接正在关，
  //    在 Windows 上会触发 libuv 断言（实测 exit code 3221226505）。
  //    等一拍让句柄关干净再退，退之前只设 exitCode（正常路径天然为 0）。
  process.exitCode = 0
  setTimeout(() => process.exit(0), 250)
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  // 在飞的请求数：stdin 关掉时不能立刻退 —— 有些客户端把最后一条请求写完就关管道，
  // 那时 tools/call 的 HTTP 还在路上，立刻退就把答案丢了（本地探针实测踩到）。
  let pending = 0
  rl.on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg
    try {
      msg = JSON.parse(s)
    } catch {
      log('收到不是 JSON 的行，已忽略')
      return
    }
    pending++
    handle(msg)
      .then((res) => { if (res) process.stdout.write(JSON.stringify(res) + '\n') })
      .catch((e) => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }) + '\n')
      })
      .finally(() => { pending-- })
  })
  rl.on('close', async () => {
    const t0 = Date.now()
    while (pending > 0 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50))
    // 同上：stdin 关了也要等一拍再退，别在句柄关闭中途 process.exit
    process.exitCode = 0
    setTimeout(() => process.exit(0), 250)
  })
  log('就绪：' + cfg.url + (ALLOW_WRITE ? '（含写命令）' : '（只读）'))
}
