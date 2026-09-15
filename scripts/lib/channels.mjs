// 通道闭包：**渲染层实际会调哪些通道**。
// 抽出来是为了让「发布侧」与「闸门」用同一套判据 —— 否则会出现
// "闸门说没问题、发布出去的包在客户端被拒"这种最难查的不一致。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 扫 src/**\/*.ts(x) 里的 `invoke('x:y')` 字面量。
 * ⚠️ 前缀必须写 [a-zA-Z]+：驼峰通道名（priceTier:set / ai:smartSearch）用 [a-z]+ 会整条漏掉。
 */
export function channelsUsedInSrc(repo) {
  const out = new Set()
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = fs.readFileSync(abs, 'utf8')
        for (const m of src.matchAll(/invoke\(\s*'([a-zA-Z]+:[A-Za-z]+)'/g)) out.add(m[1])
      }
    }
  }
  walk(path.join(repo, 'src'))
  return out
}
