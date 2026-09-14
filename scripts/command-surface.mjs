#!/usr/bin/env node
/**
 * 命令面抽取与三通道一致性检查（阶段一：立真相源）
 *
 * 背景：同一套业务命令现在被抄了三遍 
 *    electron/main.js 的 handle('x', ...)         （桌面 IPC 实现）
 *    electron/preload.cjs 的 CHANNELS 白名单        （渲染进程可调用面）
 *    electron/server.js 的 INVOKE_CHANNELS         （HTTP /api/invoke）
 * 三份不一致就会出"桌面能点、手机打不到"这类幽灵问题。本脚本把它们抽出来对比，
 * 并顺带从 electron/commands/*.js 的 JSDoc 里取描述  作为生成接口文档的原料。
 *
 * 用法：node scripts/command-surface.mjs            # 人类可读报告
 *       node scripts/command-surface.mjs --json     # 输出 JSON（供文档生成器用）
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ---------- 1) main.js：handle('name', (d, p) => ...) ----------
function fromMain() {
  const s = R('electron/main.js')
  const out = new Map()
  const re = /(?:^|\n)\s*(?:const\s+\w+\s*=\s*)?(?:handle|ipcMain\.handle)\(\s*'([^']+)'\s*,\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*([\s\S]*?)(?=\n\s*(?:const\s+\w+\s*=\s*)?(?:handle|ipcMain\.handle)\(|\n\s*\n|\Z)/g
  let m
  while ((m = re.exec(s))) {
    const body = m[3].replace(/\s+/g, ' ').trim()
    const fn = /commands\.(\w+)/.exec(body)
    out.set(m[1], { impl: fn ? fn[1] : null, usesP: /\(\s*d\s*,\s*p/.test('(' + m[2] + ')'), body: body.slice(0, 90) })
  }
  return out
}

// ---------- 2) preload.cjs：CHANNELS 白名单 ----------
function fromPreload() {
  const s = R('electron/preload.cjs')
  const m = /CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(s)
  if (!m) return new Set()
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
}

// ---------- 3) server.js：INVOKE_CHANNELS ----------
function fromServer() {
  const s = R('electron/server.js')
  const m = /INVOKE_CHANNELS\s*=\s*\{([\s\S]*?)\n\}/.exec(s)
  if (!m) return new Map()
  const out = new Map()
  const re = /'([^']+)'\s*:\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*([\s\S]*?)(?=\n\s*'|\n\s*\}|\Z)/g
  let x
  while ((x = re.exec(m[1]))) {
    const fn = /cmds\.(\w+)|commands\.(\w+)/.exec(x[3].replace(/\s+/g, ' '))
    out.set(x[1], { impl: fn ? (fn[1] || fn[2]) : null, usesP: /\(\s*d\s*,\s*p/.test('(' + x[2] + ')') })
  }
  return out
}

// ---------- 4) 命令实现的 JSDoc 描述 ----------
function jsdocIndex() {
  const dir = path.join(ROOT, 'electron/commands')
  const idx = new Map()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue
    const s = fs.readFileSync(path.join(dir, f), 'utf8')
    const re = /\/\*\*([\s\S]*?)\*\/\s*export function (\w+)/g
    let m
    while ((m = re.exec(s))) {
      const desc = m[1].split('\n').map((l) => l.replace(/^\s*\*?\s?/, '').trim()).filter(Boolean).join(' ').slice(0, 160)
      idx.set(m[2], { file: f, desc })
    }
    // 无 JSDoc 的导出函数也登记，便于标注"待补"
    for (const mm of s.matchAll(/export function (\w+)/g)) if (!idx.has(mm[1])) idx.set(mm[1], { file: f, desc: '' })
  }
  return idx
}

const main = fromMain(), pre = fromPreload(), srv = fromServer(), docs = jsdocIndex()
const allNames = [...new Set([...main.keys(), ...pre, ...srv.keys()])].sort()

const rows = allNames.map((name) => {
  const a = main.get(name), b = srv.get(name)
  return {
    name,
    isRest: name.startsWith('/api/'),
    group: name.includes(':') ? name.split(':')[0] : (name.startsWith('/api/') ? 'REST 路径' : '(无前缀)'),
    ipc: !!a,
    http: !!b,
    preloadOk: pre.has(name),
    impl: (a && a.impl) || (b && b.impl) || null,
    desc: (docs.get((a && a.impl) || (b && b.impl)) || {}).desc || '',
    srcFile: (docs.get((a && a.impl) || (b && b.impl)) || {}).file || '',
  }
})

// ---------- 一致性判定 ----------
const cmdRows = rows.filter((r) => !r.isRest) // REST 路径不与 IPC 命令名做同名比较
const onlyIpc = cmdRows.filter((r) => r.ipc && !r.http).map((r) => r.name)
const onlyHttp = cmdRows.filter((r) => !r.ipc && r.http).map((r) => r.name)
const ipcNotInPreload = cmdRows.filter((r) => r.ipc && !r.preloadOk).map((r) => r.name)
const preloadNotImpl = [...pre].filter((n) => !main.has(n)).sort()
const withDesc = rows.filter((r) => r.desc).length

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), total: rows.length, commands: rows, inconsistencies: { onlyIpc, onlyHttp, ipcNotInPreload, preloadNotImpl } }, null, 1))
  process.exit(0)
}

console.log('命令面总览')
console.log('  总命令数        : ' + rows.length)
console.log('  IPC 实现        : ' + main.size)
console.log('  HTTP 实现       : ' + srv.size)
console.log('  preload 白名单  : ' + pre.size)
console.log('  有 JSDoc 描述   : ' + withDesc + ' / ' + rows.length)
console.log('')
console.log('前缀分布')
const byGroup = {}
for (const r of rows) byGroup[r.group] = (byGroup[r.group] || 0) + 1
for (const [g, n] of Object.entries(byGroup).sort((a, b) => b[1] - a[1])) console.log('  ' + g.padEnd(14) + n)
console.log('')
console.log('!! 三份拷贝的不一致（这就是"幽灵问题"的来源）')
const show = (t, arr) => console.log('  ' + t.padEnd(34) + (arr.length ? arr.length + ' 条: ' + arr.slice(0, 8).join(', ') + (arr.length > 8 ? ' ' : '') : '无'))
show('只有 IPC、没有 HTTP', onlyIpc)
show('只有 HTTP、没有 IPC', onlyHttp)
show('有 IPC 实现但 preload 没放行', ipcNotInPreload)
show('preload 放行但没有实现', preloadNotImpl)