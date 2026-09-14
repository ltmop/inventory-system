/**
 * 命令自省与调用（供 命令台 / HTTP 命令 API / 接口文档 共用）
 *
 * 真相源说明：`electron/commandRegistry.json` 是**生成物**，
 *   由 scripts/command-surface.mjs --emit-registry 从三处代码 + JSDoc 抽取而来。
 *   改动命令后重新生成即可，接口文档也随之更新  不会再出现"文档和代码对不上"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY_FILE = path.join(HERE, 'commandRegistry.json')

let cache = null

/** 读注册表（带缓存）。文件缺失时返回空注册表，不抛命令台/接口不该因它挂掉 */
export function loadRegistry() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
  } catch {
    cache = { schemaVersion: 1, total: 0, commands: [], restRoutes: [] }
  }
  return cache
}

/** 列命令。可选按前缀分组过滤、按关键字搜（匹配命令名与描述） */
export function listCommands({ group = '', q = '' } = {}) {
  const reg = loadRegistry()
  const g = String(group || '').trim().toLowerCase()
  const kw = String(q || '').trim().toLowerCase()
  let list = reg.commands
  if (g) list = list.filter((c) => String(c.group).toLowerCase() === g)
  if (kw) {
    list = list.filter(
      (c) => c.name.toLowerCase().includes(kw) || String(c.desc || '').toLowerCase().includes(kw),
    )
  }
  const groups = {}
  for (const c of reg.commands) groups[c.group] = (groups[c.group] || 0) + 1
  return {
    ok: true,
    total: reg.commands.length,
    restRoutes: reg.restRoutes || [],
    groups,
    filtered: list.length,
    commands: list,
  }
}

/** 单条命令详情；不存在返回 { ok:false } */
export function describeCommand(name) {
  const n = String(name || '').trim()
  const reg = loadRegistry()
  const hit = reg.commands.find((c) => c.name === n)
  if (!hit) {
    return { ok: false, error: '未找到命令: ' + n, hint: '用 /api/commands 或 commands:list 查全集' }
  }
  return {
    ok: true,
    command: hit,
    channels: [
      hit.ipc ? 'IPC（桌面渲染进程，window.fi.invoke）' : null,
      hit.http ? 'HTTP（POST /api/invoke，或 POST /api/command）' : null,
    ].filter(Boolean),
    examples: {
      cli: `node -e "" 或 curl -X POST http://127.0.0.1:<port>/api/command -H 'content-type: application/json' -H 'x-token: <token>' -d '{"name":"${hit.name}","params":{}}'`,
      http: `POST /api/command  {"name":"${hit.name}","params":{}}`,
      ipc: hit.ipc ? `window.fi.invoke('${hit.name}', {})` : '(该命令未开放 IPC)',
    },
  }
}

export function registryMeta() {
  const reg = loadRegistry()
  return { schemaVersion: reg.schemaVersion, generatedAt: reg.generatedAt, source: reg.source, total: reg.total }
}