// 口径层热更包的**依赖闭包**与边界校验（发布侧与闸门共用）
//
// 为什么必须算闭包：`electron/commands/**` 并不是自足的 —— 它还会 import 三个**目录之外**的文件
// （`../license.js`、`../channels.js`、`../localSearch.js`）。只把 commands/ 打进包，
// 装上去 import 就找不到模块 → 一半新一半旧，比彻底坏掉更难查。
//
// 入口集合的定义（刻意的）：`commands.js` + **commands/ 下所有 .js**。
// 后者是因为 search.js / analytics.js / permissions.js **不在 barrel 里**，却被 main/server/orchestrator
// 直接 import —— 只打 barrel 的闭包会漏掉它们。
import fs from 'node:fs'
import path from 'node:path'

const IMPORT_RE = /^\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?'([^']+)'/gm
/** 注释里出现 `import ... from 'x'` 不算依赖 —— 不剥注释会算出多余的（甚至不存在的）文件 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/**
 * @returns {{ files: string[], externals: Map<string,string[]>, electronImports: string[], escapes: string[] }}
 *   files          相对 electronDir 的路径（`/` 分隔，已排序）—— 这就是热更包要装的文件集
 *   externals      非相对依赖（`node:*` / npm 包），不需要进包
 *   electronImports 闭包里 import 了 'electron' 的文件（有就**不能**热更：主进程模块换不掉）
 *   escapes        相对 import 跳出了 electronDir 的文件（包内解不开 → 必须拦住）
 */
export function computeCodeClosure(electronDir) {
  const root = path.resolve(electronDir)
  const seen = new Set()
  const externals = new Map()
  const electronImports = []
  const escapes = []

  const walk = (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (seen.has(rel)) return
    seen.add(rel)
    let src = ''
    try { src = stripComments(fs.readFileSync(abs, 'utf8')) } catch { return }
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1]
      if (!spec) continue
      if (spec === 'electron' || spec.startsWith('electron/')) {
        if (!electronImports.includes(rel)) electronImports.push(rel)
        continue
      }
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(abs), spec)
        if (!(target === root || target.startsWith(root + path.sep))) {
          escapes.push(`${rel} → ${spec}`)
          continue
        }
        walk(target)
        continue
      }
      if (!externals.has(spec)) externals.set(spec, [])
      externals.get(spec).push(rel)
    }
  }

  walk(path.join(root, 'commands.js'))
  for (const f of fs.readdirSync(path.join(root, 'commands'))) {
    if (f.endsWith('.js')) walk(path.join(root, 'commands', f))
  }
  return { files: [...seen].sort(), externals, electronImports, escapes }
}
