// shell-release-audit.mjs —— 「哪些改动热更推不到、必须装壳」的机器审计
//
// 为什么要它：热更能推的只有两样东西 ——
//   ① B 通道：dist/**（前端构建产物，来自 src/ public/ index.html）
//   ② C 通道：口径层闭包（electron/commands.js + electron/commands/** 及其相对 import）
// 其余 electron/** 一律**推不到**，只能随安装包发。靠记性列这份清单迟早漏，
// 所以这里用 build-web-bundle.mjs 同一份 computeCodeClosure 来算，口径不会漂移。
//
// 用法：
//   node scripts/shell-release-audit.mjs                  # 与上一个装壳版本比（默认 tag v1.1.10）
//   node scripts/shell-release-audit.mjs --base <ref>
//   node scripts/shell-release-audit.mjs --json            # 机器可读
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { computeCodeClosure } from './lib/code-closure.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const BASE = arg('base', 'v1.1.10')
const JSON_OUT = argv.includes('--json')

const git = (args) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) {
    console.error('✗ git ' + args.join(' ') + ' 失败：' + String(r.stderr || '').trim())
    process.exit(2)
  }
  return String(r.stdout || '')
}

// 闭包：热更 C 通道能带的文件（相对 electron/）
const closure = computeCodeClosure(path.join(REPO, 'electron'))
const closureSet = new Set(closure.files.map((f) => 'electron/' + f))

const changed = git(['diff', '--name-only', BASE + '..HEAD']).split('\n').map((s) => s.trim()).filter(Boolean)

// 分类
const buckets = { web: [], closure: [], shellCore: [], shellMobile: [], other: [] }
for (const f of changed) {
  if (f.startsWith('electron/')) {
    if (closureSet.has(f)) buckets.closure.push(f)
    // 手机端（electron/mobile/**）虽然也不在热更闭包里，但它有**另一条部署路**：
    // 直接拷到中心库 /opt/inventory-app/electron/mobile/（静态文件按请求读，不用重启）。
    // 只有"桌面端自己那份 /m"（局域网模式）要等装壳。所以单独一桶，别和真壳层混。
    else if (f.startsWith('electron/mobile/')) buckets.shellMobile.push(f)
    else buckets.shellCore.push(f)
    continue
  }
  // dist 由 src/ public/ index.html 构建而来 —— 这些改动能走 B 通道
  if (f.startsWith('src/') || f.startsWith('public/') || f === 'index.html' || f.startsWith('index.html')) {
    buckets.web.push(f)
    continue
  }
  buckets.other.push(f)
}

// 结论：真壳层里有东西 = 必须装壳
const needShell = buckets.shellCore.length > 0

if (JSON_OUT) {
  console.log(JSON.stringify({ base: BASE, head: git(['rev-parse', '--short', 'HEAD']).trim(), needShell, ...buckets }, null, 2))
  process.exit(0)
}

const head = git(['rev-parse', '--short', 'HEAD']).trim()
console.log('=== 发壳审计：' + BASE + ' → ' + head + ' ===')
console.log('')
const show = (title, list, note) => {
  console.log(title + '（' + list.length + ' 个）' + (note ? '  —— ' + note : ''))
  for (const f of list) console.log('    ' + f)
  if (!list.length) console.log('    （无）')
  console.log('')
}
show('① B 通道（热更可推）', buckets.web, '改这些跑 build-web-bundle 就能热更')
show('② C 通道闭包（热更可推）', buckets.closure, '口径层，必须与 ① 一起发')
show('③ 🔴 真·壳层（热更推不到，只能装壳）', buckets.shellCore, '主进程/preload 等，只有安装包能换')
show('④ 📱 手机端（有单独部署路）', buckets.shellMobile, '直接拷中心库 /opt/inventory-app/electron/mobile/ 即生效；桌面局域网那份要等装壳')
show('⑤ 其他（文档/脚本等）', buckets.other, '不影响发版')
console.log(needShell
  ? '→ 结论：**需要发一个新壳**（③ 里有 ' + buckets.shellCore.length + ' 个文件热更推不到）'
  : '→ 结论：③ 为空 —— 前端与手机端都能各自热更/单独部署，**不必装壳**')
process.exit(0)
